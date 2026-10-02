#!/usr/bin/env bash
# AIM-2231 — run on vexa.aimable.ai by .github/workflows/deploy-aimable.yml.
# Args: <deploy dir under $HOME> <meeting-api image|''> <bot image|''> <force> <ghcr user>; GHCR token on stdin.
set -euo pipefail
DIR="$HOME/$1"; MEETING_API="$2"; BOT="$3"; FORCE="$4"; ACTOR="$5"
read -r TOKEN  # first stdin line after the script, never on the command line
cd "$DIR"

live=$(docker exec vexa-v012-postgres-1 psql -U postgres -d vexa -tAc \
  "select count(*) from meetings where status in ('requested','joining','awaiting_admission','needs_help','active','stopping')")
bots=$(docker ps --format '{{.Names}}' | grep -c '^vexa-mtg-' || true)
echo "live meetings: $live, bot containers: $bots"
if [ "$((live + bots))" -gt 0 ] && [ "$FORCE" != "true" ]; then
  echo "::error::A meeting is live; not deploying (re-run with force to override)."
  exit 1
fi

echo "$TOKEN" | docker login ghcr.io -u "$ACTOR" --password-stdin >/dev/null
for img in $MEETING_API $BOT; do docker pull -q "$img"; done
docker logout ghcr.io >/dev/null

backup="docker-compose.override.yml.bak-$(date -u +%Y%m%dT%H%M%SZ)"
cp docker-compose.override.yml "$backup"
services=""
if [ -n "$MEETING_API" ]; then
  sed -i -E "/^  meeting-api:/,/^  [a-z]/ s#^(    image: ).*#\1$MEETING_API#" docker-compose.override.yml
  services="meeting-api"
fi
if [ -n "$BOT" ]; then
  sed -i -E "s#(BROWSER_IMAGE=).*#\1$BOT#" docker-compose.override.yml
  services="$services runtime"
fi
diff "$backup" docker-compose.override.yml || true
docker compose up -d $services

healthy() {
  for svc in $services; do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "vexa-v012-$svc-1" 2>/dev/null)" = healthy ] || return 1
  done
}
for _ in $(seq 1 30); do healthy && break; sleep 5; done
if ! healthy; then
  echo "::error::$services not healthy after 150 s; rolling back to $backup"
  cp "$backup" docker-compose.override.yml
  docker compose up -d $services
  exit 1
fi
echo "deployed: $services"

# Keep the newest two of each of our images (current + rollback); never build here.
for repo in ghcr.io/aimable-ai/vexa-v012-meeting-api ghcr.io/aimable-ai/vexa-v012-bot; do
  docker images "$repo" --format '{{.Repository}}:{{.Tag}}' | tail -n +3 | xargs -r docker rmi >/dev/null 2>&1 || true
done
docker image prune -f >/dev/null
df -h / | tail -1
