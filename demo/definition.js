import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { treeDigest } from './tree-digest.js';
import { loadBrand } from './brand.js';
import { loadCatalog } from './services.js';

// Single accent palette, sourced from the active brand pack (PAC_BRAND_PACK, else the bundled
// default). Previously duplicated verbatim in compileStatic() and compile() -- see
// docs/implementation-status.md.
const brand = loadBrand();
const accentPalette = () => brand.accentPalette();
export const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const sha = value => createHash('sha256').update(value).digest('hex');
const csphash = value => createHash('sha256').update(value, 'utf8').digest('base64');

const SOURCE_PATH_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
const SOURCE_EXT_RE = /\.(html|css|js|json|svg)$/i;
const MAX_SOURCE_FILES = 25;
const MAX_SOURCE_BYTES = 512000;

function validateSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('source must be an object mapping file path to text content');
  const paths = Object.keys(source);
  if (!paths.length) throw new Error('source must include at least index.html');
  if (paths.length > MAX_SOURCE_FILES) throw new Error(`static tier supports at most ${MAX_SOURCE_FILES} files`);
  if (!paths.includes('index.html')) throw new Error('source must include index.html');
  let total = 0;
  const clean = {};
  for (const p of paths.sort()) {
    if (p.includes('..') || p.startsWith('/') || !SOURCE_PATH_RE.test(p)) throw new Error(`Unsafe source path: ${p}`);
    if (!SOURCE_EXT_RE.test(p)) throw new Error(`Unsupported source file type: ${p}`);
    const text = source[p];
    if (typeof text !== 'string') throw new Error(`Source file content must be a string: ${p}`);
    total += Buffer.byteLength(text, 'utf8');
    clean[p] = text;
  }
  if (total > MAX_SOURCE_BYTES) throw new Error(`static tier source must total ${MAX_SOURCE_BYTES / 1000}KB or less`);
  return clean;
}

const FORBIDDEN_JS = [
  [/\beval\s*\(/, 'eval()'],
  [/\bnew\s+Function\s*\(/, 'dynamic Function construction'],
  [/\bFunction\s*\(\s*['"`]/, 'dynamic Function construction'],
  [/document\.write\s*\(/, 'document.write()'],
  [/\bfetch\s*\(/, 'outbound fetch()'],
  [/XMLHttpRequest/, 'XMLHttpRequest'],
  [/\bWebSocket\s*\(/, 'WebSocket'],
  [/navigator\.sendBeacon/, 'navigator.sendBeacon'],
  [/\bimport\s*\(/, 'dynamic import()'],
];
function staticSafetyIssues(source) {
  const issues = [];
  const js = Object.entries(source).filter(([p]) => p.endsWith('.js')).map(([, t]) => t).join('\n');
  const all = Object.values(source).join('\n');
  for (const [re, label] of FORBIDDEN_JS) if (re.test(js)) issues.push(label);
  if (/<\/script/i.test(all)) issues.push('a "</script" sequence in source (would break the generated document)');
  if (/<\/style/i.test(all)) issues.push('a "</style" sequence in source (would break the generated document)');
  if (/https?:\/\//i.test(all)) issues.push('an external (http/https) reference — generated apps cannot reach the network');
  return issues;
}

function compileStatic(config) {
  const { title, accent: accentKey, source } = config;
  const issues = staticSafetyIssues(source);
  if (issues.length) throw new Error('Static source rejected: ' + issues.join('; '));
  const accent = accentPalette()[accentKey];
  const files = Object.keys(source).sort();
  const css = files.filter(p => p.endsWith('.css')).map(p => source[p]).join('\n');
  const js = files.filter(p => p.endsWith('.js')).map(p => source[p]).join('\n;\n');
  const assets = Object.fromEntries(files.filter(p => p.endsWith('.json') || p.endsWith('.svg')).map(p => [p, source[p]]));
  const body = source['index.html'];
  const scriptBlock = `window.PAC_ASSETS=${JSON.stringify(assets)};\n(function(){\n'use strict';\n${js}\n})();`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;accent-color:${accent}}${css}</style></head><body>${body}<script>${scriptBlock}</script></body></html>`;
  const canonicalSource = Object.fromEntries(files.map(p => [p, source[p]]));
  return {
    config, html,
    sourceDigest: sha(JSON.stringify({ title, brief: config.brief, template: config.template, accent: accentKey, tier: 'static', source: canonicalSource })),
    htmlDigest: sha(html),
    scriptHashes: [csphash(scriptBlock)],
    checks: [
      { name: 'Definition schema', passed: true },
      { name: 'Static source safety (paths, extensions, size)', passed: true },
      { name: 'No eval, dynamic code or outbound network calls', passed: true },
      { name: 'Escaped user content', passed: true },
    ],
  };
}

const APP_TIER_FIELDS = ['sourcePath', 'dockerfile', 'port', 'pathPrefix', 'healthEndpoint', 'envRefs', 'syncCapable', 'memoryLimit', 'cpuLimit'];
// Known service kinds now come from the flexible services catalog (PAC_SERVICE_CATALOG, else
// the bundled default) instead of a hardcoded list -- see docs/implementation-status.md's
// services-layer section and pracman/services/catalog.json for the PR-specific catalog.
export const serviceCatalog = loadCatalog();
const ENV_REF_TYPES = serviceCatalog.kinds();

/** Validate the app tier's referenced-source fields (see docs/implementation-status.md R2).
 * Unlike the template/static tiers, tier "app" does not embed source in the definition —
 * it names a real folder already on disk, so validation here reaches the filesystem
 * (treeDigest throws if sourcePath isn't a real, non-empty directory) rather than staying
 * pure. That is a deliberate, documented departure from the other tiers' style. */
function validateAppFields(value) {
  if (typeof value.sourcePath !== 'string' || !value.sourcePath.trim()) throw new Error('sourcePath is required for tier app (a real folder on disk)');
  const sourcePath = value.sourcePath.trim();
  if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) throw new Error(`sourcePath must be a real, existing directory: ${sourcePath}`);
  const result = { sourcePath };
  result.dockerfile = typeof value.dockerfile === 'string' && value.dockerfile.trim() ? value.dockerfile.trim() : 'Dockerfile';
  if (value.port !== undefined) {
    if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('port must be an integer 1-65535');
    result.port = value.port;
  }
  if (value.pathPrefix !== undefined) {
    if (typeof value.pathPrefix !== 'string' || !/^\/[a-z0-9-]*$/.test(value.pathPrefix)) throw new Error('pathPrefix must start with / and contain only lowercase letters, digits and hyphens');
    result.pathPrefix = value.pathPrefix;
  }
  result.healthEndpoint = typeof value.healthEndpoint === 'string' && value.healthEndpoint ? value.healthEndpoint : '/health';
  if (value.envRefs !== undefined) {
    if (typeof value.envRefs !== 'object' || value.envRefs === null || Array.isArray(value.envRefs)) throw new Error('envRefs must be an object mapping env var name to resource type');
    for (const [k, v] of Object.entries(value.envRefs)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`Invalid env var name in envRefs: ${k}`);
      if (!ENV_REF_TYPES.includes(v)) throw new Error(`Unsupported envRefs resource type for ${k}: ${v} (expected one of ${ENV_REF_TYPES.join(', ')})`);
    }
    result.envRefs = value.envRefs;
  }
  if (value.syncCapable !== undefined) {
    if (typeof value.syncCapable !== 'boolean') throw new Error('syncCapable must be a boolean');
    result.syncCapable = value.syncCapable;
  }
  if (value.memoryLimit !== undefined) {
    if (typeof value.memoryLimit !== 'string' || !/^\d+[mg]$/i.test(value.memoryLimit)) throw new Error('memoryLimit must look like "512m" or "1g"');
    result.memoryLimit = value.memoryLimit;
  }
  if (value.cpuLimit !== undefined) {
    if (typeof value.cpuLimit !== 'string' || !/^\d+(\.\d+)?$/.test(value.cpuLimit)) throw new Error('cpuLimit must be a number string like "0.5"');
    result.cpuLimit = value.cpuLimit;
  }
  return result;
}

/** tier "app": pacmanager attests source identity (a byte-exact digest of the referenced
 * tree) rather than reproducing a build — see docs/implementation-status.md R3. There is
 * no html; the app is previewed by visiting its deployment, not an inlined iframe. */
function compileApp(config) {
  let tree;
  try { tree = treeDigest(config.sourcePath); }
  catch (e) { throw new Error(`Cannot read source tree at ${config.sourcePath}: ${e.message}`); }
  let gitCommit = null;
  try { gitCommit = execSync('git rev-parse HEAD', { cwd: config.sourcePath, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a git repo, or git unavailable — informational only */ }
  return {
    config, html: null, htmlDigest: null, scriptHashes: [],
    sourceDigest: tree.digest, fileCount: tree.fileCount, gitCommit,
    checks: [
      { name: 'Definition schema', passed: true },
      { name: 'Source path resolves to a real, non-empty directory', passed: true },
      { name: `Source tree digested (${tree.fileCount} files)`, passed: true },
    ],
  };
}

export function definition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Application definition required');
  const tier = value.tier || 'template';
  if (!['template', 'static', 'app'].includes(tier)) throw new Error('tier must be template, static or app');
  const allowed = ['title', 'brief', 'template', 'accent', 'tier',
    ...(tier === 'static' ? ['source'] : []),
    ...(tier === 'app' ? APP_TIER_FIELDS : [])];
  for (const k of Object.keys(value)) if (!allowed.includes(k)) throw new Error(`Unsupported definition field: ${k}`);
  if (typeof value.title !== 'string' || value.title.trim().length < 3 || value.title.length > 80) throw new Error('Title must be 3–80 characters');
  if (typeof value.brief !== 'string' || value.brief.length < 10 || value.brief.length > 3000) throw new Error('Brief must be 10–3000 characters');
  if (!['claims', 'knowledge'].includes(value.template)) throw new Error('Choose claims or knowledge template');
  if (!Object.keys(accentPalette()).includes(value.accent)) throw new Error(`Choose one of: ${Object.keys(accentPalette()).join(', ')}`);
  const result = { title: value.title.trim(), brief: value.brief, template: value.template, accent: value.accent, tier };
  if (tier === 'static') result.source = validateSource(value.source);
  if (tier === 'app') Object.assign(result, validateAppFields(value));
  return result;
}

export function compile(input) {
  const config = definition(input);
  if (config.tier === 'app') return compileApp(config);
  if (config.tier === 'static') return compileStatic(config);
  const accent = accentPalette()[config.accent];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(config.title)}</title><style>
  *{box-sizing:border-box}body{margin:0;padding:32px;font:15px/1.55 system-ui,sans-serif;background:#f8faf9;color:#19332f}h1{font-size:32px;letter-spacing:-1px;line-height:1.15;margin:12px 0}h2{font-size:19px}small{letter-spacing:2px;color:${accent};text-transform:uppercase;font-weight:700}.intro{max-width:700px;color:#526b65}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:28px 0}.card,section{background:white;border:1px solid #dce7e2;padding:20px;border-radius:12px}.card b{display:block;font-size:30px;color:${accent}}section{margin-top:18px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:12px 8px;border-bottom:1px solid #edf1ef}th{color:#5c706a}p{overflow-wrap:anywhere}.pill{background:#eaf3ef;color:${accent};padding:4px 8px;border-radius:5px}.empty{color:#71847e}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 system-ui} @media(max-width:600px){body{padding:18px}.grid{grid-template-columns:1fr}table{font-size:11px}h1{font-size:25px}}
  </style></head><body><small>${config.template === 'claims' ? 'Claims intelligence' : 'Team knowledge'}</small><h1>${escape(config.title)}</h1><p class="intro">${escape(config.brief)}</p><!--PAC-DATA--></body></html>`;
  return {config,html,sourceDigest:sha(JSON.stringify(config)),htmlDigest:sha(html),scriptHashes:[],checks:[{name:'Definition schema',passed:true},{name:'No generated executable code',passed:true},{name:'Escaped user content',passed:true}]};
}
export function injectBriefings(html, briefings) {
  if (!html.includes('<!--PAC-BRIEFINGS-->')) return html;
  const safe = JSON.stringify(briefings || []).replace(/</g, '\\u003c');
  return html.replace('<!--PAC-BRIEFINGS-->', `<script type="application/json" id="pac-briefings">${safe}</script>`);
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
