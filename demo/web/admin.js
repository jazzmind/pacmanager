const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,6000);}
async function api(path,body){const r=await fetch('/api/'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(data.error||'Request failed');return data;}
const action=fn=>async e=>{e?.preventDefault();try{await fn(e);}catch(error){toast(error.message);}};

const STATUS_LABEL={up:'● up',down:'● down',absent:'○ absent'};

async function loadServices(){
  const {services}=await api('admin/services');
  $('services').innerHTML=services.map(s=>`<div class="admin-tile admin-tile-${s.status}"><strong>${esc(s.name)}</strong><span class="admin-status">${STATUS_LABEL[s.status]||s.status}</span><small>${esc(s.detail||'')}</small></div>`).join('');
}

async function loadOverview(){
  const {apps,audit,totals}=await api('admin/overview');
  $('totals').textContent=`${totals.apps} applications · ${totals.published} published · ${totals.deployed} deployed · ${totals.archived} archived`;
  $('apps-table').innerHTML=apps.map(a=>`<div class="admin-row"><strong>${esc(a.config.title)}</strong><span>${esc(a.config.kind||a.config.template||'template')}</span><span>${a.archivedAt?'archived':a.published?'published v'+a.release.number:a.build?.status||'draft'}</span><span>${a.ownerEmail?esc(a.ownerEmail):'—'}</span><span>${a.completeness?a.completeness.missingOrProposed+' gaps':'—'}</span><a href="/?app=${a.id}">Open ↗</a></div>`).join('')||'<p>No applications yet.</p>';
  $('audit-feed').innerHTML=audit.map(e=>`<div class="admin-row"><span>${esc(new Date(e.at).toLocaleString())}</span><strong>${esc(e.title)}</strong><span>${esc(e.event)}</span><span>${esc(e.actor||'')}</span></div>`).join('')||'<p>No activity recorded yet.</p>';
}

$('refresh-services').onclick=action(loadServices);

$('llm-form').onsubmit=action(async()=>{
  $('llm-result').hidden=true;
  const result=await api('admin/llm-test',{model:$('llm-model').value||undefined,prompt:$('llm-prompt').value});
  $('llm-result').hidden=false;
  $('llm-result').innerHTML=`<p>${esc(result.content||'(empty response)')}</p><small>${esc(result.model)} · ${result.usage?result.usage.total_tokens+' tokens':'—'}${result.costUsd?' · $'+result.costUsd.toFixed(4):''} · ${result.tookMs}ms${result.finishReason==='length'?' · truncated (raise max tokens)':''}</small>`;
});

$('orchestration-test').onclick=action(async()=>{
  $('orchestration-result').hidden=true;
  const result=await api('admin/orchestration-test',{});
  $('orchestration-result').hidden=false;
  $('orchestration-result').innerHTML=`<p>Healthy.</p><small>${esc(JSON.stringify(result.health))}</small><ul>${result.recentWorkflows.map(w=>`<li>${esc(w.workflowId||w.id||JSON.stringify(w))}</li>`).join('')||'<li>No recent workflows.</li>'}</ul>`;
});

$('agent-form').onsubmit=action(async()=>{
  $('agent-result').hidden=true;
  const result=await api('admin/agent-test',{prompt:$('agent-prompt').value});
  $('agent-result').hidden=false;
  $('agent-result').innerHTML=`<p>${esc(result.reply||result.content||JSON.stringify(result))}</p>`;
});

async function enter(){
  $('login').hidden=true;$('console').hidden=false;
  await Promise.all([loadServices(),loadOverview()]);
}

$('signin').onsubmit=action(async()=>{await api('session',{token:$('token').value});$('token').value='';await enter();});

try{
  const me=await api('me');
  if(me.kind!=='owner')throw new Error('not owner');
  await enter();
}catch{/* Login form stays visible until an owner session is established. */}
