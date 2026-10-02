#!/usr/bin/env bash
# AIM-2231 — pull-based deploy of Aimable's images on vexa.aimable.ai. Cron runs it every minute:
#   * * * * * flock -n /tmp/aimable-deploy.lock $HOME/aimable-deploy/pull-deploy.sh >> $HOME/aimable-deploy/deploy.log 2>&1
# CI (.github/workflows/deploy-aimable.yml) moves the :deploy tag; this script applies it when no
# meeting is live or about to start, rolls back when the service doesn't come up, and never
# retries a version that failed. Silent when there is nothing to do. `touch ~/aimable-deploy/paused`
# stops it (for a manual rollback or a hand-pinned image).
set -euo pipefail
COMPOSE_DIR="$HOME/vexa-012/deploy/compose"
OVERRIDE="$COMPOSE_DIR/docker-compose.override.yml"
STATE="$HOME/aimable-deploy"
REGISTRY=ghcr.io/aimable-ai
TARGETS="meeting-api:vexa-v012-meeting-api runtime:vexa-v012-bot"   # compose service : image repo
log() { echo "$(date -u +%FT%TZ) $*"; }
once() {  # log a message only when the state behind it changes
  local key="$STATE/.last-$1"
  [ "$(cat "$key" 2>/dev/null)" = "$2" ] && return 0
  echo "$2" > "$key"; log "$2"
}

[ -e "$STATE/paused" ] && exit 0

current_ref() {
  if [ "$1" = runtime ]; then sed -nE 's#^      - BROWSER_IMAGE=(.*)$#\1#p' "$OVERRIDE"
  else sed -nE "/^  $1:/,/^  [a-z]/ s#^    image: (.*)\$#\1#p" "$OVERRIDE"; fi
}
set_ref() {
  if [ "$1" = runtime ]; then sed -i -E "s#^(      - BROWSER_IMAGE=).*\$#\1$2#" "$OVERRIDE"
  else sed -i -E "/^  $1:/,/^  [a-z]/ s#^(    image: ).*\$#\1$2#" "$OVERRIDE"; fi
}

# Live, or scheduled to start within 10 minutes (calendar auto-join spawns ~2 min ahead).
busy=$(docker exec vexa-v012-postgres-1 psql -U postgres -d vexa -tAc "
  select count(*) from meetings
  where status in ('requested','joining','awaiting_admission','needs_help','active','stopping')
     or (status = 'scheduled'
         and (data->>'scheduled_at')::timestamptz between now() - interval '10 min' and now() + interval '10 min')") \
  || { once db "cannot read Vexa meetings; not deploying"; exit 0; }
[[ "$busy" =~ ^[0-9]+$ ]] || { once db "unexpected meeting count '$busy'; not deploying"; exit 0; }
busy=$((busy + $(docker ps --format '{{.Names}}' | grep -c '^vexa-mtg-' || true)))
rm -f "$STATE/.last-db"

rollback() {  # $1 svc, $2 backup, $3 version, $4 reason
  log "$1: $4; rolling back to $(basename "$2") and never retrying $3"
  echo "$3" >> "$STATE/failed"
  cp "$2" "$OVERRIDE"
  (cd "$COMPOSE_DIR" && docker compose up -d --no-deps "$1") || log "$1: rollback restart failed, check by hand"
}

for target in $TARGETS; do
  svc=${target%%:*}; repo="$REGISTRY/${target#*:}"
  if ! err=$(docker pull -q "$repo:deploy" 2>&1); then
    once "pull-$svc" "$svc: cannot pull $repo:deploy: ${err##*$'\n'}"; continue
  fi
  rm -f "$STATE/.last-pull-$svc"
  version=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$repo:deploy")
  [[ "$version" =~ ^sha-[0-9a-f]{9}$ ]] || { once "label-$svc" "$svc: bad version label '$version'"; continue; }
  want="$repo:$version"
  [ "$(current_ref "$svc")" = "$want" ] && continue
  grep -qxF "$want" "$STATE/failed" 2>/dev/null && continue
  if [ "$busy" -gt 0 ]; then once "wait-$svc" "$svc: $want waits for meetings to end"; continue; fi
  rm -f "$STATE/.last-wait-$svc"

  docker tag "$repo:deploy" "$want"
  if [ "$svc" = runtime ] && ! docker run --rm --entrypoint node "$want" -e 0 >/dev/null 2>&1; then
    echo "$want" >> "$STATE/failed"; log "runtime: bot image $want does not start node; skipped"; continue
  fi
  backup="$OVERRIDE.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  cp "$OVERRIDE" "$backup"
  log "$svc: $(current_ref "$svc") -> $want"
  set_ref "$svc" "$want"
  if [ "$(current_ref "$svc")" != "$want" ]; then
    cp "$backup" "$OVERRIDE"; rm -f "$backup"
    once "edit-$svc" "$svc: could not set the image in the override; not deploying"; continue
  fi
  if (cd "$COMPOSE_DIR" && docker compose up -d --no-deps --wait --wait-timeout 150 "$svc"); then
    log "$svc: deployed $want"
  else
    rollback "$svc" "$backup" "$want" "not healthy within 150 s"
  fi

  # Keep what the override and its newest backups reference (current + rollback), drop the rest.
  keep=$(cat "$OVERRIDE" $(ls -t "$OVERRIDE".bak-* 2>/dev/null | head -3) | grep -oE "$repo:sha-[0-9a-f]{9}" | sort -u)
  docker images "$repo" --format '{{.Repository}}:{{.Tag}}' | grep -E ':sha-' | grep -vxF "$keep" \
    | xargs -r docker rmi >/dev/null 2>&1 || true
done
ls -t "$OVERRIDE".bak-* 2>/dev/null | tail -n +11 | xargs -r rm -f   # keep 10 backups
docker image prune -f >/dev/null 2>&1 || true
