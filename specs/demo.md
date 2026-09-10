<!-- id: DEMO-001; status: implemented-bounded-demo -->
# Bounded application demo

## Acceptance Criteria

- DEMO-001: An authenticated author creates a strict claims/knowledge definition through MCP; a worker builds it and the controller verifies the output. The preview includes app-scoped documents, discussion and explicitly bound synthetic claims. Publication freezes the definition; graduation preserves published source and current data without platform credentials and runs independently.
- DEMO-002: The Docker adapter disables networking and limits privileges/resources. Kubernetes Jobs request restricted execution, no mounted API credential and a dedicated deny-all namespace. There is no implicit process fallback. Deployment-time enforcement evidence is required separately.
- DEMO-003: Failed or tampered build output cannot be published. Draft revision conflicts are rejected. Collaborators cannot publish, bind, export, author or access another app.

## Scenarios

### Successful journey
**Steps:** Authenticate, create through MCP, build, inspect preview, invite collaborator, upload a text document, add a note, bind mock claims, publish, modify the draft and export.
**Expected Results:** Shared app data is visible to scoped users; published definition remains unchanged; downloaded checksums verify and the standalone application starts with a new credential.

### Denied actions
**Steps:** Use a collaborator token against another artifact and owner-only endpoints; upload executable HTML; return altered builder output; publish after a failed build.
**Expected Results:** Requests fail, no new release appears, and user text cannot become executable preview markup.

### Actual isolation
**Steps:** Run the Docker integration gate. On a target cluster, execute the negative network and credential tests in deploy/demo.md.
**Expected Results:** Docker worker is non-root, read-only and has only loopback networking. Cluster tests demonstrate enforced default-deny from startup. Unit inspection of adapter options alone is insufficient evidence.
