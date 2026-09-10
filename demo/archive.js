import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { render,sha } from './definition.js';

export function tar(files){
  const chunks=[];
  for(const [name,content] of Object.entries(files)){
    if(!/^[a-zA-Z0-9_./-]+$/.test(name)||name.includes('..')||name.length>99)throw new Error('Unsafe export path');
    const data=Buffer.from(content),h=Buffer.alloc(512);h.write(name,0,100,'utf8');
    const oct=(n,offset,len)=>h.write(n.toString(8).padStart(len-1,'0')+'\0',offset,len,'ascii');
    oct(0o600,100,8);oct(0,108,8);oct(0,116,8);oct(data.length,124,12);oct(0,136,12);h.fill(32,148,156);h[156]=48;h.write('ustar\0',257,6);h.write('00',263,2);
    const checksum=h.reduce((a,b)=>a+b,0);h.write(checksum.toString(8).padStart(6,'0')+'\0 ',148,8,'ascii');
    chunks.push(h,data,Buffer.alloc((512-data.length%512)%512));
  }return gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]));
}
export function graduationBundle(app){
  if(!app.release)throw new Error('Publish before exporting');
  const payload={config:app.release.result.config,documents:app.documents,comments:app.comments,binding:app.binding,claims:app.claims};
  const files={
    'package.json':JSON.stringify({name:'pac-graduated-app',private:true,type:'module',scripts:{start:'node server.js'},engines:{node:'>=22'}},null,2),
    'server.js':readFileSync(new URL('./standalone.js',import.meta.url),'utf8'),
    'index.html':render(app.release.result.html,payload),
    'definition.json':JSON.stringify(app.release.result.config,null,2),
    'data.json':JSON.stringify(payload,null,2),
    'evidence.json':JSON.stringify({build:app.release.result.checks,sourceDigest:app.release.result.sourceDigest,htmlDigest:app.release.result.htmlDigest,mode:app.release.mode,release:app.release.number,publishedAt:app.release.publishedAt,exportedAt:new Date().toISOString(),limitations:['Snapshot export; team identities must be reprovisioned.','No production certification or signed build attestation.','PDF attachments are preserved without text extraction.']},null,2),
    'README.md':'# Graduated application\n\nA standalone read-only application snapshot with source, document bytes, comments, synthetic claims and build evidence. No PAC Manager dependency.\n\nRun with Node.js 22+: set PAC_EXPORT_TOKEN to a new random secret of at least 32 characters, then npm start. Open http://127.0.0.1:8080 and enter any username with that token as the Basic Auth password. /health is public and contains no data.\n\nThis export is a portable demonstration, not an automatically production-ready service. The bundled data includes uploaded content: control who receives it. Reprovision user identities, backups and live bindings before enterprise use. index.html is a readable snapshot, data.json preserves full document bytes. No source-platform credentials or invitation tokens are included.\n',
    'score.yaml':'apiVersion: score.dev/v1b1\nmetadata:\n  name: graduated-app\ncontainers:\n  app:\n    image: .\nservice:\n  ports:\n    web:\n      port: 8080\n      targetPort: 8080\n',
    'Dockerfile':'FROM node:22-alpine\nWORKDIR /app\nCOPY --chown=10001:10001 package.json server.js index.html data.json ./\nUSER 10001:10001\nENV PAC_EXPORT_HOST=0.0.0.0\nEXPOSE 8080\nCMD ["node","server.js"]\n'
  };
  for(const doc of app.documents) files['documents/'+doc.id+'.base64']=doc.base64;
  files['checksums.json']=JSON.stringify(Object.fromEntries(Object.entries(files).map(([p,c])=>[p,sha(c)])),null,2);
  return tar(files);
}
