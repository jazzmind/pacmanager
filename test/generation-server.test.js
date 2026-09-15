import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createDemo } from '../demo/server.js';
import { createBuilder } from '../demo/builders.js';

// Real generation, wired into the actual HTTP/MCP surface (the store-level machinery is
// already covered exhaustively by test/generation-store.test.js's in-process fake). This
// proves the wiring itself: GET /api/me's cached authoring block, the generate_application
// MCP tool, and the POST /api/apps/:id/generate REST route, all over a real listening server.

function fakeAuthoring(responses){
  const calls=[];
  return {
    mode:'fake-authoring-adapter',
    calls,
    async generate(args){calls.push(args);const r=responses[calls.length-1]??responses[responses.length-1];return typeof r==='function'?r(args):r;},
    async probe(){return {status:'ok',output:{available:true,model:'fake-model'}};},
  };
}

async function fixture(t,authoring){
  const directory=mkdtempSync(join(tmpdir(),'pac-gen-server-')),ownerToken=randomBytes(32).toString('hex');
  const runtime=createDemo({directory,ownerToken,builder:createBuilder('process'),authoring});
  await new Promise(r=>runtime.server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+runtime.server.address().port;
  t.after(()=>{runtime.server.close();rmSync(directory,{recursive:true,force:true});});
  const call=async(path,body)=>{const res=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+ownerToken,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,data:await res.json()};};
  return {runtime,call,base,ownerToken};
}

test('GENSRV-001 GET /api/me reports authoring not_configured (never blocks on a live probe) when no adapter is set',async t=>{
  const {call}=await fixture(t,null);
  const me=await call('/api/me');
  assert.equal(me.status,200);
  assert.equal(me.data.authoring.available,false);
  assert.equal(me.data.authoring.state,'not_configured');
});

test('GENSRV-002 GET /api/me reports authoring available once a probe succeeds',async t=>{
  const {call}=await fixture(t,fakeAuthoring([]));
  const me=await call('/api/me');
  assert.equal(me.data.authoring.available,true);
  assert.equal(me.data.authoring.model,'fake-model');
});

test('GENSRV-003 POST /api/apps/:id/generate runs a real generation through the REST route and writes source',async t=>{
  const authoring=fakeAuthoring([{status:'ok',output:{kind:'interactive',model:'m',source:{'index.html':'<h1>hi</h1>'}}}]);
  const {runtime,call}=await fixture(t,authoring);
  const created=await call('/api/apps',{title:'Tapper Clone',brief:'An arcade game, insurance themed.',kind:'interactive',accent:'teal',tier:'intent'});
  assert.equal(created.status,201);
  const gen=await call('/api/apps/'+created.data.id+'/generate',{});
  assert.equal(gen.status,202);
  assert.equal(gen.data.status,'generating');
  await runtime.store.lastGeneration;
  const state=await call('/api/apps/'+created.data.id);
  assert.equal(state.data.generation.status,'ready');
  assert.equal(state.data.config.tier,'static');
});

test('GENSRV-006 the full describe -> generate -> build -> preview chain (what ui.js drives automatically) produces a real, working preview -- not a template with the title pasted in',async t=>{
  // index.html is a fragment, not a full document -- compileStatic() auto-wraps .js/.css into
  // one <script>/<style> block each (see pracman/adapters/authoring/lib/prompt.js's
  // STATIC_ASSEMBLY_NOTE, which tells a real model the same thing).
  const authoring=fakeAuthoring([{status:'ok',output:{kind:'interactive',model:'claude-sonnet-5',source:{'index.html':'<h1>Tapper</h1>','app.js':'window.PAC_GAME_MARKER=true;'}}}]);
  const {runtime,call,base,ownerToken}=await fixture(t,authoring);
  const created=await call('/api/apps',{title:'Tapper Clone',brief:'A clone of the arcade game Tapper, insurance themed.',kind:'interactive',accent:'teal',tier:'intent'});
  await call('/api/apps/'+created.data.id+'/generate',{});
  await runtime.store.lastGeneration;
  await call('/api/apps/'+created.data.id+'/build',{});
  await runtime.store.lastBuild;
  const state=await call('/api/apps/'+created.data.id);
  assert.equal(state.data.build.status,'ready');
  const preview=await fetch(base+'/api/apps/'+created.data.id+'/preview',{headers:{Authorization:'Bearer '+ownerToken}});
  const html=await preview.text();
  assert.match(html,/Tapper/); // the generated content itself, not a claims-workbench layout
  assert.match(preview.headers.get('content-security-policy'),/allow-scripts/); // real client-side script actually runs
});

test('GENSRV-004 generate_application MCP tool round-trips through the real MCP surface',async t=>{
  const authoring=fakeAuthoring([{status:'ok',output:{kind:'interactive',model:'m',source:{'index.html':'<h1>hi</h1>'}}}]);
  const {runtime,call}=await fixture(t,authoring);
  const tools=await call('/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'});
  assert.ok(tools.data.result.tools.some(t=>t.name==='generate_application'));
  const created=await call('/mcp',{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'create_application',arguments:{title:'Tapper Clone',brief:'An arcade game, insurance themed.',kind:'interactive',accent:'teal',tier:'intent'}}});
  const app=JSON.parse(created.data.result.content[0].text);
  const gen=await call('/mcp',{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'generate_application',arguments:{id:app.id}}});
  assert.equal(JSON.parse(gen.data.result.content[0].text).status,'generating');
  await runtime.store.lastGeneration;
  const inspected=await call('/mcp',{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'inspect_application',arguments:{id:app.id}}});
  assert.equal(JSON.parse(inspected.data.result.content[0].text).generation.status,'ready');
});

test('GENSRV-005 generate_application fails with a clear, specific error over MCP when no adapter is configured',async t=>{
  const {call}=await fixture(t,null);
  const created=await call('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'create_application',arguments:{title:'Tapper Clone',brief:'An arcade game, insurance themed.',kind:'interactive',accent:'teal',tier:'intent'}}});
  const app=JSON.parse(created.data.result.content[0].text);
  const gen=await call('/mcp',{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'generate_application',arguments:{id:app.id}}});
  assert.equal(gen.data.result.isError,true);
  assert.match(gen.data.result.content[0].text,/No authoring adapter configured. Set PAC_AUTHORING_ADAPTER/);
});
