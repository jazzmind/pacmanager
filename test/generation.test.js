import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createDemo } from '../demo/server.js';
import { compile } from '../demo/definition.js';

const owner={kind:'owner',label:'Demo owner'};
const staticConfig={title:'Pac-Man Rock',brief:'A tiny playable pacman clone, PRAC themed.',template:'knowledge',accent:'blue',tier:'static',
  source:{'index.html':'<canvas id="c" width="200" height="200"></canvas>','app.js':'const el=document.getElementById("c");el.dataset.ready="1";','style.css':'body{background:#000}'}};
function fixture(t){const directory=mkdtempSync(join(tmpdir(),'pac-generation-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));return createDemo({directory,ownerToken:'g'.repeat(64),builder:{mode:'Test compiler · no container isolation',build:async c=>compile(c)}});}

test('GEN-001 static tier compiles deterministically and is rejected by digest verification if tampered',()=>{
  const a=compile(staticConfig),b=compile(staticConfig);
  assert.equal(a.htmlDigest,b.htmlDigest);
  assert.equal(a.sourceDigest,b.sourceDigest);
  assert.ok(a.scriptHashes.length,'expected at least one CSP script hash');
  assert.ok(a.checks.every(c=>c.passed));
});

test('GEN-002 static tier rejects path traversal, disallowed extensions, missing index.html and unsafe JS',()=>{
  assert.throws(()=>compile({...staticConfig,source:{...staticConfig.source,'../evil.js':'1'}}),/Unsafe source path/);
  assert.throws(()=>compile({...staticConfig,source:{...staticConfig.source,'run.sh':'echo hi'}}),/Unsupported source file type/);
  assert.throws(()=>compile({...staticConfig,source:{'app.js':'1'}}),/must include index\.html/);
  assert.throws(()=>compile({...staticConfig,source:{'index.html':'<div></div>','app.js':'eval("1")'}}),/Static source rejected.*eval/);
  assert.throws(()=>compile({...staticConfig,source:{'index.html':'<div></div>','app.js':'fetch("http://evil")'}}),/external.*reference/);
  assert.throws(()=>compile({...staticConfig,source:{'index.html':'<div></div>','app.js':'"</script><script>bad"'}}),/script.*terminator|sequence/);
});

test('GEN-003 CSP script hash matches the exact inline script text the browser would hash',()=>{
  const result=compile(staticConfig);
  const match=result.html.match(/<script>([\s\S]*)<\/script>/);
  const hash=createHash('sha256').update(match[1],'utf8').digest('base64');
  assert.equal(hash,result.scriptHashes[0]);
});

test('GEN-004 end to end: MCP creates a static-tier app, builds, and the preview serves raw generated HTML with a script-src hash and sandboxed allow-scripts CSP',async t=>{
  const {server}=fixture(t);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port,base=`http://127.0.0.1:${port}`;
  const call=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+'g'.repeat(64)},body:JSON.stringify(body)}).then(async r=>({status:r.status,data:await r.json()}));
  const created=await call('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'create_application',arguments:staticConfig}});
  const app=JSON.parse(created.data.result.content[0].text);
  assert.equal(app.config.tier,'static');
  const built=await call('/mcp',{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'build_application',arguments:{id:app.id}}});
  assert.ok(!built.data.result.isError);
  await new Promise(r=>setTimeout(r,50));
  const preview=await fetch(base+'/api/apps/'+app.id+'/preview',{headers:{Authorization:'Bearer '+'g'.repeat(64)}});
  const html=await preview.text();
  assert.ok(html.includes('<canvas id="c"'),'raw generated markup must be served, not the collaboration template');
  assert.doesNotMatch(html,/Shared documents/,'static tier must not receive the template-tier collaboration stub');
  const csp=preview.headers.get('content-security-policy');
  assert.match(csp,/sandbox allow-scripts/);
  assert.match(csp,/script-src 'sha256-/);
  assert.match(csp,/connect-src 'none'/);
  server.close();
});

test('GEN-005 create_application via MCP without tier still defaults to the bounded template (schema fix did not make tier/source required)',async t=>{
  const {server}=fixture(t);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port,base=`http://127.0.0.1:${port}`;
  const call=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+'g'.repeat(64)},body:JSON.stringify(body)}).then(async r=>({status:r.status,data:await r.json()}));
  const created=await call('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'create_application',arguments:{title:'Claims workspace',brief:'Review synthetic claims.',template:'claims',accent:'teal'}}});
  const app=JSON.parse(created.data.result.content[0].text);
  assert.equal(app.config.tier,'template');
  server.close();
});

test('GEN-006 agent runs are recorded via MCP, capped and validated, and rendered into a static app that opts in with the PAC-BRIEFINGS marker',async t=>{
  const briefingApp={title:'News Desk',brief:'Displays recorded agent briefings for a topic.',template:'knowledge',accent:'plum',tier:'static',
    source:{'index.html':'<div id="feed"></div><!--PAC-BRIEFINGS-->','app.js':'const raw=document.getElementById("pac-briefings");const items=raw?JSON.parse(raw.textContent):[];document.getElementById("feed").textContent=items.length+" briefings";'}};
  const {server}=fixture(t);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port,base=`http://127.0.0.1:${port}`;
  const call=(body)=>fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+'g'.repeat(64)},body:JSON.stringify(body)}).then(async r=>({status:r.status,data:await r.json()}));
  const created=await call({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'create_application',arguments:briefingApp}});
  const app=JSON.parse(created.data.result.content[0].text);
  const missingSources=await call({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'record_agent_run',arguments:{id:app.id,agentId:'news-briefing',topic:'Topic',text:'Body',sources:[]}}});
  assert.ok(missingSources.data.result.isError,'must reject a run with no sources');
  const recorded=await call({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'record_agent_run',arguments:{id:app.id,agentId:'news-briefing',topic:'Quarterly claims trend',text:'Coverage summary here.',sources:['https://example.invalid/article']}}});
  assert.ok(!recorded.data.result.isError);
  const record=JSON.parse(recorded.data.result.content[0].text);
  assert.match(record.label,/AI-generated/,'must default to a disclosed, non-impersonating label');
  await call({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'build_application',arguments:{id:app.id}}});
  await new Promise(r=>setTimeout(r,50));
  const preview=await fetch(base+'/api/apps/'+app.id+'/preview',{headers:{Authorization:'Bearer '+'g'.repeat(64)}});
  const html=await preview.text();
  assert.match(html,/application\/json" id="pac-briefings"/);
  assert.match(html,/Quarterly claims trend/);
  assert.doesNotMatch(html,/<\/script><script>bad/,'injected JSON must not allow tag breakout');
  server.close();
});
