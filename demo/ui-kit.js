import { loadBrand } from './brand.js';
import { DEFAULT_STYLE, normalizeStyle } from './style-options.js';

/** PAC UI kit: one prebuilt, deterministic stylesheet per (brand pack, accent, style). No URLs, no
 * @font-face, no external assets -- it must fit the static tier's CSP and no-URL source gate.
 * Brand-neutral: every colour comes from the brand pack tokens or the accent; contrast-critical
 * colours are nudged until they reach WCAG AA against the surface they sit on. */

const HEXRE = /^#[0-9a-fA-F]{6}$/;
const full = h => { h = String(h || '').trim(); if (/^#[0-9a-fA-F]{3}$/.test(h)) h = '#' + [...h.slice(1)].map(c => c + c).join(''); return HEXRE.test(h) ? h.toLowerCase() : null; };
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const hex = c => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const lum = h => { const [r, g, b] = rgb(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mix = (a, b, t) => { const p = rgb(a), q = rgb(b); return hex(p.map((v, i) => v + (q[i] - v) * t)); };
/** Move `c` toward white or black (whichever direction is away from bg) until it reaches `min` contrast on every bg given. */
function ensure(c, bgs, min = 4.5) {
  bgs = [].concat(bgs);
  const ok = x => bgs.every(b => contrast(x, b) >= min);
  if (ok(c)) return c;
  const toward = bgs.every(b => lum(b) < 0.4) ? '#ffffff' : '#000000';
  for (let t = 0.05; t <= 1.0001; t += 0.05) { const x = mix(c, toward, t); if (ok(x)) return x; }
  return toward;
}
const onColor = bg => contrast('#ffffff', bg) >= contrast('#14181c', bg) ? '#ffffff' : '#14181c';

function palette(tokens, accent, dark) {
  const t = (k, d) => full(tokens[k]) || d;
  const brandC = t('brand', accent);
  if (!dark) {
    const surface = t('surface', '#ffffff'), canvas = t('canvas', '#f6f6f4'), ink = ensure(t('ink', '#1c2420'), [surface, canvas], 7);
    const muted = ensure(t('ink-muted', '#5d6b64'), [surface, canvas], 4.5);
    const acc = ensure(accent, [surface, canvas]), brd = ensure(brandC, [surface, canvas]);
    return {
      canvas, surface, ink, muted, line: t('line', '#dcdfdb'), sunken: t('sunken', mix(canvas, ink, 0.05)), brand: brd, accent: acc,
      'on-brand': onColor(brd), 'on-accent': onColor(acc), 'accent-hover': ensure(t('accent-hover', mix(acc, '#000000', 0.15)), [surface], 4.5),
      ok: ensure(t('ok', '#2e7d46'), [surface, canvas]), warn: ensure(t('warn', '#a86a1f'), [surface, canvas]), error: ensure(t('error', '#b3261e'), [surface, canvas]),
      hover: t('hover', mix(surface, acc, 0.08)),
    };
  }
  const canvas = mix(t('navy', '#14181c'), '#000000', 0.25), surface = mix(canvas, '#ffffff', 0.07), ink = '#eef1ef';
  const acc = ensure(accent, [surface, canvas]), brd = ensure(brandC, [surface, canvas]);
  return {
    canvas, surface, ink, muted: ensure('#9aa6a0', [surface, canvas], 4.5), line: mix(surface, '#ffffff', 0.16), sunken: mix(canvas, '#000000', 0.25), brand: brd, accent: acc,
    'on-brand': onColor(brd), 'on-accent': onColor(acc), 'accent-hover': mix(acc, '#ffffff', 0.15),
    ok: ensure('#3f9d5d', [surface, canvas]), warn: ensure('#d19a3c', [surface, canvas]), error: ensure('#e0605a', [surface, canvas]),
    hover: mix(surface, acc, 0.16),
  };
}

// Per-preset shape: radius, shadow, type, header treatment. Density sets spacing.
const PRESETS = {
  clean: { r: 8, sh: '0 1px 2px rgba(0,0,0,.06)', fs: 16, hw: 650, hd: 'var(--pac-font)', band: false, card: 'border', tr: 'none', btn: 8 },
  bold: { r: 4, sh: '0 2px 0 rgba(0,0,0,.12)', fs: 17, hw: 800, hd: 'var(--pac-font-display)', band: true, card: 'thick', tr: 'none', btn: 4 },
  dashboard: { r: 6, sh: '0 1px 1px rgba(0,0,0,.08)', fs: 14, hw: 650, hd: 'var(--pac-font)', band: false, card: 'border', tr: 'none', btn: 6 },
  editorial: { r: 2, sh: 'none', fs: 18, hw: 600, hd: "Georgia,'Times New Roman',Times,serif", band: false, card: 'rule', tr: 'none', btn: 2 },
  playful: { r: 18, sh: '0 6px 18px rgba(0,0,0,.10)', fs: 16, hw: 750, hd: 'var(--pac-font-display)', band: false, card: 'soft', tr: 'transform .15s', btn: 999 },
};
const DENS = { comfortable: { gap: 16, py: 10, px: 16, pad: 24, ctl: 40, lh: 1.55 }, compact: { gap: 10, py: 5, px: 10, pad: 14, ctl: 32, lh: 1.4 } };

const SCALE = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24];
const px = n => n === 0 ? '0' : n * 4 + 'px';
const SIZES = { xs: [12, 16], sm: [14, 20], base: [16, 24], lg: [18, 28], xl: [20, 28], '2xl': [24, 32], '3xl': [30, 36], '4xl': [36, 40] };
const COLORS = ['brand', 'accent', 'muted', 'line', 'surface', 'canvas', 'ok', 'warn', 'error'];
const cvar = c => `var(--pac-${c})`;
const vars = p => Object.entries(p).map(([k, v]) => `--pac-${k}:${v};`).join('');

export function buildKitCss({ style, accentHex, brand, scope } = {}) {
  const st = normalizeStyle(style || DEFAULT_STYLE);
  brand = brand || loadBrand();
  const data = brand.data || {}, tokens = data.tokens || {};
  const accent = full(accentHex) || full(tokens.accent) || full(tokens.brand) || '#245e49';
  const P = PRESETS[st.preset], D = DENS[st.density];
  const fonts = data.fonts || {}, fb = fonts.fallback || 'ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif';
  const sans = `${fonts.sans ? `'${String(fonts.sans).replace(/[^\w \-]/g, '')}',` : ''}${fb}`;
  const disp = st.preset === 'editorial' ? P.hd : `${fonts.display ? `'${String(fonts.display).replace(/[^\w \-]/g, '')}',` : ''}${fb}`;
  const out = [];
  const sc = scope || '';
  const sel = s => s.split(',').map(x => {
    x = x.trim();
    if (!sc) return x;
    if (/^(:root|html|body)$/.test(x)) return sc;
    return `${sc} ${x.replace(/^(:root|html|body)\s+/, '')}`;
  }).join(',');
  const R = (s, b) => out.push(`${sel(s)}{${b}}`);
  const M = (cond, fn) => { out.push(`@media ${cond}{`); fn(); out.push('}'); };

  const light = palette(tokens, accent, false), dark = palette(tokens, accent, true);
  const shape = `--pac-font:${sans};--pac-font-display:${st.preset === 'editorial' ? disp : disp};--pac-head:${P.hd === 'var(--pac-font)' ? sans : st.preset === 'editorial' ? P.hd : disp};--pac-radius:${P.r}px;--pac-radius-btn:${P.btn}px;--pac-shadow:${P.sh};--pac-fs:${P.fs}px;--pac-hw:${P.hw};--pac-gap:${D.gap}px;--pac-py:${D.py}px;--pac-px:${D.px}px;--pac-pad:${D.pad}px;--pac-ctl:${D.ctl}px;--pac-lh:${D.lh};`;
  const pal = st.theme === 'dark' ? dark : light;
  R(':root', `${shape}${vars(pal)}color-scheme:${st.theme === 'dark' ? 'dark' : st.theme === 'auto' ? 'light dark' : 'light'};`);
  if (st.theme === 'auto') M('(prefers-color-scheme:dark)', () => R(':root', vars(dark)));

  // reset + typography
  R('*,*::before,*::after', 'box-sizing:border-box');
  R('body', `margin:0;background:var(--pac-canvas);color:var(--pac-ink);font:var(--pac-fs)/var(--pac-lh) var(--pac-font);-webkit-text-size-adjust:100%;accent-color:var(--pac-accent)${sc ? ';padding:0' : ''}`);
  R('h1,h2,h3,h4,h5,h6', 'font-family:var(--pac-head);font-weight:var(--pac-hw);line-height:1.2;margin:0 0 .5em;letter-spacing:-.01em;overflow-wrap:anywhere');
  R('h1', `font-size:${st.preset === 'bold' ? '2.4em' : '2em'}`); R('h2', 'font-size:1.5em'); R('h3', 'font-size:1.2em'); R('h4,h5,h6', 'font-size:1em');
  R('p,ul,ol,pre,table,figure', 'margin:0 0 1em'); R('p', st.preset === 'editorial' ? 'max-width:68ch' : 'overflow-wrap:anywhere');
  R('a', 'color:var(--pac-accent);text-underline-offset:2px'); R('a:hover', 'color:var(--pac-accent-hover)');
  R('small', 'font-size:.85em;color:var(--pac-muted)');
  R('hr', 'border:0;border-top:1px solid var(--pac-line);margin:1.5em 0');
  R('code,pre,kbd', "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em");
  R('code', 'background:var(--pac-sunken);padding:.1em .35em;border-radius:4px');
  R('pre', 'background:var(--pac-sunken);padding:12px;border-radius:var(--pac-radius);overflow:auto;white-space:pre-wrap');
  R('pre code', 'background:none;padding:0');
  R('img,svg,video', 'max-width:100%;height:auto');
  R(':focus-visible', 'outline:3px solid var(--pac-accent);outline-offset:2px');
  R('::selection', 'background:var(--pac-accent);color:var(--pac-on-accent)');

  // form controls + buttons
  const ctl = 'font:inherit;color:var(--pac-ink);background:var(--pac-surface);border:1px solid var(--pac-muted);border-radius:var(--pac-radius-btn);padding:var(--pac-py) var(--pac-px);min-height:var(--pac-ctl);max-width:100%';
  R('input,select,textarea,.pac-input', ctl);
  R('input[type=checkbox],input[type=radio]', 'min-height:0;width:1.1em;height:1.1em;padding:0');
  R('textarea,textarea.pac-input', 'min-height:6em;resize:vertical;border-radius:var(--pac-radius)');
  R('input::placeholder,textarea::placeholder', 'color:var(--pac-muted);opacity:1');
  R('input:focus,select:focus,textarea:focus', 'outline:3px solid var(--pac-accent);outline-offset:1px;border-color:var(--pac-accent)');
  R('input:disabled,select:disabled,textarea:disabled,button:disabled', 'opacity:.55;cursor:not-allowed');
  R('label', 'font-weight:600;font-size:.9em');
  const btn = `font:inherit;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:var(--pac-ctl);padding:var(--pac-py) calc(var(--pac-px)*1.2);border-radius:var(--pac-radius-btn);border:1px solid var(--pac-line);background:var(--pac-surface);color:var(--pac-ink);text-decoration:none;${P.tr !== 'none' ? `transition:${P.tr},background .15s;` : ''}box-shadow:var(--pac-shadow)`;
  R('button,.pac-btn', btn);
  R('button:hover,.pac-btn:hover', `background:var(--pac-hover)${st.preset === 'playful' ? ';transform:translateY(-1px)' : ''}`);
  R('.pac-btn-primary,.pac-btn.primary,button[type=submit]', 'background:var(--pac-accent);border-color:var(--pac-accent);color:var(--pac-on-accent)');
  R('.pac-btn-primary:hover,.pac-btn.primary:hover,button[type=submit]:hover', 'background:var(--pac-accent-hover);color:var(--pac-on-accent)');
  R('.pac-btn-ghost', 'background:transparent;border-color:transparent;box-shadow:none;color:var(--pac-accent)');
  R('.pac-btn-ghost:hover', 'background:var(--pac-hover)');
  R('.pac-btn-danger', 'background:var(--pac-error);border-color:var(--pac-error);color:#fff');
  R('.pac-btn-danger:hover', 'background:var(--pac-error);filter:brightness(.92);color:#fff');

  // components
  const cardCss = { border: 'border:1px solid var(--pac-line);box-shadow:var(--pac-shadow)', thick: 'border:2px solid var(--pac-ink);box-shadow:var(--pac-shadow)', rule: 'border:0;border-top:3px solid var(--pac-ink);padding-top:var(--pac-pad)', soft: 'border:1px solid var(--pac-line);box-shadow:var(--pac-shadow)' }[P.card];
  R('.pac-card', `background:var(--pac-surface);border-radius:var(--pac-radius);padding:var(--pac-pad);${cardCss}`);
  if (P.card === 'rule') R('.pac-card', 'background:transparent;padding-left:0;padding-right:0');
  R('.pac-card>:last-child', 'margin-bottom:0');
  R('.pac-field', 'display:flex;flex-direction:column;gap:6px;margin-bottom:var(--pac-gap)');
  R('.pac-field small', 'color:var(--pac-muted)');
  R('.pac-table', 'width:100%;border-collapse:collapse;font-size:.95em');
  R('.pac-table th,.pac-table td', 'text-align:left;padding:var(--pac-py) var(--pac-px);border-bottom:1px solid var(--pac-line);vertical-align:top');
  R('.pac-table th', `font-weight:700;color:var(--pac-muted);${st.preset === 'dashboard' ? 'text-transform:uppercase;font-size:.78em;letter-spacing:.05em;' : ''}background:var(--pac-sunken)`);
  if (st.preset !== 'editorial') R('.pac-table tbody tr:hover', 'background:var(--pac-hover)');
  R('.pac-badge', `display:inline-block;padding:2px 10px;border-radius:${st.preset === 'editorial' ? '2px' : '999px'};background:var(--pac-sunken);color:var(--pac-ink);border:1px solid var(--pac-line);font-size:.8em;font-weight:600;line-height:1.5`);
  for (const [n, c] of [['ok', 'ok'], ['warn', 'warn'], ['error', 'error'], ['accent', 'accent']]) R(`.pac-badge-${n}`, `color:var(--pac-${c});border-color:var(--pac-${c})`);
  R('.pac-tabs', 'display:flex;gap:4px;border-bottom:1px solid var(--pac-line);margin-bottom:var(--pac-gap);overflow-x:auto');
  R('.pac-tabs>*', 'padding:var(--pac-py) var(--pac-px);color:var(--pac-muted);font-weight:600;text-decoration:none;border:0;border-bottom:3px solid transparent;background:none;box-shadow:none;border-radius:0;cursor:pointer;white-space:nowrap');
  R('.pac-tabs>.active,.pac-tabs>[aria-selected=true],.pac-tabs>[aria-current]', 'color:var(--pac-ink);border-bottom-color:var(--pac-accent)');
  R('.pac-empty', 'text-align:center;color:var(--pac-muted);padding:calc(var(--pac-pad)*2) var(--pac-pad);border:2px dashed var(--pac-line);border-radius:var(--pac-radius)');
  const heroBg = st.preset === 'bold' ? 'background:var(--pac-brand);color:var(--pac-on-brand)' : st.preset === 'playful' ? 'background:var(--pac-sunken);color:var(--pac-ink)' : 'background:var(--pac-surface);color:var(--pac-ink)';
  R('.pac-hero', `${heroBg};padding:calc(var(--pac-pad)*${st.preset === 'bold' ? 2.4 : 1.6}) var(--pac-pad);border-radius:var(--pac-radius);margin-bottom:var(--pac-gap);${st.preset === 'editorial' ? 'text-align:left;border-bottom:1px solid var(--pac-line);border-radius:0' : ''}`);
  R('.pac-hero h1,.pac-hero h2', `margin-bottom:.3em${st.preset === 'bold' ? ';color:var(--pac-on-brand)' : ''}`);
  R('.pac-hero p', 'margin-bottom:0;max-width:60ch');
  R('.pac-stat', 'display:flex;flex-direction:column;gap:2px;background:var(--pac-surface);border:1px solid var(--pac-line);border-radius:var(--pac-radius);padding:var(--pac-py) var(--pac-px);' + (st.preset === 'dashboard' ? 'border-left:4px solid var(--pac-accent)' : ''));
  R('.pac-stat b,.pac-stat strong', `font-size:${st.preset === 'dashboard' ? '1.8em' : '2em'};line-height:1.1;font-family:var(--pac-head);color:var(--pac-ink)`);
  R('.pac-stat span,.pac-stat small', 'color:var(--pac-muted);font-size:.85em');
  R('.pac-alert', 'padding:var(--pac-py) var(--pac-px);border-radius:var(--pac-radius);border:1px solid var(--pac-line);border-left:4px solid var(--pac-accent);background:var(--pac-surface);color:var(--pac-ink);margin-bottom:var(--pac-gap)');
  for (const c of ['ok', 'warn', 'error']) R(`.pac-alert-${c}`, `border-left-color:var(--pac-${c})`);
  R('.pac-grid', 'display:grid;gap:var(--pac-gap);grid-template-columns:repeat(auto-fill,minmax(min(100%,240px),1fr))');
  R('.pac-chat', 'display:flex;flex-direction:column;gap:8px');
  R('.pac-msg,.pac-chat>*', `max-width:85%;padding:var(--pac-py) var(--pac-px);border-radius:${Math.min(P.r, 18)}px;background:var(--pac-sunken);color:var(--pac-ink);align-self:flex-start;overflow-wrap:anywhere`);
  R('.pac-msg-user,.pac-msg.user,.pac-chat>.user', 'align-self:flex-end;background:var(--pac-accent);color:var(--pac-on-accent)');

  // app shell + nav (layout)
  const navBand = P.band;
  R('.pac-app', `min-height:100vh;display:flex;flex-direction:column;background:var(--pac-canvas)`);
  R('.pac-main,.pac-app>main', `flex:1;width:100%;padding:var(--pac-pad);${st.layout === 'single' ? 'max-width:720px;margin:0 auto' : st.preset === 'editorial' ? 'max-width:960px;margin:0 auto' : 'max-width:1200px;margin:0 auto'}`);
  const navBg = navBand ? 'background:var(--pac-brand);color:var(--pac-on-brand);border-color:transparent' : 'background:var(--pac-surface);color:var(--pac-ink);border-color:var(--pac-line)';
  R('.pac-nav', `${navBg};display:flex;align-items:center;gap:var(--pac-gap);padding:var(--pac-py) var(--pac-pad);border-bottom:1px solid;flex-wrap:wrap`);
  const navInk = navBand ? 'var(--pac-on-brand)' : 'var(--pac-ink)';
  R('.pac-nav a', `color:${navInk};text-decoration:none;font-weight:600;padding:6px 10px;border-radius:var(--pac-radius-btn)`);
  R('.pac-nav a:hover,.pac-nav a[aria-current],.pac-nav a.active', navBand ? 'background:rgba(255,255,255,.18);color:var(--pac-on-brand)' : 'background:var(--pac-hover);color:var(--pac-ink)');
  R('.pac-nav .brand,.pac-nav-title', `font-family:var(--pac-head);font-weight:var(--pac-hw);font-size:1.15em;color:${navInk};margin-right:auto`);
  if (st.layout === 'single') {
    R('.pac-nav', 'justify-content:center;border-bottom:0;background:transparent;color:var(--pac-ink)');
    R('.pac-nav a', 'color:var(--pac-ink)');
    R('.pac-nav .brand,.pac-nav-title', 'margin-right:0;color:var(--pac-ink)');
  }
  if (st.layout === 'sidebar') M('(min-width:768px)', () => {
    R('.pac-app', 'flex-direction:row;align-items:stretch');
    R('.pac-nav', `flex-direction:column;align-items:stretch;flex-wrap:nowrap;width:${st.preset === 'dashboard' ? 208 : 232}px;flex:none;border-bottom:0;border-right:1px solid ${navBand ? 'transparent' : 'var(--pac-line)'};padding:var(--pac-pad) var(--pac-px);gap:4px;align-self:stretch`);
    R('.pac-nav .brand,.pac-nav-title', 'margin:0 0 var(--pac-gap)');
    R('.pac-main,.pac-app>main', 'min-width:0;margin:0');
  });

  // utilities
  R('.hidden', 'display:none'); R('.block', 'display:block'); R('.inline-block', 'display:inline-block'); R('.flex', 'display:flex'); R('.inline-flex', 'display:inline-flex'); R('.grid', 'display:grid');
  R('.flex-col', 'flex-direction:column'); R('.flex-row', 'flex-direction:row'); R('.flex-wrap', 'flex-wrap:wrap'); R('.flex-1', 'flex:1 1 0%'); R('.shrink-0', 'flex-shrink:0');
  R('.items-start', 'align-items:flex-start'); R('.items-center', 'align-items:center'); R('.items-end', 'align-items:flex-end'); R('.items-stretch', 'align-items:stretch');
  R('.justify-start', 'justify-content:flex-start'); R('.justify-center', 'justify-content:center'); R('.justify-end', 'justify-content:flex-end'); R('.justify-between', 'justify-content:space-between');
  for (let i = 1; i <= 4; i++) R(`.grid-cols-${i}`, `grid-template-columns:repeat(${i},minmax(0,1fr))`);
  M('(min-width:768px)', () => {
    for (let i = 1; i <= 4; i++) R(`.md\\:grid-cols-${i}`, `grid-template-columns:repeat(${i},minmax(0,1fr))`);
    R('.md\\:flex', 'display:flex'); R('.md\\:hidden', 'display:none'); R('.md\\:block', 'display:block'); R('.md\\:grid', 'display:grid'); R('.md\\:flex-row', 'flex-direction:row'); R('.md\\:w-1\\/2', 'width:50%');
  });
  M('(min-width:1024px)', () => { for (let i = 1; i <= 4; i++) R(`.lg\\:grid-cols-${i}`, `grid-template-columns:repeat(${i},minmax(0,1fr))`); });
  for (const n of SCALE) {
    const v = px(n);
    R(`.gap-${n}`, `gap:${v}`); R(`.gap-x-${n}`, `column-gap:${v}`); R(`.gap-y-${n}`, `row-gap:${v}`);
    R(`.p-${n}`, `padding:${v}`); R(`.px-${n}`, `padding-left:${v};padding-right:${v}`); R(`.py-${n}`, `padding-top:${v};padding-bottom:${v}`);
    for (const [k, s] of [['t', 'top'], ['r', 'right'], ['b', 'bottom'], ['l', 'left']]) { R(`.p${k}-${n}`, `padding-${s}:${v}`); R(`.m${k}-${n}`, `margin-${s}:${v}`); }
    R(`.m-${n}`, `margin:${v}`); R(`.mx-${n}`, `margin-left:${v};margin-right:${v}`); R(`.my-${n}`, `margin-top:${v};margin-bottom:${v}`);
    R(`.space-y-${n}>*+*`, `margin-top:${v}`); R(`.space-x-${n}>*+*`, `margin-left:${v}`);
  }
  R('.mx-auto', 'margin-left:auto;margin-right:auto'); R('.ml-auto', 'margin-left:auto'); R('.mr-auto', 'margin-right:auto');
  for (const [k, [s, l]] of Object.entries(SIZES)) R(`.text-${k}`, `font-size:${s}px;line-height:${l}px`);
  R('.font-normal', 'font-weight:400'); R('.font-medium', 'font-weight:500'); R('.font-semibold', 'font-weight:600'); R('.font-bold', 'font-weight:700');
  R('.italic', 'font-style:italic'); R('.uppercase', 'text-transform:uppercase'); R('.text-left', 'text-align:left'); R('.text-center', 'text-align:center'); R('.text-right', 'text-align:right');
  R('.leading-tight', 'line-height:1.25'); R('.leading-normal', 'line-height:1.5'); R('.tracking-wide', 'letter-spacing:.05em');
  R('.rounded-none', 'border-radius:0'); R('.rounded-sm', 'border-radius:2px'); R('.rounded', 'border-radius:4px'); R('.rounded-md', 'border-radius:6px'); R('.rounded-lg', 'border-radius:8px'); R('.rounded-xl', 'border-radius:12px'); R('.rounded-2xl', 'border-radius:16px'); R('.rounded-full', 'border-radius:9999px');
  R('.shadow-sm', 'box-shadow:0 1px 2px rgba(0,0,0,.08)'); R('.shadow', 'box-shadow:0 1px 3px rgba(0,0,0,.12),0 1px 2px rgba(0,0,0,.08)'); R('.shadow-md', 'box-shadow:0 4px 8px rgba(0,0,0,.12)'); R('.shadow-lg', 'box-shadow:0 10px 20px rgba(0,0,0,.14)'); R('.shadow-none', 'box-shadow:none');
  R('.border', 'border:1px solid var(--pac-line)'); R('.border-0', 'border:0'); R('.border-b', 'border-bottom:1px solid var(--pac-line)'); R('.border-t', 'border-top:1px solid var(--pac-line)');
  R('.w-full', 'width:100%'); R('.w-auto', 'width:auto'); R('.h-full', 'height:100%'); R('.min-h-screen', 'min-height:100vh'); R('.min-w-0', 'min-width:0');
  for (const [k, v] of Object.entries({ xs: 320, sm: 384, md: 448, lg: 512, xl: 576, '2xl': 672, '3xl': 768, '4xl': 896, '5xl': 1024, '6xl': 1152 })) R(`.max-w-${k}`, `max-width:${v}px`);
  R('.max-w-full', 'max-width:100%'); R('.truncate', 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
  R('.overflow-auto', 'overflow:auto'); R('.overflow-hidden', 'overflow:hidden'); R('.relative', 'position:relative'); R('.cursor-pointer', 'cursor:pointer');
  for (const c of COLORS) { R(`.text-${c}`, `color:${cvar(c)}`); R(`.bg-${c}`, `background-color:${cvar(c)}`); R(`.border-${c}`, `border-color:${cvar(c)}`); }
  R('.bg-brand', 'color:var(--pac-on-brand)'); R('.bg-accent', 'color:var(--pac-on-accent)');
  R('.text-ink', 'color:var(--pac-ink)');
  M('(max-width:480px)', () => { R('.pac-main', 'padding:calc(var(--pac-pad)*.65)'); R('.pac-table', 'display:block;overflow-x:auto'); });
  return out.join('\n') + '\n';
}
