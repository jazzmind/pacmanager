import { initGraduation } from './graduation-ui.js';
const $=id=>document.getElementById(id);let me,app,apps=[],selected=new URLSearchParams(location.search).get('app'),published=new URLSearchParams(location.search).get('published')==='1',editing=false,previewKey='',historyOpen=false,selectedRelease=null;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Deterministic inline-SVG card art (data: URI -- the preview CSP is img-src 'self' data:, no
// hotlinking allowed, and deploykit's webUI already learned that the hard way). Purely cosmetic:
// a two-stop gradient plus one circle, both derived from the app id so the same app always
// renders the same art without storing anything.
function placeholderArt(seed){
  let h=0;for(const c of seed)h=(h*31+c.charCodeAt(0))>>>0;
  const hue1=h%360,hue2=(hue1+40)%360;
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue1},55%,55%)"/><stop offset="1" stop-color="hsl(${hue2},55%,38%)"/></linearGradient></defs><rect width="200" height="120" fill="url(#g)"/><circle cx="${40+h%110}" cy="${25+h%55}" r="30" fill="rgba(255,255,255,0.16)"/></svg>`;
  return 'data:image/svg+xml,'+encodeURIComponent(svg);
}
function statusOf(a){
  if(a.archivedAt)return 'archived';
  if(a.published)return 'published';
  if(a.generation?.status==='generating')return 'generating';
  if(a.build?.status==='building')return 'building';
  return a.build?.status||'draft';
}
function statusLabel(a){const s=statusOf(a);return s==='published'?'Published · v'+a.release.number:s.charAt(0).toUpperCase()+s.slice(1);}
function cardHtml(a){
  const kind=a.config.kind||a.config.template||'template';
  return `<button class="card" data-app="${a.id}"><div class="card-art"><img src="${placeholderArt(a.id)}" alt=""></div><div class="card-body"><strong>${esc(a.config.title)}</strong><div class="card-meta"><span class="card-badge status-${statusOf(a)}">${esc(statusLabel(a))}</span><span class="card-badge">${esc(kind)}</span></div><small>${new Date(a.createdAt).toLocaleDateString()}${a.lastDeployment?' · deployed':''}</small></div></button>`;
}
function renderHome(){
  const email=me?.email,isAdmin=me.kind==='owner';
  const mine=email?apps.filter(a=>a.ownerEmail===email):(isAdmin?apps:[]);
  const shared=email?apps.filter(a=>(a.sharedWith||[]).includes(email)):[];
  $('cards-mine').innerHTML=mine.map(cardHtml).join('')||'<p>Nothing yet — create your first application.</p>';
  $('shelf-shared').hidden=!email;
  $('cards-shared').innerHTML=shared.map(cardHtml).join('')||'<p>Nothing shared with you yet.</p>';
  $('shelf-all').hidden=!isAdmin;
  if(isAdmin)$('cards-all').innerHTML=apps.map(cardHtml).join('')||'<p>No applications yet.</p>';
}
function showView(v){
  $('empty').hidden=v!=='empty';$('home').hidden=v!=='home';$('detail').hidden=v!=='detail';
  $('home-nav').classList.toggle('active',v==='home');
}

// What each artifact kind is, what it genuinely cannot do, and one worked example -- shown in
// the create dialog so "what can I build?" has a real answer instead of four bare option labels.
const KIND_GUIDANCE={
  interactive:{what:'A self-contained page or small game — everything runs client-side in a sandboxed preview, no server involved.',cant:"No fetch/XHR/WebSocket, no network access of any kind, nothing server-side.",example:'Example: a personal dashboard that tracks priorities, calendar and AI usage budgets — static HTML/CSS/JS with checkboxes that persist to localStorage once deployed (ephemeral in preview, since the preview iframe has no origin to persist to).'},
  knowledge:{what:'A knowledge workspace / "digital expert" layout that presents agent-run briefings recorded via record_agent_run.',cant:'Same client-side-only restrictions as interactive — briefings are injected by the host, never fetched live.',example:'Example: a weekly market-intel page your agent updates on a schedule.'},
  application:{what:'A real client+API project — a Dockerfile plus whatever server code it needs, actually built and run.',cant:'Not subject to the static-tier restrictions, but the model has to hand you something genuinely runnable.',example:"Example: something like chatprc. Be honest with yourself here — this MCP bridge has never been exercised against a live Claude session end to end, and chatprc itself has no MCP server of its own (its \"MCP skill\" is a Claude Code skill for deploykit, not an MCP server). Treat this path as unproven, not turnkey."},
  auto:{what:'Let the model read your brief and choose interactive, knowledge or application itself.',cant:'You give up control of the exact kind; it reports back what it picked and why.',example:'Good default when you\'re not sure which of the above fits.'},
};
function updateKindGuidance(){const k=$('kind').value,g=KIND_GUIDANCE[k]||KIND_GUIDANCE.auto;$('kind-guidance').innerHTML=`${esc(g.what)} ${esc(g.cant)}<span class="kind-guidance-example">${esc(g.example)}</span>`;}
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,6000);}
async function api(path,body){const r=await fetch('/api/'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(data.error||'Request failed');return data;}
async function apiDelete(path){const r=await fetch('/api/'+path,{method:'DELETE'});const data=await r.json();if(!r.ok)throw new Error(data.error||'Request failed');return data;}
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
  $('kind-guidance').hidden=legacy;updateKindGuidance();
  $('editor').showModal();
}
function authoringBadge(){
  const a=me?.authoring,badge=$('authoring-badge');badge.hidden=!a||a.available;
  if(a&&!a.available)badge.textContent=a.state==='not_configured'?'⚠ No AI connected':a.state==='credential_missing'?'⚠ AI credential missing':'⚠ AI gateway unreachable';
}
const autoBuiltRevision={};
async function refresh(){
  me=await api('me');authoringBadge();
  document.querySelectorAll('.owner').forEach(el=>el.hidden=me.kind!=='owner');$('admin-link').hidden=me.kind!=='owner';
  apps=await api('apps');$('apps').innerHTML=apps.map(a=>`<button data-app="${a.id}" class="${a.id===selected?'active':''}">${esc(a.config.title)}<small>${a.published?'Published':a.generation?.status==='generating'?'Generating':a.build?.status||'Draft'} · ${a.documents} documents</small></button>`).join('');
  if(!apps.length){selected=null;app=null;showView('empty');return;}
  // selected can point at an app that's no longer in the list (archived, e.g. by the delete
  // button below) -- fall back to the home view, not a stale detail view.
  if(selected&&apps.some(a=>a.id===selected)){app=await api('apps/'+selected);showView('detail');draw();}
  else{selected=null;app=null;renderHome();showView('home');}
}
function draw(){
  $('empty').hidden=true;$('detail').hidden=false;$('title').textContent=app.config.title+(['static','app'].includes(app.config.tier)?' · generated app':'');
  const isLive=app.generation?.status==='generating'||app.build?.status==='building';
  $('status').textContent=app.generation?.status==='generating'?'Generating…':app.build?.status==='building'?'Building…':app.release?'Published · v'+app.release.number:app.build?.status==='ready'?'Preview ready':'Draft';
  $('status').classList.toggle('live',isLive);
  $('build').disabled=app.build?.status==='building'||app.generation?.status==='generating';$('publish').disabled=app.build?.status!=='ready'||app.build.revision!==app.revision;
  if(!app.config.kind)$('generate').hidden=true; // the owner-only toggle in refresh() already hides it from non-owners
  // Once real source exists, editing means requesting a targeted change (revise), not
  // reopening the full brief editor -- see demo/store.js's startGeneration changeRequest
  // requirement. "Regenerate from scratch" is the separate, explicit, destructive escape hatch.
  const hasSource=['static','app'].includes(app.config.tier);
  $('edit').textContent=hasSource?'Request a change':'Edit brief';
  $('regenerate').hidden=me.kind!=='owner'||!hasSource;
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
  $('open-preview').href=url;$('open-preview').hidden=!ready;$('preview-label').textContent=published?'Published release · v'+(app.release?.number||'—'):'Draft application preview';
  $('canvas-view').hidden=historyOpen;$('history-view').hidden=!historyOpen;
  $('draft').classList.toggle('selected',!published&&!historyOpen);$('published').classList.toggle('selected',published&&!historyOpen);$('history').classList.toggle('selected',historyOpen);
  if(historyOpen)renderHistory();
  docs();$('comments').innerHTML=app.comments.map(c=>`<div class="comment"><strong>${esc(c.author)}</strong><p>${esc(c.text)}</p><small>${esc(new Date(c.createdAt).toLocaleTimeString())}</small></div>`).join('')||'<p>No notes yet. Start the conversation.</p>';
  $('binding-state').textContent=app.binding?'Connected · '+app.claims.length+' synthetic claims':'Not connected';$('bind').disabled=app.binding;$('bind').textContent=app.binding?'Mock service bound ✓':'Bind mock claims';$('export').href='/api/apps/'+app.id+'/export';$('export').hidden=!app.release||me.kind!=='owner';
  $('release').textContent=app.release?`Internal release v${app.release.number} · Definition revision ${app.release.revision} · Documents and discussion remain shared. ${app.revision!==app.release.revision?'Unpublished changes in draft.':''}`:'Visible to this workspace only. Publish when your team is ready.';
}
// "View earlier versions" as a real affordance, not just a number/date list with a blind
// rollback button: the right pane actually previews the selected release's own frozen content
// (see server.js's preview?release=N), and rollback only appears once a non-current one is picked.
function renderHistory(){
  const releases=(app.releases||[]).slice().reverse();
  if(!selectedRelease||!releases.some(r=>r.number===selectedRelease))selectedRelease=releases[0]?.number??null;
  $('release-history-full').innerHTML=releases.map(r=>{
    const current=app.release&&app.release.number===r.number;
    return `<button class="release-row-btn${r.number===selectedRelease?' selected':''}" data-release="${r.number}"><strong>Release v${r.number}</strong><small>${new Date(r.publishedAt).toLocaleString()}</small>${current?'<span class="tag-current">current</span>':''}</button>`;
  }).join('')||'<p class="hint" style="padding:16px">No releases published yet.</p>';
  const current=app.release&&app.release.number===selectedRelease;
  $('history-rollback').hidden=!selectedRelease||current||me.kind!=='owner';
  $('history-preview').setAttribute('sandbox',app.config.tier==='static'?'allow-scripts':'');
  $('history-preview').src=selectedRelease?'/api/apps/'+app.id+'/preview?release='+selectedRelease:'';
}
function docs(){const q=$('search').value.toLowerCase();$('documents').innerHTML=app.documents.filter(d=>(d.name+' '+d.text).toLowerCase().includes(q)).map(d=>`<div class="document"><strong>▤ ${esc(d.name)}</strong><p>${esc(d.text.slice(0,160)||'PDF attachment · no extracted text')}</p><small>${esc(d.author)} · ${Math.ceil(d.size/1024)} KB</small></div>`).join('')||'<p>No matching documents yet.</p>';}
async function enter(){me=await api('me');$('identity').textContent=me.label;$('login').hidden=true;$('workspace').hidden=false;$('new').hidden=me.kind!=='owner';$('connect').hidden=me.kind!=='owner';$('logout').textContent=me.authMode==='proxy'?'Sign out ↗':'Sign out';authoringBadge();await refresh();}
$('signin').onsubmit=action(async()=>{await api('session',{token:$('token').value});$('token').value='';await enter();});
$('logout').onclick=action(async()=>{if(me&&me.authMode==='proxy'){location.href='/oauth2/sign_out';return;}await api('logout',{});location.href='/';});
$('new').onclick=$('start').onclick=()=>editor(false);
$('edit').onclick=()=>{if(['static','app'].includes(app.config.tier))$('revise').showModal();else editor(true);};
$('connect').onclick=()=>$('connection').showModal();
$('kind').onchange=updateKindGuidance;
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
const openApp=action(async e=>{const b=e.target.closest('[data-app]');if(!b)return;selected=b.dataset.app;published=false;history.replaceState(null,'','/?app='+selected);await refresh();});
$('apps').onclick=openApp;$('home').onclick=openApp;
$('home-nav').onclick=action(async()=>{selected=null;history.replaceState(null,'','/');await refresh();});
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
$('draft').onclick=()=>{published=false;historyOpen=false;draw();};$('published').onclick=()=>{published=true;historyOpen=false;draw();};$('history').onclick=()=>{historyOpen=true;draw();};
$('delete').onclick=action(async()=>{
  if(!confirm('Archive "'+app.config.title+'"? This hides it from your list — it isn’t permanently deleted, and an admin can restore or purge it later.'))return;
  await apiDelete('apps/'+app.id);
  await refresh();
  toast('Archived.');
});
$('revise-form').onsubmit=action(async()=>{
  const changeRequest=$('change-request').value;
  await api('apps/'+app.id+'/generate',{changeRequest});
  $('revise').close();$('change-request').value='';
  await refresh();
  toast('Requesting change…');
});
$('regenerate').onclick=action(async()=>{
  if(!confirm('Regenerate "'+app.config.title+'" from scratch? This discards the current source and starts over — it cannot be undone (though any already-published release can still be rolled back to).'))return;
  await api('apps/'+app.id+'/definition',{config:{title:app.config.title,brief:app.config.brief,accent:app.config.accent,kind:app.config.kind,tier:'intent'},revision:app.revision});
  await refresh();
  toast('Regenerating from scratch…');
  api('apps/'+app.id+'/generate',{}).then(refresh).catch(error=>toast(error.message));
});
$('release-history-full').onclick=e=>{
  const b=e.target.closest('[data-release]');if(!b)return;
  selectedRelease=Number(b.dataset.release);renderHistory();
};
$('history-rollback').onclick=action(async()=>{
  if(!confirm('Roll back to release v'+selectedRelease+'? This publishes a NEW release with that old content — nothing is deleted.'))return;
  await api('apps/'+app.id+'/rollback',{release:selectedRelease});
  historyOpen=false;published=true;await refresh();
  toast('Rolled back to v'+selectedRelease+' (as a new release).');
});
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
