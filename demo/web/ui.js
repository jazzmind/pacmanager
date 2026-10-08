const BASE=document.querySelector('meta[name="pac-base"]')?.content||'';
const LOGOUT_URL=document.querySelector('meta[name="pac-logout"]')?.content||'';
import { initGraduation } from './graduation-ui.js';
import { CAPABILITIES,CAPABILITY_GROUPS,USE_CASES,SENSITIVE_DATA_NOTICE,deriveKind,expandCapabilities } from './capabilities.js';
import { sigilSvg,paintArt,hueFor } from './art.js';
const $=id=>document.getElementById(id);
const qs=new URLSearchParams(location.search);
let me,app,apps=[],selected=qs.get('app'),published=qs.get('published')==='1',previewKey='',historyOpen=false,planOpen=false,planEditing=false,wantPlan=false,selectedRelease=null,currentCards=[],chatMode='chat',inflight=null;
const local=[],dismissedGen={}; // local = in-flight / failed chat entries, merged into the thread by nonce
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Markdown for LLM-written text: marked -> DOMPurify (vendored classic scripts, globals `marked` / `DOMPurify`).
// Links are forced to open in a new tab. If either global is missing, fall back to escaped text.
if(window.DOMPurify)DOMPurify.addHook('afterSanitizeAttributes',n=>{if(n.tagName==='A'){n.setAttribute('target','_blank');n.setAttribute('rel','noopener noreferrer');}});
function md(text){const t=String(text??'');if(window.marked&&window.DOMPurify){try{return DOMPurify.sanitize(marked.parse(t,{breaks:true,gfm:true}));}catch{/* fall through */}}return '<p>'+esc(t).replace(/\n/g,'<br>')+'</p>';}
// Only touch the DOM when the markup actually changed -- the 2s poll re-renders everything, and a blind innerHTML
// would restart animations, drop hover/focus and scroll positions.
const setHtml=(el,html)=>{if(el._h===html)return false;el._h=html;el.innerHTML=html;return true;};
const uuid=()=>crypto.randomUUID?.()||Date.now().toString(36)+Math.random().toString(36).slice(2);
const fmtClock=ms=>{const s=Math.max(0,Math.floor(ms/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};

// Deterministic inline-SVG card art (now the base layer under the aurora + constellation from art.js) (data: URI -- the preview CSP is img-src 'self' data:, no
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
  return `<button class="card" data-app="${esc(a.id)}"><div class="card-art aurora" data-seed="${esc(a.id)}"><img src="${placeholderArt(a.id)}" alt="">${sigilSvg(a.config.title,{w:200,h:120,key:a.id})}</div><div class="card-body"><strong>${esc(a.config.title)}</strong><div class="card-meta"><span class="card-badge status-${statusOf(a)}">${esc(statusLabel(a))}</span><span class="card-badge">${esc(kind)}</span></div><small>${new Date(a.createdAt).toLocaleDateString()}${a.lastDeployment?' · deployed':''}</small></div></button>`;
}
function renderHome(){
  const email=me?.email,isAdmin=me.kind==='owner';
  const mine=email?apps.filter(a=>a.ownerEmail===email):(isAdmin?apps:[]);
  const shared=email?apps.filter(a=>(a.sharedWith||[]).includes(email)):[];
  const mineIds=new Set(mine.map(a=>a.id));
  // "All applications" only ever shows what ISN'T already shown above.
  const extra=isAdmin?apps.filter(a=>!mineIds.has(a.id)):[];
  $('home-summary').textContent=`${apps.length} application${apps.length===1?'':'s'} · ${apps.filter(a=>a.published).length} published`;
  $('shelf-shared').hidden=!shared.length;$('shelf-all').hidden=!extra.length;
  for(const [id,list,empty] of [['cards-mine',mine,'<p>Nothing yet — create your first application.</p>'],['cards-shared',shared,''],['cards-all',extra,'']])if(setHtml($(id),list.map(cardHtml).join('')||empty))paintArt($(id));
}
function chipColor(seed){let h=0;for(const c of seed)h=(h*31+c.charCodeAt(0))>>>0;return brandColor(BRAND_ART_TOKENS[h%4],'#0078d6');}
function renderSwitcher(){
  $('crumb-title').textContent=app.config.title;
  if(setHtml($('switcher-list'),apps.map(a=>`<button class="switcher-row${a.id===app.id?' active':''}" data-app="${esc(a.id)}"><span class="switcher-chip" data-chip="${esc(a.id)}"></span><span class="switcher-meta"><strong>${esc(a.config.title)}</strong><small>${esc(statusLabel(a))}</small></span></button>`).join('')||'<p class="hint">No other applications yet.</p>'))
    $('switcher-list').querySelectorAll('[data-chip]').forEach(c=>c.style.setProperty('background',chipColor(c.dataset.chip)));
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

// The toast is a manual popover so it renders in the top layer, above any open modal <dialog> (composer, share, ...).
function toast(text){const t=$('toast');t.textContent=text;t.hidden=false;try{if(!t.matches(':popover-open'))t.showPopover();}catch{/* no popover support: plain fixed element */}clearTimeout(toast.timer);toast.timer=setTimeout(()=>{t.hidden=true;try{t.hidePopover();}catch{/* not open */}},6000);}
async function api(path,body){const r=await fetch(BASE+'/api/'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(data.error||'Request failed');e.status=r.status;throw e;}return data;}
async function apiDelete(path){const r=await fetch(BASE+'/api/'+path,{method:'DELETE'});const data=await r.json();if(!r.ok)throw new Error(data.error||'Request failed');return data;}
const action=fn=>async e=>{e?.preventDefault();try{await fn(e);}catch(error){toast(error.message);}};
// Generation is a long call: fire it and let the 2s poll / refresh show progress. A user-initiated cancel makes
// the in-flight request fail -- that is expected, not worth a toast.
const fireGenerate=(id,body)=>api('apps/'+id+'/generate',body).then(refresh).catch(error=>{if(!/cancel/i.test(error.message))toast(error.message);refresh().catch(()=>{});});
const hasSource=()=>['static','app'].includes(app.config.tier);
const planVisible=()=>Boolean(app?.plan?.text)&&app.plan.status!=='discarded';
// A fresh intent-tier app builds from {plan}; one that already has source takes a {changeRequest}.
const genBody=()=>planVisible()&&!hasSource()?{plan:app.plan.text}:{};

const KIND_DESCRIPTIONS={interactive:'a self-contained page — everything runs in your browser, nothing server-side',knowledge:'a knowledge page that displays agent-written briefings',application:'a real server application — a Dockerfile, built and deployed like any other service'};

let graduation;
// Every card button runs one of these, then the caller refreshes and (if a message came back) toasts it.
const RUN={
  generate:async()=>{fireGenerate(app.id,genBody());return 'Generating…';},
  retry:async()=>{dismissedGen[app.id]=null;fireGenerate(app.id,genBody());return 'Retrying…';},
  cancel:async()=>{await api('apps/'+app.id+'/generate/cancel',{});return 'Generation stopped.';},
  dismiss:async()=>{dismissedGen[app.id]=app.generation?.id||true;return null;},
  build:async()=>{await api('apps/'+app.id+'/build',{});return 'Build started.';},
  publish:async()=>{await api('apps/'+app.id+'/publish',{});published=true;return 'Published.';},
  // Building a plan is the ONLY thing that changes the app -- drafting/editing a plan never does.
  executePlan:async()=>{fireGenerate(app.id,hasSource()?{changeRequest:app.plan.text}:{plan:app.plan.text});return 'Building the plan…';},
  regenerate:async()=>{
    if(!confirm('Regenerate "'+app.config.title+'" from scratch? This discards the current source and starts over — it cannot be undone (though any already-published release can still be rolled back to).'))return null;
    await api('apps/'+app.id+'/definition',{config:{title:app.config.title,brief:app.config.brief,accent:app.config.accent,kind:app.config.kind,tier:'intent'},revision:app.revision});
    fireGenerate(app.id,{});
    return 'Regenerating from scratch…';
  },
  delete:async()=>{
    if(!confirm('Archive "'+app.config.title+'"? This hides it from your list — it isn’t permanently deleted, and an admin can restore or purge it later.'))return null;
    await apiDelete('apps/'+app.id);selected=null;
    return 'Archived.';
  },
};
// The single source of "what can I do, and why" -- a pure function of the app's real state.
function proposals(){
  const hasKind=Boolean(app.config.kind),g=app.generation;
  if(g?.status==='generating')return [{tone:'info',busy:true,title:'Generating…',body:`Authoring via ${g.model||'the configured model'}${g.currentAttempt&&g.maxAttempts?` · attempt ${g.currentAttempt} of ${g.maxAttempts}`:''}. This usually takes under a minute.`,actions:[{label:'Stop',run:'cancel',cls:'stop-btn'}]}];
  if(app.build?.status==='building')return [{tone:'info',busy:true,title:'Building…',body:'Compiling and running the safety checks required before preview or publish.'}];
  const cards=[];
  const checks=app.build?.result?.checks||[],passed=checks.filter(c=>c.passed).length;
  const nextRelease=(app.release?.number||0)+1;
  const stopped=g?.status==='cancelled'&&dismissedGen[app.id]!==(g.id||true);
  if(stopped)cards.push({tone:'warn',title:'Generation stopped',body:'You stopped this run. Nothing was built from it — retry whenever you like, or describe a different change.',actions:[{label:'Retry',run:'retry'},{label:'Dismiss',run:'dismiss',cls:'ghost'}]});
  if(hasKind&&!hasSource()){
    if(!stopped){const failed=g?.status==='failed';
      cards.push({tone:failed?'warn':'action',title:failed?'Generation failed':'Not generated yet',body:failed?'The last attempt failed — see the log below. Retry, or describe the change you actually want.':'Ask for it below, or click Generate to author it from the brief.',actions:[{label:failed?'Retry generation':'Generate',run:'generate'}]});}
  }else if(app.build?.status!=='ready'||app.build.revision!==app.revision){
    cards.push({tone:'action',title:'Build this app',body:'Compiles the current definition and runs the safety checks required before preview or publish.',actions:[{label:'Build application',run:'build'}]});
  }else if(!app.release||app.release.revision!==app.build.revision){
    cards.push({tone:'primary',title:'Ready to publish',body:`Build passed ${passed}/${checks.length} checks${app.build.result?.sourceDigest?' ('+app.build.result.sourceDigest.slice(0,10)+')':''} and hasn't been released yet. Publishing makes it v${nextRelease} — the version your team sees.`,actions:[{label:'Publish as v'+nextRelease,run:'publish'}]});
  }
  return cards;
}
function renderCards(){
  const showCards=chatMode==='chat'||chatMode==='plan';
  currentCards=showCards?proposals():[];
  $('chat-cards').hidden=!showCards||!currentCards.length;
  setHtml($('chat-cards'),currentCards.map((c,ci)=>`<div class="chat-card tone-${c.tone}${c.busy?' busy':''}"><strong>${esc(c.title)}</strong><div class="chat-card-body md">${md(c.body)}</div>${(c.actions||[]).map((a,ai)=>`<button type="button" data-card="${ci}" data-action="${ai}"${a.cls?` class="${a.cls}"`:''}>${a.cls==='stop-btn'?'<svg class="icon"><use href="#icon-stop"/></svg>':''}${esc(a.label)}</button>`).join('')}</div>`).join(''));
}
const EMPTY_THREAD_MESSAGE={chat:'No questions asked yet. Ask one below.',plan:'No changes planned yet. Describe one below to get a draft plan.',notes:'No notes yet. Leave one below.',log:'No generation, build or activity events yet.'};
const when=at=>new Date(at).toLocaleString();
const metaHtml=(who,at)=>`<span class="thread-meta">${esc(who||'')} · ${esc(when(at))}</span>`;
const planTitle=t=>{const m=String(t||'').match(/^\s{0,3}#{1,4}\s+(.+)$/m);return (m?m[1]:String(t||'').split('\n').find(l=>l.trim())||'Plan').replace(/[*_`#]/g,'').trim().slice(0,120);};
const THINKING='<span class="thinking"><span class="dots"><i></i><i></i><i></i></span>Thinking…</span>';
// Chat/Plan: server chatLog merged with local in-flight entries, keyed by nonce so a poll can never drop or duplicate a bubble.
function chatItems(){
  const server=(app.chatLog||[]).filter(c=>c.mode===chatMode),seen=new Set(server.map(c=>c.nonce).filter(Boolean)),items=[];
  const add=(c,l)=>{
    const k='c:'+(c.nonce||c.id||c.at),st=l?c.status:'done';
    items.push({key:k+':q',at:c.at,cls:'thread-item thread-chatlog-q'+(st==='pending'||st==='streaming'?' thread-pending':'')+(st==='failed'?' thread-failed':''),
      html:`<span class="thread-text">${esc(c.message)}</span>${st==='failed'?`<span class="thread-err">${esc(c.error||'Could not send.')} <button type="button" class="link-btn" data-retry="${esc(c.nonce)}">Retry</button> · <button type="button" class="link-btn" data-drop="${esc(c.nonce)}">Dismiss</button></span>`:''}${metaHtml(c.author,c.at)}`});
    if(st==='failed')return;
    const live=st==='pending'||st==='streaming',who=c.mode==='plan'?'Proposed plan':'Answer';
    let body;
    if(c.mode==='plan')body=`<span class="thread-text plan-ref"><svg class="icon"><use href="#icon-doc"/></svg><span class="plan-ref-title">${live&&!c.reply?'Drafting a plan…':esc(planTitle(c.reply))}</span>${live?'<span class="dots"><i></i><i></i><i></i></span>':'<button type="button" class="link-btn" data-openplan>Open plan →</button>'}</span>`;
    else body=live&&!c.reply?`<span class="thread-text">${THINKING}</span>`:`<span class="thread-text md">${md(c.reply)}</span>`;
    items.push({key:k+':a',at:c.at,cls:'thread-item thread-chatlog-a'+(live?' live':''),html:body+(st==='stopped'?'<span class="thread-meta">Stopped</span>':metaHtml(who,c.at))});
  };
  const merged=[...server.map(c=>[c,false]),...local.filter(l=>l.appId===app.id&&l.mode===chatMode&&!seen.has(l.nonce)).map(l=>[l,true])];
  merged.forEach(([c,l])=>add(c,l));
  return items;
}
function threadItems(){
  if(chatMode==='chat'||chatMode==='plan')return chatItems();
  const rows=chatMode==='log'?[
    ...(app.audit||[]).map(e=>({at:e.at,kind:'audit',text:e.event,actor:e.actor})),
    ...(app.generation?.logs||[]).map(l=>({at:l.at,kind:'log',text:l.text,actor:app.generation.model||null})),
    ...(app.build?.logs||[]).map(l=>({at:l.at,kind:'log',text:l.text,actor:null})),
  ]:(app.comments||[]).map(c=>({at:c.createdAt,kind:'note',text:c.text,actor:c.author}));
  return rows.map((e,i)=>({key:`${chatMode}:${e.at}:${i}`,at:e.at,cls:'thread-item thread-'+e.kind,html:`<span class="thread-text">${esc(e.text)}</span>${metaHtml(e.actor,e.at)}`}));
}
// Keyed reconcile: existing nodes are updated only when their markup changed, so an in-flight bubble keeps its DOM (and the
// scroll position survives) no matter how often the poll re-renders.
function renderThread(forceBottom){
  const box=$('chat-thread'),items=threadItems().map((it,i)=>({...it,i})).sort((a,b)=>new Date(a.at)-new Date(b.at)||a.i-b.i);
  const atBottom=box.scrollHeight-box.scrollTop-box.clientHeight<40;
  if(!items.length){setHtml(box,`<p class="hint">${esc(EMPTY_THREAD_MESSAGE[chatMode])}</p>`);return;}
  if(box._h!==undefined){box._h=undefined;box.innerHTML='';}
  [...box.children].filter(c=>!c.dataset.key).forEach(c=>c.remove());
  const old=new Map([...box.children].map(c=>[c.dataset.key,c]));let prev=null;
  for(const it of items){
    let el=old.get(it.key);old.delete(it.key);
    if(!el){el=document.createElement('div');el.dataset.key=it.key;}
    if(el._h!==it.html||el.className!==it.cls){el.className=it.cls;el.innerHTML=it.html;el._h=it.html;}
    const ref=prev?prev.nextSibling:box.firstChild;if(ref!==el)box.insertBefore(el,ref);prev=el;
  }
  old.forEach(el=>el.remove());
  if(atBottom||forceBottom===true)box.scrollTop=box.scrollHeight;
}
let threadTimer=0;const scheduleThread=()=>{if(threadTimer)return;threadTimer=setTimeout(()=>{threadTimer=0;if(app)renderThread();},50);};
const autoBuiltRevision={};
async function refresh(){
  me=await api('me');
  $('admin-link').hidden=me.kind!=='owner';$('new').hidden=me.kind==='collaborator';
  apps=await api('apps');
  if(!apps.length){selected=null;app=null;showView('empty');return;}
  if(selected&&apps.some(a=>a.id===selected)){app=await api('apps/'+selected);showView('detail');draw();}
  else{selected=null;app=null;renderHome();showView('home');}
}
// Status pill: "Generating · m:ss · attempt n/N" ticks every second from startedAt, with a Stop button beside it.
function pillText(){
  const g=app.generation;
  if(g?.status==='generating')return 'Generating · '+fmtClock(Date.now()-(Date.parse(g.startedAt)||Date.now()))+(g.currentAttempt&&g.maxAttempts?` · attempt ${g.currentAttempt}/${g.maxAttempts}`:'');
  return app.build?.status==='building'?'Building…':app.release?'Published · v'+app.release.number:app.build?.status==='ready'?'Preview ready':'Draft';
}
function renderPill(){
  if(!app)return;const gen=app.generation?.status==='generating';
  $('status').textContent=pillText();$('status').classList.toggle('live',gen||app.build?.status==='building');$('gen-stop').hidden=!gen;
}
setInterval(()=>{if(app&&app.generation?.status==='generating'&&!$('detail').hidden)renderPill();},1000);
function draw(){
  renderPill();
  $('app-owner-actions').hidden=me.kind!=='owner';$('app-owner-label').textContent=app.config.title;
  renderSwitcher();
  // Once generation lands, build automatically. Only status 'ready' triggers it -- a cancelled/failed run never does.
  if(app.generation?.status==='ready'&&app.generation.revision===app.revision&&autoBuiltRevision[app.id]!==app.revision&&app.build?.status!=='building'){
    autoBuiltRevision[app.id]=app.revision;
    api('apps/'+app.id+'/build',{}).then(refresh).catch(error=>toast(error.message));
  }
  if(wantPlan&&planVisible()){planOpen=true;historyOpen=false;wantPlan=false;}
  else if(wantPlan&&['ready','failed','cancelled'].includes(app.generation?.status))wantPlan=false;
  if(planOpen&&!planVisible()){planOpen=false;planEditing=false;}
  const ready=published?Boolean(app.release):app.build?.status==='ready';const url=BASE+'/api/apps/'+app.id+'/preview'+(published?'?published=1':'');
  const key=[app.id,published,app.build?.id,app.build?.status,app.release?.number,app.documents.length,app.comments.length,app.binding].join(':');
  $('preview').hidden=!ready;$('preview-empty').hidden=ready;$('preview').setAttribute('sandbox',app.config.tier==='static'?'allow-scripts':'');if(ready&&key!==previewKey){$('preview').src=url;previewKey=key;}
  $('open-preview').href=url;$('open-preview').hidden=!ready;
  $('canvas-view').hidden=historyOpen||planOpen;$('history-view').hidden=!historyOpen||planOpen;$('plan-view').hidden=!planOpen;
  const base=!historyOpen&&!planOpen;
  $('draft').classList.toggle('selected',!published&&base);$('published').classList.toggle('selected',published&&base);$('history').classList.toggle('selected',historyOpen&&!planOpen);$('plan-tab').classList.toggle('selected',planOpen);
  $('plan-tab').hidden=!planVisible();$('plan-dot').hidden=!(planVisible()&&app.plan.status==='draft');
  if(historyOpen&&!planOpen)renderHistory();
  if(planOpen)renderPlan();
  for(let i=local.length-1;i>=0;i--)if(local[i].status==='done'&&(app.chatLog||[]).some(c=>c.nonce===local[i].nonce))local.splice(i,1);
  setChatMode(chatMode);renderCards();renderThread();
}
// The plan lives on the app (app.plan), so it survives a reload; this is the full-width reading/editing surface.
const PLAN_LABEL={draft:'Draft',executing:'Building…',executed:'Built'};
function renderPlan(){
  const p=app.plan,busy=p.status==='executing'||app.generation?.status==='generating';
  $('plan-status').textContent=PLAN_LABEL[p.status]||p.status;$('plan-status').className='plan-chip plan-'+p.status;
  $('plan-meta').textContent=[p.by,p.at&&when(p.at)].filter(Boolean).join(' · ');
  $('plan-build').disabled=busy||planEditing;$('plan-build').lastChild.textContent=p.status==='executed'?'Build again':'Build this plan';
  $('plan-edit').hidden=busy||planEditing;$('plan-discard').hidden=busy||planEditing;
  $('plan-body').hidden=planEditing;$('plan-editor').hidden=!planEditing;
  if(!planEditing)setHtml($('plan-body'),md(p.text));
}
function renderHistory(){
  const releases=(app.releases||[]).slice().reverse();
  if(!selectedRelease||!releases.some(r=>r.number===selectedRelease))selectedRelease=releases[0]?.number??null;
  setHtml($('release-history-full'),releases.map(r=>{
    const current=app.release&&app.release.number===r.number;
    return `<button class="release-row-btn${r.number===selectedRelease?' selected':''}" data-release="${r.number}"><strong>Release v${r.number}</strong><small>${new Date(r.publishedAt).toLocaleString()}</small>${current?'<span class="tag-current">current</span>':''}</button>`;
  }).join('')||'<p class="hint pad">No releases published yet.</p>');
  const current=app.release&&app.release.number===selectedRelease;
  $('history-rollback').hidden=!selectedRelease||current||me.kind!=='owner';
  $('history-preview').setAttribute('sandbox',app.config.tier==='static'?'allow-scripts':'');
  const src=selectedRelease?BASE+'/api/apps/'+app.id+'/preview?release='+selectedRelease:'';
  if($('history-preview').dataset.src!==src){$('history-preview').dataset.src=src;$('history-preview').src=src;}
}
async function enter(){me=await api('me');$('identity').textContent=me.label;$('login').hidden=true;$('workspace').hidden=false;$('connect').hidden=me.kind!=='owner';$('logout').textContent=me.authMode==='proxy'?'Sign out ↗':'Sign out';await refresh();}
$('signin').onsubmit=action(async()=>{await api('session',{token:$('token').value});$('token').value='';await enter();});
$('logout').onclick=action(async()=>{
  if(me&&me.authMode==='proxy'){
    if(LOGOUT_URL){const f=document.createElement('form');f.method='POST';f.action=LOGOUT_URL;document.body.appendChild(f);f.submit();return;}
    location.href='/oauth2/sign_out';return;
  }
  await api('logout',{});location.href=BASE+'/';
});
$('new').onclick=$('start').onclick=()=>openComposer();
$('connect').onclick=()=>{$('user-dropdown').hidden=true;$('connection').showModal();};
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
const resetView=()=>{planOpen=false;planEditing=false;wantPlan=false;historyOpen=false;};
$('crumb-home').onclick=action(async()=>{selected=null;resetView();history.replaceState(null,'',BASE+'/');await refresh();});
const openApp=action(async e=>{const b=e.target.closest('[data-app]');if(!b)return;selected=b.dataset.app;published=false;resetView();$('switcher-popover').hidden=true;history.replaceState(null,'',BASE+'/?app='+selected);await refresh();});
$('home').onclick=openApp;$('switcher-list').onclick=openApp;
$('crumb-toggle').onclick=e=>{e.stopPropagation();renderSwitcher();$('switcher-popover').hidden=!$('switcher-popover').hidden;};
$('switcher-new').onclick=()=>{$('switcher-popover').hidden=true;openComposer();};
$('user-toggle').onclick=e=>{e.stopPropagation();$('user-dropdown').hidden=!$('user-dropdown').hidden;};
document.addEventListener('click',()=>{$('user-dropdown').hidden=true;$('switcher-popover').hidden=true;});
$('dd-regenerate').onclick=action(async()=>{$('user-dropdown').hidden=true;const message=await RUN.regenerate();await refresh();if(message)toast(message);});
$('dd-delete').onclick=action(async()=>{$('user-dropdown').hidden=true;const message=await RUN.delete();await refresh();if(message)toast(message);});
$('status').onclick=()=>graduation.open();
$('gen-stop').onclick=action(async()=>{$('gen-stop').disabled=true;try{await RUN.cancel();toast('Generation stopped.');await refresh();}finally{$('gen-stop').disabled=false;}});
// Chat panel layout: resizable + expandable on wide screens, collapsible to a slim rail, and a bottom sheet below 1150px.
const CHAT_WIDE_PX=680;
let chatExpanded=false;
(function(){
  const grid=document.querySelector('.workgrid'),handle=$('chat-resize'),expandBtn=$('chat-expand'),sheetBtn=$('chat-handle');
  const savedWidth=()=>{const saved=localStorage.getItem('pac-chat-w');return saved?saved+'px':null;};
  const applyWidth=()=>{
    const w=chatExpanded?CHAT_WIDE_PX+'px':savedWidth();
    if(w)grid.style.setProperty('--chat-w',w);else grid.style.removeProperty('--chat-w');
    expandBtn.classList.toggle('expanded',chatExpanded);
    expandBtn.title=chatExpanded?'Shrink chat width':'Expand chat width';
  };
  applyWidth();
  let dragging=false;
  handle.addEventListener('mousedown',e=>{dragging=true;chatExpanded=false;e.preventDefault();});
  window.addEventListener('mousemove',e=>{
    if(!dragging)return;
    const w=Math.max(320,Math.min(720,grid.getBoundingClientRect().right-e.clientX));
    grid.style.setProperty('--chat-w',w+'px');
  });
  window.addEventListener('mouseup',()=>{if(!dragging)return;dragging=false;localStorage.setItem('pac-chat-w',parseInt(getComputedStyle(grid).getPropertyValue('--chat-w')));expandBtn.classList.toggle('expanded',false);});
  handle.addEventListener('dblclick',()=>{chatExpanded=false;grid.style.removeProperty('--chat-w');localStorage.removeItem('pac-chat-w');applyWidth();});
  expandBtn.addEventListener('click',()=>{chatExpanded=!chatExpanded;applyWidth();});
  // Collapse to a rail (wide) -- persisted like pac-chat-w.
  const setCollapsed=c=>{grid.dataset.chat=c?'collapsed':'open';localStorage.setItem('pac-chat-collapsed',c?'1':'0');};
  setCollapsed(localStorage.getItem('pac-chat-collapsed')==='1');
  $('chat-collapse').addEventListener('click',()=>setCollapsed(true));$('chat-rail').addEventListener('click',()=>setCollapsed(false));
  // Bottom sheet (narrow): click the handle to peek/open, drag it to resize.
  const setSheet=o=>{grid.dataset.sheet=o?'open':'closed';sheetBtn.setAttribute('aria-expanded',String(o));localStorage.setItem('pac-chat-sheet',o?'open':'closed');};
  setSheet(localStorage.getItem('pac-chat-sheet')==='open');
  const sh=Number(localStorage.getItem('pac-chat-sheet-h'));if(sh)grid.style.setProperty('--sheet-h',sh+'px');
  let drag=null;
  sheetBtn.addEventListener('pointerdown',e=>{drag={y:e.clientY,moved:false};sheetBtn.setPointerCapture(e.pointerId);});
  sheetBtn.addEventListener('pointermove',e=>{
    if(!drag)return;if(Math.abs(e.clientY-drag.y)>5)drag.moved=true;if(!drag.moved)return;
    const h=Math.max(160,Math.min(innerHeight*0.88,innerHeight-e.clientY));grid.style.setProperty('--sheet-h',h+'px');setSheet(true);drag.h=h;
  });
  sheetBtn.addEventListener('pointerup',()=>{if(!drag)return;if(drag.moved&&drag.h)localStorage.setItem('pac-chat-sheet-h',String(Math.round(drag.h)));else setSheet(grid.dataset.sheet!=='open');drag=null;});
  window.openChatPanel=()=>{if(grid.dataset.chat==='collapsed')setCollapsed(false);if(grid.dataset.sheet!=='open')setSheet(true);};
})();
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
$('draft').onclick=()=>{published=false;resetView();draw();};$('published').onclick=()=>{published=true;resetView();draw();};$('history').onclick=()=>{resetView();historyOpen=true;draw();};
$('plan-tab').onclick=()=>{historyOpen=false;planOpen=true;draw();};
$('chat-cards').onclick=action(async e=>{
  const b=e.target.closest('[data-card]');if(!b)return;
  const card=currentCards[Number(b.dataset.card)],act=card.actions[Number(b.dataset.action)];
  if(!act.run)return;
  b.disabled=true;
  try{const message=await RUN[act.run]();await refresh();if(message)toast(message);}
  finally{if(app)b.disabled=false;}
});
// ---- plan tab actions
$('plan-build').onclick=action(async()=>{$('plan-build').disabled=true;const message=await RUN.executePlan();await refresh();toast(message);});
$('plan-edit').onclick=()=>{planEditing=true;$('plan-text').value=app.plan.text;renderPlan();$('plan-text').focus();};
$('plan-cancel').onclick=()=>{planEditing=false;renderPlan();};
$('plan-save').onclick=action(async()=>{const text=$('plan-text').value.trim();if(!text)throw new Error('A plan cannot be empty — discard it instead.');await api('apps/'+app.id+'/plan',{text});planEditing=false;await refresh();toast('Plan saved.');});
$('plan-discard').onclick=action(async()=>{if(!confirm('Discard this plan? Nothing has been built from it.'))return;await api('apps/'+app.id+'/plan',{status:'discarded'});planOpen=false;planEditing=false;await refresh();toast('Plan discarded.');});
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
const CHAT_MODE_PLACEHOLDER={chat:'Ask about this app…',plan:'Describe a change…',notes:'Add a note…'};
function setChatMode(mode){
  chatMode=mode;
  document.querySelectorAll('#chat-modes [data-mode]').forEach(b=>b.classList.toggle('selected',b.dataset.mode===mode));
  $('chat-form').hidden=mode==='log';
  if(mode!=='log')$('chat-input').placeholder=CHAT_MODE_PLACEHOLDER[mode];
}
$('chat-modes').onclick=e=>{const b=e.target.closest('[data-mode]');if(!b)return;setChatMode(b.dataset.mode);renderCards();renderThread(true);};
// Auto-growing composer textarea: 1-6 lines, scrolls only past that.
const MAX_INPUT_PX=6*20+18;
function autosize(){const t=$('chat-input');t.style.height='auto';const h=t.scrollHeight+2;t.style.height=Math.min(h,MAX_INPUT_PX)+'px';t.style.overflowY=h>MAX_INPUT_PX?'auto':'hidden';}
$('chat-input').addEventListener('input',autosize);
$('chat-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('chat-form').requestSubmit();}});
function setBusy(b){$('chat-send').disabled=b;$('chat-send').hidden=b;$('chat-stop').hidden=!b;}
// Server-sent events over fetch (EventSource can't POST): "event:" / "data:" blocks separated by a blank line; ": ping" comments ignored.
async function readSse(body,on){
  const rd=body.getReader(),dec=new TextDecoder();let buf='';
  for(;;){
    const {done,value}=await rd.read();if(done)break;
    buf=(buf+dec.decode(value,{stream:true})).replace(/\r\n/g,'\n');let i;
    while((i=buf.indexOf('\n\n'))>=0){
      const block=buf.slice(0,i);buf=buf.slice(i+2);let ev='message';const data=[];
      for(const line of block.split('\n')){if(line.startsWith(':'))continue;if(line.startsWith('event:'))ev=line.slice(6).trim();else if(line.startsWith('data:'))data.push(line.slice(5).replace(/^ /,''));}
      if(data.length){let j=data.join('\n');try{j=JSON.parse(j);}catch{/* keep raw */}on(ev,j);}
    }
  }
}
const dropLocal=e=>{const i=local.indexOf(e);if(i>=0)local.splice(i,1);};
// A finished local entry stays (status 'done') until the server's chatLog contains its nonce -- see draw() -- so a poll that
// raced the server's write can't make the bubble blink out.
function finishChat(e,entry){Object.assign(e,entry||{},{nonce:e.nonce,appId:e.appId,status:'done'});}
// Optimistic send: the user bubble and a "Thinking…" assistant bubble appear instantly, the reply streams in, and a failure
// turns the user bubble into a failed one with Retry. Local entries are keyed by nonce so polls merge instead of wiping them.
async function sendChat(mode,message){
  const e={nonce:uuid(),appId:app.id,mode,message,reply:'',status:'pending',author:me?.label||'You',at:new Date().toISOString(),ctrl:new AbortController()};
  local.push(e);inflight=e;setBusy(true);window.openChatPanel?.();renderThread(true);
  try{
    const res=await fetch(BASE+'/api/apps/'+e.appId+'/chat',{method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream'},body:JSON.stringify({mode,message,nonce:e.nonce}),signal:e.ctrl.signal});
    if(!res.ok){const d=await res.json().catch(()=>({}));throw new Error(d.error||'Request failed');}
    if(!(res.headers.get('content-type')||'').includes('text/event-stream')){const d=await res.json();finishChat(e,d.reply!==undefined&&!d.message?{...d,mode,message,nonce:e.nonce}:d);}
    else await readSse(res.body,(ev,data)=>{
      if(ev==='delta'){e.reply+=data?.text??'';e.status='streaming';scheduleThread();}
      else if(ev==='done'){finishChat(e,typeof data==='object'?data:null);}
      else if(ev==='error'){throw new Error(data?.error||'The reply failed.');}
    });
    if(e.status!=='done')throw new Error('The connection closed before the reply finished.');
  }catch(err){
    if(err.name==='AbortError'||e.ctrl.signal.aborted){
      if(e.reply){e.status='stopped';}else{dropLocal(e);if(!$('chat-input').value)$('chat-input').value=message;autosize();}
    }else{e.status='failed';e.error=err.message;e.reply='';}
  }finally{
    if(inflight===e){inflight=null;setBusy(false);}
    renderThread();
  }
  if(e.status==='done'){await refresh();if(mode==='plan')toast('Plan drafted — open it in the Plan tab.');}
}
$('chat-stop').onclick=()=>inflight?.ctrl.abort();
$('chat-thread').onclick=e=>{
  const r=e.target.closest('[data-retry]'),d=e.target.closest('[data-drop]');
  if(r){const entry=local.find(l=>l.nonce===r.dataset.retry);if(!entry||inflight)return;dropLocal(entry);sendChat(entry.mode,entry.message);}
  else if(d){const entry=local.find(l=>l.nonce===d.dataset.drop);if(entry){dropLocal(entry);renderThread();}}
  else if(e.target.closest('[data-openplan]')){if(planVisible()){historyOpen=false;planOpen=true;draw();}else toast('No open plan for this app.');}
};
$('chat-form').onsubmit=action(async()=>{
  if(chatMode==='log'||inflight)return; // log is read-only; one reply at a time
  const text=$('chat-input').value.trim();if(!text)return;
  $('chat-input').value='';autosize();
  if(chatMode==='notes'){await api('apps/'+app.id+'/comments',{text});await refresh();return;}
  sendChat(chatMode,text);
});
$('invite-form').onsubmit=action(async()=>{const result=await api('apps/'+app.id+'/invite',{label:$('colleague').value});$('invite-url').value=result.url;$('invite-url').hidden=false;$('colleague').value='';$('invite-url').select();await refreshInviteList();});
// ---------------------------------------------------------------------------------------------------------------------
// New-application composer: full-screen, 3 steps (Idea -> Draft -> Confirm). The AI drafts title, capabilities and a plan
// from a plain-language idea (POST api/drafts); nobody has to tick boxes unless they choose the manual escape hatch.
// Draft state + conversation history live in sessionStorage so a refresh doesn't lose them.
const CMP_KEY='pac-composer';
let cs=null,cmpToken=0,cmpBusy=false,cmpMenu=false;
const freshCs=()=>({step:1,prompt:'',history:[],draft:null,caps:[],title:'',summary:'',accent:$('accent').options[0]?.value||'',manual:false,error:null,errStatus:0,lastUser:''});
const saveCs=()=>{try{sessionStorage.setItem(CMP_KEY,JSON.stringify({...cs,open:$('composer').open}));}catch{/* storage full/blocked: draft just won't survive a refresh */}};
const effectiveCaps=()=>new Set(expandCapabilities(cs.caps));
const capById=id=>CAPABILITIES.find(c=>c.id===id);
const accentLabel=v=>[...$('accent').options].find(o=>o.value===v)?.textContent||v;
function openComposer(){cs=freshCs();showComposer();}
function showComposer(){if(!$('composer').open)$('composer').showModal();renderComposer();}
function swatchesHtml(){return `<div class="swatches" role="group" aria-label="Accent colour">${[...$('accent').options].map(o=>`<button type="button" class="swatch${o.value===cs.accent?' selected':''}" data-accent="${esc(o.value)}" data-sw="${esc(o.value)}" title="${esc(o.textContent)}" aria-label="Accent: ${esc(o.textContent)}" aria-pressed="${o.value===cs.accent}"></button>`).join('')}<small>${esc(accentLabel(cs.accent))}</small></div>`;}
// Brand accent hexes aren't exposed to the page, only keys/labels -- use the key as a CSS colour when it is one ("teal"),
// otherwise a stable generated hue, so swatches stay distinguishable and brand-neutral.
function paintSwatches(root){root.querySelectorAll('[data-sw]').forEach(s=>{const v=s.dataset.sw,hex=$('accent').querySelector(`option[value="${CSS.escape(v)}"]`)?.dataset.color;s.style.setProperty('--sw',hex||`hsl(${hueFor(v)} 70% 45%)`);});}
function chipsHtml(editable){
  const eff=effectiveCaps(),why=new Map((cs.draft?.capabilities||[]).map(c=>[c.id,c.why]));
  const chips=[...eff].map(id=>{const c=capById(id);if(!c)return '';const implied=!cs.caps.includes(id),tip=why.get(id)||c.description;
    return `<span class="chip${implied?' implied':''}" title="${esc(tip)}"><span class="chip-main"><b>${esc(c.label)}</b><small>${esc(tip)}</small></span>${implied?'<em class="cap-tag">included</em>':editable?`<button type="button" class="chip-x" data-rm="${esc(id)}" aria-label="Remove ${esc(c.label)}"><svg class="icon"><use href="#icon-x"/></svg></button>`:''}</span>`;}).join('');
  const rest=CAPABILITIES.filter(c=>c.group!=='future'&&!eff.has(c.id));
  const add=editable&&rest.length?`<span class="addwrap"><button type="button" class="chip chip-add" data-act="addmenu" aria-expanded="${cmpMenu}"><svg class="icon"><use href="#icon-plus"/></svg>Add</button><div class="addmenu"${cmpMenu?'':' hidden'}>${rest.map(c=>`<button type="button" data-add="${esc(c.id)}"><b>${esc(c.label)}</b><small>${esc(c.description)}</small></button>`).join('')}</div></span>`:'';
  return (chips||'<span class="hint">No extra capabilities — a simple self-contained page.</span>')+add;
}
const kindLine=()=>{const k=deriveKind([...effectiveCaps()]);return `This will be built as ${KIND_DESCRIPTIONS[k]}.`;};
function renderCapabilityGroups(){
  const effective=effectiveCaps(),explicit=new Set(cs.caps);
  $('capability-groups').innerHTML=CAPABILITY_GROUPS.map(group=>{
    const items=CAPABILITIES.filter(c=>c.group===group.id);
    return `<div class="cap-group"><h4>${esc(group.label)}</h4><p class="hint">${esc(group.hint)}</p>${items.map(c=>{
      const checked=effective.has(c.id),implied=checked&&!explicit.has(c.id),disabled=group.id==='future'||implied;
      return `<label class="cap-item${disabled?' cap-disabled':''}"><input type="checkbox" data-cap="${esc(c.id)}"${checked?' checked':''}${disabled?' disabled':''}><span><strong>${esc(c.label)}</strong>${group.id==='future'?'<em class="cap-tag">not yet</em>':implied?'<em class="cap-tag">included</em>':''}<small>${esc(c.description)}</small></span></label>`;
    }).join('')}</div>`;
  }).join('')+`<p class="hint warn">${esc(SENSITIVE_DATA_NOTICE)}</p>`;
  $('kind-derived').textContent=kindLine();
}
const ideaPrompt=u=>u.description.replace(/\s*\([^)]*\)/g,'').trim();
function step1Html(){
  const warn='';
  return `<section class="cmp-hero aurora" data-seed="what-should-we-build">${sigilSvg('What should we build',{w:720,h:220,key:'composer-hero'})}<div class="cmp-hero-copy"><p class="eyebrow">From idea to application</p><h1>What should we build?</h1><p>Describe it in your own words. We’ll sketch the application, the capabilities it needs and a plan — you review before anything is built.</p></div></section>
<div class="cmp-prompt"><textarea id="cmp-prompt" rows="4" maxlength="3000" placeholder="e.g. A claims-triage dashboard where adjusters can filter synthetic claims, chart them and export a summary.">${esc(cs.prompt)}</textarea><div class="cmp-prompt-row"><span class="hint"><kbd>${/Mac|iP/.test(navigator.platform)?'⌘':'Ctrl'}</kbd> + <kbd>Enter</kbd> to sketch</span><button type="button" id="cmp-sketch" class="primary" data-act="sketch"><svg class="icon"><use href="#icon-sparkle"/></svg>Sketch it</button></div>${warn}<p class="cmp-skip"><button type="button" class="link-btn" data-act="manual">Skip the AI — pick capabilities manually</button></p></div>
<h3 class="cmp-sub">Or start from an idea</h3><div class="ideas">${USE_CASES.map(u=>`<button type="button" class="idea" data-usecase="${esc(u.id)}"><div class="idea-art aurora" data-seed="${esc(u.id)}">${sigilSvg(u.label,{w:220,h:110,key:u.id})}</div><div class="idea-body"><strong>${esc(u.label)}</strong><p>${esc(ideaPrompt(u))}</p></div></button>`).join('')}</div>`;
}
function step2Html(){
  if(cs.manual)return `<div class="cmp-narrow"><h2>Pick it yourself</h2><p class="hint">No AI involved — name it, describe it and tick what it should be able to do.</p>
<label>Application name<input id="cmp-title" maxlength="80" placeholder="Claims team workspace" value="${esc(cs.title)}"></label>
<label>Describe what your team needs<textarea id="cmp-summary" maxlength="3000" placeholder="Help adjusters review synthetic claims, share guidance and discuss follow-ups.">${esc(cs.summary||cs.prompt)}</textarea></label>
<div class="cmp-block"><h4>Accent</h4>${swatchesHtml()}</div>
<div id="capability-picker"><p class="eyebrow">WHAT SHOULD IT BE ABLE TO DO?</p><div id="capability-groups"></div></div><p class="hint kind-line" id="kind-derived"></p>
<p class="cmp-skip"><button type="button" class="link-btn" data-act="back">← Use the AI sketch instead</button></p></div>`;
  if(cmpBusy)return `<div class="cmp-narrow sketching" role="status" aria-live="polite"><div class="sketch-art aurora" data-seed="sketching">${sigilSvg('sketching your application',{w:420,h:150,key:'sketching'})}</div><p class="eyebrow">Sketching your application…</p><div class="sk sk-title"></div><div class="sk sk-line"></div><div class="sk sk-line short"></div><div class="sk-chips"><i></i><i></i><i></i><i></i></div><div class="sk sk-block"></div></div>`;
  if(cs.error)return `<div class="cmp-narrow"><div class="cmp-error" role="alert"><strong>Couldn’t sketch that</strong><p>${esc(cs.error)}</p><div class="cmp-error-actions"><button type="button" class="primary" data-act="retry">Retry</button><button type="button" class="ghost" data-act="back">Edit my idea</button><button type="button" class="link-btn" data-act="manual">Skip the AI — pick capabilities manually</button></div></div></div>`;
  const d=cs.draft;if(!d)return '<div class="cmp-narrow"><p class="hint">Nothing sketched yet.</p><button type="button" class="primary" data-act="back">Back</button></div>';
  const unavailable=(d.unavailable||[]).map(u=>`<li><b>${esc(capById(u.id)?.label||u.id)}</b> — ${esc(u.why)}</li>`).join('');
  const questions=(d.questions||[]).map(q=>`<li>${esc(q)}</li>`).join('');
  return `<div class="cmp-grid"><div class="cmp-col">
<label>Name<input id="cmp-title" maxlength="80" value="${esc(cs.title)}"></label>
<label>What it does<textarea id="cmp-summary" rows="3" maxlength="3000">${esc(cs.summary)}</textarea></label>
<div class="cmp-block"><h4>Capabilities</h4><div class="chips" id="cmp-chips">${chipsHtml(true)}</div><p class="hint kind-line"><b>${esc(kindLine())}</b> ${esc(d.kindRationale||'')}</p></div>
${unavailable?`<div class="cmp-block cmp-unavailable"><h4>Not available yet</h4><ul>${unavailable}</ul></div>`:''}
<div class="cmp-block"><h4>Accent</h4>${swatchesHtml()}</div>
<p class="cmp-skip"><button type="button" class="link-btn" data-act="manual">Skip the AI — pick capabilities manually</button></p></div>
<div class="cmp-col"><details class="cmp-plan" open><summary>The plan</summary><div class="md">${md(d.plan||'')}</div></details>
<div class="cmp-block cmp-refine"><h4>${questions?'A few questions':'Want to change something?'}</h4>${questions?`<ul>${questions}</ul>`:''}<textarea id="cmp-reply" rows="2" maxlength="2000" placeholder="Answer here, or tell me what to change…"></textarea><div class="cmp-prompt-row"><span class="hint"><kbd>${/Mac|iP/.test(navigator.platform)?'⌘':'Ctrl'}</kbd> + <kbd>Enter</kbd></span><button type="button" class="ghost" data-act="refine">Refine</button></div></div></div></div>`;
}
function step3Html(){
  const d=cs.draft;
  return `<div class="cmp-narrow cmp-confirm"><p class="eyebrow">Ready to build</p><h2>${esc(cs.title)}</h2><p class="cmp-lede">${esc(cs.summary||cs.prompt)}</p>
<div class="cmp-block"><h4>It will be able to</h4><div class="chips">${chipsHtml(false)}</div><p class="hint kind-line">${esc(kindLine())}</p></div>
<div class="cmp-block"><h4>Accent</h4><div class="swatches"><button type="button" class="swatch selected" data-sw="${esc(cs.accent)}" aria-label="${esc(accentLabel(cs.accent))}" disabled></button><small>${esc(accentLabel(cs.accent))}</small></div></div>
${d?.plan?`<details class="cmp-plan"><summary>The plan</summary><div class="md">${md(d.plan)}</div></details>`:'<p class="hint">No plan was drafted — the application will be generated from your description.</p>'}
<p class="hint warn">${esc(SENSITIVE_DATA_NOTICE)}</p></div>`;
}
function footHtml(){
  if(cs.step===1)return '<span></span>';
  if(cs.step===2)return `<button type="button" class="ghost" data-act="back">Back</button>${cmpBusy||cs.error?'':'<button type="button" class="primary" data-act="next">Continue <svg class="icon icon-r"><use href="#icon-arrow-right"/></svg></button>'}`;
  return `<button type="button" class="ghost" data-act="back" id="cmp-back3">Back</button><button type="button" class="primary" data-act="build" id="cmp-build"><svg class="icon"><use href="#icon-sparkle"/></svg>Build it</button>`;
}
function renderComposer(){
  document.querySelectorAll('#cmp-stepper li').forEach(li=>{const n=Number(li.dataset.step);li.classList.toggle('active',n===cs.step);li.classList.toggle('done',n<cs.step);});
  $('cmp-body').innerHTML=cs.step===1?step1Html():cs.step===2?step2Html():step3Html();
  $('cmp-foot').innerHTML=footHtml();$('cmp-foot').hidden=cs.step===1;
  if(cs.step===2&&cs.manual)renderCapabilityGroups();
  paintArt($('composer'));paintSwatches($('composer'));$('cmp-main').scrollTop=0;saveCs();
  if(cs.step===1)$('cmp-prompt')?.focus();
}
// Re-render only the capability chips + kind line (keeps focus in the title/summary inputs).
function rerenderChips(){if($('cmp-chips'))$('cmp-chips').innerHTML=chipsHtml(true);else renderComposer();saveCs();}
const draftDigest=d=>`${d.title}: ${d.summary}\nCapabilities: ${(d.capabilities||[]).map(c=>c.id).join(', ')||'none'}\nKind: ${d.kind||''}${d.questions?.length?'\nQuestions: '+d.questions.join(' | '):''}`;
function draftError(e){return e.status===501?'AI drafting isn’t set up on this studio yet — no authoring model is connected. Ask your admin to configure one, or skip the AI and pick capabilities manually.':e.status===502?'The AI drafting service didn’t return a usable draft. This is usually temporary — try again in a moment.':e.message||'Something went wrong while sketching.';}
async function sketch(reply){
  const text=(reply??cs.prompt).trim();if(text.length<10){toast('Say a little more — a sentence or two is plenty.');return;}
  const token=++cmpToken,prevDraft=cs.draft;cs.pending=text;
  const history=reply!==undefined&&prevDraft?[...cs.history,{role:'user',content:cs.lastUser||cs.prompt},{role:'assistant',content:draftDigest(prevDraft)}]:[];
  cs.step=2;cs.manual=false;cs.error=null;cmpBusy=true;cmpMenu=false;renderComposer();
  try{
    const d=await api('drafts',{brief:text,...(history.length?{history}:{})});
    if(token!==cmpToken||!$('composer').open)return;
    cs.history=history;cs.lastUser=text;cs.draft=d;cs.title=d.title||cs.title;cs.summary=d.summary||'';
    cs.caps=(d.capabilities||[]).filter(c=>!c.implied&&capById(c.id)&&capById(c.id).group!=='future').map(c=>c.id);
  }catch(e){if(token!==cmpToken)return;cs.error=draftError(e);cs.errStatus=e.status||0;}
  finally{if(token===cmpToken){cmpBusy=false;if($('composer').open)renderComposer();}}
}
function goManual(){cmpToken++;cmpBusy=false;cs.manual=true;cs.error=null;cs.step=2;if(!cs.draft){cs.title=cs.title||'';cs.summary=cs.summary||cs.prompt;}renderComposer();}
function validateDraft(){
  const t=(cs.title||'').trim(),s=(cs.summary||'').trim()||cs.prompt.trim();
  if(t.length<3)throw new Error('Give it a name (at least 3 characters).');
  if(s.length<10)throw new Error('Describe it in a sentence or two (at least 10 characters).');
}
async function buildIt(){
  validateDraft();
  const caps=[...effectiveCaps()],plan=cs.manual?'':cs.draft?.plan;
  const result=await api('apps',{title:cs.title.trim(),brief:((cs.summary||'').trim()||cs.prompt.trim()).slice(0,3000),accent:cs.accent,kind:deriveKind(caps),tier:'intent',capabilities:caps});
  sessionStorage.removeItem(CMP_KEY);cs=null;$('composer').close();
  selected=result.id;published=false;resetView();wantPlan=Boolean(plan);history.replaceState(null,'',BASE+'/?app='+selected);
  fireGenerate(selected,plan?{plan}:{});
  await refresh();toast(plan?'Application created. Building from your plan…':'Application created. Generating…');
}
const COMPOSER_ACTIONS={
  sketch:()=>sketch(),retry:()=>sketch(cs.pending),refine:()=>{const r=$('cmp-reply').value.trim();if(!r){toast('Type an answer or a change first.');return;}return sketch(r);},
  manual:goManual,addmenu:()=>{cmpMenu=!cmpMenu;rerenderChips();},
  back:()=>{cmpToken++;cmpBusy=false;cmpMenu=false;cs.error=null;if(cs.step===2&&cs.manual&&cs.draft){cs.manual=false;}else cs.step=Math.max(1,cs.step-1);if(cs.step===1)cs.manual=false;renderComposer();},
  next:()=>{validateDraft();cs.step=3;renderComposer();},
  build:async()=>{const b=$('cmp-build');b.disabled=true;try{await buildIt();}catch(e){b.disabled=false;throw e;}},
};
$('composer').addEventListener('click',async e=>{try{await onComposerClick(e);}catch(error){toast(error.message);}});
async function onComposerClick(e){
  const t=e.target.closest('[data-act],[data-rm],[data-add],[data-usecase],[data-accent],#cmp-close,#cmp-stepper li');if(!t||!cs)return;
  if(t.disabled)return;
  if(t.id==='cmp-close'){$('composer').close();return;}
  if(t.dataset.act){await COMPOSER_ACTIONS[t.dataset.act]?.();return;}
  if(t.dataset.rm){cs.caps=cs.caps.filter(c=>c!==t.dataset.rm);rerenderChips();return;}
  if(t.dataset.add){if(!cs.caps.includes(t.dataset.add))cs.caps.push(t.dataset.add);cmpMenu=false;rerenderChips();return;}
  if(t.dataset.accent){cs.accent=t.dataset.accent;renderComposer();return;}
  if(t.dataset.usecase){const u=USE_CASES.find(x=>x.id===t.dataset.usecase);if(!u)return;cs.prompt=ideaPrompt(u);saveCs();const p=$('cmp-prompt');p.value=cs.prompt;p.focus();p.setSelectionRange(p.value.length,p.value.length);p.scrollIntoView({block:'center',behavior:'smooth'});return;}
  if(t.tagName==='LI'){const n=Number(t.dataset.step);if(n<cs.step&&!cmpBusy){cs.step=n;if(n===1)cs.manual=false;renderComposer();}}
}
$('composer').addEventListener('input',e=>{
  if(!cs)return;const id=e.target.id;
  if(id==='cmp-prompt')cs.prompt=e.target.value;else if(id==='cmp-title')cs.title=e.target.value;else if(id==='cmp-summary')cs.summary=e.target.value;else return;
  saveCs();
});
$('composer').addEventListener('change',e=>{const cb=e.target.closest('[data-cap]');if(!cb||!cs)return;if(cb.checked&&!cs.caps.includes(cb.dataset.cap))cs.caps.push(cb.dataset.cap);else if(!cb.checked)cs.caps=cs.caps.filter(c=>c!==cb.dataset.cap);renderCapabilityGroups();saveCs();});
$('composer').addEventListener('keydown',e=>{
  if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){if(e.target.id==='cmp-prompt'){e.preventDefault();COMPOSER_ACTIONS.sketch();}else if(e.target.id==='cmp-reply'){e.preventDefault();COMPOSER_ACTIONS.refine()?.catch?.(err=>toast(err.message));}}
});
// Esc / Cancel / Close all abandon the draft; only a page refresh keeps it.
$('composer').addEventListener('close',()=>{cmpToken++;cmpBusy=false;cmpMenu=false;sessionStorage.removeItem(CMP_KEY);});
const invitation=new URLSearchParams(location.hash.slice(1)).get('invite');if(invitation){history.replaceState(null,'',location.pathname+location.search);try{await api('session',{token:invitation});}catch(error){toast(error.message);}}
try{await enter();}catch{/* Login is shown until authenticated. */}
graduation=initGraduation({api,action,$,getApp:()=>app,getMe:()=>me,toast,esc,refresh});
// A refresh mid-composition brings the overlay (and its draft) back.
try{const st=JSON.parse(sessionStorage.getItem(CMP_KEY)||'null');if(me&&st?.open){cs={...freshCs(),...st};showComposer();if(cs.step===2&&!cs.manual&&!cs.draft)sketch(cs.pending);}}catch{sessionStorage.removeItem(CMP_KEY);}
setInterval(()=>{if(me&&!document.hidden)refresh().catch(error=>toast(error.message));},2000);
