import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemo } from '../demo/server.js';
import { compile } from '../demo/definition.js';
import { assuranceRecord,saveAssurance,reportHtml,reportMarkdown,completeness } from '../demo/assurance.js';
import { graduationFiles } from '../demo/archive.js';
import { createGithubPublisher } from '../demo/github-publisher.js';
const owner={kind:'owner',label:'Demo owner'},config={title:'Claims review',brief:'Review synthetic claims and discuss follow-ups.',template:'claims',accent:'teal'};
function fixture(t,github){const directory=mkdtempSync(join(tmpdir(),'pac-assurance-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));return createDemo({directory,ownerToken:'x'.repeat(64),builder:{mode:'Test compiler · no container isolation',build:async c=>compile(c)},github});}
async function published(runtime){const app=runtime.store.create(owner,config);runtime.store.startBuild(owner,app.id);await runtime.store.lastBuild;runtime.store.publish(owner,app.id);return app;}

test('ASSURANCE-004 a kind-based generated artifact\'s ARB/BOM claims are accurate -- not the stale "no generated scripts" / "${undefined} template" claims that predate real generation',async t=>{
  const runtime=fixture(t);
  const kindConfig={title:'Tapper Clone',brief:'An arcade game, insurance themed.',kind:'interactive',accent:'teal',tier:'static',source:{'index.html':'<h1>hi</h1>','app.js':'window.x=1;'}};
  const app=runtime.store.create(owner,kindConfig);
  runtime.store.startBuild(owner,app.id);await runtime.store.lastBuild;
  runtime.store.publish(owner,app.id);
  const record=assuranceRecord(app);
  assert.ok(!record.data.arb.scope.text.includes('undefined template'), 'template is never set on a kind-based record -- must not leak as literal "undefined"');
  assert.ok(!record.data.arb.frontend.text.includes('no generated scripts'), 'a real generated <script> block exists for this artifact -- claiming otherwise is false');
  assert.match(record.data.arb.frontend.text, /interactive/);
  assert.match(record.data.arb.scope.text, /live server-side integrations remain outside this demo/i); // still calls out what IS out of scope correctly
  assert.match(record.facts.artifactRuntime, /generated client-side scripts/);
  assert.match(record.data.bom.permissions.text, /sandboxed, network-blocked iframe/);
});

test('ASSURANCE-005 a classic (kind-less) artifact keeps the original, still-accurate claims unchanged',async t=>{
  const app=await published(fixture(t));
  const record=assuranceRecord(app);
  assert.match(record.data.arb.frontend.text, /no generated executable scripts/);
  assert.match(record.data.arb.scope.text, /claims template/);
  assert.match(record.facts.artifactRuntime, /no generated executable scripts/);
});

test('ASSURANCE-001 published changes regenerate all report data and preserve human decisions as stale',async t=>{
  const runtime=fixture(t),app=await published(runtime);let record=assuranceRecord(app);
  assert.equal(record.release,1);assert.match(record.data.arb.purpose.text,/Claims review/);assert.equal(record.data.readiness.recovery.status,'unknown');assert.ok(completeness(record).missingOrProposed>0);
  const data=record.data;data.readiness.recovery={status:'proposed',text:'Target recovery within four hours; owner must confirm.',owner:'Service owner',evidence:[]};
  saveAssurance(runtime.store,owner,app.id,{revision:0,release:1,data});
  const before=assuranceRecord(app);assert.throws(()=>saveAssurance(runtime.store,owner,app.id,{revision:0,release:1,data}),/changed/);
  runtime.store.update(owner,app.id,{...config,title:'Team knowledge hub',brief:'Share onboarding guidance across the team.',template:'knowledge',accent:'plum'},1);
  assert.equal(assuranceRecord(app).title,'Claims review','Draft edit must not relabel published documents');
  runtime.store.startBuild(owner,app.id);await runtime.store.lastBuild;runtime.store.publish(owner,app.id);runtime.store.bind(owner,app.id);
  const after=assuranceRecord(app);assert.equal(after.release,2);assert.notEqual(after.generatedDigest,before.generatedDigest);assert.notEqual(after.sourceDigest,before.sourceDigest);assert.equal(after.stale,true);assert.match(after.data.arb.scope.text,/knowledge/);assert.match(after.data.arb.frontend.text,/plum/);assert.equal(after.data.readiness.recovery.text,data.readiness.recovery.text);assert.ok(after.data.components.some(c=>c.id==='pac-mock-claims'));
  for(const kind of ['arb','readiness','bom']){const md=reportMarkdown(after,kind);assert.match(md,/Team knowledge hub/);assert.match(md,/Release: 2/);assert.match(md,/STALE/);assert.ok(md.includes(after.sourceDigest));}
  const files=graduationFiles(app);assert.equal(JSON.parse(files['assurance.json']).release,2);assert.match(files['reports/arb.html'],/Team knowledge hub/);
  const bad=structuredClone(after.data);bad.arb.risks={status:'documented',text:'Approved',owner:'Owner',evidence:[]};assert.throws(()=>saveAssurance(runtime.store,owner,app.id,{revision:1,release:2,data:bad}),/evidence/);
  bad.arb.risks.status='approved';assert.throws(()=>saveAssurance(runtime.store,owner,app.id,{revision:1,release:2,data:bad}),/Invalid/);
  const safe=structuredClone(after);safe.data.arb.risks.text='<script>alert(1)</script>';assert.ok(!reportHtml(safe,'arb').includes('<script>'));assert.match(reportHtml(safe,'arb'),/&lt;script&gt;/);
});

test('ASSURANCE-002 MCP exposes guidance, versioned updates and generated preview links with scoped access',async t=>{
  const runtime=fixture(t),app=await published(runtime);await new Promise(r=>runtime.server.listen(0,'127.0.0.1',r));t.after(()=>runtime.server.close());const base='http://127.0.0.1:'+runtime.server.address().port;
  const call=async(method,params,token='x'.repeat(64))=>(await (await fetch(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json());
  assert.ok((await call('initialize',{})).result.capabilities.prompts);
  assert.ok((await call('prompts/list',{})).result.prompts.some(p=>p.name==='evolve_application'));
  assert.match((await call('prompts/get',{name:'evolve_application',arguments:{artifactId:app.id,change:'Make the accent plum'}})).result.messages[0].content.text,/publish only after/);
  assert.equal(JSON.parse((await call('resources/read',{uri:'pac://assurance/schema'})).result.contents[0].text).type,'object');
  const doc=JSON.parse((await call('tools/call',{name:'preview_assurance_document',arguments:{id:app.id,kind:'readiness'}})).result.content[0].text);assert.match(doc.markdown,/Systems Readiness/);
  const change=await call('tools/call',{name:'update_application',arguments:{id:app.id,revision:1,...config,title:'Updated knowledge desk',template:'knowledge',accent:'plum'}});assert.ok(!change.result.isError);
  await call('tools/call',{name:'build_application',arguments:{id:app.id}});await runtime.store.lastBuild;
  const release=await call('tools/call',{name:'publish_application',arguments:{id:app.id}});assert.ok(!release.result.isError);
  const evolved=JSON.parse((await call('tools/call',{name:'get_assurance',arguments:{id:app.id}})).result.content[0].text);assert.equal(evolved.record.release,2);assert.match(evolved.record.data.arb.frontend.text,/knowledge.*plum/);
  for(const kind of ['arb','readiness','bom'])assert.match(JSON.parse((await call('tools/call',{name:'preview_assurance_document',arguments:{id:app.id,kind}})).result.content[0].text).markdown,/Updated knowledge desk/);
  const collaborator=runtime.store.tokenSession({kind:'collaborator',label:'Reviewer',appId:app.id});
  const denied=await call('tools/call',{name:'update_assurance',arguments:{id:app.id,revision:0,release:1,data:assuranceRecord(app).data}},collaborator);assert.equal(denied.result.isError,true);
  const response=await fetch(base+'/api/apps/'+app.id+'/reports/bom?format=md&download=1',{headers:{Authorization:'Bearer '+collaborator}});assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/bom.md/);
  const other=runtime.store.create(owner,{...config,title:'Other artifact'});assert.equal((await fetch(base+'/api/apps/'+other.id+'/reports/arb',{headers:{Authorization:'Bearer '+collaborator}})).status,404);
  const ui=await fetch(base+'/graduation-ui.js');assert.equal(ui.status,200);assert.match(ui.headers.get('content-type'),/javascript/);
});

test('ASSURANCE-003 GitHub publishes only reviewed code to an allowed private repository, rejects stale plans and replay',async t=>{
  const requests=[];let privateRepo=true;
  const publisher=createGithubPublisher({token:'test-secret',repositories:['demo/apps'],request:async(url,options)=>{
    assert.ok(url.startsWith('https://api.github.com/repos/demo/apps'));assert.equal(options.redirect,'error');requests.push({url,body:options.body?JSON.parse(options.body):null,method:options.method});
    const payload=url.endsWith('/git/trees')?{sha:'tree'}:url.endsWith('/git/commits')?{sha:'commit'}:url.endsWith('/git/refs')?{ref:'ok'}:{private:privateRepo};return {ok:true,json:async()=>payload};
  }});
  const runtime=fixture(t,publisher),app=await published(runtime);runtime.store.upload(owner,app.id,{name:'private.txt',base64:Buffer.from('PRIVATE UPLOAD MARKER').toString('base64')});runtime.store.comment(owner,app.id,'PRIVATE COMMENT MARKER');
  assert.throws(()=>publisher.prepare(app,'other/repo'),/not enabled/);
  const plan=publisher.prepare(app,'demo/apps');assert.ok(plan.files.some(f=>f.path==='assurance.json'));assert.ok(!JSON.stringify(plan.files).includes('PRIVATE UPLOAD MARKER'));assert.ok(!JSON.stringify(plan.files).includes('PRIVATE COMMENT MARKER'));assert.ok(!JSON.stringify(plan.files).includes('test-secret'));assert.ok(!plan.files.some(f=>f.path.startsWith('.github/')));
  await assert.rejects(()=>publisher.publish(app,{id:plan.id,digest:'wrong'}),/Invalid/);
  const result=await publisher.publish(app,{id:plan.id,digest:plan.digest});assert.equal(result.commit,'commit');assert.equal(requests.at(-1).body.ref,'refs/heads/'+plan.branch);assert.deepEqual(requests.find(r=>r.url.endsWith('/git/commits')).body.parents,[]);assert.ok(requests.every(r=>r.method!=='PATCH'));await assert.rejects(()=>publisher.publish(app,{id:plan.id,digest:plan.digest}),/already used/);
  const stale=publisher.prepare(app,'demo/apps');runtime.store.bind(owner,app.id);await assert.rejects(()=>publisher.publish(app,{id:stale.id,digest:stale.digest}),/changed/);
  const publicPlan=publisher.prepare(app,'demo/apps');privateRepo=false;await assert.rejects(()=>publisher.publish(app,{id:publicPlan.id,digest:publicPlan.digest}),/private repositories/);
  await new Promise(r=>runtime.server.listen(0,'127.0.0.1',r));t.after(()=>runtime.server.close());const base='http://127.0.0.1:'+runtime.server.address().port;
  const response=await fetch(base+'/api/apps/'+app.id+'/github-prepare',{method:'POST',headers:{Authorization:'Bearer '+'x'.repeat(64),'Content-Type':'application/json'},body:JSON.stringify({repository:'demo/apps'})});assert.equal(response.status,403,'MCP owner bearer cannot publish without browser review');
  const login=await fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'x'.repeat(64)})});const cookie=login.headers.get('set-cookie').split(';')[0];
  const prepare=await fetch(base+'/api/apps/'+app.id+'/github-prepare',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({repository:'demo/apps'})});assert.equal(prepare.status,200);
});
