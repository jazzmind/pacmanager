import { randomUUID } from 'node:crypto';
import { graduationFiles } from './archive.js';
import { assuranceRecord } from './assurance.js';
import { sha } from './definition.js';

export const fingerprint=app=>sha(JSON.stringify({release:app.release,assurance:assuranceRecord(app)}));
export function createGithubPublisher({token=process.env.PAC_GITHUB_TOKEN,repositories=(process.env.PAC_GITHUB_REPOSITORIES||'').split(',').filter(Boolean),request=fetch}={}){
  const allowed=repositories.filter(r=>/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r));
  const plans=new Map();
  const api=async(path,method='GET',body)=>{
    const response=await request('https://api.github.com'+path,{method,headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('GitHub request failed ('+response.status+'). Check repository access and token permissions.');
    return response.json();
  };
  return {
    configuration:()=>({enabled:Boolean(token&&allowed.length),repositories:token?allowed:[],mode:'New branch in an existing private repository; no default-branch changes'}),
    prepare(app,repository){
      if(!token||!allowed.includes(repository))throw new Error('GitHub destination is not enabled by the platform administrator');
      if(!app.release)throw new Error('Publish internally before preparing GitHub publication');
      for(const [id,p] of plans)if(p.expires<Date.now())plans.delete(id);
      if(plans.size>=50)throw new Error('Too many pending publication previews');
      const files=graduationFiles(app,{includeData:false}),id=randomUUID(),branch='pac/'+app.id+'/v'+app.release.number+'-'+id.slice(0,8);
      const digest=sha(JSON.stringify({repository,branch,files}));
      const plan={id,artifactId:app.id,release:app.release.number,repository,branch,digest,files,expires:Date.now()+300000,fingerprint:fingerprint(app),state:'prepared'};plans.set(id,plan);
      return {id,repository,branch,digest,expires:plan.expires,files:Object.entries(files).map(([path,content])=>({path,content,sha256:sha(content),bytes:Buffer.byteLength(content)})),excludes:['Uploaded document contents','Discussion notes','Claims rows','Workspace sessions and credentials'],notice:'Assurance prose and application brief ARE included. Review every file before confirming.'};
    },
    async publish(app,{id,digest}){
      const plan=plans.get(id);
      if(!plan||plan.state!=='prepared'||plan.artifactId!==app.id||plan.digest!==digest||plan.expires<Date.now())throw new Error('Invalid, expired or already used publication preview');
      if(fingerprint(app)!==plan.fingerprint)throw new Error('Application or assurance data changed. Prepare and review a new preview.');
      plan.state='publishing';
      try{
        const path='/repos/'+plan.repository;const repo=await api(path);
        if(repo.private!==true)throw new Error('The demo publishes only to private repositories');
        const tree=await api(path+'/git/trees','POST',{tree:Object.entries(plan.files).map(([path,content])=>({path,content,mode:'100644',type:'blob'}))});
        const commit=await api(path+'/git/commits','POST',{message:'Graduate PAC application release '+plan.release,tree:tree.sha,parents:[]});
        await api(path+'/git/refs','POST',{ref:'refs/heads/'+plan.branch,sha:commit.sha});
        plan.state='published';return {repository:plan.repository,branch:plan.branch,commit:commit.sha,url:'https://github.com/'+plan.repository+'/tree/'+plan.branch,digest};
      }catch(error){plan.state='failed';throw error;}
    }
  };
}
