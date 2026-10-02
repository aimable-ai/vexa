# deploy/aimable

Aimable's own deploy of the 0.12 stack on vexa.aimable.ai (AIM-2231), separate from the upstream
release chain.

- `deploy-on-box.sh` — run by `.github/workflows/deploy-aimable.yml` on the box: refuses while a
  meeting is live, pulls the CI-built images from GHCR, points `meeting-api` / the runtime's
  `BROWSER_IMAGE` at them in `~/vexa-012/deploy/compose/docker-compose.override.yml` (backed up
  first), restarts those services and rolls back when they don't come up healthy.

Run it from GitHub: Actions → "Deploy Aimable (vexa 0.12)" → choose `meeting-api`, `bot` or both.
Rollback by hand: copy the newest `docker-compose.override.yml.bak-*` back and
`docker compose up -d meeting-api runtime`.
