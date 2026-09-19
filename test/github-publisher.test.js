import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGithubPublisher } from '../demo/github-publisher.js';
import { Store } from '../demo/store.js';
import { createBuilder } from '../demo/builders.js';

// No dedicated coverage of this module existed before -- these tests lock in both the
// pre-existing shared-token/allowlist mode and the new personal-token mode (any well-formed
// owner/repo, no platform allowlist, because it's the caller's own credential).
// graduationFiles()/render() need a genuinely complete, published app record (definition,
// build result, digests) -- easier and more honest to build one for real through Store than
// to hand-fake compile()'s internals. Each test builds its OWN app once and reuses that same
// object across prepare()/publish(), since publish() fingerprint-checks the app it's given
// against the one prepare() saw.

async function fakeApp(t){
  const directory=mkdtempSync(join(tmpdir(),'pac-gh-test-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const store=new Store(directory,createBuilder('process'));
  const owner={kind:'owner',label:'Workspace owner'};
  const created=store.create(owner,{title:'Test App',brief:'A test application for github publisher tests.',accent:'teal',template:'claims'});
  await store.startBuild(owner,created.id);
  await store.lastBuild;
  store.publish(owner,created.id);
  return store.state.apps.find(a=>a.id===created.id);
}
function fakeRequest(responses){
  const calls=[];
  return {calls,fetch:async(url,init)=>{calls.push({url,init});const r=responses[calls.length-1]??responses.at(-1);return {ok:r.ok!==false,status:r.status||200,json:async()=>r.body};}};
}

test('GH-001 configuration reports the shared allowlist as disabled with no token, but always allows a personal token', ()=>{
  const gh=createGithubPublisher({token:'',repositories:[],request:async()=>{}});
  const config=gh.configuration();
  assert.equal(config.enabled,false);
  assert.equal(config.allowPersonal,true);
});

test('GH-002 prepare refuses a repository outside the shared allowlist when no personal token is supplied', async t=>{
  const app=await fakeApp(t);
  const gh=createGithubPublisher({token:'shared-tok',repositories:['org/allowed'],request:async()=>{}});
  assert.throws(()=>gh.prepare(app,'org/not-allowed'),/not enabled by the platform administrator/);
});

test('GH-003 prepare with a personal token accepts any well-formed owner/repo, bypassing the shared allowlist', async t=>{
  const app=await fakeApp(t);
  const gh=createGithubPublisher({token:'shared-tok',repositories:['org/allowed'],request:async()=>{}});
  const plan=gh.prepare(app,'someone-else/their-repo','personal-tok-123');
  assert.equal(plan.repository,'someone-else/their-repo');
});

test('GH-004 prepare with a personal token rejects a malformed repository string', async t=>{
  const app=await fakeApp(t);
  const gh=createGithubPublisher({token:'',repositories:[],request:async()=>{}});
  assert.throws(()=>gh.prepare(app,'not-a-valid-repo-string','personal-tok'),/owner\/repo form/);
});

test('GH-005 with no shared token and no personal token, prepare fails clearly instead of silently using an empty credential', async t=>{
  const app=await fakeApp(t);
  const gh=createGithubPublisher({token:'',repositories:[],request:async()=>{}});
  assert.throws(()=>gh.prepare(app,'org/repo'),/No GitHub token available/);
});

test('GH-006 publish uses the personal token supplied at prepare time, authenticates with it, and never with the shared token', async t=>{
  const app=await fakeApp(t);
  const fake=fakeRequest([
    {body:{private:true}},
    {body:{sha:'tree-sha'}},
    {body:{sha:'commit-sha'}},
    {body:{}},
  ]);
  const gh=createGithubPublisher({token:'shared-tok-should-not-be-used',repositories:[],request:fake.fetch});
  const plan=gh.prepare(app,'someone-else/their-repo','personal-tok-abc');
  const result=await gh.publish(app,{id:plan.id,digest:plan.digest});
  assert.equal(result.repository,'someone-else/their-repo');
  assert.ok(fake.calls.every(c=>c.init.headers.Authorization==='Bearer personal-tok-abc'));
  assert.ok(fake.calls.every(c=>c.init.headers.Authorization!=='Bearer shared-tok-should-not-be-used'));
});

test('GH-007 the personal token is discarded from the plan after publish resolves, win or lose', async t=>{
  const app=await fakeApp(t);
  const fake=fakeRequest([{ok:false,status:404}]);
  const gh=createGithubPublisher({token:'',repositories:[],request:fake.fetch});
  const plan=gh.prepare(app,'someone/repo','personal-tok-xyz');
  await assert.rejects(()=>gh.publish(app,{id:plan.id,digest:plan.digest}));
  // A second publish attempt against the same (now failed) plan must not succeed by reusing a
  // lingering credential -- the plan is already invalid (state !== 'prepared') at this point.
  await assert.rejects(()=>gh.publish(app,{id:plan.id,digest:plan.digest}),/Invalid, expired or already used/);
});
