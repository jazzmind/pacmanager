import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createBuilder,dockerArgs } from '../demo/builders.js';
const exec=promisify(execFile);
test('DEMO-002 actual Docker worker builds with restricted OS configuration',{skip:process.env.PAC_TEST_DOCKER!=='1',timeout:60000},async()=>{
  const result=await createBuilder('docker').build({title:'Docker demo',brief:'Verify a real isolated worker.',template:'claims',accent:'teal'});assert.match(result.html,/Docker demo/);
  const args=dockerArgs(process.env.PAC_BUILDER_IMAGE||'pac-builder:demo','pac-probe-'+randomUUID());const image=args.pop();args.push('--entrypoint=node',image,'--input-type=module','-e',`import {networkInterfaces} from 'node:os';import{writeFileSync}from'node:fs';let readOnly=false;try{writeFileSync('/worker/probe','x')}catch(e){readOnly=['EROFS','EACCES'].includes(e.code)}console.log(JSON.stringify({uid:process.getuid(),readOnly,interfaces:networkInterfaces()}));`);
  const {stdout}=await exec('docker',args,{timeout:30000});const probe=JSON.parse(stdout);assert.equal(probe.uid,10001);assert.equal(probe.readOnly,true);assert.ok(Object.values(probe.interfaces).flat().every(i=>i.internal));
});
