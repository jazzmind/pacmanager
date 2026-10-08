// Style options shared by the server and the browser (no imports).
export const STYLE_PRESETS = [
  { id: 'clean', label: 'Clean', description: 'Airy, light, subtle borders' },
  { id: 'bold', label: 'Bold', description: 'Strong brand header band, large type' },
  { id: 'dashboard', label: 'Dashboard', description: 'Dense, stat tiles, built for data' },
  { id: 'editorial', label: 'Editorial', description: 'Serif headings, comfortable reading measure' },
  { id: 'playful', label: 'Playful', description: 'Rounded, vivid accent, soft shadows' },
];
export const STYLE_THEMES = [{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }, { id: 'auto', label: 'Auto' }];
export const STYLE_DENSITIES = [{ id: 'comfortable', label: 'Comfortable' }, { id: 'compact', label: 'Compact' }];
export const STYLE_LAYOUTS = [
  { id: 'top-nav', label: 'Top nav', description: 'Navigation bar across the top' },
  { id: 'sidebar', label: 'Sidebar', description: 'Navigation column on the left' },
  { id: 'single', label: 'Single page', description: 'One focused column, no navigation chrome' },
];
export const DEFAULT_STYLE = { preset: 'clean', theme: 'light', density: 'comfortable', layout: 'top-nav' };
const ids = (l) => l.map((x) => x.id);
const SETS = { preset: ids(STYLE_PRESETS), theme: ids(STYLE_THEMES), density: ids(STYLE_DENSITIES), layout: ids(STYLE_LAYOUTS) };
export function normalizeStyle(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  for (const k of Object.keys(DEFAULT_STYLE)) out[k] = SETS[k].includes(v[k]) ? v[k] : DEFAULT_STYLE[k];
  return out;
}
