"""
Sandbox-level SSO credential injection.

An Azure App Registration (tenant/client/secret) is configured **once** on the
sandbox — set via `deploykit manage` into the control-plane container's own
environment (`~/.config/deploykit/env`, written at bootstrap; see
`scripts/bootstrap-sandbox.sh`) — and this module derives the env vars every
deployed app container needs from it. App builders never see or handle these
secrets directly.

This complements, rather than replaces, edge SSO (an oauth2-proxy forward-auth
sitting in front of nginx — see `nginx/conf.d/deploykit.conf`): edge SSO gates
*access* to every app with zero app-side code; this module additionally hands
an app its own Azure credentials when it wants identity claims or its own
OAuth flow (e.g. Graph API calls, a client-side MSAL SPA).

Covers both naming conventions already in use across templates:
  - Generic:  AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
  - Auth.js:  AUTH_MICROSOFT_ENTRA_ID_ID, AUTH_MICROSOFT_ENTRA_ID_SECRET,
              AUTH_MICROSOFT_ENTRA_ID_ISSUER (the `internal-nextjs` template
              and `webui` both use this trio — see lib/auth.ts in each)
"""

from __future__ import annotations

import os

_ISSUER_TEMPLATE = "https://login.microsoftonline.com/{tenant_id}/v2.0"


def sandbox_sso_env() -> dict[str, str]:
    """Sandbox-level SSO vars to inject as defaults into every app container.

    Returns `{}` (injects nothing) when no Azure App Registration is
    configured on the sandbox yet (`AZURE_TENANT_ID` unset) — deploys are
    unaffected until an operator sets one up.
    """
    tenant_id = os.environ.get("AZURE_TENANT_ID", "")
    client_id = os.environ.get("AZURE_CLIENT_ID", "")
    client_secret = os.environ.get("AZURE_CLIENT_SECRET", "")
    if not (tenant_id and client_id and client_secret):
        return {}

    issuer = _ISSUER_TEMPLATE.format(tenant_id=tenant_id)
    return {
        "AZURE_TENANT_ID": tenant_id,
        "AZURE_CLIENT_ID": client_id,
        "AZURE_CLIENT_SECRET": client_secret,
        "AUTH_MICROSOFT_ENTRA_ID_ID": client_id,
        "AUTH_MICROSOFT_ENTRA_ID_SECRET": client_secret,
        "AUTH_MICROSOFT_ENTRA_ID_ISSUER": issuer,
    }
