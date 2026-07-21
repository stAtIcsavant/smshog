# syntax=docker/dockerfile:1

# ── Stage 1: Build the UI ──────────────────────────────────────────────────────
FROM node:20-alpine AS ui-builder
WORKDIR /app/ui
COPY ui/package*.json ./
# Inline env vars: only active during this RUN, not baked into the image
RUN NPM_CONFIG_STRICT_SSL=false npm install
COPY ui/ .
RUN npm run build

# ── Stage 2: Final image ───────────────────────────────────────────────────────
# node:20 (Debian/buildpack-deps) ships with python3, make, g++ for better-sqlite3
FROM node:20

LABEL org.opencontainers.image.title="SMSHog" \
      org.opencontainers.image.description="MailHog-style SMS capture for local development" \
      org.opencontainers.image.vendor="SMSHog" \
      com.docker.desktop.extension.api.version=">= 0.3.0" \
      com.docker.desktop.extension.icon="https://raw.githubusercontent.com/stAtIcsavant/smshog/main/smshog.svg" \
      com.docker.extension.screenshots='[{"alt":"SMSHog inbox","url":"https://raw.githubusercontent.com/stAtIcsavant/smshog/main/screenshot.png"}]' \
      com.docker.extension.detailed-description="Capture and inspect outbound SMS in development. Drop-in Twilio API replacement. Simulate delivery receipts, send replies, and forward to real webhooks." \
      com.docker.extension.publisher-url="https://github.com/stAtIcsavant/smshog" \
      com.docker.extension.additional-urls='[]' \
      com.docker.extension.categories="testing-tools,utility-tools" \
      com.docker.extension.changelog="Initial release: Twilio-compatible SMS capture, live inbox, delivery simulation, simulated replies, and webhook forwarding."

WORKDIR /app

COPY backend/package*.json ./backend/
# NODE_TLS_REJECT_UNAUTHORIZED=0 is required for node-gyp, which downloads Node.js
# headers from nodejs.org using its own HTTP client (ignores NPM_CONFIG_STRICT_SSL).
# Inline so it is NOT present in the running container.
RUN cd backend && NODE_TLS_REJECT_UNAUTHORIZED=0 NPM_CONFIG_STRICT_SSL=false npm install --omit=dev
COPY backend/ ./backend/

# Pre-built UI — must land at /ui to match metadata.json "root": "ui"
COPY --from=ui-builder /app/ui/dist /ui

# metadata.json, compose file, and icon must be at the container root
COPY metadata.json /metadata.json
COPY docker-compose.yaml /docker-compose.yaml
COPY smshog.svg /smshog.svg

CMD ["node", "backend/server.js"]
