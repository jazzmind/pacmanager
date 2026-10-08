import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createDemo } from '../demo/server.js';
import { createBuilder } from '../demo/builders.js';

// Chat/Plan: the fix for "every chat message silently became a change request." Chat answers
// questions without touching the app; Plan drafts a plain-language proposal for the user to
// review before anything is executed -- executing it is a separate, later generate() call,
// never part of this endpoint.

function fakeLitellm(reply,finishReason='stop'){
  return new Promise(resolve=>{
    const s=http.createServer((req,res)=>{
      let body='';req.on('data',c=>body+=c);
      req.on('end',()=>{res.end(JSON.stringify({model:'local-qwen',choices:[{message:{content:typeof reply==='function'?reply(JSON.parse(body)):reply},finish_reason:finishReason}],usage:{total_tokens:20}}));});
    });
    s.listen(0,'127.0.0.1',()=>resolve(s));
  });
}

async function fixture(t,{env}={}){
  const directory=mkdtempSync(join(tmpdir(),'pac-chat-')),ownerToken=randomBytes(32).toString('hex');
  const restoreEnv={};
  for(const [k,v] of Object.entries(env||{})){restoreEnv[k]=process.env[k];process.env[k]=v;}
  const runtime=createDemo({directory,ownerToken,builder:createBuilder('process')});
  await new Promise(r=>runtime.server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+runtime.server.address().port;
  t.after(()=>{runtime.server.close();rmSync(directory,{recursive:true,force:true});for(const [k,v] of Object.entries(restoreEnv))v===undefined?delete process.env[k]:process.env[k]=v;});
  const call=async(path,body)=>{const res=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+ownerToken,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,data:await res.json()};};
  return {runtime,call};
}

test('CHAT-001 fails with a clear 501 when no LLM is configured', async t=>{
  const {call}=await fixture(t,{env:{PAC_LITELLM_URL:''}});
  const created=await call('/api/apps',{title:'Chat App',brief:'Exercises the chat endpoint.',template:'claims',accent:'teal'});
  const res=await call('/api/apps/'+created.data.id+'/chat',{mode:'chat',message:'What does this app do?'});
  assert.equal(res.status,501);
  assert.match(res.data.error,/PAC_LITELLM_URL/);
});

test('CHAT-002 rejects an invalid mode before ever calling the LLM', async t=>{
  const {call}=await fixture(t,{env:{PAC_LITELLM_URL:''}});
  const created=await call('/api/apps',{title:'Chat App',brief:'Exercises the chat endpoint.',template:'claims',accent:'teal'});
  const res=await call('/api/apps/'+created.data.id+'/chat',{mode:'delete-everything',message:'hi'});
  assert.equal(res.status,400);
  assert.match(res.data.error,/mode must be/);
});

test('CHAT-003 chat mode calls the real LLM and persists the exchange on the app, readable via view()', async t=>{
  const fake=await fakeLitellm('This app is a claims workbench for synthetic demo data.');
  t.after(()=>fake.close());
  const {call}=await fixture(t,{env:{PAC_LITELLM_URL:`http://127.0.0.1:${fake.address().port}`}});
  const created=await call('/api/apps',{title:'Chat App',brief:'Exercises the chat endpoint.',template:'claims',accent:'teal'});
  const res=await call('/api/apps/'+created.data.id+'/chat',{mode:'chat',message:'What does this app do?'});
  assert.equal(res.status,200);
  assert.equal(res.data.mode,'chat');
  assert.match(res.data.reply,/claims workbench/);
  const state=await call('/api/apps/'+created.data.id);
  assert.equal(state.data.chatLog.length,1);
  assert.equal(state.data.chatLog[0].message,'What does this app do?');
  assert.equal(state.data.chatLog[0].reply,res.data.reply);
  assert.equal(state.data.chatLog[0].mode,'chat');
});

test('CHAT-004 plan mode sends a different system prompt (asking for a plan, not an answer) and never calls generate() or touches config', async t=>{
  let capturedBody=null;
  const fake=await fakeLitellm(body=>{capturedBody=body;return 'Plan: add a dark-mode toggle to the header.';});
  t.after(()=>fake.close());
  const {call}=await fixture(t,{env:{PAC_LITELLM_URL:`http://127.0.0.1:${fake.address().port}`}});
  const created=await call('/api/apps',{title:'Plan App',brief:'Exercises plan mode.',template:'claims',accent:'teal'});
  const res=await call('/api/apps/'+created.data.id+'/chat',{mode:'plan',message:'Add a dark mode toggle.'});
  assert.equal(res.status,200);
  assert.match(res.data.reply,/dark-mode toggle/);
  assert.match(capturedBody.messages[0].content,/draft a short, concrete PLAN/);
  const state=await call('/api/apps/'+created.data.id);
  assert.equal(state.data.revision,1); // definition untouched -- planning never executes anything
  assert.equal(state.data.chatLog[0].mode,'plan');
});

test('CHAT-006 an empty reply truncated by the token budget (finish_reason "length") fails with a clear error instead of silently returning nothing -- found live against the real local model', async t=>{
  const fake=await fakeLitellm('','length');
  t.after(()=>fake.close());
  const {call}=await fixture(t,{env:{PAC_LITELLM_URL:`http://127.0.0.1:${fake.address().port}`}});
  const created=await call('/api/apps',{title:'Chat App',brief:'Exercises the truncation error path.',template:'claims',accent:'teal'});
  const res=await call('/api/apps/'+created.data.id+'/chat',{mode:'plan',message:'Add a dark mode toggle.'});
  assert.equal(res.status,502);
  assert.match(res.data.error,/ran out of budget/);
});

test('CHAT-005 message length/emptiness validation matches comment()\'s own rule (1-3000 chars)', async t=>{
  const {call}=await fixture(t,{env:{PAC_LITELLM_URL:''}});
  const created=await call('/api/apps',{title:'Chat App',brief:'Exercises the chat endpoint.',template:'claims',accent:'teal'});
  const empty=await call('/api/apps/'+created.data.id+'/chat',{mode:'chat',message:'   '});
  assert.equal(empty.status,400);
  const tooLong=await call('/api/apps/'+created.data.id+'/chat',{mode:'chat',message:'x'.repeat(3001)});
  assert.equal(tooLong.status,400);
});

test('CHAT-ALIAS chat and plan request LiteLLM capability aliases, never a vendor model name',async t=>{
  const seen=[];
  const llm=await fakeLitellm(b=>{seen.push(b.model);return 'ok';});
  t.after(()=>llm.close());
  const {call}=await fixture(t,{env:{PAC_LITELLM_URL:'http://127.0.0.1:'+llm.address().port}});
  const created=await call('/api/apps',{title:'Alias App',brief:'Exercises alias selection.',template:'claims',accent:'teal'});
  await call('/api/apps/'+created.data.id+'/chat',{mode:'chat',message:'hello'});
  await call('/api/apps/'+created.data.id+'/chat',{mode:'plan',message:'add a filter'});
  assert.deepEqual(seen,['chat','agent']);
});
