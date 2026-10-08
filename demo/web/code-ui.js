// Code tab: file tree + editor for a generated app's source. Plain ES module, no build step.
// The editor is CodeMirror 6 from the vendored bundle (window.PacCM, lazy-loaded the first time the tab opens); if the bundle
// is missing or throws, a monospace <textarea> with the same surface is used instead. Nothing here touches inline styles.
const EXT_LANG={html:'html',htm:'html',css:'css',js:'javascript',mjs:'javascript',cjs:'javascript',json:'json',md:'markdown',py:'python',sh:'shell',yml:'yaml',yaml:'yaml'};
const LANG_LABEL={html:'HTML',css:'CSS',javascript:'JavaScript',json:'JSON',markdown:'Markdown',python:'Python',dockerfile:'Dockerfile',shell:'Shell',yaml:'YAML',text:'Text'};
const langOf=p=>/(^|\/)Dockerfile[^/]*$/.test(p)?'dockerfile':EXT_LANG[(p.split('.').pop()||'').toLowerCase()]||'text';

let cmPromise=null;
function loadCM(base){
  if(window.PacCM)return Promise.resolve(window.PacCM);
  if(!cmPromise)cmPromise=new Promise(resolve=>{
    const s=document.createElement('script');s.src=base+'/vendor/codemirror.min.js';
    s.onload=()=>resolve(window.PacCM||null);s.onerror=()=>resolve(null);document.head.appendChild(s);
  });
  return cmPromise;
}
// Same surface as the CodeMirror wrapper: setDoc(text,language,readOnly) getDoc() setReadOnly(b) focus() destroy().
function textareaEditor({parent,doc,readOnly,onChange,onSave}){
  const t=document.createElement('textarea');t.className='code-fallback';t.spellcheck=false;t.value=doc||'';t.readOnly=!!readOnly;t.setAttribute('aria-label','Source code');
  let silent=false;
  t.addEventListener('input',()=>{if(!silent)onChange?.();});
  t.addEventListener('keydown',e=>{
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'){e.preventDefault();onSave?.();return;}
    if(e.key==='Tab'&&!e.shiftKey&&!e.metaKey&&!e.ctrlKey&&!t.readOnly){e.preventDefault();t.setRangeText('  ',t.selectionStart,t.selectionEnd,'end');t.dispatchEvent(new Event('input'));}
  });
  parent.appendChild(t);
  return {setDoc(text,_l,ro){silent=true;t.value=text;if(ro!==undefined)t.readOnly=!!ro;t.scrollTop=0;t.setSelectionRange(0,0);silent=false;},getDoc:()=>t.value,setReadOnly(r){t.readOnly=!!r;},focus(){t.focus();},destroy(){t.remove();}};
}

export function initCode({api,$,getApp,getMe,toast,esc,BASE,rebuild}){
  const st={appId:null,loaded:false,tier:null,editable:false,reason:'',files:[],key:null,cur:null,base:'',dirty:false,isNew:false,issues:[],notice:null,busy:false,stale:false,open:new Set(),prompt:null,ownRev:null,published:false,listing:false,token:0,editor:null,editorKind:null,pendingEditor:null};
  const bar={path:$('code-path'),lang:$('code-lang'),dot:$('code-dot'),save:$('code-save'),saveBuild:$('code-save-build'),lock:$('code-lock'),notice:$('code-notice'),issues:$('code-issues'),empty:$('code-empty'),tree:$('code-tree-list'),host:$('code-editor'),prompt:$('code-prompt')};
  const canEditPrincipal=()=>getMe()?.kind!=='collaborator';
  const fileEntry=p=>st.files.find(f=>f.path===p);
  const roReason=()=>{
    if(st.published)return 'Published view is read-only — switch to the Draft tab to edit the source.';
    if(!canEditPrincipal())return 'You have view-only access to this application.';
    if(!st.editable)return st.reason||'This application’s source can’t be edited right now.';
    if(st.cur?.readOnly)return 'This file is managed by the studio and can’t be edited.';
    return '';
  };
  const globallyEditable=()=>!st.published&&canEditPrincipal()&&st.editable;
  const fileRO=()=>!globallyEditable()||Boolean(st.cur?.readOnly);
  const isDirty=()=>st.dirty;

  function reset(appId){
    st.appId=appId;st.loaded=false;st.tier=null;st.files=[];st.key=null;st.cur=null;st.base='';st.dirty=false;st.isNew=false;st.issues=[];st.notice=null;st.stale=false;st.prompt=null;st.open=new Set();st.token++;
  }
  // ---- editor
  async function ensureEditor(){
    if(st.editor)return st.editor;
    if(st.pendingEditor)return st.pendingEditor;
    st.pendingEditor=(async()=>{
      const cm=await loadCM(BASE);
      const opts={parent:bar.host,doc:'',language:'text',readOnly:true,dark:false,onChange:()=>{const d=st.editor.getDoc()!==st.base;if(d!==st.dirty){st.dirty=d;chrome();}else if(st.isNew)chrome();},onSave:()=>save(false)};
      let ed=null,kind='textarea';
      if(cm?.createEditor){try{ed=cm.createEditor(opts);kind='codemirror';}catch(e){console.warn('CodeMirror failed, using a plain textarea:',e);bar.host.replaceChildren();}}
      if(!ed)ed=textareaEditor(opts);
      st.editor=ed;st.editorKind=kind;bar.host.dataset.editor=kind;return ed;
    })();
    return st.pendingEditor;
  }
  // ---- tree
  function treeHtml(){
    const root={dirs:new Map(),files:[]};
    for(const f of st.files){const parts=f.path.split('/');let n=root;for(const d of parts.slice(0,-1)){if(!n.dirs.has(d))n.dirs.set(d,{dirs:new Map(),files:[]});n=n.dirs.get(d);}n.files.push({name:parts.at(-1),f});}
    const one=(n,prefix,depth)=>{
      const dc=`ft-d${Math.min(depth,8)}`;
      const dirs=[...n.dirs.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([name,child])=>{
        const p=prefix+name,open=st.open.has(p);
        return `<button type="button" class="ft-row ft-dir ${dc}" data-dir="${esc(p)}" aria-expanded="${open}"><svg class="icon ft-chev${open?' open':''}"><use href="#icon-chevron-down"/></svg><svg class="icon ft-ic"><use href="#icon-folder"/></svg><span>${esc(name)}</span></button>${open?one(child,p+'/',depth+1):''}`;
      }).join('');
      const files=n.files.sort((a,b)=>a.name.localeCompare(b.name)).map(({name,f})=>{
        const sel=st.cur?.path===f.path,lang=langOf(f.path);
        return `<button type="button" class="ft-row ft-file ft-${lang} ${dc}${sel?' selected':''}" data-path="${esc(f.path)}" title="${esc(f.path)}${f.readOnly||f.managed?' (managed by the studio, read-only)':''}"><svg class="icon ft-ic"><use href="#icon-file"/></svg><span>${esc(name)}</span>${f.readOnly||f.managed?'<svg class="icon ft-lock" aria-label="read-only"><use href="#icon-lock"/></svg>':''}${sel&&st.dirty?'<i class="ft-dirty" aria-label="unsaved"></i>':''}</button>`;
      }).join('');
      return dirs+files;
    };
    return one(root,'',0)||'<p class="hint pad">No files yet.</p>';
  }
  function drawTree(){const h=treeHtml();if(bar.tree._h!==h){bar.tree._h=h;bar.tree.innerHTML=h;}}
  function expandTo(path){const parts=path.split('/').slice(0,-1);let p='';for(const d of parts){p+=(p?'/':'')+d;st.open.add(p);}}
  // ---- chrome (top bar, banners, issues)
  function chrome(){
    const has=Boolean(st.cur),ro=fileRO(),why=has?roReason():'';
    bar.path.textContent=st.cur?.path||'No file selected';bar.lang.textContent=has?(LANG_LABEL[st.cur.language]||st.cur.language||''):'';
    bar.dot.hidden=!(st.dirty||(st.isNew&&has));bar.dot.title='Unsaved changes';
    const canSave=has&&!ro&&!st.busy&&(st.dirty||st.isNew);
    bar.save.hidden=bar.saveBuild.hidden=!globallyEditable()||(has&&st.cur.readOnly);
    bar.save.disabled=!canSave;bar.saveBuild.disabled=!canSave;
    bar.lock.hidden=!why;if(why)bar.lock.innerHTML=`<svg class="icon"><use href="#icon-lock"/></svg><span>${esc(why)}</span>`;
    for(const id of ['code-new','code-rename','code-delete'])$(id).hidden=!globallyEditable();
    $('code-rename').disabled=!has||st.cur.readOnly||st.isNew;$('code-delete').disabled=!has||st.cur.readOnly||st.isNew;$('code-new').disabled=st.busy;
    bar.notice.hidden=!st.notice&&!st.stale;
    if(st.notice)bar.notice.innerHTML=`<span>${esc(st.notice.text)}</span>${st.notice.reload?'<button type="button" class="ghost" data-code="reload">Reload from server</button>':''}`;
    else if(st.stale)bar.notice.innerHTML='<span>The source changed elsewhere (a rebuild or another edit). Your unsaved edits are untouched — saving may report a conflict.</span><button type="button" class="ghost" data-code="reload">Discard mine &amp; reload</button>';
    bar.issues.hidden=!st.issues.length;
    bar.issues.innerHTML=st.issues.length?`<strong>Not saved — unsafe code:</strong><ul>${st.issues.map(i=>`<li>${esc(i)}</li>`).join('')}</ul>`:'';
    drawTree();
    const p=st.prompt;bar.prompt.hidden=!p;
    if(p){$('code-prompt-label').textContent=p.kind==='new'?'New file path (e.g. styles/extra.css)':p.kind==='rename'?'Rename to':'Delete '+(st.cur?.path||'')+'? This can’t be undone.';
      $('code-prompt-input').hidden=p.kind==='delete';$('code-prompt-ok').textContent=p.kind==='delete'?'Delete':p.kind==='new'?'Create':'Rename';$('code-prompt-ok').classList.toggle('danger-item',p.kind==='delete');}
  }
  function showEmpty(msg){bar.empty.hidden=!msg;bar.empty.innerHTML=msg||'';$('code-body').hidden=Boolean(msg);}
  // ---- data
  async function loadList(){
    if(st.listing)return;st.listing=true;const id=st.appId,tok=st.token;
    try{
      const r=await api('apps/'+id+'/files');if(tok!==st.token)return;
      st.tier=r.tier;st.editable=Boolean(r.editable);st.reason=r.reason||'';st.files=r.files||[];st.loaded=true;st.key=keyOf(getApp());
      if(st.isNew&&st.cur&&!fileEntry(st.cur.path))st.files=[...st.files,{path:st.cur.path,size:0,sha:null}];
      if(!st.cur||(!st.isNew&&!fileEntry(st.cur.path)&&!st.dirty)){
        const first=st.files.find(f=>f.path==='index.html')||st.files.find(f=>!f.readOnly)||st.files[0];
        if(first)await openFile(first.path,{force:true});else{st.cur=null;await clearEditor();}
      }else if(!st.dirty&&!st.isNew&&st.cur&&fileEntry(st.cur.path)&&fileEntry(st.cur.path).sha!==st.cur.sha)await openFile(st.cur.path,{force:true,keepScroll:true});
      else if(st.cur&&!st.isNew){const f=fileEntry(st.cur.path);if(f&&f.sha!==st.cur.sha&&st.dirty)st.stale=true;}
    }catch(e){if(tok===st.token){st.loaded=true;st.notice={text:e.message};}}
    finally{st.listing=false;chrome();}
  }
  async function clearEditor(){const ed=await ensureEditor();ed.setDoc('','text',true);st.base='';st.dirty=false;}
  async function openFile(path,{force=false,keepScroll=false}={}){
    if(!force&&st.dirty&&!confirm('Discard unsaved edits to '+st.cur.path+'?'))return false;
    const tok=++st.token,id=st.appId;
    try{
      const r=await api('apps/'+id+'/file?path='+encodeURIComponent(path));if(tok!==st.token)return false;
      const ed=await ensureEditor();if(tok!==st.token)return false;
      st.cur={path:r.path,sha:r.sha,language:r.language&&r.language!=='text'?r.language:langOf(r.path),readOnly:Boolean(r.readOnly)||Boolean(fileEntry(r.path)?.readOnly),size:r.size};
      st.base=r.content;st.dirty=false;st.isNew=false;st.issues=[];st.notice=null;st.stale=false;expandTo(r.path);
      const pos=keepScroll&&ed.view?ed.view.scrollDOM.scrollTop:0;
      ed.setDoc(r.content,st.cur.language,fileRO());if(pos&&ed.view)ed.view.scrollDOM.scrollTop=pos;
      chrome();return true;
    }catch(e){if(tok===st.token){st.notice={text:'Could not open '+path+': '+e.message};chrome();}return false;}
  }
  async function save(thenBuild){
    if(!st.cur||fileRO()||st.busy||!(st.dirty||st.isNew))return;
    const id=st.appId,path=st.cur.path,content=st.editor.getDoc();
    st.busy=true;st.issues=[];st.notice=null;chrome();
    try{
      const r=await api('apps/'+id+'/file',{path,content,baseSha:st.isNew?null:st.cur.sha});
      if(st.appId!==id||st.cur?.path!==path)return;
      st.ownRev=r.revision;st.cur.sha=r.sha;st.cur.size=r.size;st.base=content;st.isNew=false;st.dirty=st.editor.getDoc()!==content;
      const f=fileEntry(path);if(f){f.sha=r.sha;f.size=r.size;}else st.files.push({path,size:r.size,sha:r.sha});
      if(r.issues?.length)st.notice={text:'Saved with warnings: '+r.issues.join('; ')};
      toast(thenBuild?'Saved — rebuilding…':'Saved '+path+'. Rebuild to see it in the preview.');
      st.busy=false;chrome();
      if(thenBuild)await rebuild();
    }catch(e){
      if(e.status===422)st.issues=Array.isArray(e.data?.issues)&&e.data.issues.length?e.data.issues:[e.message];
      else if(e.status===409)st.notice={text:e.message||'This file changed since you opened it.',reload:true};
      else toast(e.message);
    }finally{st.busy=false;chrome();}
  }
  // ---- inline prompt (new / rename / delete)
  const startPrompt=kind=>{
    if(kind!=='new'&&!st.cur)return;
    if(kind==='rename'&&st.dirty){toast('Save or discard your edits before renaming.');return;}
    st.prompt={kind};const inp=$('code-prompt-input');inp.value=kind==='rename'?st.cur.path:kind==='new'?(st.cur?st.cur.path.split('/').slice(0,-1).join('/')+(st.cur.path.includes('/')?'/':''):''):'';chrome();
    (kind==='delete'?$('code-prompt-ok'):inp).focus();
  };
  async function submitPrompt(){
    const p=st.prompt;if(!p)return;const id=st.appId,val=$('code-prompt-input').value.trim();
    if(p.kind!=='delete'&&(!val||val.endsWith('/')||val.startsWith('/')||val.includes('..')||/[\\\s]/.test(val)))throw new Error('Enter a relative file path without spaces, e.g. src/app.js');
    if(p.kind==='new'){
      if(fileEntry(val))throw new Error(val+' already exists.');
      if(st.dirty&&!confirm('Discard unsaved edits to '+st.cur.path+'?'))return;
      const ed=await ensureEditor();st.token++;
      st.cur={path:val,sha:null,language:langOf(val),readOnly:false,size:0};st.base='';st.isNew=true;st.dirty=false;st.issues=[];st.notice=null;st.stale=false;
      st.files=[...st.files.filter(f=>f.sha!==null),{path:val,size:0,sha:null}];expandTo(val);ed.setDoc('',st.cur.language,false);st.prompt=null;chrome();ed.focus();return;
    }
    st.busy=true;chrome();
    try{
      if(p.kind==='rename'){if(val===st.cur.path){st.prompt=null;return;}await api('apps/'+id+'/file-rename',{from:st.cur.path,to:val});toast('Renamed to '+val+'.');st.cur=null;st.prompt=null;await loadList();await openFile(val,{force:true});}
      else{const path=st.cur.path;await api('apps/'+id+'/file-delete',{path,baseSha:st.cur.sha});toast('Deleted '+path+'.');st.cur=null;st.dirty=false;st.prompt=null;await loadList();}
    }finally{st.busy=false;chrome();}
  }
  // ---- events
  bar.save.onclick=()=>save(false);bar.saveBuild.onclick=()=>save(true);
  $('code-new').onclick=()=>startPrompt('new');$('code-rename').onclick=()=>startPrompt('rename');$('code-delete').onclick=()=>startPrompt('delete');
  $('code-prompt-cancel').onclick=()=>{st.prompt=null;chrome();};
  bar.prompt.onsubmit=async e=>{e.preventDefault();try{await submitPrompt();}catch(err){toast(err.message);}};
  bar.prompt.addEventListener('keydown',e=>{if(e.key==='Escape'){st.prompt=null;chrome();}});
  bar.tree.onclick=e=>{
    const d=e.target.closest('[data-dir]'),f=e.target.closest('[data-path]');
    if(d){const p=d.dataset.dir;if(st.open.has(p))st.open.delete(p);else st.open.add(p);drawTree();}
    else if(f&&f.dataset.path!==st.cur?.path){
      if(st.isNew&&!st.dirty){st.files=st.files.filter(x=>x.sha!==null);st.isNew=false;}
      openFile(f.dataset.path);
    }
  };
  bar.notice.onclick=e=>{if(e.target.closest('[data-code="reload"]')&&st.cur){const path=st.cur.path;st.dirty=false;st.isNew=false;loadList().then(()=>openFile(path,{force:true}));}};
  window.addEventListener('beforeunload',e=>{if(st.dirty){e.preventDefault();e.returnValue='';}});
  function keyOf(app){return [app.revision,app.generation?.status,app.build?.status].join(':');}
  return {
    dirty:isDirty,
    // Drop in-memory edits after the user confirmed leaving; the next draw reloads from the server.
    discard(){st.dirty=false;st.isNew=false;st.cur=null;st.key=null;st.loaded=false;st.issues=[];st.notice=null;st.prompt=null;st.stale=false;},
    currentPath:()=>st.cur?.path||'',
    // Called by the 2s poll while the Code tab is open. Never touches the editor while there are unsaved edits.
    draw(app,{published}){
      if(st.appId!==app.id)reset(app.id);
      st.published=published;
      if(!['static','app'].includes(app.config.tier)){
        showEmpty(app.config.tier==='intent'?'<h2>Generate the application to see its code.</h2><p>Once it has been generated you can read and edit every file here.</p>':'<h2>This application has no editable source.</h2><p>It is rendered from a built-in template, so there is no code to show.</p>');return;
      }
      showEmpty('');
      if(!st.loaded){if(!st.listing)loadList();chrome();return;}
      const k=keyOf(app);
      if(k!==st.key&&!st.busy&&!st.listing){
        if(st.dirty){st.key=k;if(app.revision!==st.ownRev)st.stale=true;}
        else loadList();
      }
      if(st.editor&&st.cur)st.editor.setReadOnly?.(fileRO());
      chrome();
    },
  };
}
