import { randomUUID } from 'node:crypto';
import { graduationFiles } from './archive.js';
import { assuranceRecord } from './assurance.js';
import { sha } from './definition.js';

const REPO_SHAPE=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const fingerprint=app=>sha(JSON.stringify({release:app.release,assurance:assuranceRecord(app)}));
/** Two ways to reach GitHub, both ending at the same prepare/review/publish flow:
 *  - the platform's own token (PAC_GITHUB_TOKEN), restricted to an admin-configured allowlist
 *    (PAC_GITHUB_REPOSITORIES) -- the "shared repo for builders without their own account" mode.
 *  - a personal token supplied per-request, which may target ANY well-formed owner/repo: it is
 *    the caller's own credential authorizing their own destination, so the platform allowlist
 *    doesn't apply to it. This is what "personal" and "dedicated" repo modes use -- same
 *    mechanism, the only difference is which repo the user types in.
 * A personal token lives only in the in-memory plan for its 5-minute window; it is never
 * written to state.json or logged (see the audit call in server.js's github-publish route,
 * which records only the repository and commit, never a credential). */
export function createGithubPublisher({token=process.env.PAC_GITHUB_TOKEN,repositories=(process.env.PAC_GITHUB_REPOSITORIES||'').split(',').filter(Boolean),request=fetch}={}){
  const allowed=repositories.filter(r=>REPO_SHAPE.test(r));
  const plans=new Map();
  const api=async(useToken,path,method='GET',body)=>{
    const response=await request('https://api.github.com'+path,{method,headers:{Authorization:'Bearer '+useToken,Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('GitHub request failed ('+response.status+'). Check repository access and token permissions.');
    return response.json();
  };
  return {
    configuration:()=>({enabled:Boolean(token&&allowed.length),repositories:token?allowed:[],allowPersonal:true,mode:'New branch in an existing private repository; no default-branch changes'}),
    prepare(app,repository,personalToken){
      const useToken=personalToken||token;
      if(!useToken)throw new Error('No GitHub token available. Ask your admin to configure the shared repo, or supply your own token.');
      if(personalToken){
        if(!REPO_SHAPE.test(repository))throw new Error('repository must be in owner/repo form');
      }else if(!allowed.includes(repository))throw new Error('GitHub destination is not enabled by the platform administrator');
      if(!app.release)throw new Error('Publish internally before preparing GitHub publication');
      for(const [id,p] of plans)if(p.expires<Date.now())plans.delete(id);
      if(plans.size>=50)throw new Error('Too many pending publication previews');
      const files=graduationFiles(app,{includeData:false}),id=randomUUID(),branch='pac/'+app.id+'/v'+app.release.number+'-'+id.slice(0,8);
      const digest=sha(JSON.stringify({repository,branch,files}));
      const plan={id,artifactId:app.id,release:app.release.number,repository,branch,digest,files,token:useToken,expires:Date.now()+300000,fingerprint:fingerprint(app),state:'prepared'};plans.set(id,plan);
      return {id,repository,branch,digest,expires:plan.expires,files:Object.entries(files).map(([path,content])=>({path,content,sha256:sha(content),bytes:Buffer.byteLength(content)})),excludes:['Uploaded document contents','Discussion notes','Claims rows','Workspace sessions and credentials'],notice:'Assurance prose and application brief ARE included. Review every file before confirming.'};
    },
    async publish(app,{id,digest}){
      const plan=plans.get(id);
      if(!plan||plan.state!=='prepared'||plan.artifactId!==app.id||plan.digest!==digest||plan.expires<Date.now())throw new Error('Invalid, expired or already used publication preview');
      if(fingerprint(app)!==plan.fingerprint)throw new Error('Application or assurance data changed. Prepare and review a new preview.');
      plan.state='publishing';
      try{
        const path='/repos/'+plan.repository;const repo=await api(plan.token,path);
        if(repo.private!==true)throw new Error('The demo publishes only to private repositories');
        const tree=await api(plan.token,path+'/git/trees','POST',{tree:Object.entries(plan.files).map(([path,content])=>({path,content,mode:'100644',type:'blob'}))});
        const commit=await api(plan.token,path+'/git/commits','POST',{message:'Graduate PAC application release '+plan.release,tree:tree.sha,parents:[]});
        await api(plan.token,path+'/git/refs','POST',{ref:'refs/heads/'+plan.branch,sha:commit.sha});
        plan.state='published';return {repository:plan.repository,branch:plan.branch,commit:commit.sha,url:'https://github.com/'+plan.repository+'/tree/'+plan.branch,digest};
      }catch(error){plan.state='failed';throw error;}
      finally{plan.token=null;} // drop the credential from memory the moment it's no longer needed, win or lose
    }
  };
}
