#!/usr/bin/env bash
# Creates the msgraph connection, the Graph mail OpenAPI tool and the mail_reader agent.
# Requires: TENANT_ID, CLIENT_ID, CLIENT_SECRET; ADK installed; environment activated.
set -euo pipefail
: "${TENANT_ID:?set TENANT_ID}" "${CLIENT_ID:?set CLIENT_ID}" "${CLIENT_SECRET:?set CLIENT_SECRET}"
cd "$(dirname "$0")"

TOKEN_URL="https://login.microsoftonline.com/$TENANT_ID/oauth2/v2.0/token"

echo "== Connection"
orchestrate connections import -f connections/msgraph-connection.yaml

for env in draft live; do
  echo "== Credentials ($env)"
  orchestrate connections set-credentials -a msgraph --env "$env" \
    --client-id "$CLIENT_ID" \
    --token-url "$TOKEN_URL" \
    --grant-type urn:ietf:params:oauth:grant-type:jwt-bearer \
    -t "body:client_secret=$CLIENT_SECRET" \
    -t "body:requested_token_use=on_behalf_of" \
    -t "body:scope=https://graph.microsoft.com/.default" \
    -t "body:app_token_key=assertion"
done

echo "== OpenAPI tool bound to msgraph"
orchestrate tools import -k openapi -f tools/graph-mail-openapi.yaml -a msgraph

echo "== Agent"
orchestrate agents import -f agents/mail-agent.yaml
orchestrate agents deploy --name mail_reader

echo "== Done. Get the embed values from the wxO UI:"
echo "   Agent mail_reader -> Deploy tab -> Select Live env -> Channels -> Embedded agent. "
echo "   Copy orchestrationID, hostURL, agentId, agentEnvironmentId and crn from the script into host/.env"
