import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
const token=process.env.PAC_EXPORT_TOKEN;
if(!token||token.length<32)throw new Error('Set PAC_EXPORT_TOKEN to a new secret of at least 32 characters');
const same=x=>Buffer.byteLength(x)===Buffer.byteLength(token)&&timingSafeEqual(Buffer.from(x),Buffer.from(token));
const server=createServer((req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  if(req.method==='GET'&&req.url==='/health'){res.setHeader('Content-Type','application/json');return res.end('{"status":"ok"}');}
  const decoded=req.headers.authorization?.startsWith('Basic ')?Buffer.from(req.headers.authorization.slice(6),'base64').toString():'';
  const password=decoded.includes(':')?decoded.slice(decoded.indexOf(':')+1):'';
  if(!same(password)){res.writeHead(401,{'WWW-Authenticate':'Basic realm="Graduated application", charset="UTF-8"'});return res.end('Authentication required');}
  if(req.method!=='GET'||!['/','/data.json'].includes(req.url)){res.statusCode=404;return res.end('Not found');}
  res.setHeader('Content-Type',req.url==='/'?'text/html; charset=utf-8':'application/json');
  res.end(readFileSync(new URL(req.url==='/'?'./index.html':'./data.json',import.meta.url)));
});
server.listen(Number(process.env.PORT||8080),process.env.PAC_EXPORT_HOST||'127.0.0.1');
