<!-- id: ASSURANCE-001; status: implemented-demo -->
# Living assurance and reviewed code publication

## Acceptance Criteria

- ASSURANCE-001: ARB, readiness and BOM views derive from a strict versioned JSON record. Publishing a changed app regenerates observed facts for that release, preserves owner decisions and flags them stale. Draft edits never relabel published reports. Export includes structured source and report views.
- ASSURANCE-002: MCP prompts/resources expose schema and authoring guidance; tools inspect, update and preview records with artifact-scoped access. Unknowns, not-applicable rationales and owner evidence are explicit. Document generation never grants an approval.
- ASSURANCE-003: GitHub publication is disabled by default, scoped to configured private destinations, excludes live workspace contents and requires an exact file/destination review in an owner browser session. Expired, changed or consumed plans fail. A new branch is created without modifying default branches.

## Scenarios

### Change and republish
**Steps:** Publish a claims app, enter a proposed recovery decision, change the title/template/accent through MCP, rebuild and publish. Preview all reports.
**Expected Results:** Release/source digest and generated text/inventory reflect the new app. The recovery decision remains with a re-review flag. An old revision cannot overwrite the new record.

### Publish code
**Steps:** Configure a private destination, prepare a code publication, inspect the file contents and confirm through the owner session. Try replaying the plan and preparing an unlisted or public target.
**Expected Results:** Only the reviewed file tree reaches the new branch. Live document/note content and credentials are absent. Replays, stale state, public targets and unlisted destinations fail.
