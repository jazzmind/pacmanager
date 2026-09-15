import { initGraduation } from './graduation-ui.js';
const $=id=>document.getElementById(id);let me,app,apps=[],selected=new URLSearchParams(location.search).get('app'),published=new URLSearchParams(location.search).get('published')==='1',editing=false,previewKey='';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,6000);}
async function api(path,body){const r=await fetch('/api/'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(data.error||'Request failed');return data;}
const action=fn=>async e=>{e?.preventDefault();try{await fn(e);}catch(error){toast(error.message);}};
// A legacy (kind-less) app keeps editing through the old two-value "template" layout picker,
// exactly as before -- dual-accept, see demo/definition.js. Every other case (new apps always,
// and any app that already has a kind) uses the real artifact-type picker instead.
function editor(isEdit){
  editing=isEdit;const legacy=isEdit&&!app.config.kind;
  $('app-title').value=isEdit?app.config.title:'';$('brief').value=isEdit?app.config.brief:'';
  $('accent').value=isEdit?app.config.accent:$('accent').options[0]?.value;
  $('kind-field').hidden=legacy;$('template-field').hidden=!legacy;
  if(legacy)$('template').value=app.config.template;else $('kind').value=isEdit?(app.config.kind||'interactive'):'interactive';
  $('editor-authoring-warning').hidden=legacy||Boolean(me?.authoring?.available);
  $('editor-title').textContent=isEdit?'Update your application':'What would you like to build?';
  $('editor').showModal();
}
function authoringBadge(){
  const a=me?.authoring,badge=$('authoring-badge');badge.hidden=!a||a.available;
  if(a&&!a.available)badge.textContent=a.state==='not_configured'?'⚠ No AI connected':a.state==='credential_missing'?'⚠ AI credential missing':'⚠ AI gateway unreachable';
}
const autoBuiltRevision={};
async function refresh(){
  me=await api('me');authoringBadge();
  apps=await api('apps');$('apps').innerHTML=apps.map(a=>`<button data-app="${a.id}" class="${a.id===selected?'active':''}">${esc(a.config.title)}<small>${a.published?'Published':a.generation?.status==='generating'?'Generating':a.build?.status||'Draft'} · ${a.documents} documents</small></button>`).join('');
  if(!selected&&apps.length)selected=apps[0].id;
  if(selected){app=await api('apps/'+selected);draw();}
}
function draw(){
  $('empty').hidden=true;$('detail').hidden=false;$('title').textContent=app.config.title+(['static','app'].includes(app.config.tier)?' · generated app':'');
  $('status').textContent=app.generation?.status==='generating'?'Generating…':app.build?.status==='building'?'Building…':app.release?'Published · v'+app.release.number:app.build?.status==='ready'?'Preview ready':'Draft';
  document.querySelectorAll('.owner').forEach(el=>el.hidden=me.kind!=='owner');$('build').disabled=app.build?.status==='building'||app.generation?.status==='generating';$('publish').disabled=app.build?.status!=='ready'||app.build.revision!==app.revision;
  if(!app.config.kind)$('generate').hidden=true; // .owner above already hides it from non-owners
  $('generate').disabled=app.generation?.status==='generating';$('generate').textContent=app.generation?.status==='failed'?'Retry generation':'Generate';
  $('mode').textContent=app.build?.mode||me.mode;
  const logs=[...(app.generation?.logs||[]),...(app.build?.logs||[])];
  $('logs').innerHTML=(logs.length?logs:[{text:app.config.tier==='intent'?'Generating happens automatically after you save a brief.':'Save a definition, then build.'}]).map(l=>`<li>${esc(l.text)}</li>`).join('');
  // Once generation lands, build automatically -- describing a brief should produce a working
  // preview in one motion, per the original complaint ("I asked it to make a game and it
  // didn't"). Guarded by revision so it only fires once per successful generation.
  if(app.generation?.status==='ready'&&app.generation.revision===app.revision&&autoBuiltRevision[app.id]!==app.revision&&app.build?.status!=='building'){
    autoBuiltRevision[app.id]=app.revision;
    api('apps/'+app.id+'/build',{}).then(refresh).catch(error=>toast(error.message));
  }
  const ready=published?Boolean(app.release):app.build?.status==='ready';const url='/api/apps/'+app.id+'/preview'+(published?'?published=1':'');
  const key=[app.id,published,app.build?.id,app.build?.status,app.release?.number,app.documents.length,app.comments.length,app.binding].join(':');
  $('preview').hidden=!ready;$('preview-empty').hidden=ready;$('preview').setAttribute('sandbox',app.config.tier==='static'?'allow-scripts':'');if(ready&&key!==previewKey){$('preview').src=url;previewKey=key;}
  $('open-preview').href=url;$('open-preview').hidden=!ready;$('preview-label').textContent=published?'Published release · v'+(app.release?.number||'—'):'Draft application preview';$('draft').classList.toggle('selected',!published);$('published').classList.toggle('selected',published);
  docs();$('comments').innerHTML=app.comments.map(c=>`<div class="comment"><strong>${esc(c.author)}</strong><p>${esc(c.text)}</p><small>${esc(new Date(c.createdAt).toLocaleTimeString())}</small></div>`).join('')||'<p>No notes yet. Start the conversation.</p>';
  $('binding-state').textContent=app.binding?'Connected · '+app.claims.length+' synthetic claims':'Not connected';$('bind').disabled=app.binding;$('bind').textContent=app.binding?'Mock service bound ✓':'Bind mock claims';$('export').href='/api/apps/'+app.id+'/export';$('export').hidden=!app.release||me.kind!=='owner';
  $('release').textContent=app.release?`Internal release v${app.release.number} · Definition revision ${app.release.revision} · Documents and discussion remain shared. ${app.revision!==app.release.revision?'Unpublished changes in draft.':''}`:'Visible to this workspace only. Publish when your team is ready.';
}
function docs(){const q=$('search').value.toLowerCase();$('documents').innerHTML=app.documents.filter(d=>(d.name+' '+d.text).toLowerCase().includes(q)).map(d=>`<div class="document"><strong>▤ ${esc(d.name)}</strong><p>${esc(d.text.slice(0,160)||'PDF attachment · no extracted text')}</p><small>${esc(d.author)} · ${Math.ceil(d.size/1024)} KB</small></div>`).join('')||'<p>No matching documents yet.</p>';}
async function enter(){me=await api('me');$('identity').textContent=me.label;$('login').hidden=true;$('workspace').hidden=false;$('new').hidden=me.kind!=='owner';$('connect').hidden=me.kind!=='owner';$('logout').textContent=me.authMode==='proxy'?'Sign out ↗':'Sign out';authoringBadge();await refresh();}
$('signin').onsubmit=action(async()=>{await api('session',{token:$('token').value});$('token').value='';await enter();});
$('logout').onclick=action(async()=>{if(me&&me.authMode==='proxy'){location.href='/oauth2/sign_out';return;}await api('logout',{});location.href='/';});
$('new').onclick=$('start').onclick=()=>editor(false);$('edit').onclick=()=>editor(true);$('connect').onclick=()=>$('connection').showModal();
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
$('apps').onclick=action(async e=>{const b=e.target.closest('[data-app]');if(!b)return;selected=b.dataset.app;published=false;history.replaceState(null,'','/?app='+selected);await refresh();});
$('definition-form').onsubmit=action(async()=>{
  const legacy=editing&&!app.config.kind;
  const base={title:$('app-title').value,brief:$('brief').value,accent:$('accent').value};
  // Non-legacy always resets to tier "intent" -- editing a brief means regenerating it, not
  // hand-patching whatever source (if any) was there before. See demo/definition.js's dual
  // accept: template and kind are mutually exclusive, never sent together.
  const config=legacy?{...base,template:$('template').value,...(app.config.tier==='static'?{tier:app.config.tier,source:app.config.source}:{})}:{...base,kind:$('kind').value,tier:'intent'};
  const result=editing?await api('apps/'+app.id+'/definition',{config,revision:app.revision}):await api('apps',config);
  selected=result.id;published=false;$('editor').close();await refresh();
  if(legacy){toast('Definition saved. Ready to build.');return;}
  toast('Definition saved. Generating your application…');
  api('apps/'+selected+'/generate',{}).then(refresh).catch(error=>toast(error.message));
});
for(const [id,route,message] of [['build','build','Build started. Activity updates below.'],['generate','generate','Generating your application…'],['bind','binding','Mock claims service bound.'],['publish','publish','Published internally. Invite your team from the Team tab.']])$(id).onclick=action(async()=>{await api('apps/'+app.id+'/'+route,{});if(id==='publish')published=true;await refresh();toast(message);});
$('draft').onclick=()=>{published=false;draw();};$('published').onclick=()=>{published=true;draw();};
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tab').forEach(t=>t.hidden=t.id!==b.dataset.tab);document.querySelectorAll('[data-tab]').forEach(t=>t.classList.toggle('selected',t===b));});
$('search').oninput=docs;
$('upload').onchange=action(async()=>{const file=$('upload').files[0];if(!file)return;if(file.size>256000)throw new Error('Choose a file under 256 KB');const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);await api('apps/'+app.id+'/documents',{name:file.name,base64:btoa(binary)});$('upload').value='';await refresh();toast('Document added to shared knowledge.');});
$('note').onsubmit=action(async()=>{await api('apps/'+app.id+'/comments',{text:$('note-text').value});$('note-text').value='';await refresh();});
$('invite').onclick=()=>{$('invite-url').hidden=true;$('invite-form').hidden=false;$('invite-dialog').showModal();};
$('invite-form').onsubmit=action(async()=>{const result=await api('apps/'+app.id+'/invite',{label:$('colleague').value});$('invite-url').value=result.url;$('invite-url').hidden=false;$('invite-form').hidden=true;$('invite-url').select();});
const invitation=new URLSearchParams(location.hash.slice(1)).get('invite');if(invitation){history.replaceState(null,'',location.pathname+location.search);try{await api('session',{token:invitation});}catch(error){toast(error.message);}}
try{await enter();}catch{/* Login is shown until authenticated. */}
initGraduation({api,action,$,getApp:()=>app,getMe:()=>me,toast,esc});
setInterval(()=>{if(me&&!document.hidden)refresh().catch(error=>toast(error.message));},2000);
