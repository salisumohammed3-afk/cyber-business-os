FROM node:22-alpine

RUN apk add --no-cache git curl

WORKDIR /app

# Copy only what the worker needs
COPY worker/ ./worker/
COPY api/agent-scripts/ ./api/agent-scripts/

CMD ["node", "worker/index.mjs"]
