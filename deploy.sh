#!/usr/bin/env bash
# Deploy Live Translate to the VPS as a Docker container behind the existing shared Caddy.
# Run on the server from the repo folder:  bash deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

CADDY=signal-desk-app-caddy-1
SITES=/home/deploy/caddy-sites

echo "== Checking what the server already runs"
docker ps --format '{{.Names}}\t{{.Ports}}' | sed 's/^/   /'
docker ps --format '{{.Names}}' | grep -qx "$CADDY" || { echo "!! $CADDY is not running - stopping."; exit 1; }

NET=$(docker inspect "$CADDY" -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' | head -n1)
echo "== Caddy network: $NET"
export CADDY_NETWORK="$NET"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "== Created .env (no Claude key yet - add ANTHROPIC_API_KEY to .env and re-run to use Claude)"
fi

echo "== Building and starting container"
docker compose up -d --build

echo "== Installing Caddy site file"
cp caddy/translate.caddy "$SITES/translate.caddy"
docker exec "$CADDY" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec "$CADDY" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile

echo "== Health check"
sleep 3
docker exec "$CADDY" wget -qO- http://live-translate:3000/api/config && echo
echo "== Natural voice speed test (from the voice service log)"
for i in $(seq 1 30); do docker logs live-translate-tts 2>&1 | grep -q "Self-test" && break; sleep 2; done
docker logs live-translate-tts 2>&1 | grep "Self-test" || echo "   voice service still starting - check later with: docker logs live-translate-tts"
free -m | head -2
echo "Done: https://translate.dhirajmakam.com"
