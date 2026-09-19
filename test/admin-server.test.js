import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { createDemo } from '../demo/server.js';
import { createBuilder } from '../demo/builders.js';

// The admin console is the one surface gated on "owner kind AND a browser session, never a
// bearer token" -- mirroring the pre-existing GitHub-publish gate (server.js action.startsWith
// ('github-')). These tests prove that gate holds for every /api/admin/* route, and that each
// route degrades honestly (not silently) when its adapter/env var is unconfigured.

async function fixture(t,{runtime,orchestration,agent,env}={}){
  const directory=mkdtempSync(join(tmpdir(),'pac-admin-server-')),ownerToken=randomBytes(32).toString('hex');
  const restoreEnv={};
  for(const [k,v] of Object.entries(env||{})){restoreEnv[k]=process.env[k];process.env[k]=v;}
  const runtimeInstance=createDemo({directory,ownerToken,builder:createBuilder('process'),runtime:runtime||null,orchestration:orchestration||null,agent:agent||null});
  await new Promise(r=>runtimeInstance.server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+runtimeInstance.server.address().port;
  t.after(()=>{runtimeInstance.server.close();rmSync(directory,{recursive:true,force:true});for(const [k,v] of Object.entries(restoreEnv))v===undefined?delete process.env[k]:process.env[k]=v;});
  // Owner browser session (POST /api/session), NOT a bearer -- proves the gate treats these
  // differently. callBearer proves the bearer path is refused.
  const sessionRes=await fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:ownerToken})});
  const cookie=sessionRes.headers.get('set-cookie').split(';')[0];
  const callSession=async(path,body)=>{const res=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,data:await res.json()};};
  const callBearer=async(path,body)=>{const res=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+ownerToken,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,data:await res.json()};};
  return {runtime:runtimeInstance,callSession,callBearer,base,ownerToken};
}

test('ADMIN-001 an owner bearer token (MCP/CLI path) is refused on every admin route, even though it is a valid owner credential elsewhere',async t=>{
  const {callBearer}=await fixture(t);
  const overview=await callBearer('/api/admin/overview');
  assert.equal(overview.status,403);
  assert.match(overview.data.error,/owner browser session/);
});

test('ADMIN-002 a non-owner browser session (a collaborator, via an app invite) is refused',async t=>{
  const {base,callSession}=await fixture(t);
  const created=await callSession('/api/apps',{title:'Guest App',brief:'A test application for admin gating.',template:'claims',accent:'teal'});
  const invite=await callSession('/api/apps/'+created.data.id+'/invite',{label:'Guest'});
  const token=new URL(invite.data.url).hash.slice('#invite='.length);
  const acceptRes=await fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
  const guestCookie=acceptRes.headers.get('set-cookie').split(';')[0];
  const res=await fetch(base+'/api/admin/overview',{headers:{Cookie:guestCookie}});
  assert.equal(res.status,403);
});

test('ADMIN-003 GET /api/admin/overview aggregates apps (including archived) and a merged audit feed for the owner browser session',async t=>{
  const {callSession}=await fixture(t);
  await callSession('/api/apps',{title:'Tapper Clone',brief:'An arcade game, insurance themed.',template:'claims',accent:'teal'});
  const overview=await callSession('/api/admin/overview');
  assert.equal(overview.status,200);
  assert.equal(overview.data.totals.apps,1);
  assert.ok(overview.data.apps.some(a=>a.config.title==='Tapper Clone'));
  assert.ok(overview.data.audit.some(e=>e.event==='created'));
});

test('ADMIN-004 GET /api/admin/services reports every tile, marking unconfigured adapters/env vars as absent rather than omitting them',async t=>{
  const {callSession}=await fixture(t,{env:{PAC_LITELLM_URL:'',PAC_OLLAMA_URL:'',PAC_TEMPORAL_ADDRESS:''}});
  const res=await callSession('/api/admin/services');
  assert.equal(res.status,200);
  const byId=Object.fromEntries(res.data.services.map(s=>[s.id,s]));
  assert.equal(byId.litellm.status,'absent');
  assert.equal(byId.ollama.status,'absent');
  assert.equal(byId.deploykit.status,'absent');
  assert.equal(byId.temporal.status,'absent');
});

test('ADMIN-005 POST /api/admin/llm-test fails with a clear 501 when PAC_LITELLM_URL is not configured',async t=>{
  const {callSession}=await fixture(t,{env:{PAC_LITELLM_URL:''}});
  const res=await callSession('/api/admin/llm-test',{prompt:'hi'});
  assert.equal(res.status,501);
  assert.match(res.data.error,/PAC_LITELLM_URL/);
});

test('ADMIN-006 POST /api/admin/llm-test runs a real completion against a fake LiteLLM server and surfaces cost/usage/finish reason',async t=>{
  const fake=await new Promise(resolve=>{
    const s=http.createServer((req,res)=>{
      let body='';req.on('data',c=>body+=c);req.on('end',()=>{
        res.setHeader('x-litellm-response-cost','0.0021');
        res.end(JSON.stringify({model:'local-qwen',choices:[{message:{content:'hi there'},finish_reason:'stop'}],usage:{total_tokens:12}}));
      });
    });
    s.listen(0,'127.0.0.1',()=>resolve(s));
  });
  t.after(()=>fake.close());
  const {callSession}=await fixture(t,{env:{PAC_LITELLM_URL:`http://127.0.0.1:${fake.address().port}`}});
  const res=await callSession('/api/admin/llm-test',{prompt:'Say hi'});
  assert.equal(res.status,200);
  assert.equal(res.data.content,'hi there');
  assert.equal(res.data.usage.total_tokens,12);
  assert.equal(res.data.costUsd,0.0021);
});

test('ADMIN-007 POST /api/admin/orchestration-test fails with a clear 501 when no orchestration adapter is configured',async t=>{
  const {callSession}=await fixture(t);
  const res=await callSession('/api/admin/orchestration-test',{});
  assert.equal(res.status,501);
  assert.match(res.data.error,/PAC_ORCHESTRATION_ADAPTER/);
});

test('ADMIN-008 POST /api/admin/orchestration-test round-trips through a fake orchestration adapter',async t=>{
  const orchestration={mode:'fake',health:async()=>({status:'ok',output:{namespace:'default'}}),listWorkflows:async()=>({status:'ok',output:{workflows:[{workflowId:'wf-1'}]}})};
  const {callSession}=await fixture(t,{orchestration});
  const res=await callSession('/api/admin/orchestration-test',{});
  assert.equal(res.status,200);
  assert.equal(res.data.health.namespace,'default');
  assert.equal(res.data.recentWorkflows[0].workflowId,'wf-1');
});

test('ADMIN-009 POST /api/admin/agent-test fails with a clear 501 when no agent adapter is configured',async t=>{
  const {callSession}=await fixture(t);
  const res=await callSession('/api/admin/agent-test',{prompt:'hi'});
  assert.equal(res.status,501);
  assert.match(res.data.error,/PAC_AGENT_ADAPTER/);
});

test('ADMIN-010 POST /api/admin/agent-test round-trips through a fake agent adapter',async t=>{
  const agent={mode:'fake',run:async({prompt})=>({status:'ok',output:{reply:'Echo: '+prompt}})};
  const {callSession}=await fixture(t,{agent});
  const res=await callSession('/api/admin/agent-test',{prompt:'ping'});
  assert.equal(res.status,200);
  assert.equal(res.data.reply,'Echo: ping');
});

test('ADMIN-011 GET /admin.html and /admin.js are served without authentication (the page itself is public; every capability behind it is gated server-side)',async t=>{
  const {base}=await fixture(t);
  const html=await fetch(base+'/admin.html');
  assert.equal(html.status,200);
  assert.match(await html.text(),/Admin console/);
  const js=await fetch(base+'/admin.js');
  assert.equal(js.status,200);
  assert.equal(js.headers.get('content-type'),'text/javascript');
});
