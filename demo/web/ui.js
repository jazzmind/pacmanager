import { initGraduation } from './graduation-ui.js';
const $=id=>document.getElementById(id);
let me,app,apps=[],selected=new URLSearchParams(location.search).get('app'),published=new URLSearchParams(location.search).get('published')==='1',editing=false,previewKey='',historyOpen=false,selectedRelease=null,currentCards=[];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Deterministic inline-SVG card art (data: URI -- the preview CSP is img-src 'self' data:, no
// hotlinking allowed, and deploykit's webUI already learned that the hard way). Colors are read
// from the ACTIVE brand pack's own CSS custom properties at paint time, not hardcoded or
// HSL-rotated -- a random hue rotation produced off-brand magenta/olive art regardless of which
// pack (Plymouth Rock or the OSS default) was loaded. Still fully deterministic per app id.
const BRAND_ART_TOKENS=['brand','brand-dark','accent','navy'];
function brandColor(name,fallback){const v=getComputedStyle(document.documentElement).getPropertyValue('--pac-'+name).trim();return v||fallback;}
function placeholderArt(seed){
  let h=0;for(const c of seed)h=(h*31+c.charCodeAt(0))>>>0;
  const c1=brandColor(BRAND_ART_TOKENS[h%4],'#0078d6'),c2=brandColor(BRAND_ART_TOKENS[(h+1+h%3)%4],'#0351aa');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="200" height="120" fill="url(#g)"/><circle cx="${40+h%110}" cy="${25+h%55}" r="30" fill="rgba(255,255,255,0.16)"/></svg>`;
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
  const mineIds=new Set(mine.map(a=>a.id));
  // "All applications" only ever shows what ISN'T already shown above -- the old version showed
  // the exact same list twice under "My applications" and "All applications" whenever the
  // signed-in principal owned everything (the common single-owner local case).
  const extra=isAdmin?apps.filter(a=>!mineIds.has(a.id)):[];
  $('home-summary').textContent=`${apps.length} application${apps.length===1?'':'s'} · ${apps.filter(a=>a.published).length} published`;
  $('cards-mine').innerHTML=mine.map(cardHtml).join('')||'<p>Nothing yet — create your first application.</p>';
  $('shelf-shared').hidden=!shared.length;$('cards-shared').innerHTML=shared.map(cardHtml).join('');
  $('shelf-all').hidden=!extra.length;$('cards-all').innerHTML=extra.map(cardHtml).join('');
}
function chipColor(seed){let h=0;for(const c of seed)h=(h*31+c.charCodeAt(0))>>>0;return brandColor(BRAND_ART_TOKENS[h%4],'#0078d6');}
function renderSwitcher(){
  $('crumb-title').textContent=app.config.title;
  $('switcher-list').innerHTML=apps.map(a=>`<button class="switcher-row${a.id===app.id?' active':''}" data-app="${a.id}"><span class="switcher-chip" style="background:${chipColor(a.id)}"></span><span class="switcher-meta"><strong>${esc(a.config.title)}</strong><small>${esc(statusLabel(a))}</small></span></button>`).join('')||'<p class="hint">No other applications yet.</p>';
}
function updateCrumb(view){
  $('crumb-current').hidden=view!=='detail';
  $('share-btn').hidden=view!=='detail'||me.kind!=='owner';
  if(view==='detail')$('crumb-title').textContent=app.config.title;
}
function showView(v){
  $('empty').hidden=v!=='empty';$('home').hidden=v!=='home';$('detail').hidden=v!=='detail';
  document.body.dataset.view=v;
  updateCrumb(v);
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

let graduation;
// Every card button runs one of these, then the caller refreshes and (if a message came back)
// toasts it -- keeps each action self-contained instead of scattering confirm()/toast() calls
// across a dozen individual button handlers like the old toolbar did.
const RUN={
  generate:async()=>{await api('apps/'+app.id+'/generate',{});return 'Generating…';},
  build:async()=>{await api('apps/'+app.id+'/build',{});return 'Build started.';},
  publish:async()=>{await api('apps/'+app.id+'/publish',{});published=true;return 'Published.';},
  bind:async()=>{await api('apps/'+app.id+'/binding',{});return 'Mock claims service bound.';},
  regenerate:async()=>{
    if(!confirm('Regenerate "'+app.config.title+'" from scratch? This discards the current source and starts over — it cannot be undone (though any already-published release can still be rolled back to).'))return null;
    await api('apps/'+app.id+'/definition',{config:{title:app.config.title,brief:app.config.brief,accent:app.config.accent,kind:app.config.kind,tier:'intent'},revision:app.revision});
    api('apps/'+app.id+'/generate',{}).then(refresh).catch(error=>toast(error.message));
    return 'Regenerating from scratch…';
  },
  delete:async()=>{
    if(!confirm('Archive "'+app.config.title+'"? This hides it from your list — it isn’t permanently deleted, and an admin can restore or purge it later.'))return null;
    await apiDelete('apps/'+app.id);selected=null;
    return 'Archived.';
  },
};
// The single source of "what can I do, and why" -- a pure function of the app's real state, so
// it's always in sync with what's actually possible (unlike the old always-on button bar, which
// showed every action regardless of whether it made sense right now).
function proposals(){
  const isOwner=me.kind==='owner',hasKind=Boolean(app.config.kind),hasSource=['static','app'].includes(app.config.tier);
  if(app.generation?.status==='generating')return [{tone:'info',busy:true,title:'Generating…',body:`Authoring via ${app.generation.model||'the configured model'}. This usually takes under a minute.`}];
  if(app.build?.status==='building')return [{tone:'info',busy:true,title:'Building…',body:'Compiling and running the safety checks required before preview or publish.'}];
  const cards=[];
  const checks=app.build?.result?.checks||[],passed=checks.filter(c=>c.passed).length;
  const nextRelease=(app.release?.number||0)+1;
  if(hasKind&&!hasSource){
    const failed=app.generation?.status==='failed';
    cards.push({tone:failed?'warn':'action',title:failed?'Generation failed':'Not generated yet',body:failed?'The last attempt failed — see the log below. Retry, or describe the change you actually want.':'Ask for it below, or click Generate to author it from the brief.',actions:[{label:failed?'Retry generation':'Generate',run:'generate'}]});
  }else if(app.build?.status!=='ready'||app.build.revision!==app.revision){
    cards.push({tone:'action',title:'Build this app',body:'Compiles the current definition and runs the safety checks required before preview or publish.',actions:[{label:'Build application',run:'build'}]});
  }else if(!app.release||app.release.revision!==app.build.revision){
    // No redundant "Published · vN" info card once there's nothing left to do -- the status
    // badge in the detail bar already says that, and clicking it opens the publish/promote
    // modal. A card only appears here while there's a genuine next action to take.
    cards.push({tone:'primary',title:'Ready to publish',body:`Build passed ${passed}/${checks.length} checks${app.build.result?.sourceDigest?' ('+app.build.result.sourceDigest.slice(0,10)+')':''} and hasn't been released yet. Publishing makes it v${nextRelease} — the version your team sees.`,actions:[{label:'Publish as v'+nextRelease,run:'publish'}]});
  }
  if(isOwner&&!app.binding)cards.push({tone:'action',title:'Bind mock claims',body:'Grants access to synthetic claims data for testing. No live service.',actions:[{label:'Bind mock claims',run:'bind'}]});
  return cards;
}
function renderCards(){
  currentCards=proposals();
  $('chat-cards').innerHTML=currentCards.map((c,ci)=>`<div class="chat-card tone-${c.tone}${c.busy?' busy':''}"><strong>${esc(c.title)}</strong><p>${esc(c.body)}</p>${(c.actions||[]).map((a,ai)=>a.href?`<a class="button" href="${a.href}">${esc(a.label)}</a>`:`<button data-card="${ci}" data-action="${ai}">${esc(a.label)}</button>`).join('')}</div>`).join('');
}
// The thread merges audit[] (system events -- created, published, rolled back, document
// uploaded...) with comments[] (human notes) into one chronological record. Both already
// existed in the API response; audit[] specifically was fetched every 2s and never shown.
function renderThread(){
  const events=[
    ...(app.audit||[]).map(e=>({at:e.at,kind:'audit',text:e.event,actor:e.actor})),
    ...(app.comments||[]).map(c=>({at:c.createdAt,kind:'note',text:c.text,actor:c.author})),
    // Raw generation/build log lines (including failure reasons and the model that ran) --
    // previously shown in a details block that this redesign removed; folded into the same
    // thread rather than dropped, which is also where proposals()'s "see the log below" points.
    ...(app.generation?.logs||[]).map(l=>({at:l.at,kind:'log',text:l.text,actor:app.generation.model||null})),
    ...(app.build?.logs||[]).map(l=>({at:l.at,kind:'log',text:l.text,actor:null})),
  ].sort((a,b)=>new Date(a.at)-new Date(b.at));
  const thread=$('chat-thread');
  const wasAtBottom=thread.scrollHeight-thread.scrollTop-thread.clientHeight<40;
  thread.innerHTML=events.map(e=>`<div class="thread-item thread-${e.kind}"><span class="thread-text">${esc(e.text)}</span><span class="thread-meta">${esc(e.actor||'')} · ${new Date(e.at).toLocaleString()}</span></div>`).join('')||'<p class="hint">No activity yet. Ask for a change below to get started.</p>';
  if(wasAtBottom)thread.scrollTop=thread.scrollHeight;
}
const autoBuiltRevision={};
async function refresh(){
  me=await api('me');
  $('admin-link').hidden=me.kind!=='owner';$('new').hidden=me.kind==='collaborator';
  apps=await api('apps');
  if(!apps.length){selected=null;app=null;showView('empty');return;}
  // selected can point at an app that's no longer in the list (archived, e.g. by the delete
  // action below) -- fall back to the home view, not a stale detail view.
  if(selected&&apps.some(a=>a.id===selected)){app=await api('apps/'+selected);showView('detail');draw();}
  else{selected=null;app=null;renderHome();showView('home');}
}
function draw(){
  const isLive=app.generation?.status==='generating'||app.build?.status==='building';
  $('status').textContent=app.generation?.status==='generating'?'Generating…':app.build?.status==='building'?'Building…':app.release?'Published · v'+app.release.number:app.build?.status==='ready'?'Preview ready':'Draft';
  $('status').classList.toggle('live',isLive);
  $('app-owner-actions').hidden=me.kind!=='owner';$('app-owner-label').textContent=app.config.title;
  renderSwitcher();
  // Once generation lands, build automatically -- describing a brief should produce a working
  // preview in one motion. Guarded by revision so it only fires once per successful generation.
  if(app.generation?.status==='ready'&&app.generation.revision===app.revision&&autoBuiltRevision[app.id]!==app.revision&&app.build?.status!=='building'){
    autoBuiltRevision[app.id]=app.revision;
    api('apps/'+app.id+'/build',{}).then(refresh).catch(error=>toast(error.message));
  }
  const ready=published?Boolean(app.release):app.build?.status==='ready';const url='/api/apps/'+app.id+'/preview'+(published?'?published=1':'');
  const key=[app.id,published,app.build?.id,app.build?.status,app.release?.number,app.documents.length,app.comments.length,app.binding].join(':');
  $('preview').hidden=!ready;$('preview-empty').hidden=ready;$('preview').setAttribute('sandbox',app.config.tier==='static'?'allow-scripts':'');if(ready&&key!==previewKey){$('preview').src=url;previewKey=key;}
  $('open-preview').href=url;$('open-preview').hidden=!ready;
  $('canvas-view').hidden=historyOpen;$('history-view').hidden=!historyOpen;
  $('draft').classList.toggle('selected',!published&&!historyOpen);$('published').classList.toggle('selected',published&&!historyOpen);$('history').classList.toggle('selected',historyOpen);
  if(historyOpen)renderHistory();
  renderCards();renderThread();
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
async function enter(){me=await api('me');$('identity').textContent=me.label;$('login').hidden=true;$('workspace').hidden=false;$('connect').hidden=me.kind!=='owner';$('logout').textContent=me.authMode==='proxy'?'Sign out ↗':'Sign out';await refresh();}
$('signin').onsubmit=action(async()=>{await api('session',{token:$('token').value});$('token').value='';await enter();});
$('logout').onclick=action(async()=>{if(me&&me.authMode==='proxy'){location.href='/oauth2/sign_out';return;}await api('logout',{});location.href='/';});
$('new').onclick=$('start').onclick=()=>editor(false);
$('connect').onclick=()=>{$('user-dropdown').hidden=true;$('connection').showModal();};
$('kind').onchange=updateKindGuidance;
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
$('crumb-home').onclick=action(async()=>{selected=null;history.replaceState(null,'','/');await refresh();});
const openApp=action(async e=>{const b=e.target.closest('[data-app]');if(!b)return;selected=b.dataset.app;published=false;$('switcher-popover').hidden=true;history.replaceState(null,'','/?app='+selected);await refresh();});
$('home').onclick=openApp;$('switcher-list').onclick=openApp;
$('crumb-toggle').onclick=e=>{e.stopPropagation();renderSwitcher();$('switcher-popover').hidden=!$('switcher-popover').hidden;};
$('switcher-new').onclick=()=>{$('switcher-popover').hidden=true;editor(false);};
$('user-toggle').onclick=e=>{e.stopPropagation();$('user-dropdown').hidden=!$('user-dropdown').hidden;};
document.addEventListener('click',()=>{$('user-dropdown').hidden=true;$('switcher-popover').hidden=true;});
$('dd-regenerate').onclick=action(async()=>{$('user-dropdown').hidden=true;const message=await RUN.regenerate();await refresh();if(message)toast(message);});
$('dd-delete').onclick=action(async()=>{$('user-dropdown').hidden=true;const message=await RUN.delete();await refresh();if(message)toast(message);});
$('status').onclick=()=>graduation.open();
// Resizable chat width -- persisted so it isn't re-dragged every session. Clamped so the
// preview canvas can never be squeezed unusably narrow or the chat too narrow to type in.
(function(){
  const grid=document.querySelector('.workgrid'),handle=$('chat-resize');
  const saved=localStorage.getItem('pac-chat-w');if(saved)grid.style.setProperty('--chat-w',saved+'px');
  let dragging=false;
  handle.addEventListener('mousedown',e=>{dragging=true;e.preventDefault();});
  window.addEventListener('mousemove',e=>{
    if(!dragging)return;
    const w=Math.max(320,Math.min(720,grid.getBoundingClientRect().right-e.clientX));
    grid.style.setProperty('--chat-w',w+'px');
  });
  window.addEventListener('mouseup',()=>{if(!dragging)return;dragging=false;localStorage.setItem('pac-chat-w',parseInt(getComputedStyle(grid).getPropertyValue('--chat-w')));});
  handle.addEventListener('dblclick',()=>{grid.style.removeProperty('--chat-w');localStorage.removeItem('pac-chat-w');});
})();
// Share modal: collaborators (add/remove by email) plus the pre-existing one-time invite
// link flow, now with pending invites actually listed (GET /api/apps/:id/invites) instead
// of being created into a void with no way to see what's already outstanding.
async function refreshInviteList(){
  const invites=await api('apps/'+app.id+'/invites');
  $('invite-list').innerHTML=invites.map(i=>`<div class="thread-item"><span class="thread-text">${esc(i.label)}</span><span class="thread-meta">link expires ${new Date(i.expires).toLocaleTimeString()}</span></div>`).join('');
}
async function openShare(){
  $('share-list').innerHTML=(app.sharedWith||[]).map(email=>`<div class="thread-item"><span class="thread-text">${esc(email)}</span><button data-unshare="${esc(email)}" class="subtle">Remove</button></div>`).join('')||'<p class="hint">Nobody yet.</p>';
  await refreshInviteList();
  $('invite-url').hidden=true;
  $('share-dialog').showModal();
}
$('share-btn').onclick=action(openShare);
$('share-list').onclick=action(async e=>{const b=e.target.closest('[data-unshare]');if(!b)return;await api('apps/'+app.id+'/unshare',{email:b.dataset.unshare});await refresh();await openShare();});
$('share-form').onsubmit=action(async()=>{await api('apps/'+app.id+'/share',{email:$('share-email').value});$('share-email').value='';await refresh();await openShare();});
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
$('draft').onclick=()=>{published=false;historyOpen=false;draw();};$('published').onclick=()=>{published=true;historyOpen=false;draw();};$('history').onclick=()=>{historyOpen=true;draw();};
$('chat-cards').onclick=action(async e=>{
  const b=e.target.closest('[data-card]');if(!b)return;
  const card=currentCards[Number(b.dataset.card)],act=card.actions[Number(b.dataset.action)];
  if(!act.run)return;
  b.disabled=true;
  try{const message=await RUN[act.run]();await refresh();if(message)toast(message);}
  finally{if(app)b.disabled=false;}
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
$('upload').onchange=action(async()=>{const file=$('upload').files[0];if(!file)return;if(file.size>256000)throw new Error('Choose a file under 256 KB');const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);await api('apps/'+app.id+'/documents',{name:file.name,base64:btoa(binary)});$('upload').value='';await refresh();toast('Document added.');});
$('chat-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('chat-form').requestSubmit();}});
$('chat-form').onsubmit=action(async()=>{
  const text=$('chat-input').value.trim();if(!text)return;
  const hasSource=['static','app'].includes(app.config.tier);
  $('chat-input').value='';
  if(hasSource){await api('apps/'+app.id+'/generate',{changeRequest:text});toast('Requesting change…');}
  else await api('apps/'+app.id+'/comments',{text});
  await refresh();
});
$('invite-form').onsubmit=action(async()=>{const result=await api('apps/'+app.id+'/invite',{label:$('colleague').value});$('invite-url').value=result.url;$('invite-url').hidden=false;$('colleague').value='';$('invite-url').select();await refreshInviteList();});
const invitation=new URLSearchParams(location.hash.slice(1)).get('invite');if(invitation){history.replaceState(null,'',location.pathname+location.search);try{await api('session',{token:invitation});}catch(error){toast(error.message);}}
try{await enter();}catch{/* Login is shown until authenticated. */}
graduation=initGraduation({api,action,$,getApp:()=>app,getMe:()=>me,toast,esc,refresh});
setInterval(()=>{if(me&&!document.hidden)refresh().catch(error=>toast(error.message));},2000);
