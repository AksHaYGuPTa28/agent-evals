# Demo server image. No dependencies to install: the project uses only Node's standard library.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY src ./src
COPY public ./public

# Writable place for the audit log (it is also written to stdout, see AUDIT_STDOUT).
RUN mkdir /data && chown node:node /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    TRUST_PROXY=1 \
    AUDIT_FILE=/data/audit.jsonl \
    AUDIT_STDOUT=1

# Never run as root. API keys are NOT in the image: pass GEMINI_API_KEY / ANTHROPIC_API_KEY as runtime secrets.
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server.mjs"]
