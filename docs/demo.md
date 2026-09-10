# Five-minute demo

This is a runnable, bounded application demo. An external MCP author supplies a definition; PAC Manager compiles a trusted template in a build worker. It does not generate or execute arbitrary application code. The claims and knowledge templates share documents, text search and team discussion. No model keys or npm dependencies are required by the platform.

## Start locally

Install Node.js 22+ and Docker, start Docker, and clone this repository. From the repository root:

```sh
npm run demo:setup
npm run demo
```

Open http://127.0.0.1:3000. In a separate terminal, read `.pac-demo/owner.token` and paste it into the sign-in screen. Treat this as the workspace admin credential; never commit it or paste it into a prompt. State persists in `.pac-demo/state.json`. Stop with Ctrl-C; restart with the same command. To reset, stop the server and move `.pac-demo` aside.

The setup builds the local worker image. Each application build runs a fresh container with no network, a read-only filesystem, non-root UID, dropped capabilities and explicit CPU/memory/PID/time limits. The controller runs on the host and has access to Docker; only trusted fixed-template definitions reach the worker. This is not the full platform network boundary. Do not expose the host controller publicly.

For development without Docker only:

```sh
PAC_BUILD_MODE=process npm run demo
```

This explicit mode is labelled **no container isolation** in build activity. Docker failure never falls back to it. Do not use it to demonstrate container security.

## Connect the author

Use a local MCP client such as Claude Desktop. Add this entry to the client's MCP server configuration and restart the client. Use absolute paths; on Windows use JSON-escaped backslashes. If Node is not on the desktop application's PATH, use its absolute executable path too.

```json
{
  "mcpServers": {
    "pacmanager": {
      "command": "node",
      "args": ["/absolute/pacmanager/demo/mcp-stdio.js"],
      "env": {
        "PAC_MANAGER_URL": "http://127.0.0.1:3000",
        "PAC_TOKEN_FILE": "/absolute/pacmanager/.pac-demo/owner.token"
      }
    }
  }
}
```

The bridge communicates over stdio to the client and authenticated HTTP to the local controller. Eight tools list, create, inspect, update, build, bind mocks, publish and return an export link. The bridge is tested against the server; a live Claude session has not been exercised in the implementation workspace. See the [official local MCP setup guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers). This demo negotiates MCP 2025-03-26 and implements single JSON-RPC messages, not batch requests. Remote ChatGPT connector/OAuth support is not implemented. The eight-step demo uses the Claude path.

## Rehearsal script

Prepare two browser profiles, an authenticated local MCP client, and `demo/fixtures/adjuster-guide.md`. Run setup before presenting so image downloads are outside the five minutes.

| Time | Action | Observable result |
|---|---|---|
| 0:00–0:30 | Show the connected PAC Manager tools in Claude. | Real authoring connection, not a simulated chat window. |
| 0:30–1:10 | Ask: “Create a teal claims workbench called Claims team workspace. Help adjusters review synthetic claims and share guidance. Build it, inspect its status and give me the app ID.” | A new app appears automatically in the browser. |
| 1:10–1:35 | Open the app's build activity. | Worker mode, verification and actual completion; no artificial progress delay. |
| 1:35–2:00 | Open the live preview. | Compiled claims workbench; isolated browser document without executable scripts. |
| 2:00–3:00 | Upload the sample guidance. In Team, create an invitation, open it in the second profile, and post a note. | The document and colleague's note appear in both sessions within two seconds. |
| 3:00–3:30 | In Access, bind mock claims. | Five synthetic claims appear; no enterprise credentials or network calls. |
| 3:30–4:10 | Publish internally. | Published v1 is available to invited users. Edit the draft title to show that release v1 stays fixed. |
| 4:10–5:00 | Download the graduation package. | A real tar.gz containing a standalone app, source, data, build evidence and checksums. |

If the authoring client is unavailable, the New application form exercises the same definition and build path. Say that the authoring connection is unavailable; do not present the form as AI generation.

## Graduation

Extract `pac-graduation.tar.gz` into an empty folder. Set a new random `PAC_EXPORT_TOKEN` of at least 32 characters and run `npm start` there. Open http://127.0.0.1:8080; use any username and that token as the Basic Auth password. The archive includes its own Dockerfile and Score starter. Set the token through your target environment's secret mechanism; never bake it into an image.

The package is a **read-only snapshot**, including uploaded bytes and comments, with no dependency on PAC Manager. It is tested to start independently. Team identities, write APIs, live service adapters, database migrations, production auth and operational readiness still require engineering. Score is starter metadata, not a turnkey production deployment. Snapshot HTML includes current documents; the compiled definition stays at the published revision.

## Boundaries to make explicit

- One owner workspace, at most 30 apps, two concurrent builds, 20 documents per app (256 KB each), 500 notes per app. Single-process JSON storage; no HA or cross-process writes.
- Collaborators can read, upload and discuss only their invited app. Invitations expire after one hour and are single-use; sessions last 24 hours. No user directory, per-user revocation UI, SSO or enterprise OAuth yet.
- Publication freezes application definition, not live documents, notes or binding state. Team collaboration is shared notes and uploads with polling; simultaneous rich-document editing is not implemented.
- TXT/Markdown content is searchable. PDFs are preserved as attachments without extraction; no vector database, embeddings or semantic retrieval yet.
- The mock binding is an in-process synthetic provider. No arbitrary outbound connector, live claims replacement or L7 gateway exists yet.
- Docker isolation is configured but not executed in the implementation workspace. EKS manifests likewise require cluster verification. Browser preview and full desktop-client rehearsal remain verification gates before a public demo.
- The preview uses a trusted renderer, escaped content and a restrictive CSP/sandbox. Artifact data isolation is enforced in controller authorization; artifacts do not have separate running servers/databases in this version.
- SpecGuard remains optional and unconfigured. Offline tests are the actual evidence. PACOS agents are not running and will require an executable agent runtime plus approved external capabilities.

For a private cluster installation see [demo deployment](../deploy/demo.md). This profile does not replace the broader [threat model](threat-model.md).
