import { assertValid, digest } from './contract.js';

export function plan(artifact) {
  assertValid(artifact);
  const id = digest(artifact);
  return {
    mode: 'plan-only', artifact: artifact.metadata.name, digest: id,
    namespace: `pac-${artifact.metadata.name}`,
    workload: { ...artifact.workload, runtimeClass: 'gvisor', privileged: false,
      readOnlyRootFilesystem: true, runAsNonRoot: true, automountServiceAccountToken: false },
    network: { ingress: [], egress: [], dns: 'blocked-until-broker-policy-installed' },
    resources: artifact.resources.map(r => ({ ...r, scope: artifact.metadata.name, provisioning: 'not-implemented' })),
    capabilityRequests: artifact.capabilities,
    blockers: ['No runtime adapter installed', 'No identity or grant service installed',
      'No data provisioner installed', 'No signed build evidence verified'],
    warning: 'This plan does not create a sandbox or enforce network isolation.'
  };
}

export function graduation(artifact) {
  assertValid(artifact);
  return {
    format: 'pac-graduation/v1alpha1', artifact, digest: digest(artifact),
    score: { apiVersion: 'score.dev/v1b1', metadata: { name: artifact.metadata.name },
      containers: { app: { image: artifact.workload.image } },
      service: { ports: { web: { port: artifact.workload.port, targetPort: artifact.workload.port } } },
      resources: Object.fromEntries(artifact.resources.map(r => [r.name, { type: r.type }])) },
    readiness: 'incomplete',
    requiredEvidence: ['source-revision','sbom','build-provenance','test-results','data-export',
      'schema-migrations','restore-test','owner-and-runbook','capability-bindings','threat-review'],
    caveats: ['Score alone does not carry or enforce PAC security policy.',
      'This bundle is metadata, not a deployable application or proof of production readiness.',
      'Export actual source, data, policies and migrations separately before graduation.']
  };
}
