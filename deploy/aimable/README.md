# deploy/aimable

Aimable's own deploy of the 0.12 stack on vexa.aimable.ai (AIM-2231), separate from the upstream
release chain. Pull-based: nothing connects to the box.

1. GitHub Actions → "Deploy Aimable (vexa 0.12)" → `meeting-api`, `bot` or both. CI builds the
   image(s), pushes `ghcr.io/aimable-ai/vexa-v012-{meeting-api,bot}:sha-<short>` and moves `:deploy`.
2. On the box, cron runs `pull-deploy.sh` every minute. When `:deploy` points at a new version and no
   meeting is live or scheduled within 10 minutes, it backs up
   `~/vexa-012/deploy/compose/docker-compose.override.yml`, sets the `meeting-api` image / the
   runtime's `BROWSER_IMAGE`, restarts that one service (`--no-deps --wait`) and rolls back when it
   isn't healthy within 150 s; that version is then never retried. A bot image must at least start
   `node`; whether it joins meetings only shows on the next meeting.

Box setup (once): copy `pull-deploy.sh` to `~/aimable-deploy/`, give the box GHCR read access (public
packages, or `docker login ghcr.io` with a read-only packages token), add the cron line from the
script header. Log: `~/aimable-deploy/deploy.log`.

Rollback by hand: `touch ~/aimable-deploy/paused` (otherwise cron re-applies `:deploy` within a
minute), copy the newest `docker-compose.override.yml.bak-*` back, `docker compose up -d --no-deps
meeting-api runtime`. Add the bad `repo:sha-…` to `~/aimable-deploy/failed`, then remove `paused`.
