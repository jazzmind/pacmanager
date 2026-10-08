const BASE=document.querySelector('meta[name="pac-base"]')?.content||'';
export function initGraduation({api,action,$,getApp,getMe,toast,esc,refresh}){
  const dialog=document.createElement('dialog');dialog.id='graduation';
  dialog.innerHTML=`<div class="graduation-head"><div><p class="eyebrow">PUBLISH, DEPLOY, GRADUATE</p><h2 id="promote-state">Not published yet</h2></div><div><button id="promote-publish" class="primary" hidden>Publish</button><button id="close-graduation" class="subtle">Close</button></div></div>
<div class="boundary">
  <div class="rung"><strong>Preview</strong><span class="rung-sub">only you, sandboxed</span><p>Nothing external.</p></div>
  <div class="rung"><strong>Published to the studio</strong><span class="rung-sub">share it; Deploy makes it reachable</span><p>AI models, a database, document storage, sample/mock internal APIs.</p></div>
  <div class="rung rung-warn"><strong>Production — needs graduation</strong><span class="rung-sub">internal data/APIs, NPI, real customers, business-critical</span><p>The real thing, via the devops-platform handoff.</p></div>
</div>
<div class="promote-actions"><button id="promote-deploy" class="ghost">Deploy to the studio</button><span id="deploy-status" class="hint"></span><select id="promote-target" aria-label="Graduation target" title="EKS and Lambda also need a Nexus registry, not yet collected here"><option value="cloudfront">CloudFront</option><option value="eks">EKS</option><option value="lambda">Lambda</option></select><button id="promote-graduate" class="ghost">Check graduation readiness</button></div>
<div id="graduate-panel" hidden></div>
<hr>
<p id="assurance-status"></p><div class="report-actions"><select id="report-kind" aria-label="Document"><option value="arb">Architecture Review Board</option><option value="readiness">Systems Readiness</option><option value="bom">Bill of Materials</option></select><a id="report-html" class="button">Download HTML</a><a id="report-md" class="button">Markdown</a><a id="report-json" class="button">Source JSON</a><a id="report-open" class="button" target="_blank" rel="noopener">Open preview ↗</a></div><iframe id="report-preview" title="Generated governance document" sandbox=""></iframe><p class="hint">Generated facts follow the published application automatically. Authored decisions retain their evidence and need re-review after a release change. Document generation is not an approval.</p><details id="assurance-edit"><summary>Edit structured decisions and evidence</summary><p>Claude can maintain these records through MCP. You can also edit JSON here. Managed facts regenerate from the app; changes to managed fields are ignored.</p><textarea id="assurance-json" aria-label="Structured assurance data" spellcheck="false"></textarea><button id="save-assurance">Save structured record</button></details><hr><div class="graduation-head"><div><h2>Publish the code to GitHub.</h2><p>Review source and reports before creating a branch in a configured private repository.</p></div><a id="graduate-archive" class="button">Download full package ↓</a></div><p id="github-config-note"></p><div id="github-controls" class="fields"><label id="github-shared-field">Destination<select id="github-repository"></select></label><label id="github-own-toggle"><input id="github-own" type="checkbox"> Use my own GitHub token instead</label><label id="github-repo-custom-field" hidden>Repository (owner/repo)<input id="github-repo-custom" placeholder="your-org/your-repo"></label><label id="github-token-field" hidden>Personal access token (repo scope)<input id="github-token" type="password" autocomplete="off"></label><p class="hint" id="github-own-hint" hidden>Used once to prepare and publish, then discarded — never saved to disk. Works for a personal "everything I own" repo or a dedicated repo for one real app; either way, paste a token with write access to that repository.</p><button id="github-prepare">Prepare publication</button></div><section id="github-review" hidden><p id="github-plan-summary"></p><p class="hint">Uploaded documents, discussion notes, claims rows and credentials are excluded. Your application brief and authored assurance prose are included.</p><select id="github-file" aria-label="Review file"></select><pre id="github-content"></pre><label><input id="github-confirm" type="checkbox"> I reviewed these files and approve publishing them to this repository and branch.</label><button id="github-publish">Publish reviewed code ↗</button></section><p id="github-result"></p>`;
  document.body.append(dialog);let record,plan,appId,sharedEnabled=false;
  const report=()=>{const path=BASE+'/api/apps/'+appId+'/reports/'+$('report-kind').value;$('report-preview').src=path;$('report-open').href=path;for(const format of ['html','md','json'])$('report-'+format).href=path+'?format='+format+'&download=1';};
  const load=async()=>{const result=await api('apps/'+appId+'/assurance');record=result.record;$('assurance-status').textContent=`Release ${record.release??'not published'} · ${result.completeness.missingOrProposed} decisions unknown or proposed · ${record.stale?'Authored decisions need re-review':'Pending independent review'} · Source ${(record.sourceDigest||'unavailable').slice(0,12)}`;$('assurance-json').value=JSON.stringify(record.data,null,2);report();};
  function updateOwnToggle(sharedEnabled){
    // No shared repo configured -- there is nothing to toggle away from, so force "own token"
    // mode on and hide the (empty, useless) shared destination picker and the checkbox itself.
    const forced=!sharedEnabled;
    $('github-own').checked=forced||$('github-own').checked;$('github-own').disabled=forced;
    $('github-own-toggle').hidden=forced;
    $('github-shared-field').hidden=$('github-own').checked;
    $('github-repo-custom-field').hidden=!$('github-own').checked;
    $('github-token-field').hidden=!$('github-own').checked;
    $('github-own-hint').hidden=!$('github-own').checked;
  }
  // Reflects the app's real release/build state -- the same fields the "Ready to publish"
  // chat card reads -- so the modal opened from clicking the status badge is never stale
  // relative to what that card already told you.
  function promote(){
    const app=getApp(),owner=getMe().kind==='owner';
    const nextRelease=(app.release?.number||0)+1;
    const canPublish=owner&&app.build?.status==='ready'&&(!app.release||app.release.revision!==app.build.revision);
    $('promote-state').textContent=app.release?`Published · v${app.release.number}${app.revision!==app.release.revision||canPublish?' · draft has unpublished changes':''}`:'Not published yet';
    $('promote-publish').hidden=!canPublish;$('promote-publish').textContent='Publish as v'+nextRelease;
    $('promote-deploy').hidden=!owner;$('promote-deploy').disabled=!app.release;
    $('deploy-status').textContent=app.deployments?.length?`Last deploy: ${app.deployments[app.deployments.length-1].status}`:'Not deployed yet.';
    $('promote-graduate').hidden=!owner;
    $('graduate-panel').hidden=true;$('graduate-panel').innerHTML='';
  }
  const open=action(async()=>{appId=getApp().id;const owner=getMe().kind==='owner';$('assurance-edit').hidden=!owner;$('graduate-archive').hidden=!owner||!getApp().release;$('graduate-archive').href=BASE+'/api/apps/'+appId+'/export';$('github-review').hidden=true;$('github-result').textContent='';$('github-controls').hidden=true;$('github-own').checked=false;promote();await load();dialog.showModal();
    if(owner){const config=await api('apps/'+appId+'/github-config');sharedEnabled=config.enabled;$('github-config-note').textContent=config.enabled?config.mode:'No shared repo is configured — use your own GitHub token below to publish to a personal or app-specific repository.';$('github-controls').hidden=!config.allowPersonal&&!config.enabled;$('github-repository').innerHTML=config.repositories.map(r=>`<option>${esc(r)}</option>`).join('');updateOwnToggle(sharedEnabled);}else $('github-config-note').textContent='The workspace owner can publish source code.';
  });
  $('promote-publish').onclick=action(async()=>{await api('apps/'+appId+'/publish',{});await refresh();promote();toast('Published.');});
  $('promote-deploy').onclick=action(async()=>{await api('apps/'+appId+'/deploy',{});await refresh();promote();toast('Deploying…');});
  // The graduation gate is real: a local-only service binding blocks with a 409 naming the
  // exact env var/kind, unless allowLocalOnly is explicitly set (recorded in the audit trail
  // server-side). Rendered inline rather than as a toast so the blocker text and the override
  // checkbox stay visible together.
  // devops-platform's real required fields go well beyond target -- name always, and
  // team/repository/registry/nexus.{url,pathPrefix} for anything but cloudfront. None of
  // that is collected anywhere yet (matches pacmanager's own documented "DevOps sign-off"
  // open item: who provisions the real environment envelope is unresolved). Supplying a
  // derived name keeps the common cloudfront path genuinely working; eks/lambda will
  // legitimately fail with a clear adapter error until that information exists somewhere.
  const slug=title=>{const base=title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,50)||'app';return /^[a-z]/.test(base)?base:'a-'+base;};
  $('promote-graduate').onclick=action(async()=>{
    $('graduate-panel').hidden=false;$('graduate-panel').innerHTML='<p class="hint">Checking…</p>';
    const target=$('promote-target').value,name=slug(getApp().config.title);
    try{
      const result=await api('apps/'+appId+'/graduate',{adapter:'devops-platform',target,name});
      $('graduate-panel').innerHTML=`<p><strong>Ready.</strong> Graduation files generated for review — nothing has been committed or deployed on its own.</p><pre>${esc(JSON.stringify(result,null,2)).slice(0,2000)}</pre>`;
    }catch(error){
      // Rendered inline rather than lost to a toast either way -- both failure modes are
      // genuinely informative: a local-only service binding is a real platform blocker with
      // an explicit override; a missing devops-platform field (team/repository/registry/
      // nexus.{url,pathPrefix} -- none of which exist anywhere in this environment yet) is the
      // honest "who provisions the real environment envelope" gap pacmanager's own docs
      // already flag as unresolved, not something to paper over with a fake success.
      if(!/Graduation blocked/.test(error.message)){$('graduate-panel').innerHTML=`<p class="hint warn">${esc(error.message)}</p>`;return;}
      $('graduate-panel').innerHTML=`<p class="hint warn">${esc(error.message)}</p><label><input id="allow-local-only" type="checkbox"> I understand — graduate anyway (recorded in the activity log)</label><button id="graduate-force" class="ghost">Graduate anyway</button>`;
      $('graduate-force').onclick=action(async()=>{
        if(!$('allow-local-only').checked)throw new Error('Check the box to confirm you understand the risk.');
        const result=await api('apps/'+appId+'/graduate',{adapter:'devops-platform',target,name,allowLocalOnly:true});
        $('graduate-panel').innerHTML=`<p><strong>Graduated, with the local-only override recorded.</strong></p><pre>${esc(JSON.stringify(result,null,2)).slice(0,2000)}</pre>`;
      });
    }
  });
  $('github-own').onchange=()=>updateOwnToggle(sharedEnabled);
  $('close-graduation').onclick=()=>dialog.close();$('report-kind').onchange=report;
  setInterval(async()=>{if(!dialog.open||document.hidden)return;try{promote();const next=(await api('apps/'+appId+'/assurance')).record;if(next.generatedDigest!==record.generatedDigest||next.recordRevision!==record.recordRevision||next.release!==record.release){report();$('github-review').hidden=true;if($('assurance-edit').open){$('assurance-status').textContent='Application changed. Report preview refreshed. Close and reopen graduation to reload decisions before saving.';}else await load();}}catch(error){toast(error.message);}},2000);
  $('save-assurance').onclick=action(async()=>{await api('apps/'+appId+'/assurance',{revision:record.recordRevision,release:record.release,data:JSON.parse($('assurance-json').value)});await load();$('github-review').hidden=true;toast('Structured decisions saved. Reports regenerated.');});
  $('github-prepare').onclick=action(async()=>{
    const own=$('github-own').checked;
    const repository=own?$('github-repo-custom').value:$('github-repository').value;
    const token=own?$('github-token').value:undefined;
    if(own&&!token)throw new Error('Paste your personal access token first.');
    plan=await api('apps/'+appId+'/github-prepare',{repository,token});
    $('github-token').value=''; // never lingers in the DOM longer than the one request that needed it
    $('github-plan-summary').textContent=`${plan.repository} → ${plan.branch} · ${plan.files.length} files · Expires in five minutes · ${plan.digest}`;$('github-file').innerHTML=plan.files.map((f,i)=>`<option value="${i}">${esc(f.path)} · ${f.bytes} bytes</option>`).join('');$('github-content').textContent=plan.files[0].content;$('github-confirm').checked=false;$('github-publish').disabled=false;$('github-review').hidden=false;
  });
  $('github-file').onchange=()=>{$('github-content').textContent=plan.files[Number($('github-file').value)].content;};
  $('github-publish').onclick=action(async()=>{if(!$('github-confirm').checked)throw new Error('Review the file contents and confirm the destination first.');$('github-publish').disabled=true;try{const result=await api('apps/'+appId+'/github-publish',{id:plan.id,digest:plan.digest});$('github-result').textContent='Published commit '+result.commit+' · ';const link=document.createElement('a');link.href=result.url;link.textContent='Open repository branch ↗';link.target='_blank';link.rel='noopener';$('github-result').append(link);$('github-review').hidden=true;}catch(error){$('github-review').hidden=true;throw new Error(error.message+' Prepare a new publication preview before retrying.');}});
  return {open};
}
