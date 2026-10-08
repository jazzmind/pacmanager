import http from 'node:http';
import { readFileSync,mkdirSync,existsSync,writeFileSync } from 'node:fs';
import { randomBytes,timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store,DemoError } from './store.js';
import { createBuilder } from './builders.js';
import { render,injectBriefings,escape,KINDS,REPO_MODES } from './definition.js';
import { graduationBundle } from './archive.js';
import { assuranceSchema,assuranceRecord,completeness,saveAssurance,reportHtml,reportMarkdown,authoringGuide } from './assurance.js';
import { createGithubPublisher } from './github-publisher.js';
import { createRuntimeAdapter } from './runtime-adapter.js';
import { createGraduationAdapters } from './graduation-adapter.js';
import { createAuthoringAdapter } from './authoring-adapter.js';
import { createOrchestrationAdapter } from './orchestration-adapter.js';
import { createAgentAdapter } from './agent-adapter.js';
import { loadBrand } from './brand.js';
import { principalFromProxyHeaders } from './proxy-auth.js';
import { adminOverview,adminServices,adminLlmTest,adminOrchestrationTest,adminAgentTest } from './admin.js';
import { appChat,appChatStream } from './chat.js';
import { draftApplication } from './draft.js';

const equal=(a,b)=>typeof a==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const brand=loadBrand();
// Exact request path -> file under demo/web/. The ONLY way a /web file is reachable: no prefix matching, so nothing here can be traversed out of.
const STATIC_FILES=Object.freeze({'/':'index.html','/ui.js':'ui.js','/graduation-ui.js':'graduation-ui.js','/style.css':'style.css','/admin.html':'admin.html','/admin.js':'admin.js','/art.js':'art.js',
  '/vendor/marked.min.js':'vendor/marked.min.js','/vendor/purify.min.js':'vendor/purify.min.js','/vendor/LICENSE-marked.txt':'vendor/LICENSE-marked.txt','/vendor/LICENSE-purify.txt':'vendor/LICENSE-purify.txt'});
// `kind` and `template` are dual-accept (see definition.js): a caller supplies exactly one.
// `kind` picks a real artifact type -- interactive/knowledge/application, or "auto" to let the
// model decide -- and pairs with tier "intent" (no source yet; generate_application produces
// it). `template` is the legacy claims/knowledge layout, unrelated to generation.
const definitionProps={title:{type:'string'},brief:{type:'string'},template:{enum:['claims','knowledge']},kind:{enum:KINDS},accent:{enum:Object.keys(brand.accentPalette())},tier:{enum:['template','static','app','intent']},source:{type:'object',additionalProperties:{type:'string'},description:'Only for tier "static": file path -> text content. Must include index.html. Allowed extensions: .html .css .js .json .svg. This is how real generated code (e.g. a game) is authored — tier "template" (the default) only ever produces the bounded claims/knowledge layout.'},sourcePath:{type:'string',description:'Only for tier "app": path to a real, existing directory on disk containing a Dockerfile. Not embedded source — pacmanager attests its digest, it does not copy it.'},
  repo:{type:'object',additionalProperties:false,properties:{mode:{enum:REPO_MODES},url:{type:'string'},branch:{type:'string'},path:{type:'string'}},required:['mode','url'],description:'Optional: which GitHub repo this artifact\'s source lives in. mode "shared" = a common repo for builders without their own GitHub account (path scopes it to a subdirectory); "personal" = one repo for everything you own (path scopes it too); "dedicated" = this artifact owns the repo root. Metadata only in this pass — pacmanager does not yet read from or write to the repo on your behalf.'}};
const toolsList=[
  ['list_applications','List your applications',{},[]],
  ['create_application','Create an application. Either omit tier (or pass "template") for the bounded claims/knowledge layout, or pass an artifact kind — interactive, knowledge, application, or auto to let the model choose — with tier "intent" and no source; call generate_application afterwards to actually author it. Pass tier "static" with a source file map yourself only if you are hand-authoring code rather than generating it.',definitionProps,['title','brief','accent']],
  ['inspect_application','Read draft, build logs, generation status, documents and comments',{id:{type:'string'}},['id']],
  ['update_application','Update the definition; revision prevents overwriting another edit. Include tier and source to change or keep generated code — omitting them resets the app to the bounded template tier.',{id:{type:'string'},revision:{type:'integer'},...definitionProps},['id','revision','title','brief','accent']],
  ['generate_application','Generate or revise real source for a "kind"-based application using the configured authoring adapter — an actual model call, not a template. If the artifact is tier "intent" (nothing generated yet), this generates from scratch and changeRequest is ignored. If it already has source, changeRequest is REQUIRED and describes the specific change to make — the model is given the current source and asked to revise it, not rewrite it from the brief. To start over from nothing instead, reset tier to "intent" first (a separate, explicit, destructive step). Fails clearly (501) if no adapter is configured; validates and repairs its own output against the same safety gate a hand-authored source map must pass, up to a few attempts, before failing. Poll inspect_application for progress and the result.',{id:{type:'string'},changeRequest:{type:'string'}},['id']],
  ['cancel_generation','Stop a running generation: the authoring call is aborted, nothing is written to the application, and the slot is freed. Fails (409) if nothing is generating.',{id:{type:'string'}},['id']],
  ['rollback_application','Roll an application back to a previously published release. Publishes a NEW release with the old release\'s exact content — release numbers stay monotonic, nothing is rewritten. Only releases still within the retention window (see inspect_application\'s releases list) can be targeted.',{id:{type:'string'},release:{type:'integer'}},['id','release']],
  ['build_application','Start a real build, then inspect its status',{id:{type:'string'}},['id']],
  ['bind_mock_claims','Grant access to synthetic claims; no live service',{id:{type:'string'}},['id']],
  ['publish_application','Publish the current successfully built draft internally',{id:{type:'string'}},['id']],
  ['graduation_link','Get the authenticated download URL for a published snapshot',{id:{type:'string'}},['id']],
  ['get_assurance','Read generated architecture, readiness, BOM data and gaps. Managed facts refresh with every published change.',{id:{type:'string'}},['id']],
  ['get_assurance_schema','Get the structured dossier schema and authoring guidance',{},[]],
  ['update_assurance','Save owner-supplied decisions and evidence with revision and release checks. Managed fields regenerate automatically.',{id:{type:'string'},revision:{type:'integer'},release:{type:['integer','null']},data:assuranceSchema},['id','revision','release','data']],
  ['preview_assurance_document','Generate a report from current release data',{id:{type:'string'},kind:{enum:['arb','readiness','bom']}},['id','kind']],
  ['record_agent_run','Record a completed agent run (for example a news briefing) so a generated app can display it. The agent — typically Claude itself, driven by an agent pack such as PACOS news-briefing — does the actual research and writing; this only stores the typed, evidence-carrying result. Only imitate a named person\'s writing style when their own writing samples were supplied as evidence; otherwise use a neutral voice, and always set label to disclose that.',{id:{type:'string'},agentId:{type:'string'},topic:{type:'string'},text:{type:'string'},sources:{type:'array',items:{type:'string'}},label:{type:'string'}},['id','agentId','topic','text','sources']],
  ['deploy_application','Deploy the published release to a runtime, via the configured runtime adapter (PAC_RUNTIME_ADAPTER). Fails with a clear error if no adapter is configured — this demo never deploys anywhere on its own.',{id:{type:'string'}},['id']],
  ['deployment_status','Get live deployment status from the runtime adapter',{id:{type:'string'}},['id']],
  ['deployment_logs','Get recent deployment logs from the runtime adapter',{id:{type:'string'},tail:{type:'integer'}},['id']],
  ['undeploy_application','Remove the deployed release via the runtime adapter. Refused unless the current release has been exported first (GET /api/apps/:id/export) — undeploy can permanently delete provisioned data.',{id:{type:'string'}},['id']],
  ['graduate_application','Generate a real graduation bundle (e.g. Jenkinsfile, workload.yml, image.yml) for a named platform via a configured graduation adapter (PAC_GRADUATION_ADAPTERS). This only generates files for review — it never commits, publishes, or triggers a pipeline on its own. Blocked if any declared service binding (envRefs) has no production equivalent (services catalog projection "local-only"), unless allowLocalOnly is set.',{id:{type:'string'},adapter:{type:'string'},target:{type:'string'},team:{type:'string'},repository:{type:'string'},registry:{type:'string'},image:{type:'string'},nexus:{type:'object'},resources:{type:'object'},allowLocalOnly:{type:'boolean'}},['id','adapter','target']],
  ['share_application','Grant a colleague access to this application by email (tenant SSO identity, not the label-based one-time invite). Owner-only. If the application is deployed, also pushes the updated allowlist to the runtime adapter so the deployed URL enforces it.',{id:{type:'string'},email:{type:'string'}},['id','email']],
  ['unshare_application','Revoke a colleague\'s email-based access to this application. Owner-only.',{id:{type:'string'},email:{type:'string'}},['id','email']],
  ['archive_application','Archive an application: hides it from list_applications, reversible with unarchive_application. Changes nothing else — config, documents and deployments are untouched. This is the normal "delete" action; the app is still directly reachable by id until purged.',{id:{type:'string'}},['id']],
  ['unarchive_application','Restore an archived application to list_applications.',{id:{type:'string'}},['id']],
  ['purge_application','Permanently remove an archived application: its record, invites, collaborator sessions and generated source workdir. Requires the application to be archived first. Refuses if it has been deployed unless force is set, in which case it is undeployed first on a best-effort basis. Irreversible.',{id:{type:'string'},force:{type:'boolean'}},['id']]
].map(([name,description,properties,required])=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}}));

export function createDemo({directory,ownerToken,builder,origin='http://127.0.0.1:3000',github=createGithubPublisher(),runtime=createRuntimeAdapter(),graduationAdapters=createGraduationAdapters(),authoring=createAuthoringAdapter(),orchestration=createOrchestrationAdapter(),agent=createAgentAdapter(),basePath=process.env.PAC_BASE_PATH||''}){
  if(!ownerToken||ownerToken.length<32)throw new Error('Owner token must be at least 32 characters');
  // Mounted under a URL prefix (e.g. /pac behind a shared nginx)? Paths arrive either with the prefix
  // (nginx forwards the full URI) or without it (nginx stripped it) -- both work. Everything this server
  // *emits* (links, redirects, the cookie path, the page's own asset URLs) carries the prefix.
  const base=String(basePath||'').trim().replace(/\/+$/,'');
  if(base&&!/^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(base))throw new Error('PAC_BASE_PATH must look like /pac');
  const logoutUrl=process.env.PAC_LOGOUT_URL||'';
  const store=new Store(directory,builder,runtime,graduationAdapters,authoring);
  // Loopback aliases: 127.0.0.1 and localhost name the same machine at the same port/scheme, and this
  // server only ever binds to loopback (HOST defaults to 127.0.0.1). Accepting both prevents a confusing
  // silent 403 when a browser is pointed at "localhost" instead of the exact configured origin.
  const originAliases=new Set([origin]);
  try{
    const u=new URL(origin);
    if(u.hostname==='127.0.0.1')originAliases.add(`${u.protocol}//localhost${u.port?':'+u.port:''}`);
    if(u.hostname==='localhost')originAliases.add(`${u.protocol}//127.0.0.1${u.port?':'+u.port:''}`);
  }catch{}
  // Extra origins the same studio answers on (short host name vs FQDN, an ingress hostname...). Origin only, no path.
  for(const o of String(process.env.PAC_PUBLIC_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean))originAliases.add(o.replace(/\/+$/,''));
  /** Where a deployed app answers: same host as the studio unless PAC_APPS_ORIGIN says otherwise, at PAC_APP_PATH_PREFIX+deployId. */
  const appUrl=deployId=>`${(process.env.PAC_APPS_ORIGIN||origin).replace(/\/+$/,'')}${process.env.PAC_APP_PATH_PREFIX||'/'}${deployId}/`;
  /** SSE variant of POST /chat. Headers go out immediately so proxies/browsers open the stream; the exchange is persisted only once the model has finished
   * (event: done carries the stored entry). A client that disconnects first aborts the upstream call and persists nothing. */
  async function chatStream(principal,id,app,body,res){
    if(body.nonce!==undefined&&(typeof body.nonce!=='string'||body.nonce.length>64))throw new DemoError(400,'nonce must be a string of at most 64 characters');
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no',Connection:'keep-alive'});
    res.flushHeaders();res.socket?.setNoDelay(true);
    const abort=new AbortController(),send=(event,data)=>{if(!res.writableEnded&&!res.destroyed)res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);};
    const ping=setInterval(()=>{if(!res.writableEnded&&!res.destroyed)res.write(': ping\n\n');},15000);
    res.on('close',()=>{clearInterval(ping);if(!res.writableEnded)abort.abort();});
    try{
      const result=await appChatStream(app,{mode:body.mode,message:body.message},text=>send('delta',{text}),abort.signal);
      if(abort.signal.aborted)return;
      send('done',store.recordChat(principal,id,{mode:body.mode,message:body.message,reply:result.reply,nonce:body.nonce}));
    }catch(error){if(!abort.signal.aborted)send('error',{error:error.message,status:error.status||400});}
    finally{clearInterval(ping);res.end();}
  }
  const server=http.createServer(async(req,res)=>{
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    const cookie=token=>res.setHeader('Set-Cookie',`pac_session=${token}; HttpOnly; SameSite=Lax; Path=${base||''}/; Max-Age=86400${origin.startsWith('https:')?'; Secure':''}`);
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
    try{
      if(req.headers.origin&&!originAliases.has(req.headers.origin))throw new DemoError(403,'Origin denied');
      const url=new URL(req.url,origin);let path=url.pathname;
      if(base){
        if(path===base){res.writeHead(302,{Location:base+'/'+url.search});return res.end();}
        if(path.startsWith(base+'/'))path=path.slice(base.length)||'/';
      }
      if(req.method==='GET'&&path==='/health')return json(200,{ok:true});
      if(req.method==='GET'&&path==='/brand.css'){res.setHeader('Content-Type','text/css');return res.end(brand.cssVars());}
      if(req.method==='GET'&&path.startsWith('/brand/')){
        const asset=path.slice('/brand/'.length);
        const assetPath=brand.assetPath(asset);
        if(!assetPath)throw new DemoError(404,'Unknown brand asset');
        res.setHeader('Content-Type',assetPath.endsWith('.svg')?'image/svg+xml':assetPath.endsWith('.png')?'image/png':'application/octet-stream');
        return res.end(readFileSync(assetPath));
      }
      if(req.method==='GET'&&path==='/capabilities.js'){
        // The one static asset served from demo/ itself, not demo/web/ -- shared verbatim
        // between the server (definition.js validates against it) and the browser (the
        // gallery/tick-list renders from it), so the picker can never drift from what the
        // backend actually accepts. Zero Node-specific imports by design, so it's valid to
        // hand straight to a <script type="module"> as-is.
        res.setHeader('Content-Type','text/javascript');
        return res.end(readFileSync(new URL('./capabilities.js',import.meta.url),'utf8'));
      }
      if(req.method==='GET'&&Object.hasOwn(STATIC_FILES,path)){
        const file=STATIC_FILES[path];res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':file.endsWith('.txt')?'text/plain; charset=utf-8':'text/javascript');
        let content;try{content=readFileSync(new URL('./web/'+file,import.meta.url),'utf8');}catch(e){if(e.code==='ENOENT')throw new DemoError(404,'Not found');throw e;} // an allowlisted asset the front end hasn't shipped yet is a 404, not a crash
        if(file==='index.html'){
          content=content
            .replace(/\{\{PAC_PRODUCT_NAME\}\}/g,escape(brand.data.productName||'PAC Manager'))
            .replace(/\{\{PAC_PRODUCT_TAGLINE\}\}/g,escape(brand.t('product.tagline','')))
            // logoMono (not logo): both current consumers of this marker — the login page
            // (canvas background) and the sidebar (a light surface) — are light backgrounds.
            // Found live: the white `logo` asset rendered at ~1.1:1 contrast on both,
            // effectively invisible. If a dark header/sidebar is ever added, that surface
            // needs its own marker pointing back at `logo` — don't "fix" this again by
            // recoloring the SVG with a CSS filter, the brand pack's lint.forbidLogoRecolor
            // rule exists specifically to prevent that.
            .replace(/\{\{PAC_LOGO_HTML\}\}/g,brand.assetPath('logoMono')?`<img class="brand-logo" src="/brand/logoMono" alt="${escape(brand.data.productName||'PAC Manager')}">`:`<span class="brand-text">${escape(brand.data.productName||'PAC Manager')}</span>`)
            // The one dark surface in the app (the top workspace bar) needs the OTHER logo
            // variant -- the white/reverse `logo` asset, not `logoMono` (see the comment just
            // above: logoMono is for light surfaces only, verified live at ~1.1:1 contrast on
            // dark). No CSS-filter recoloring here either, same lint.forbidLogoRecolor reason.
            .replace(/\{\{PAC_LOGO_REVERSE_HTML\}\}/g,brand.assetPath('logo')?`<img class="brand-logo" src="/brand/logo" alt="${escape(brand.data.productName||'PAC Manager')}">`:`<span class="brand-text">${escape(brand.data.productName||'PAC Manager')}</span>`);
          content=content.replace(/\{\{PAC_ACCENT_OPTIONS\}\}/g,Object.entries(brand.accentPalette()).map(([k,hex])=>`<option value="${escape(k)}" data-color="${escape(String(hex))}">${escape(brand.accentLabel(k))}</option>`).join(''));
        }
        if(file.endsWith('.html')){
          // Point every root-absolute asset/link at the prefix, and hand the page its base + sign-out target.
          content=content.replace(/(href|src)="\/(?!\/)/g,`$1="${base}/`)
            .replace('<meta charset="utf-8">',`<meta charset="utf-8"><meta name="pac-base" content="${escape(base)}"><meta name="pac-logout" content="${escape(logoutUrl)}">`);
        }
        return res.end(content);
      }
      let body={};
      if(req.method==='POST'){
        if(!req.headers['content-type']?.startsWith('application/json'))throw new DemoError(415,'JSON required');
        const parts=[];let size=0;for await(const part of req){size+=part.length;if(size>400000)throw new DemoError(413,'Request too large');parts.push(part);}
        try{body=JSON.parse(Buffer.concat(parts).toString());}catch{throw new DemoError(400,'Invalid JSON');}
        if(!body||typeof body!=='object'||Array.isArray(body))throw new DemoError(400,'JSON object required');
      }
      if(req.method==='POST'&&path==='/api/session'){
        const token=equal(body.token,ownerToken)?store.tokenSession({kind:'owner',label:'Studio owner'}):store.accept(body.token);
        cookie(token);return json(200,{ok:true});
      }
      const bearer=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      const sessionToken=bearer||req.headers.cookie?.split('; ').find(c=>c.startsWith('pac_session='))?.slice(12);
      // Proxy-header identity (PAC_AUTH_MODE=proxy) is tried first but never overrides an
      // explicit bearer/session credential -- a CLI/MCP caller presenting the owner token
      // directly must keep working even when pacmanager also sits behind an authenticating
      // proxy. See proxy-auth.js for the two independent gates (opt-in mode + shared secret)
      // that make this fail closed rather than trusting any client-supplied header.
      const principal=equal(bearer,ownerToken)?{kind:'owner',label:'Connected author'}:(store.session(sessionToken)||principalFromProxyHeaders(req));
      if(!principal)throw new DemoError(401,'Sign in to the studio');
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
              case 'generate_application':output=await store.startGeneration(principal,a.id,{changeRequest:a.changeRequest});break;
              case 'cancel_generation':output=store.cancelGeneration(principal,a.id);break;
              case 'rollback_application':output=store.rollback(principal,a.id,a.release);break;
              case 'build_application':output=store.startBuild(principal,a.id);break;
              case 'bind_mock_claims':store.bind(principal,a.id);output={bound:'claims.mock',live:false};break;
              case 'publish_application':store.publish(principal,a.id);output={url:origin+base+'/?app='+a.id+'&published=1'};break;
              case 'graduation_link':store.access(principal,a.id,true);output={url:origin+base+'/api/apps/'+a.id+'/export',authentication:'Studio browser session required'};break;
              case 'get_assurance':{const record=assuranceRecord(store.access(principal,a.id));output={record,completeness:completeness(record)};break;}
              case 'get_assurance_schema':output={schema:assuranceSchema,guide:authoringGuide};break;
              case 'update_assurance':output=saveAssurance(store,principal,a.id,a);break;
              case 'preview_assurance_document':{const record=assuranceRecord(store.access(principal,a.id));output={markdown:reportMarkdown(record,a.kind),preview:origin+base+'/api/apps/'+a.id+'/reports/'+a.kind,release:record.release,sourceDigest:record.sourceDigest};break;}
              case 'record_agent_run':output=store.recordBriefing(principal,a.id,a);break;
              case 'deploy_application':output=await store.deployApplication(principal,a.id);break;
              case 'deployment_status':output=await store.deploymentStatus(principal,a.id);break;
              case 'deployment_logs':output=await store.deploymentLogs(principal,a.id,a.tail);break;
              case 'undeploy_application':output=await store.undeployApplication(principal,a.id);break;
              case 'graduate_application':{const {id,adapter,...options}=a;output=await store.graduateApplication(principal,id,adapter,options);break;}
              case 'share_application':output={sharedWith:await store.shareWithEmail(principal,a.id,a.email)};break;
              case 'unshare_application':output={sharedWith:await store.unshareEmail(principal,a.id,a.email)};break;
              case 'archive_application':output=store.archive(principal,a.id);break;
              case 'unarchive_application':output=store.unarchive(principal,a.id);break;
              case 'purge_application':output=await store.purge(principal,a.id,{force:Boolean(a.force)});break;
              default:throw new DemoError(400,'Unknown tool');
            }
            result={content:[{type:'text',text:JSON.stringify(output)}]};
          }else return json(200,{jsonrpc:'2.0',id:body.id,error:{code:-32601,message:'Method not found'}});
        }catch(error){if(body.method!=='tools/call')return json(200,{jsonrpc:'2.0',id:body.id,error:{code:-32602,message:error.message}});result={isError:true,content:[{type:'text',text:error.message}]};}
        return json(200,{jsonrpc:'2.0',id:body.id,result});
      }
      if(path==='/api/me'&&req.method==='GET'){
        // Cached probe (see store.js's authoringStatus) -- never blocks this on a live model
        // call, so a page load can never hang on the gateway. Surfaced here so the browser can
        // show "no AI configured" before the user writes a brief, per the original complaint.
        const authoring=await store.authoringStatus();
        return json(200,{kind:principal.kind,label:principal.label,email:principal.email||null,mode:builder.mode,authMode:principal.via==='proxy'?'proxy':'local',authoring});
      }
      // Admin console gate: owner kind AND the owner's own browser session, never a bearer
      // token -- mirrors the one existing owner-only precedent, the GitHub publish routes
      // above (see action.startsWith('github-')), so a CLI/MCP caller holding the owner
      // token can never reach admin-only surface, only a human sitting at the browser can.
      if(path.startsWith('/api/admin/')){
        if(bearer||principal.kind!=='owner')throw new DemoError(403,'The admin console requires the owner browser session.');
        const sub=path.slice('/api/admin/'.length);
        if(sub==='overview'&&req.method==='GET')return json(200,adminOverview(store));
        if(sub==='services'&&req.method==='GET')return json(200,await adminServices({runtime,orchestration}));
        if(sub==='llm-test'&&req.method==='POST')return json(200,await adminLlmTest(body));
        if(sub==='orchestration-test'&&req.method==='POST')return json(200,await adminOrchestrationTest({orchestration}));
        if(sub==='agent-test'&&req.method==='POST')return json(200,await adminAgentTest({agent,prompt:body.prompt}));
        throw new DemoError(404,'Not found');
      }
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
          if(action==='github-prepare')return json(200,github.prepare(app,body.repository,body.token||undefined));
          if(action==='github-publish'){
            const result=await github.publish(app,body);store.audit(app,'code published to '+result.repository+' at '+result.commit,principal);store.save();return json(200,result);
          }
        }
        throw new DemoError(405,'Method not allowed');
      }
      if(path==='/api/drafts'&&req.method==='POST'){
        if(principal.kind!=='owner'&&principal.kind!=='user')throw new DemoError(403,'Sign in to create an application'); // same gate as store.create()
        return json(200,await draftApplication({brief:body.brief,history:body.history}));
      }
      if(path==='/api/logout'&&req.method==='POST'){store.state.sessions=store.state.sessions.filter(s=>s!==principal);store.save();cookie('');return json(200,{ok:true});}
      if(path==='/api/apps'){
        if(req.method==='GET')return json(200,store.list(principal,{includeArchived:url.searchParams.get('archived')==='1'}));
        if(req.method==='POST'){const {plan,...cfg}=body;return json(201,store.view(principal,store.create(principal,cfg,{plan}).id));}
      }
      const match=path.match(/^\/api\/apps\/([a-f0-9-]+)(?:\/(preview|definition|build|generate|documents|comments|chat|binding|publish|invite|invites|share|unshare|export|deploy|deployment-status|deployment-logs|undeploy|graduate|unarchive|purge|rollback|generate\/cancel|plan|preview-start|preview-stop|preview-status|preview-logs))?$/);
      if(!match)throw new DemoError(404,'Not found');
      const [,id,action]=match,app=store.access(principal,id);
      if(req.method==='GET'){
        if(!action)return json(200,store.view(principal,id));
        if(action==='preview'){
          const releaseParam=url.searchParams.get('release');
          // A specific past release -- the "view earlier versions" affordance the release
          // history panel needs, not just a bare number/date list with a blind rollback button.
          const historical=releaseParam?(app.releases||[]).find(r=>r.number===Number(releaseParam)):null;
          if(releaseParam&&!historical)throw new DemoError(404,`Release ${releaseParam} is not retained (kept: last ${(app.releases||[]).length}).`);
          const result=historical?historical.result:url.searchParams.get('published')==='1'?app.release?.result:app.build?.status==='ready'?app.build.result:null;
          if(!result)throw new DemoError(409,'Build or publish this application first');
          if(app.config.tier==='app'){res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
            return res.end('<!doctype html><meta charset=utf-8><body style="font:16px system-ui;margin:3rem;color:#333"><h2>This is a server application</h2><p>It runs as its own service, so it has no static page to render. Open <b>Start live preview</b> in the studio to run it and see it here.</p></body>');}
          const generated=app.config.tier==='static';
          const scriptSrc=generated&&result.scriptHashes?.length?result.scriptHashes.map(h=>`'sha256-${h}'`).join(' '):"'none'";
          res.setHeader('Content-Type','text/html');
          res.setHeader('Content-Security-Policy',`sandbox${generated?' allow-scripts':''}; default-src 'none'; script-src ${scriptSrc}; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`);
          return res.end(generated?injectBriefings(result.html,app.briefings):render(result.html,app));
        }
        if(action==='export'){store.access(principal,id,true);if(!app.release)throw new DemoError(409,'Publish first');const bundle=graduationBundle(app);store.recordExport(principal,id);res.setHeader('Content-Type','application/gzip');res.setHeader('Content-Disposition','attachment; filename="pac-graduation.tar.gz"');return res.end(bundle);}
        if(action==='preview-status')return json(200,{...(await store.previewStatus(principal,id)),url:app.preview?appUrl(app.preview.deployId):null});
        if(action==='preview-logs')return json(200,await store.previewLogs(principal,id,Number(url.searchParams.get('tail'))||100));
        if(action==='deployment-status')return json(200,await store.deploymentStatus(principal,id));
        if(action==='deployment-logs')return json(200,await store.deploymentLogs(principal,id,Number(url.searchParams.get('tail'))||100));
        if(action==='invites')return json(200,store.listInvites(principal,id));
      }
      // DELETE is archive, not purge -- soft, reversible, hides the app from list() and
      // nothing else. Deliberately only reachable on the bare app path (no action suffix);
      // purge is a POST action below because it takes an options body ({force}) and archive
      // is a precondition for it, not something DELETE itself needs to express.
      if(req.method==='DELETE'&&!action){store.archive(principal,id);return json(200,store.view(principal,id));}
      if(req.method!=='POST')throw new DemoError(405,'Method not allowed');
      switch(action){
        case 'definition':store.update(principal,id,body.config,body.revision);break;
        case 'build':return json(202,store.startBuild(principal,id));
        case 'generate':return json(202,await store.startGeneration(principal,id,{changeRequest:body.changeRequest,plan:body.plan}));
        case 'generate/cancel':return json(200,store.cancelGeneration(principal,id));
        case 'plan':return json(200,store.setPlan(principal,id,{text:body.text,status:body.status,capabilities:body.capabilities}));
        case 'rollback':return json(200,store.rollback(principal,id,body.release));
        case 'documents':store.upload(principal,id,body);break;
        case 'comments':store.comment(principal,id,body.text);break;
        case 'chat':{
          if(/text\/event-stream/.test(req.headers.accept||''))return await chatStream(principal,id,app,body,res);
          const result=await appChat(app,{mode:body.mode,message:body.message});return json(200,store.recordChat(principal,id,{mode:body.mode,message:body.message,reply:result.reply,nonce:body.nonce}));
        }
        case 'binding':store.bind(principal,id);break;
        case 'publish':store.publish(principal,id);break;
        case 'invite':return json(201,{url:origin+base+'/?app='+id+'#invite='+store.invite(principal,id,body.label)});
        case 'share':return json(200,{sharedWith:await store.shareWithEmail(principal,id,body.email)});
        case 'unshare':return json(200,{sharedWith:await store.unshareEmail(principal,id,body.email)});
        case 'deploy':return json(202,await store.deployApplication(principal,id));
        case 'preview-start':return json(202,await store.startPreview(principal,id));
        case 'preview-stop':return json(200,await store.stopPreview(principal,id));
        case 'undeploy':return json(200,await store.undeployApplication(principal,id));
        case 'graduate':{const {adapter,...options}=body;return json(200,await store.graduateApplication(principal,id,adapter,options));}
        case 'unarchive':store.unarchive(principal,id);break;
        case 'purge':return json(200,await store.purge(principal,id,{force:Boolean(body.force)}));
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
