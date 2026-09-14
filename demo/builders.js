import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';

export function dockerArgs(image, name) {
  return ['run','--rm','--name',name,'--pull=never','--network=none','--read-only','--cap-drop=ALL',
    '--security-opt=no-new-privileges','--user=10001:10001','--memory=128m','--memory-swap=128m',
    '--cpus=0.5','--pids-limit=32','--tmpfs=/tmp:rw,noexec,nosuid,size=8m','-i',image];
}
// PAC_BRAND_PACK/PAC_SERVICE_CATALOG are passed through despite this being the untrusted-build-
// worker environment allowlist: they are operator-installed local filesystem paths to non-secret
// config (logos, tokens, a service catalog), not app-authored input and not a credential -- the
// same reasoning adapter-host.js already documents for why *its* env isn't stripped. Without this,
// build-worker.js's own compile() re-validates the definition against a *different* brand pack
// than the one the app was created under (this process's own PAC_BRAND_PACK is legitimately
// absent from the child by default), so an accent key valid under a custom pack fails build every
// time. Found live: creating an app with accent:'brand' under the PR pack built successfully in
// the main process, then failed in the worker with "Choose one of: teal, blue, plum" -- the
// bundled default pack's keys, because the worker never saw PAC_BRAND_PACK at all.
// NOTE: this only fixes PAC_BUILD_MODE=process. Docker/Kubernetes build modes are still isolated
// from the brand pack by design (--network=none, no mounts) -- see docs/implementation-status.md.
function command(executable,args,input) {
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME,DOCKER_HOST:process.env.DOCKER_HOST,DOCKER_CONFIG:process.env.DOCKER_CONFIG,PAC_BRAND_PACK:process.env.PAC_BRAND_PACK,PAC_SERVICE_CATALOG:process.env.PAC_SERVICE_CATALOG}});
    let output='',error=''; const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Build timed out'));},30000);
    child.stdout.on('data',b=>{output+=b;if(output.length>1000000){child.kill();reject(new Error('Build output too large'));}});
    child.stderr.on('data',b=>{error=(error+b).slice(-4000);});
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.stdin.on('error',()=>{});
    child.on('close',code=>{clearTimeout(timer);if(code!==0)reject(new Error(error||'Build failed'));else{try{resolve(JSON.parse(output));}catch{reject(new Error('Invalid builder response'));}}});
    child.stdin.end(JSON.stringify(input));
  });
}
export function createBuilder(mode='docker') {
  if(mode==='process') return {mode:'process · no container isolation',build:config=>command(process.execPath,[fileURLToPath(new URL('./build-worker.js',import.meta.url))],config)};
  if(mode==='kubernetes') return kubeBuilder();
  if(mode!=='docker')throw new Error('PAC_BUILD_MODE must be docker, kubernetes or explicit process');
  return {mode:'Docker · network disabled',async build(config){
    const name='pac-build-'+randomUUID();
    try{return await command('docker',dockerArgs(process.env.PAC_BUILDER_IMAGE||'pac-builder:demo',name),config);}
    catch(e){throw new Error('Docker build failed. Run npm run demo:setup first. '+e.message);}
    finally {const clean=spawn('docker',['rm','-f',name],{stdio:'ignore'});clean.on('error',()=>{});}
  }};
}
export function jobSpec(name, namespace, image, config, runtimeClass) {
  return {apiVersion:'batch/v1',kind:'Job',metadata:{name,namespace},spec:{backoffLimit:0,activeDeadlineSeconds:45,ttlSecondsAfterFinished:120,template:{metadata:{labels:{'app.kubernetes.io/name':'pac-build'}},spec:{restartPolicy:'Never',automountServiceAccountToken:false,...(runtimeClass?{runtimeClassName:runtimeClass}:{}),securityContext:{runAsNonRoot:true,runAsUser:10001,seccompProfile:{type:'RuntimeDefault'}},containers:[{name:'build',image,imagePullPolicy:'IfNotPresent',env:[{name:'PAC_BUILD_INPUT',value:JSON.stringify(config)}],resources:{requests:{cpu:'100m',memory:'64Mi'},limits:{cpu:'500m',memory:'128Mi'}},securityContext:{allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:['ALL']}}}]}}}};
}
function kubeBuilder(){
  const root='/var/run/secrets/kubernetes.io/serviceaccount/';
  const namespace=process.env.PAC_BUILD_NAMESPACE||'pac-builds';
  const image=process.env.PAC_BUILDER_IMAGE;
  if(!image)throw new Error('PAC_BUILDER_IMAGE required for Kubernetes');
  const request=(method,path,body)=>new Promise((resolve,reject)=>{
    const req=https.request({hostname:process.env.KUBERNETES_SERVICE_HOST,port:process.env.KUBERNETES_SERVICE_PORT_HTTPS||443,path,method,ca:readFileSync(root+'ca.crt'),headers:{Authorization:'Bearer '+readFileSync(root+'token','utf8').trim(),'Content-Type':'application/json'},timeout:10000},res=>{
      let text='';res.on('data',b=>{text+=b;if(text.length>1000000)req.destroy(new Error('Cluster response too large'));});res.on('end',()=>{if(res.statusCode>=400)reject(new Error(`Kubernetes ${res.statusCode}: ${text.slice(0,300)}`));else resolve(text);});
    });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Cluster timeout')));req.end(body?JSON.stringify(body):undefined);
  });
  return {mode:'Kubernetes Job · namespace network policy',async build(config){
    const name='pac-build-'+randomUUID();const path=`/apis/batch/v1/namespaces/${namespace}/jobs`;
    await request('POST',path,jobSpec(name,namespace,image,config,process.env.PAC_RUNTIME_CLASS));
    try{
      for(let i=0;i<50;i++){
        const job=JSON.parse(await request('GET',path+'/'+name));
        if(job.status?.failed)throw new Error('Build job failed');
        if(job.status?.succeeded){
          const pods=JSON.parse(await request('GET',`/api/v1/namespaces/${namespace}/pods?labelSelector=job-name%3D${name}`));
          if(!pods.items?.[0])throw new Error('Build pod absent');
          return JSON.parse(await request('GET',`/api/v1/namespaces/${namespace}/pods/${pods.items[0].metadata.name}/log?container=build`));
        }
        await new Promise(r=>setTimeout(r,1000));
      }throw new Error('Build job timed out');
    }finally{await request('DELETE',path+'/'+name,{propagationPolicy:'Background'}).catch(()=>{});}
  }};
}
