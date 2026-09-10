import http from 'node:http';
import { readFileSync,mkdirSync,existsSync,writeFileSync } from 'node:fs';
import { randomBytes,timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store,DemoError } from './store.js';
import { createBuilder } from './builders.js';
import { render } from './definition.js';
import { graduationBundle } from './archive.js';
import { assuranceSchema,assuranceRecord,completeness,saveAssurance,reportHtml,reportMarkdown,authoringGuide } from './assurance.js';
import { createGithubPublisher } from './github-publisher.js';

const equal=(a,b)=>typeof a==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const toolsList=[
  ['list_applications','List your applications',{}],
  ['create_application','Create a bounded claims or knowledge application',{title:{type:'string'},brief:{type:'string'},template:{enum:['claims','knowledge']},accent:{enum:['teal','blue','plum']}}],
  ['inspect_application','Read draft, build logs, documents and comments',{id:{type:'string'}}],
  ['update_application','Update the definition; revision prevents overwriting another edit',{id:{type:'string'},revision:{type:'integer'},title:{type:'string'},brief:{type:'string'},template:{enum:['claims','knowledge']},accent:{enum:['teal','blue','plum']}}],
  ['build_application','Start a real build, then inspect its status',{id:{type:'string'}}],
  ['bind_mock_claims','Grant access to synthetic claims; no live service',{id:{type:'string'}}],
  ['publish_application','Publish the current successfully built draft internally',{id:{type:'string'}}],
  ['graduation_link','Get the authenticated download URL for a published snapshot',{id:{type:'string'}}],
  ['get_assurance','Read generated architecture, readiness, BOM data and gaps. Managed facts refresh with every published change.',{id:{type:'string'}}],
  ['get_assurance_schema','Get the structured dossier schema and authoring guidance',{}],
  ['update_assurance','Save owner-supplied decisions and evidence with revision and release checks. Managed fields regenerate automatically.',{id:{type:'string'},revision:{type:'integer'},release:{type:['integer','null']},data:assuranceSchema}],
  ['preview_assurance_document','Generate a report from current release data',{id:{type:'string'},kind:{enum:['arb','readiness','bom']}}]
].map(([name,description,properties])=>({name,description,inputSchema:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}}));

export function createDemo({directory,ownerToken,builder,origin='http://127.0.0.1:3000',github=createGithubPublisher()}){
  if(!ownerToken||ownerToken.length<32)throw new Error('Owner token must be at least 32 characters');
  const store=new Store(directory,builder);
  const server=http.createServer(async(req,res)=>{
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    const cookie=token=>res.setHeader('Set-Cookie',`pac_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${origin.startsWith('https:')?'; Secure':''}`);
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
    try{
      if(req.headers.origin&&req.headers.origin!==origin)throw new DemoError(403,'Origin denied');
      const url=new URL(req.url,origin),path=url.pathname;
      if(req.method==='GET'&&path==='/health')return json(200,{ok:true});
      if(req.method==='GET'&&['/','/ui.js','/graduation-ui.js','/style.css'].includes(path)){
        const file=path==='/'?'index.html':path.slice(1);res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript');return res.end(readFileSync(new URL('./web/'+file,import.meta.url)));
      }
      let body={};
      if(req.method==='POST'){
        if(!req.headers['content-type']?.startsWith('application/json'))throw new DemoError(415,'JSON required');
        const parts=[];let size=0;for await(const part of req){size+=part.length;if(size>400000)throw new DemoError(413,'Request too large');parts.push(part);}
        try{body=JSON.parse(Buffer.concat(parts).toString());}catch{throw new DemoError(400,'Invalid JSON');}
        if(!body||typeof body!=='object'||Array.isArray(body))throw new DemoError(400,'JSON object required');
      }
      if(req.method==='POST'&&path==='/api/session'){
        const token=equal(body.token,ownerToken)?store.tokenSession({kind:'owner',label:'Workspace owner'}):store.accept(body.token);
        cookie(token);return json(200,{ok:true});
      }
      const bearer=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      const sessionToken=bearer||req.headers.cookie?.split('; ').find(c=>c.startsWith('pac_session='))?.slice(12);
      const principal=equal(bearer,ownerToken)?{kind:'owner',label:'Connected author'}:store.session(sessionToken);
      if(!principal)throw new DemoError(401,'Sign in to the workspace');
      if(path==='/mcp'){
        if(req.method!=='POST'){res.setHeader('Allow','POST');return json(405,{error:'Use POST'});}
        if(!Object.hasOwn(body,'id')){res.writeHead(202);return res.end();}
        let result;
        try{
          if(body.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{},prompts:{},resources:{}},serverInfo:{name:'pacmanager-demo',version:'0.3.0'}};
          else if(body.method==='ping')result={};
          else if(body.method==='prompts/list')result={prompts:[{name:'prepare_graduation',description:'Generate and maintain architecture review, systems readiness and BOM records',arguments:[{name:'artifactId',description:'Application ID',required:true}]},{name:'evolve_application',description:'Change an application, rebuild, publish and verify updated documentation',arguments:[{name:'artifactId',description:'Application ID',required:true},{name:'change',description:'Requested change',required:true}]}]};
          else if(body.method==='prompts/get'){
            const {name,arguments:a={}}=body.params||{};store.access(principal,a.artifactId,true);
            if(!['prepare_graduation','evolve_application'].includes(name))throw new Error('Unknown prompt');
            if(name==='evolve_application'&&(typeof a.change!=='string'||!a.change.trim()))throw new Error('A change is required');
            result={messages:[{role:'user',content:{type:'text',text:authoringGuide+'\nArtifact ID: '+a.artifactId+(name==='evolve_application'?'\nUser requested change: '+a.change+'\nInspect the current app and assurance data. Use update_application with the current revision for supported changes (title, brief, claims/knowledge template, accent). Build and poll inspect_application until successful; publish only after the current build succeeds. Then get_assurance and preview all three reports. Verify release/source digest changed and generated sections reflect the new definition. Preserve owner-supplied records, identify stale decisions for re-review, and describe unsupported changes honestly. Never pretend a brief edit implements an unsupported behavior.':'')}}]};
          }
          else if(body.method==='resources/list')result={resources:[{uri:'pac://assurance/schema',name:'Assurance schema',mimeType:'application/json'},{uri:'pac://assurance/guide',name:'Graduation authoring guidance',mimeType:'text/plain'}]};
          else if(body.method==='resources/read'){
            const uri=body.params?.uri;if(!['pac://assurance/schema','pac://assurance/guide'].includes(uri))throw new Error('Unknown resource');
            result={contents:[{uri,mimeType:uri.endsWith('schema')?'application/json':'text/plain',text:uri.endsWith('schema')?JSON.stringify(assuranceSchema):authoringGuide}]};
          }
          else if(body.method==='tools/list')result={tools:toolsList};
          else if(body.method==='tools/call'){
            const {name,arguments:a={}}=body.params||{};let output;
            switch(name){
              case 'list_applications':output=store.list(principal);break;
              case 'create_application':output=store.create(principal,a);break;
              case 'inspect_application':output=store.view(principal,a.id);break;
              case 'update_application':{const {id,revision,...config}=a;output=store.update(principal,id,config,revision);break;}
              case 'build_application':output=store.startBuild(principal,a.id);break;
              case 'bind_mock_claims':store.bind(principal,a.id);output={bound:'claims.mock',live:false};break;
              case 'publish_application':store.publish(principal,a.id);output={url:origin+'/?app='+a.id+'&published=1'};break;
              case 'graduation_link':store.access(principal,a.id,true);output={url:origin+'/api/apps/'+a.id+'/export',authentication:'Workspace browser session required'};break;
              case 'get_assurance':{const record=assuranceRecord(store.access(principal,a.id));output={record,completeness:completeness(record)};break;}
              case 'get_assurance_schema':output={schema:assuranceSchema,guide:authoringGuide};break;
              case 'update_assurance':output=saveAssurance(store,principal,a.id,a);break;
              case 'preview_assurance_document':{const record=assuranceRecord(store.access(principal,a.id));output={markdown:reportMarkdown(record,a.kind),preview:origin+'/api/apps/'+a.id+'/reports/'+a.kind,release:record.release,sourceDigest:record.sourceDigest};break;}
              default:throw new DemoError(400,'Unknown tool');
            }
            result={content:[{type:'text',text:JSON.stringify(output)}]};
          }else return json(200,{jsonrpc:'2.0',id:body.id,error:{code:-32601,message:'Method not found'}});
        }catch(error){if(body.method!=='tools/call')return json(200,{jsonrpc:'2.0',id:body.id,error:{code:-32602,message:error.message}});result={isError:true,content:[{type:'text',text:error.message}]};}
        return json(200,{jsonrpc:'2.0',id:body.id,result});
      }
      if(path==='/api/me'&&req.method==='GET')return json(200,{kind:principal.kind,label:principal.label,mode:builder.mode});
      const report=path.match(/^\/api\/apps\/([a-f0-9-]+)\/reports\/(arb|readiness|bom)$/);
      if(report&&req.method==='GET'){
        const record=assuranceRecord(store.access(principal,report[1])),kind=report[2],format=url.searchParams.get('format')||'html';
        if(!['html','md','json'].includes(format))throw new DemoError(400,'Choose html, md or json');
        const content=format==='json'?JSON.stringify(record,null,2):format==='md'?reportMarkdown(record,kind):reportHtml(record,kind);
        res.setHeader('Content-Type',format==='html'?'text/html; charset=utf-8':format==='md'?'text/markdown; charset=utf-8':'application/json');
        res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
        if(url.searchParams.get('download')==='1')res.setHeader('Content-Disposition',`attachment; filename="${kind}.${format}"`);
        return res.end(content);
      }
      const assurancePath=path.match(/^\/api\/apps\/([a-f0-9-]+)\/(assurance|github-config|github-prepare|github-publish)$/);
      if(assurancePath){
        const [,id,action]=assurancePath,app=store.access(principal,id,action!=='assurance'||req.method!=='GET');
        if(action==='assurance'&&req.method==='GET'){const record=assuranceRecord(app);return json(200,{record,completeness:completeness(record)});}
        if(action==='assurance'&&req.method==='POST')return json(200,saveAssurance(store,principal,id,body));
        if(action==='github-config'&&req.method==='GET')return json(200,github.configuration());
        if(action.startsWith('github-')&&req.method==='POST'){
          if(bearer||principal.kind!=='owner')throw new DemoError(403,'Use the owner browser session to review and publish code');
          if(action==='github-prepare')return json(200,github.prepare(app,body.repository));
          if(action==='github-publish'){
            const result=await github.publish(app,body);store.audit(app,'code published to '+result.repository+' at '+result.commit,principal);store.save();return json(200,result);
          }
        }
        throw new DemoError(405,'Method not allowed');
      }
      if(path==='/api/logout'&&req.method==='POST'){store.state.sessions=store.state.sessions.filter(s=>s!==principal);store.save();cookie('');return json(200,{ok:true});}
      if(path==='/api/apps'){
        if(req.method==='GET')return json(200,store.list(principal));
        if(req.method==='POST')return json(201,store.view(principal,store.create(principal,body).id));
      }
      const match=path.match(/^\/api\/apps\/([a-f0-9-]+)(?:\/(preview|definition|build|documents|comments|binding|publish|invite|export))?$/);
      if(!match)throw new DemoError(404,'Not found');
      const [,id,action]=match,app=store.access(principal,id);
      if(req.method==='GET'){
        if(!action)return json(200,store.view(principal,id));
        if(action==='preview'){
          const result=url.searchParams.get('published')==='1'?app.release?.result:app.build?.status==='ready'?app.build.result:null;
          if(!result)throw new DemoError(409,'Build or publish this application first');
          res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");return res.end(render(result.html,app));
        }
        if(action==='export'){store.access(principal,id,true);if(!app.release)throw new DemoError(409,'Publish first');res.setHeader('Content-Type','application/gzip');res.setHeader('Content-Disposition','attachment; filename="pac-graduation.tar.gz"');return res.end(graduationBundle(app));}
      }
      if(req.method!=='POST')throw new DemoError(405,'Method not allowed');
      switch(action){
        case 'definition':store.update(principal,id,body.config,body.revision);break;
        case 'build':return json(202,store.startBuild(principal,id));
        case 'documents':store.upload(principal,id,body);break;
        case 'comments':store.comment(principal,id,body.text);break;
        case 'binding':store.bind(principal,id);break;
        case 'publish':store.publish(principal,id);break;
        case 'invite':return json(201,{url:origin+'/?app='+id+'#invite='+store.invite(principal,id,body.label)});
        default:throw new DemoError(404,'Not found');
      }
      return json(200,store.view(principal,id));
    }catch(error){json(error.status||400,{error:error.message});}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return {server,store};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const directory=resolve(process.env.PAC_DATA_DIR||'.pac-demo');mkdirSync(directory,{recursive:true,mode:0o700});
  const tokenFile=resolve(directory,'owner.token');
  if(!process.env.PAC_OWNER_TOKEN&&!existsSync(tokenFile))writeFileSync(tokenFile,randomBytes(32).toString('hex'),{mode:0o600});
  const ownerToken=process.env.PAC_OWNER_TOKEN||readFileSync(tokenFile,'utf8').trim();
  const port=Number(process.env.PORT||3000),origin=process.env.PAC_PUBLIC_ORIGIN||`http://127.0.0.1:${port}`;
  const {server}=createDemo({directory,ownerToken,builder:createBuilder(process.env.PAC_BUILD_MODE||'docker'),origin});
  server.listen(port,process.env.HOST||'127.0.0.1',()=>console.log(`PAC Manager: ${origin}\nOwner token file: ${tokenFile}\nBuild mode: ${process.env.PAC_BUILD_MODE||'docker'}`));
}
