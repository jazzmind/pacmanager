import { mkdirSync,readFileSync,writeFileSync,renameSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID,randomBytes } from 'node:crypto';
import { definition,sha,compile } from './definition.js';

export class DemoError extends Error {constructor(status,message){super(message);this.status=status;}}
const fail=(status,message)=>{throw new DemoError(status,message);};
const now=()=>new Date().toISOString();
const id=()=>randomUUID();
export class Store {
  constructor(directory,builder){
    mkdirSync(directory,{recursive:true,mode:0o700});this.file=join(directory,'state.json');this.builder=builder;
    this.state=existsSync(this.file)?JSON.parse(readFileSync(this.file,'utf8')):{version:1,apps:[],sessions:[],invites:[]};
    for(const app of this.state.apps)if(app.build?.status==='building'){app.build.status='failed';app.build.logs.push({at:now(),text:'Server restarted during build. Retry the build.'});}
    this.save();this.running=0;
  }
  save(){writeFileSync(this.file+'.tmp',JSON.stringify(this.state),{mode:0o600});renameSync(this.file+'.tmp',this.file);}
  tokenSession(principal){
    this.state.sessions=this.state.sessions.filter(s=>s.expires>Date.now());
    if(this.state.sessions.length>=200)fail(429,'Session limit reached');
    const token=randomBytes(32).toString('hex');this.state.sessions.push({hash:sha(token),...principal,expires:Date.now()+86400000});this.save();return token;
  }
  session(token){return this.state.sessions.find(s=>s.hash===sha(token||'')&&s.expires>Date.now());}
  access(principal,appId,owner=false){
    const app=this.state.apps.find(a=>a.id===appId);
    if(!app || !principal || (principal.kind!=='owner'&&principal.appId!==app.id))fail(404,'Application not found');
    if(owner&&principal.kind!=='owner')fail(403,'Only the owner can do this');
    return app;
  }
  list(p){return this.state.apps.filter(a=>p.kind==='owner'||a.id===p.appId).map(a=>({id:a.id,config:a.config,revision:a.revision,build:a.build?{status:a.build.status}:null,published:Boolean(a.release),documents:a.documents.length}));}
  create(p,config){
    if(p.kind!=='owner')fail(403,'Owner access required');
    if(this.state.apps.length>=30)fail(429,'Demo supports up to 30 applications');
    const app={id:id(),config:definition(config),revision:1,createdAt:now(),documents:[],comments:[],binding:false,claims:[],build:null,release:null,audit:[]};
    this.state.apps.push(app);this.audit(app,'created',p);this.save();return app;
  }
  audit(app,event,p){app.audit.push({at:now(),event,actor:p.label});app.audit=app.audit.slice(-200);}
  update(p,appId,config,revision){
    const app=this.access(p,appId,true);if(revision!==app.revision)fail(409,'Draft changed. Reload before saving.');
    app.config=definition(config);app.revision++;this.audit(app,'draft updated',p);this.save();return app;
  }
  startBuild(p,appId){
    const app=this.access(p,appId,true);if(app.build?.status==='building')fail(409,'Build already running');
    if(this.running>=2)fail(429,'Two builds are already running');
    const config=structuredClone(app.config),revision=app.revision,job=id();this.running++;
    app.build={id:job,status:'building',revision,mode:this.builder.mode,logs:[{at:now(),text:'Validated application definition.'},{at:now(),text:'Starting '+this.builder.mode}],result:null};this.save();
    this.lastBuild=Promise.resolve().then(()=>this.builder.build(config)).then(result=>{
      const expected=compile(config);
      if(result.htmlDigest!==expected.htmlDigest||result.html!==expected.html||result.sourceDigest!==expected.sourceDigest)throw new Error('Builder output failed independent verification');
      app.build.result=expected;app.build.status='ready';app.build.logs.push({at:now(),text:'Controller verified builder output against the definition.'},{at:now(),text:'Preview ready. Build '+result.sourceDigest.slice(0,12)});
    }).catch(error=>{app.build.status='failed';app.build.logs.push({at:now(),text:error.message.slice(0,1000)});}).finally(()=>{this.running--;this.save();});
    return {id:job,status:'building'};
  }
  upload(p,appId,input){
    const app=this.access(p,appId);
    if(typeof input.name!=='string'||input.name.length>120||!/^.+\.(txt|md|pdf)$/i.test(input.name)||/[\x00-\x1f/\\]/.test(input.name))fail(400,'Upload a .txt, .md or .pdf file with a plain filename');
    if(typeof input.base64!=='string'||input.base64.length>360000||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64))fail(400,'Invalid file content');
    const bytes=Buffer.from(input.base64,'base64');if(bytes.length>256000||bytes.length===0)fail(413,'Files must be 1–256 KB');
    if(app.documents.length>=20)fail(429,'20-document demo limit reached');
    if(/\.pdf$/i.test(input.name)&&bytes.subarray(0,5).toString()!=='%PDF-')fail(400,'Invalid PDF header');
    const doc={id:id(),name:input.name,size:bytes.length,base64:bytes.toString('base64'),text:/\.(txt|md)$/i.test(input.name)?bytes.toString('utf8'):'',author:p.label,createdAt:now(),sha256:sha(bytes)};
    app.documents.push(doc);this.audit(app,'document uploaded',p);this.save();return {id:doc.id,name:doc.name};
  }
  comment(p,appId,text){const app=this.access(p,appId);if(typeof text!=='string'||!text.trim()||text.length>3000)fail(400,'Note must be 1–3000 characters');if(app.comments.length>=500)fail(429,'Comment limit reached');app.comments.push({id:id(),text:text.trim(),author:p.label,createdAt:now()});this.save();}
  bind(p,appId){const app=this.access(p,appId,true);app.binding=true;app.claims=JSON.parse(readFileSync(new URL('./mock-claims.json',import.meta.url)));this.audit(app,'mock claims binding granted',p);this.save();}
  publish(p,appId){const app=this.access(p,appId,true);if(app.build?.status!=='ready'||app.build.revision!==app.revision)fail(409,'Build the current draft before publishing');const previous=app.release?.result.config;app.release={number:(app.release?.number||0)+1,publishedAt:now(),revision:app.revision,mode:app.build.mode,result:structuredClone(app.build.result)};app.releaseHistory=[...(app.releaseHistory||[]),{release:app.release.number,definitionRevision:app.revision,at:app.release.publishedAt,sourceDigest:app.release.result.sourceDigest,changedFields:Object.keys(app.config).filter(k=>!previous||previous[k]!==app.config[k]),actor:p.label}].slice(-50);this.audit(app,'published release '+app.release.number,p);this.save();return app.release;}
  invite(p,appId,label){const app=this.access(p,appId,true);if(typeof label!=='string'||label.trim().length<2||label.length>50)fail(400,'Enter a colleague’s display name');this.state.invites=this.state.invites.filter(i=>!i.used&&i.expires>Date.now());if(this.state.invites.length>=100)fail(429,'Invite limit reached');const token=randomBytes(32).toString('hex');this.state.invites.push({hash:sha(token),appId,label:label.trim(),expires:Date.now()+3600000,used:false});this.audit(app,'collaborator invitation created',p);this.save();return token;}
  accept(token){const i=this.state.invites.find(i=>i.hash===sha(token||'')&&!i.used&&i.expires>Date.now());if(!i)fail(401,'Invalid or expired access token');const session=this.tokenSession({kind:'collaborator',appId:i.appId,label:i.label});i.used=true;this.save();return session;}
  view(p,appId){const app=this.access(p,appId);return {...app,documents:app.documents.map(({base64,...doc})=>doc),build:app.build?{...app.build,result:app.build.result?{sourceDigest:app.build.result.sourceDigest,checks:app.build.result.checks}:null}:null,release:app.release?{number:app.release.number,publishedAt:app.release.publishedAt,revision:app.release.revision}:null};}
}
