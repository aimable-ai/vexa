#!/usr/bin/env bash
# AIM-2231 — pull-based deploy of Aimable's images on vexa.aimable.ai. Cron runs it every minute:
#   * * * * * flock -n /tmp/aimable-deploy.lock $HOME/aimable-deploy/pull-deploy.sh >> $HOME/aimable-deploy/deploy.log 2>&1
# CI (.github/workflows/deploy-aimable.yml) moves the :deploy tag; this script applies it when no
# meeting is live, rolls back when the service doesn't come up healthy, and never retries a
# version that failed. Silent when there is nothing to do.
set -euo pipefail
COMPOSE_DIR="$HOME/vexa-012/deploy/compose"
OVERRIDE="$COMPOSE_DIR/docker-compose.override.yml"
STATE="$HOME/aimable-deploy"
REGISTRY=ghcr.io/aimable-ai
log() { echo "$(date -u +%FT%TZ) $*"; }

# service : image repo : how the override references it
TARGETS="meeting-api:vexa-v012-meeting-api runtime:vexa-v012-bot"

current_ref() {  # the image the override uses now for this service
  if [ "$1" = runtime ]; then sed -nE 's#.*BROWSER_IMAGE=(.*)#\1#p' "$OVERRIDE"
  else sed -nE "/^  $1:/,/^  [a-z]/ s#^    image: (.*)#\1#p" "$OVERRIDE"; fi
}

set_ref() {
  if [ "$1" = runtime ]; then sed -i -E "s#(BROWSER_IMAGE=).*#\1$2#" "$OVERRIDE"
  else sed -i -E "/^  $1:/,/^  [a-z]/ s#^(    image: ).*#\1$2#" "$OVERRIDE"; fi
}

live_meetings() {
  local db bots
  db=$(docker exec vexa-v012-postgres-1 psql -U postgres -d vexa -tAc \
    "select count(*) from meetings where status in ('requested','joining','awaiting_admission','needs_help','active','stopping')")
  bots=$(docker ps --format '{{.Names}}' | grep -c '^vexa-mtg-' || true)
  echo $((db + bots))
}

healthy() { [ "$(docker inspect -f '{{.State.Health.Status}}' "vexa-v012-$1-1" 2>/dev/null)" = healthy ]; }

for target in $TARGETS; do
  svc=${target%%:*}; repo="$REGISTRY/${target#*:}"
  docker pull -q "$repo:deploy" >/dev/null 2>&1 || continue   # nothing published yet
  version=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$repo:deploy")
  [ -n "$version" ] || { log "$repo:deploy has no version label; skipping"; continue; }
  want="$repo:$version"
  [ "$(current_ref "$svc")" = "$want" ] && continue
  grep -qxF "$want" "$STATE/failed" 2>/dev/null && continue
  if [ "$(live_meetings)" -gt 0 ]; then
    [ -f "$STATE/waiting-$svc" ] || { log "$svc: $want waits for live meetings to end"; touch "$STATE/waiting-$svc"; }
    continue
  fi
  rm -f "$STATE/waiting-$svc"

  docker tag "$repo:deploy" "$want"
  backup="$OVERRIDE.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  cp "$OVERRIDE" "$backup"
  log "$svc: $(current_ref "$svc") -> $want"
  set_ref "$svc" "$want"
  (cd "$COMPOSE_DIR" && docker compose up -d "$svc")
  for _ in $(seq 1 30); do healthy "$svc" && break; sleep 5; done
  if healthy "$svc"; then
    log "$svc: deployed $want"
  else
    log "$svc: not healthy after 150 s; rolling back to $backup and never retrying $want"
    echo "$want" >> "$STATE/failed"
    cp "$backup" "$OVERRIDE"
    (cd "$COMPOSE_DIR" && docker compose up -d "$svc")
  fi
  # keep the two newest versions (current + rollback)
  docker images "$repo" --format '{{.Repository}}:{{.Tag}}' | grep -v ':deploy$' | tail -n +3 | xargs -r docker rmi >/dev/null 2>&1 || true
done
docker image prune -f >/dev/null 2>&1 || true
