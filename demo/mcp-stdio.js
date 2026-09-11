import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
const base=process.env.PAC_MANAGER_URL||'http://127.0.0.1:3000';
const defaultTokenFile=new URL('../.pac-demo/owner.token',import.meta.url);
let token;
try{
  token=process.env.PAC_MANAGER_TOKEN||readFileSync(process.env.PAC_TOKEN_FILE||defaultTokenFile,'utf8').trim();
}catch(error){
  process.stderr.write(`PAC Manager MCP bridge: could not read the owner token (${error.message}). Set PAC_TOKEN_FILE to an absolute path, or PAC_MANAGER_TOKEN directly, or run "npm run demo" first so the token file exists.\n`);
  process.exit(1);
}
for await(const line of createInterface({input:process.stdin})){
  let message;
  try{
    message=JSON.parse(line);
    const response=await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:line,signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('PAC Manager returned '+response.status);
    if(response.status!==202)process.stdout.write(JSON.stringify(await response.json())+'\n');
  }catch(error){if(message&&Object.hasOwn(message,'id'))process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:error.message}})+'\n');else process.stderr.write(error.message+'\n');}
}
