FROM node:22-alpine

# bash for the orchestrator's `bash` tool (predictable heredocs + pipes).
# github-cli so the orchestrator can `gh pr create`, `gh repo clone`, etc.
# without an auth dance. openssh-client so it can clone via SSH if the
# token path fails.
RUN apk add --no-cache git curl bash openssh-client github-cli

WORKDIR /app

# Copy only what the worker + orchestrator need
COPY worker/ ./worker/
COPY api/agent-scripts/ ./api/agent-scripts/

# Bootstrap a workspace clone at startup so the orchestrator's bash tool
# can edit + git push from a real working tree. Clone happens at startup
# (not build time) so the workspace always reflects the latest main when
# Railway restarts the service.
RUN chmod +x /app/worker/bootstrap-workspace.sh

# Default port for the orchestrator HTTP server.
ENV ORCHESTRATOR_PORT=3000
EXPOSE 3000

# Launcher runs the existing task-poller AND the new HTTP orchestrator side
# by side in one container. See worker/launcher.mjs for the rationale.
CMD ["sh", "-c", "/app/worker/bootstrap-workspace.sh && node worker/launcher.mjs"]
