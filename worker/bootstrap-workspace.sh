#!/bin/sh
# bootstrap-workspace.sh — clone the repo into /workspace at container start
# so the orchestrator's bash tool can edit + git push from a real working tree.
#
# Required env vars:
#   GITHUB_TOKEN    Personal access token (or fine-grained) with repo scope.
#   GITHUB_REPO     "<owner>/<repo>" e.g. "salisumohammed3-afk/cyber-business-os".
#
# Optional:
#   GITHUB_BRANCH   Default "main".
#   GIT_USER_NAME   For commits. Default "Orchestrator".
#   GIT_USER_EMAIL  For commits. Default "orchestrator@cyber-business-os.local".

set -e

WORKSPACE="${ORCHESTRATOR_WORKSPACE:-/workspace}"
BRANCH="${GITHUB_BRANCH:-main}"
GIT_NAME="${GIT_USER_NAME:-Orchestrator}"
GIT_EMAIL="${GIT_USER_EMAIL:-orchestrator@cyber-business-os.local}"

if [ -z "$GITHUB_TOKEN" ] || [ -z "$GITHUB_REPO" ]; then
  echo "[bootstrap] WARN: GITHUB_TOKEN or GITHUB_REPO missing — orchestrator will start WITHOUT a workspace clone."
  echo "[bootstrap] The bash tool will still work but cd /workspace will be empty."
  mkdir -p "$WORKSPACE"
  exit 0
fi

mkdir -p "$WORKSPACE"

if [ -d "$WORKSPACE/.git" ]; then
  echo "[bootstrap] workspace already cloned, pulling latest..."
  cd "$WORKSPACE"
  git fetch origin "$BRANCH"
  git reset --hard "origin/$BRANCH"
else
  echo "[bootstrap] cloning $GITHUB_REPO into $WORKSPACE..."
  git clone --depth 50 --branch "$BRANCH" "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git" "$WORKSPACE"
fi

cd "$WORKSPACE"
git config user.name  "$GIT_NAME"
git config user.email "$GIT_EMAIL"
# Make sure the remote uses the token for push.
git remote set-url origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git"

echo "[bootstrap] workspace ready at $WORKSPACE on branch $BRANCH"
