import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createDemo } from '../demo/server.js';
import { createBuilder } from '../demo/builders.js';

test('CAPSTATIC-001 GET /capabilities.js serves demo/capabilities.js verbatim, publicly, as a JS module', async t => {
  const directory=mkdtempSync(join(tmpdir(),'pac-capjs-')),ownerToken=randomBytes(32).toString('hex');
  const runtime=createDemo({directory,ownerToken,builder:createBuilder('process')});
  await new Promise(r=>runtime.server.listen(0,'127.0.0.1',r));
  t.after(()=>{runtime.server.close();rmSync(directory,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+runtime.server.address().port;
  const res=await fetch(base+'/capabilities.js'); // no auth header -- must be public, same as index.html itself
  assert.equal(res.status,200);
  assert.equal(res.headers.get('content-type'),'text/javascript');
  const served=await res.text();
  assert.equal(served,readFileSync(new URL('../demo/capabilities.js',import.meta.url),'utf8'));
});

test('CAPSTATIC-002 demo/capabilities.js has no Node-specific imports -- it must be safe to hand a browser as-is', () => {
  const source=readFileSync(new URL('../demo/capabilities.js',import.meta.url),'utf8');
  assert.ok(!/from\s+['"]node:/.test(source));
  assert.ok(!/require\(/.test(source));
});
