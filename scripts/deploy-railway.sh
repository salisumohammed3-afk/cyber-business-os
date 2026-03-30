#!/bin/bash
# Deploy the latest commit to Railway
# Uses the Railway GraphQL API directly (no CLI needed)
RAILWAY_TOKEN="${RAILWAY_TOKEN:-4579ef21-1722-43fd-89d0-17d0efd0eed1}"
SERVICE_ID="dbe1ce11-fab7-4184-943a-1b764ecb8b06"
ENV_ID="9567252f-40b3-4b33-94de-cf0d975b2d43"

COMMIT_SHA=$(git rev-parse HEAD)
COMMIT_MSG=$(git log -1 --format='%s' | head -c 60)

echo "Deploying $COMMIT_SHA ($COMMIT_MSG) to Railway..."

RESULT=$(curl -s "https://backboard.railway.app/graphql/v2" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation { serviceInstanceDeploy(serviceId: \\\"$SERVICE_ID\\\", environmentId: \\\"$ENV_ID\\\", commitSha: \\\"$COMMIT_SHA\\\") }\"}")

if echo "$RESULT" | grep -q '"serviceInstanceDeploy":true'; then
  echo "Deploy triggered successfully."
else
  echo "Deploy failed: $RESULT"
  exit 1
fi
