import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
const base=process.env.PAC_MANAGER_URL||'http://127.0.0.1:3000';
const token=process.env.PAC_MANAGER_TOKEN||readFileSync(process.env.PAC_TOKEN_FILE||'.pac-demo/owner.token','utf8').trim();
for await(const line of createInterface({input:process.stdin})){
  let message;
  try{
    message=JSON.parse(line);
    const response=await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:line,signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('PAC Manager returned '+response.status);
    if(response.status!==202)process.stdout.write(JSON.stringify(await response.json())+'\n');
  }catch(error){if(message&&Object.hasOwn(message,'id'))process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:error.message}})+'\n');else process.stderr.write(error.message+'\n');}
}
