# Minimal portable service starter
A conventional Node HTTP service with /health and /, no PAC SDK dependency.
Run node server.js, then visit http://127.0.0.1:8080/health.
Loopback binding is intentional for local testing. This template has no authentication, persistence, TLS or sandbox; never expose it directly to a shared network.
A future build adapter must replace host binding through trusted configuration behind authenticated ingress and add approved resource bindings.

