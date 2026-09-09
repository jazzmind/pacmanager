# Graduation, not abandonment
## Required handoff
Source revision and repository history; immutable OCI image; build instructions; dependency lock and SBOM; manifest and bindings; tests with results; schema and migrations; data export and import tooling; approved rights for export; runbook; telemetry and usage; owner/SLO; backup/restore and rollback plan.

## Migration
1. Provision target identities/resources with no broader authority.
2. Run source and contract tests against target nonproduction providers.
3. Snapshot databases/files/document state together with a consistency marker.
4. Import, reconcile record counts and hashes, and validate source ACLs.
5. Quiesce writes or use a reviewed replication/cutover strategy.
6. Switch users; retain a time-bounded rollback path.
7. Verify permission revocations, jobs and webhook deduplication.
8. Retire old credentials/resources only after acceptance.

Code rollback is not data rollback. Schema changes need compatibility windows; mock-to-live promotion never migrates synthetic data. Document exports include structured collaborative state and readable exports, not Git alone.

The alpha CLI exports contract and Score JSON metadata with missing evidence explicitly listed. It does not export source/data or certify readiness. A future exporter must demonstrate restore on a clean target.

