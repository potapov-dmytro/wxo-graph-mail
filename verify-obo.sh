#!/usr/bin/env bash
# Verifies the Entra ID OBO chain to Microsoft Graph outside watsonx Orchestrate.
# 1. Signs the user in with device code flow for api://<client-id>/access_as_user
# 2. Exchanges that token for a Graph token (OBO)
# 3. Calls /me and /me/messages
# Requires: TENANT_ID, CLIENT_ID, CLIENT_SECRET; jq; python3.
# Needs "Allow public client flows" = Yes on the app registration (turn off after testing).
set -euo pipefail
: "${TENANT_ID:?set TENANT_ID}" "${CLIENT_ID:?set CLIENT_ID}" "${CLIENT_SECRET:?set CLIENT_SECRET}"

AUTH="https://login.microsoftonline.com/$TENANT_ID/oauth2/v2.0"
API_SCOPE="api://$CLIENT_ID/access_as_user"

decode() { # print selected claims of a JWT
  python3 - "$1" <<'PY'
import base64, json, sys
p = sys.argv[1].split(".")[1]; p += "=" * (-len(p) % 4)
c = json.loads(base64.urlsafe_b64decode(p))
print(json.dumps({k: c.get(k) for k in ("aud", "iss", "ver", "scp", "preferred_username", "upn")}, indent=2))
PY
}

echo "== Step 1: user sign-in (device code)"
dc=$(curl -s "$AUTH/devicecode" -d client_id="$CLIENT_ID" --data-urlencode scope="$API_SCOPE")
echo "$dc" | jq -e .device_code >/dev/null || { echo "$dc"; exit 1; }
echo "$dc" | jq -r .message
interval=$(echo "$dc" | jq -r .interval)
device_code=$(echo "$dc" | jq -r .device_code)

while :; do
  sleep "$interval"
  resp=$(curl -s "$AUTH/token" \
    -d grant_type=urn:ietf:params:oauth:grant-type:device_code \
    -d client_id="$CLIENT_ID" -d device_code="$device_code")
  err=$(echo "$resp" | jq -r '.error // empty')
  [[ -z "$err" ]] && break
  [[ "$err" == "authorization_pending" || "$err" == "slow_down" ]] || { echo "$resp"; exit 1; }
done
USER_TOKEN=$(echo "$resp" | jq -r .access_token)
echo "User token claims (aud must be $CLIENT_ID, ver 2.0, scp access_as_user):"
decode "$USER_TOKEN"

echo "== Step 2: OBO exchange for a Graph token"
obo=$(curl -s "$AUTH/token" \
  -d grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer \
  -d client_id="$CLIENT_ID" \
  --data-urlencode client_secret="$CLIENT_SECRET" \
  --data-urlencode assertion="$USER_TOKEN" \
  --data-urlencode scope="https://graph.microsoft.com/.default" \
  -d requested_token_use=on_behalf_of)
GRAPH_TOKEN=$(echo "$obo" | jq -r '.access_token // empty')
[[ -n "$GRAPH_TOKEN" ]] || { echo "OBO failed:"; echo "$obo" | jq .; exit 1; }
echo "Graph token claims (aud must be https://graph.microsoft.com or 00000003-0000-0000-c000-000000000000):"
decode "$GRAPH_TOKEN"

echo "== Step 3a: /me"
curl -s https://graph.microsoft.com/v1.0/me -H "Authorization: Bearer $GRAPH_TOKEN" \
  | jq '{displayName, userPrincipalName, mail}'

echo "== Step 3b: three most recent emails"
curl -s "https://graph.microsoft.com/v1.0/me/messages?\$top=3&\$select=subject,from,receivedDateTime" \
  -H "Authorization: Bearer $GRAPH_TOKEN" \
  | jq 'if .value then [.value[] | {receivedDateTime, subject, from: .from.emailAddress.address}] else . end'

echo "== Done. If 3b shows emails, the Entra side is correct."
