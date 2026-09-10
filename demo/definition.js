import { createHash } from 'node:crypto';
export const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const sha = value => createHash('sha256').update(value).digest('hex');
export function definition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Application definition required');
  for (const k of Object.keys(value)) if (!['title','brief','template','accent'].includes(k)) throw new Error(`Unsupported definition field: ${k}`);
  if (typeof value.title !== 'string' || value.title.trim().length < 3 || value.title.length > 80) throw new Error('Title must be 3–80 characters');
  if (typeof value.brief !== 'string' || value.brief.length < 10 || value.brief.length > 3000) throw new Error('Brief must be 10–3000 characters');
  if (!['claims','knowledge'].includes(value.template)) throw new Error('Choose claims or knowledge template');
  if (!['teal','blue','plum'].includes(value.accent)) throw new Error('Choose teal, blue or plum accent');
  return {title:value.title.trim(),brief:value.brief,template:value.template,accent:value.accent};
}
export function compile(input) {
  const config = definition(input);
  const accent = {teal:'#136f63',blue:'#245a9e',plum:'#79476f'}[config.accent];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(config.title)}</title><style>
  *{box-sizing:border-box}body{margin:0;padding:32px;font:15px/1.55 system-ui,sans-serif;background:#f8faf9;color:#19332f}h1{font-size:32px;letter-spacing:-1px;line-height:1.15;margin:12px 0}h2{font-size:19px}small{letter-spacing:2px;color:${accent};text-transform:uppercase;font-weight:700}.intro{max-width:700px;color:#526b65}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:28px 0}.card,section{background:white;border:1px solid #dce7e2;padding:20px;border-radius:12px}.card b{display:block;font-size:30px;color:${accent}}section{margin-top:18px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:12px 8px;border-bottom:1px solid #edf1ef}th{color:#5c706a}p{overflow-wrap:anywhere}.pill{background:#eaf3ef;color:${accent};padding:4px 8px;border-radius:5px}.empty{color:#71847e}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 system-ui} @media(max-width:600px){body{padding:18px}.grid{grid-template-columns:1fr}table{font-size:11px}h1{font-size:25px}}
  </style></head><body><small>${config.template === 'claims' ? 'Claims intelligence' : 'Team knowledge'}</small><h1>${escape(config.title)}</h1><p class="intro">${escape(config.brief)}</p><!--PAC-DATA--></body></html>`;
  return {config,html,sourceDigest:sha(JSON.stringify(config)),htmlDigest:sha(html),checks:[{name:'Definition schema',passed:true},{name:'No generated executable code',passed:true},{name:'Escaped user content',passed:true}]};
}
export function render(html, app) {
  const claims = app.binding ? app.claims : [];
  const documents = app.documents || [], comments = app.comments || [];
  let body = `<div class="grid"><div class="card">Shared documents<b>${documents.length}</b></div><div class="card">Team notes<b>${comments.length}</b></div><div class="card">${app.binding ? 'Synthetic claims' : 'Connected services'}<b>${claims.length}</b></div></div>`;
  if(app.binding) body += `<section><h2>Claims overview <span class="pill">Mock data</span></h2><table><thead><tr><th>Claim</th><th>Loss</th><th>Status</th><th>Estimate</th></tr></thead><tbody>${claims.map(c=>`<tr><td>${escape(c.id)}</td><td>${escape(c.loss)}</td><td>${escape(c.status)}</td><td>$${Number(c.estimate).toLocaleString('en-US')}</td></tr>`).join('')}</tbody></table></section>`;
  body += `<section><h2>Shared knowledge</h2>${documents.length ? documents.map(d=>`<p><strong>${escape(d.name)}</strong> <span class="pill">${escape(d.author)}</span></p>${d.text ? `<pre>${escape(d.text.slice(0,700))}</pre>` : '<p>Attachment available in the workspace.</p>'}`).join('') : '<p class="empty">Upload documents in the workspace to build your team’s shared context.</p>'}</section>`;
  body += `<section><h2>Team discussion</h2>${comments.length ? comments.slice(-10).map(c=>`<p><strong>${escape(c.author)}</strong> · ${escape(c.createdAt.slice(0,16).replace('T',' '))}<br>${escape(c.text)}</p>`).join('') : '<p class="empty">Add a note in the workspace. Colleagues will see it here.</p>'}</section>`;
  return html.replace('<!--PAC-DATA-->', () => body);
}
