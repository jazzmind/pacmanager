/**
 * Business-language capability taxonomy for the "what should your app be able to do?"
 * picker (demo/web/index.html's new-application flow). A business user maps requirements
 * onto plain-English capabilities, not onto "RAG" or "Temporal" — this module is the one
 * place that translates between the two, and the one place honest about which capabilities
 * are real today versus not built yet (shown, not hidden — see docs/architecture.md's note
 * on this platform's own culture of documenting what's proven vs aspirational).
 *
 * Served both to the server (definition.js validates against CAPABILITY_IDS; store.js
 * derives envRefs from a generated app's stored capabilities) and to the browser as a
 * static file (ui.js renders the gallery/tick-list from the same data) -- one definition,
 * no drift between what the picker offers and what the backend accepts.
 */
export const CAPABILITY_GROUPS = [
  { id: 'today', label: 'Works today — no server needed', hint: 'Runs entirely in the browser, in the sandboxed preview and once shared.' },
  { id: 'server', label: 'Needs a real server app — more capable, less proven', hint: 'Becomes an "application" artifact: a real Dockerfile, built and deployed like any other service.' },
  { id: 'future', label: 'Not available yet — tell us if you need one', hint: 'Listed honestly rather than hidden. Nothing here can be selected.' },
];

export const CAPABILITIES = [
  { id: 'analyze', group: 'today', label: 'Work with data', description: 'Charts, filters and totals over data bundled with the app or pasted in.' },
  { id: 'export-data', group: 'today', label: 'Download results', description: 'Save results as a CSV or JSON file.' },
  { id: 'print-pdf', group: 'today', label: 'Print or save as PDF', description: "Uses your browser's own print dialog — no PDF library exists in this platform yet." },
  { id: 'remember', group: 'today', label: 'Remember choices on this device', description: 'Checkboxes and preferences persist between visits, on this device only. Ephemeral in preview; real once shared.' },
  { id: 'collaborate', group: 'today', label: 'Share and collect comments', description: 'Share it with colleagues and gather notes and discussion — built into every application automatically.' },
  { id: 'briefings', group: 'today', label: 'Show AI-written briefings', description: 'Displays research or updates an agent has already written for it. The app itself never calls AI — an agent (e.g. Claude) writes results in, and the app just displays them.' },
  // envRef is "pgvector", not "postgres": the real PR catalog (pracman/services/catalog.json)
  // has no separate plain-postgres kind at all -- pgvector IS the database it provisions,
  // just with the vector extension already enabled. Found live: capabilities.js originally
  // said "postgres" here, which the real deployed catalog rejects outright as an unknown
  // resource type, hanging every generation attempt on a repair loop that could never
  // succeed. Fixed on both sides: this mapping, and demo/services/default/catalog.json (the
  // bundled OSS default) now also declares "pgvector" so the same capability validates
  // consistently whichever catalog is actually loaded.
  { id: 'shared-data', group: 'server', label: 'Store data everyone shares', description: 'A real, dedicated database so information persists and everyone sees the same thing.', envRef: 'pgvector' },
  { id: 'documents', group: 'server', label: 'Store and search documents', description: 'A database with semantic-search support. Only the storage exists today — actually finding relevant passages is code the app itself still has to include.', envRef: 'pgvector', implies: ['shared-data'] },
  { id: 'ai-models', group: 'server', label: 'Use AI models while it runs', description: 'Summarize, draft, or answer questions using the same AI gateway the platform itself uses.', envRef: 'litellm' },
  { id: 'web-search', group: 'future', label: 'Search the web', description: 'No mechanism exists anywhere in this platform yet.' },
  { id: 'messaging', group: 'future', label: 'Send email or Teams messages', description: 'No mechanism exists yet. A comms bridge is designed but not built.' },
  { id: 'schedule', group: 'future', label: 'Run on a schedule', description: 'Temporal is wired up for the admin console only, deliberately with no way to start a real workflow yet.' },
  { id: 'internal-systems', group: 'future', label: 'Reach internal company systems and APIs', description: 'Only a mock/sample API exists for testing — never a real one.' },
];

export const CAPABILITY_IDS = CAPABILITIES.map(c => c.id);

/** Personal/customer (NPI) data and real customer traffic aren't a capability checkbox —
 * they're the reason an app needs to graduate rather than stay published in the studio (see
 * the publish/promote modal's boundary explainer). Surfaced in the picker as a routing
 * statement, not a selectable item. */
export const SENSITIVE_DATA_NOTICE = 'Handling customer or personal (NPI) data, reaching real internal systems, or serving real customers isn\'t a capability you turn on here — it means this application needs to graduate to production. Build it here first; graduation is a separate, explicit step.';

/** A handful of representative business use cases for the gallery — each a starting point
 * (capabilities + derived kind), not a locked-in choice; every field stays editable via
 * "Describe it myself". */
export const USE_CASES = [
  { id: 'team-dashboard', label: 'Team dashboard', description: "A home page for your team's priorities, status and links — the pattern behind the personal chief-of-staff dashboard.", capabilities: ['analyze', 'export-data', 'remember', 'collaborate'] },
  { id: 'briefing', label: 'Interactive briefing or walkthrough', description: 'A page that presents research or a walkthrough your agent already wrote, for colleagues to read and discuss.', capabilities: ['briefings', 'collaborate'] },
  { id: 'data-explorer', label: 'Data explorer', description: 'Paste in a spreadsheet; get filters, charts and a printable summary back.', capabilities: ['analyze', 'export-data', 'print-pdf'] },
  { id: 'practice-scenario', label: 'Practice scenario or game', description: 'An interactive scenario or game for training or engagement — self-contained, nothing shared between players.', capabilities: ['remember'] },
  { id: 'digital-expert', label: 'Digital expert', description: 'A page that answers questions in a specific voice, backed by recorded briefings. (A version that reads its own document library and calls AI live is possible via the server path, but has never been proven end to end here — treat that route as unproven, not turnkey.)', capabilities: ['briefings', 'collaborate'] },
  { id: 'intake-form', label: 'Guided intake form', description: 'Collect structured submissions from colleagues into one shared, exportable place.', capabilities: ['shared-data', 'export-data', 'collaborate'] },
];

/** Any server capability forces kind:"application" (a real Dockerfile, deployed like any
 * other service); "briefings" alone maps to the knowledge kind's agent-run-briefing layout;
 * everything else is a plain interactive artifact. Retires asking a business user to pick a
 * kind directly — they answer what it should DO, not what it IS. */
export function deriveKind(capabilityIds = []) {
  const set = new Set(capabilityIds);
  if (CAPABILITIES.some(c => c.group === 'server' && set.has(c.id))) return 'application';
  if (set.has('briefings')) return 'knowledge';
  return 'interactive';
}

/** Expands `implies` (e.g. "documents" implying "shared-data") into the full effective set —
 * a business user checking "store and search documents" shouldn't also have to separately
 * notice and check "store data everyone shares". */
export function expandCapabilities(capabilityIds = []) {
  const set = new Set(capabilityIds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const cap of CAPABILITIES) {
      if (set.has(cap.id) && cap.implies) for (const dep of cap.implies) if (!set.has(dep)) { set.add(dep); grew = true; }
    }
  }
  return [...set];
}

/** The only place capability ids become deploykit envRefs -- see pracman's
 * adapters/runtime/deploykit/lib/appspec.js for what each resource type actually does at
 * deploy time. One env var name per resource kind is enough for this pass; an app needing
 * two capabilities of the same kind (unlikely -- pgvector already is a superset of postgres)
 * would collide, which is an acceptable simplification for now, not silently wrong. */
const ENV_VAR_NAMES = { postgres: 'DATABASE_URL', pgvector: 'DATABASE_URL', litellm: 'LITELLM_URL' };
export function deriveEnvRefs(capabilityIds = []) {
  const envRefs = {};
  // First-write-wins, not last: expandCapabilities always inserts an explicit capability
  // before the dependencies it implies (e.g. "documents" before the "shared-data" it pulls
  // in), and pgvector is a strict superset of plain postgres for the same DATABASE_URL name
  // -- found live, a naive last-write-wins loop let "shared-data" silently downgrade
  // "documents"'s own binding back to plain postgres.
  for (const id of expandCapabilities(capabilityIds)) {
    const cap = CAPABILITIES.find(c => c.id === id);
    const varName = cap?.envRef && ENV_VAR_NAMES[cap.envRef];
    if (varName && !(varName in envRefs)) envRefs[varName] = cap.envRef;
  }
  return envRefs;
}
