import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Declarative service catalog loader — the OSS side of pacmanager's flexible services layer.
 * Mirrors brand.js's shape deliberately: a catalog is data (PAC_SERVICE_CATALOG, else a bundled
 * neutral default), loaded once, validated fail-fast. An app's `envRefs: {ENV_VAR: kind}` names
 * a catalog kind; this module is the single source of truth for which kinds exist, replacing
 * the hardcoded ENV_REF_TYPES list that used to live in definition.js.
 *
 * `prod.projection` is a closed vocabulary that drives the graduation gate (see archive.js):
 *   - "native"       a real devops-platform resource type exists; graduation emits it directly.
 *   - "substituted"  no matching type; graduates onto a different type teams already use by
 *                    hand (e.g. an API-gateway-less LLM proxy riding on a `secret` + `properties`
 *                    pair). Always carries a `caveat`.
 *   - "local-only"   no prod equivalent at all (e.g. a mock API stub). Blocks graduation unless
 *                    the caller explicitly passes allowLocalOnly.
 * PR-specific catalog contents (which images, which real endpoints) live in pracman, never here
 * — see pracman/README.md's OSS/PR split table. */

const DEFAULT_CATALOG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'services', 'default');
const PROJECTIONS = new Set(['native', 'substituted', 'local-only']);
const KIND_RE = /^[a-z][a-z0-9-]*$/;

function validate(path, data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.services)) throw new Error(`Service catalog error: ${path} must have a "services" array`);
  const seen = new Set();
  for (const entry of data.services) {
    if (!entry || typeof entry.kind !== 'string' || !KIND_RE.test(entry.kind)) throw new Error(`Service catalog error: invalid or missing "kind" in ${path}`);
    if (seen.has(entry.kind)) throw new Error(`Service catalog error: duplicate kind "${entry.kind}" in ${path}`);
    seen.add(entry.kind);
    if (typeof entry.implemented !== 'boolean') throw new Error(`Service catalog error: ${entry.kind}.implemented must be a boolean`);
    if (!entry.prod || !PROJECTIONS.has(entry.prod.projection)) throw new Error(`Service catalog error: ${entry.kind}.prod.projection must be one of ${[...PROJECTIONS].join(', ')}`);
    if (entry.prod.projection !== 'native' && typeof entry.prod.caveat !== 'string') throw new Error(`Service catalog error: ${entry.kind}.prod.caveat is required when projection is not "native"`);
    if (entry.binding && (typeof entry.binding !== 'object' || Array.isArray(entry.binding))) throw new Error(`Service catalog error: ${entry.kind}.binding must be an object of {sentinelToken: resultKey}`);
  }
}

function loadCatalogFile(dir) {
  const path = resolve(dir, 'catalog.json');
  if (!existsSync(path)) throw new Error(`Service catalog error: no catalog.json at ${dir}`);
  let data;
  try { data = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new Error(`Service catalog error: invalid JSON in ${path}: ${e.message}`); }
  validate(path, data);
  return data;
}

export function loadCatalog(catalogPath = process.env.PAC_SERVICE_CATALOG) {
  // Accept either a directory containing catalog.json (mirrors PAC_BRAND_PACK's convention) or a
  // direct path to a .json file, so a caller can point PAC_SERVICE_CATALOG straight at
  // pracman/services/catalog.json without also passing a directory.
  let data;
  if (!catalogPath) {
    data = loadCatalogFile(DEFAULT_CATALOG_DIR);
  } else if (catalogPath.endsWith('.json')) {
    if (!existsSync(catalogPath)) throw new Error(`Service catalog error: no file at ${catalogPath}`);
    try { data = JSON.parse(readFileSync(catalogPath, 'utf8')); }
    catch (e) { throw new Error(`Service catalog error: invalid JSON in ${catalogPath}: ${e.message}`); }
    validate(catalogPath, data);
  } else {
    data = loadCatalogFile(catalogPath);
  }
  const byKind = new Map(data.services.map(s => [s.kind, s]));
  return {
    /** Every declarable kind name, e.g. for envRefs validation and MCP tool schemas. */
    kinds() { return [...byKind.keys()]; },
    /** Full catalog entry for a kind, or undefined. */
    service(kind) { return byKind.get(kind); },
    /** The one sentinel token an app's envRefs binding resolves to for this kind. Services with
     * more than one token (e.g. a multi-var DynamoDB-style binding) aren't expressible through
     * the single-env-var-per-kind envRefs shape yet — this returns the first declared token,
     * which is correct today because every implemented single-token kind only declares one. */
    primaryToken(kind) {
      const svc = byKind.get(kind);
      const tokens = svc && svc.binding ? Object.keys(svc.binding) : [];
      return tokens[0];
    },
    projectionOf(kind) {
      const svc = byKind.get(kind);
      return svc ? svc.prod.projection : undefined;
    },
    caveatOf(kind) {
      const svc = byKind.get(kind);
      return svc ? svc.prod.caveat : undefined;
    },
  };
}

/**
 * Derive a graduation adapter's `resources` payload ({resourceType: [refNames]}) from an
 * app's envRefs and this catalog -- the missing wiring: pracman's devops-platform adapter's
 * generateWorkload() has always accepted a `resources` map, but nothing ever populated it,
 * so a graduated app's workload.yml carried zero resource references regardless of what the
 * app actually declared (see pracman/adapters/graduation/devops-platform/lib/workload.js's
 * referenceResources() -- the platform's "reference by name, never define inline" shape).
 *
 * Skips any kind whose catalog entry has no `prod.resourceType` (a local-only binding, e.g.
 * mock-api) -- those are graduation blockers already, surfaced separately by
 * graduationBlockers(). If a caller passed allowLocalOnly to get past that gate, there is
 * still no real production resource to reference, so it's correctly omitted here rather than
 * emitted as a reference to something that doesn't exist.
 *
 * `refName` is deterministic (`<appId>-<kind>`), not caller-supplied -- devops-platform
 * resolves resources by name against ones that already exist in the target account, so this
 * name must match whatever the real resource was actually named at provisioning time. That
 * match is a graduation-review-time human responsibility (documented in each kind's own
 * `prod.caveat`), not something this function can verify.
 *
 * Two envRefs naming the same kind (e.g. two env vars both bound to `pgvector`) collapse to
 * one reference, matching appspec.js's own treatment of the same case -- they're the same
 * underlying physical resource, not two.
 */
export function deriveGraduationResources(envRefs, catalog, appId) {
  const resources = {};
  for (const kind of new Set(Object.values(envRefs || {}))) {
    const svc = catalog.service(kind);
    const resourceType = svc?.prod?.resourceType;
    if (!resourceType) continue;
    const refName = `${appId}-${kind}`;
    (resources[resourceType] ||= []).push(refName);
  }
  return resources;
}
