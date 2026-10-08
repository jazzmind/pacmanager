/** Design-system guidance for the authoring prompt: the PAC UI kit's class cheat-sheet (generated from compact lists so it can't
 * sprawl), the chosen style in words, and one layout skeleton per layout. The kit itself (demo/ui-kit.js) is host-injected for
 * static kinds and written to pac-ui.css for the application kind -- the model never reproduces it. */
const COMPONENTS = [
  ['.pac-app / .pac-main', 'page shell (wrap everything) and its content area'],
  ['.pac-nav (+ .brand, <a>)', 'navigation bar or sidebar, depending on the chosen layout'],
  ['.pac-card', 'bordered surface for a group of content'],
  ['.pac-btn, -primary, -ghost, -danger', 'buttons (plain <button> is already styled)'],
  ['.pac-field > label + .pac-input', 'labelled form field; inputs/select/textarea are styled by default'],
  ['.pac-table', 'data table'], ['.pac-badge, -ok, -warn, -error, -accent', 'status pill'],
  ['.pac-tabs > a|button (.active)', 'tab strip'], ['.pac-empty', 'empty state'], ['.pac-hero', 'page intro band'],
  ['.pac-stat > b + span', 'big-number tile'], ['.pac-alert, -ok, -warn, -error', 'message banner'],
  ['.pac-grid', 'responsive auto-fill card grid'], ['.pac-chat > .pac-msg, .pac-msg-user', 'chat bubbles'],
];
const UTILITIES = [
  'flex flex-col flex-wrap flex-1 grid grid-cols-1..4 md:grid-cols-1..4 lg:grid-cols-1..4 md:flex md:hidden hidden block',
  'items-start|center|end justify-start|center|end|between gap-0..24 (4px scale) p-/px-/py-/pt-/m-/mx-/my-/mt-/mb- 0..24 space-y-/space-x- 0..24',
  'text-xs|sm|base|lg|xl|2xl|3xl|4xl font-normal|medium|semibold|bold text-left|center|right uppercase italic truncate',
  'rounded rounded-md|lg|xl|full shadow-sm|shadow|shadow-md|shadow-lg border border-b border-t w-full max-w-xs..6xl mx-auto min-h-screen',
  'colour utilities (tokens only): text-/bg-/border- + brand|accent|muted|line|surface|canvas|ok|warn|error',
];
export const KIT_CHEATSHEET = [
  'Components:', ...COMPONENTS.map(([c, d]) => `- ${c}: ${d}`),
  'Tailwind-compatible utilities (same names as Tailwind, curated subset -- use only these):', ...UTILITIES.map(u => `- ${u}`),
  'Colour tokens as CSS variables if you must write CSS: var(--pac-brand|accent|ink|muted|line|surface|canvas|sunken|ok|warn|error), also --pac-radius, --pac-gap, --pac-pad.',
].join('\n');

const PRESET_WORDS = {
  clean: 'clean: airy, light, subtle borders, generous whitespace',
  bold: 'bold: strong brand-coloured header band, large heavy type, thick borders',
  dashboard: 'dashboard: dense, data-first, small type, stat tiles and tables',
  editorial: 'editorial: serif headings, a comfortable reading measure, rules instead of boxes',
  playful: 'playful: very rounded, vivid accent, soft shadows, pill buttons',
};
const LAYOUT_WORDS = { 'top-nav': 'top-nav (navigation bar across the top)', sidebar: 'sidebar (navigation column on the left on wide screens, stacked on phones)', single: 'single (one focused centred column, minimal navigation)' };
export function styleInWords(style = {}) {
  const { preset = 'clean', theme = 'light', density = 'comfortable', layout = 'top-nav' } = style;
  return `Style: ${PRESET_WORDS[preset] || preset}; theme ${theme}${theme === 'auto' ? ' (follows the OS light/dark setting)' : ''}; ${density} density; layout ${LAYOUT_WORDS[layout] || layout}. The kit already renders all of this -- just use its classes; never branch on the style.`;
}

export const LAYOUT_SKELETONS = {
  'top-nav': `<div class="pac-app">
  <header class="pac-nav"><span class="brand">App name</span><a href="#home" aria-current="page">Home</a><a href="#data">Data</a></header>
  <main class="pac-main">
    <section class="pac-hero"><h1>Title</h1><p>One-line purpose.</p></section>
    <div class="pac-grid"><div class="pac-card"><h2>Section</h2>...</div></div>
  </main>
</div>`,
  sidebar: `<div class="pac-app">
  <nav class="pac-nav" aria-label="Main"><span class="brand">App name</span><a href="#home" aria-current="page">Home</a><a href="#data">Data</a></nav>
  <main class="pac-main">
    <h1>Title</h1>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4"><div class="pac-stat"><b>42</b><span>Label</span></div>...</div>
    <div class="pac-card mt-4"><table class="pac-table">...</table></div>
  </main>
</div>`,
  single: `<div class="pac-app">
  <header class="pac-nav"><span class="brand">App name</span></header>
  <main class="pac-main">
    <h1>Title</h1>
    <div class="pac-card"><div class="pac-field"><label for="q">Question</label><input id="q" class="pac-input"></div><button class="pac-btn pac-btn-primary">Go</button></div>
  </main>
</div>`,
};

/** The full Design system block for the prompt. Static kinds: kit is injected by the host. Application kind: kit is pac-ui.css in the workdir. */
export function designSystemBlock({ kind, style }) {
  const app = kind === 'application';
  const lines = [
    'DESIGN SYSTEM (PAC UI kit) -- build the interface from this kit instead of writing your own styling:',
    styleInWords(style),
    '',
    KIT_CHEATSHEET,
    '',
    `Layout skeleton for the chosen layout (adapt the content, keep the structure):`,
    LAYOUT_SKELETONS[style?.layout] || LAYOUT_SKELETONS['top-nav'],
    '',
    'Design rules:',
    '- Use kit classes first; write minimal custom CSS, only for what the kit cannot express.',
    '- Colours come only from the tokens (utilities or var(--pac-*)); no hard-coded hex/rgb colours.',
    '- Every control has an accessible label (label/for, aria-label); keep visible focus; use semantic elements (header, nav, main, button, table).',
    '- Responsive: must work at 360px and at 1280px wide; no fixed widths wider than the viewport.',
    '- No external assets: no CDN, web fonts, remote images or icon fonts (inline SVG is fine).',
  ];
  if (app || kind === 'auto') lines.push(
    '- For this application kind the kit is ALREADY in the project as pac-ui.css (host-managed, with pac-ui.json). NEVER overwrite or output pac-ui.css/pac-ui.json; serve it and link it with <link rel="stylesheet" href="{APP_BASE_PATH}/pac-ui.css"> (use the real APP_BASE_PATH env value, empty string when unset).',
    '- Honour APP_BASE_PATH for every link, fetch and static asset path (the app is served under that prefix). Listen on the PORT environment variable. Expose GET /health returning 200. Include a Dockerfile at the project root.');
  if (kind === 'auto') lines.push('(The two bullets above about pac-ui.css, APP_BASE_PATH, PORT, /health and the Dockerfile apply ONLY if you choose kind "application".)');
  if (!app) lines.push('- For static kinds (interactive, knowledge): the host injects the kit CSS into the page ahead of your own CSS: do NOT reproduce or copy the kit, and do not write a reset or base typography. Your styles.css only holds small app-specific additions.');
  return lines.join('\n');
}
