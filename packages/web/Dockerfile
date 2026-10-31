# Anubis-bypass relay container for the released Worker.
# A Node process whose TLS/HTTP2 fingerprint clears Anubis (unlike workerd).
# It only runs the dumb fetch proxy in container/ — no app code, no deps.
#
# Cloudflare Containers run linux/amd64; pin it so the image also builds on
# Apple Silicon dev machines. CI runners are amd64, so no emulation there.
FROM --platform=linux/amd64 node:22.23.4-slim

WORKDIR /app
# Just the relay sources — zero npm dependencies (uses Node's built-in fetch + http).
COPY container/relay.mjs container/server.mjs ./

EXPOSE 8080
CMD ["node", "server.mjs"]
