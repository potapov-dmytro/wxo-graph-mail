# Entra ID Requirements And OBO Check

> **Note:** This page is not guidance on configuring Microsoft Entra ID or Microsoft Graph. It lists only what this sample needs in order to demonstrate OBO in watsonx Orchestrate. Follow Microsoft's documentation and your organisation's policies.

Steps 1 and 2 of the [README](README.md). The Entra ID tenant already exists. This page lists what the app registration must contain, then shows how to prove the OBO chain to Microsoft Graph before touching wxO.

## Step 1: App Registration Requirements

Reuse an existing registration if it meets all points. One registration is enough for a sample build. Split host and middle tier for prod.

1. Single-tenant app registration.
2. Authentication > Web platform, redirect URI `http://localhost:5555/auth/redirect` (replace with the real host URL outside local runs).
3. Certificates & secrets: a client secret. Store it in a secrets manager.
4. Expose an API: Application ID URI `api://<client-id>` and scope `access_as_user`, consent by admins and users.
5. Manifest: `"requestedAccessTokenVersion": 2` in the `api` section. Without it Entra issues v1 tokens and issuer and audience checks get messy.
6. API permissions: Microsoft Graph delegated `User.Read` and `Mail.Read`, with admin consent. OBO cannot prompt for consent, so missing consent fails at runtime with `AADSTS65001`.
7. Only for `verify-obo.sh` (device code): Authentication > Allow public client flows: Yes. Not needed for wxO to work. Do not enable it on a production app registration or tenant; use a test one and turn it off afterwards.

## Step 2: Prove OBO Outside wxO

An example of how to verify the token chain before touching wxO.

```bash
export TENANT_ID=... CLIENT_ID=... CLIENT_SECRET=...
bash verify-obo.sh
```

Pass criteria: user token `aud` is your client ID, OBO returns a Graph token, three recent emails print.
