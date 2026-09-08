#!/usr/bin/env bash
# AIM-1889 — back up the Vexa stack's own data: the Postgres DB (meetings,
# transcripts, users/tokens) and the MinIO object store (recordings). Prunes
# backups older than the retention window. Intended to run from cron on the
# Vexa host; mirrors the style of restore-prod-dump.sh.
#
# Usage:
#   backup.sh [--dir <backup-dir>] [--retention-days N]
# Defaults: dir=/opt/vexa/backups, retention=30 days.
#
# Cron (daily 03:15):
#   15 3 * * * /opt/vexa/deploy/compose/scripts/backup.sh >> /var/log/vexa-backup.log 2>&1
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "/opt/vexa")
ENV_FILE="$ROOT/.env"
COMPOSE_FILE="$ROOT/deploy/compose/docker-compose.yml"

BACKUP_DIR="/opt/vexa/backups"
RETENTION_DAYS=30
while [ $# -gt 0 ]; do
    case "$1" in
        --dir) BACKUP_DIR="$2"; shift 2 ;;
        --retention-days) RETENTION_DAYS="$2"; shift 2 ;;
        *) echo "Unknown arg: $1"; exit 2 ;;
    esac
done

_env() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true; }
DB_USER=$(_env DB_USER); DB_USER=${DB_USER:-postgres}
DB_NAME=$(_env DB_NAME); DB_NAME=${DB_NAME:-vexa}
MINIO_ACCESS_KEY=$(_env MINIO_ACCESS_KEY); MINIO_ACCESS_KEY=${MINIO_ACCESS_KEY:-vexa-access-key}
MINIO_SECRET_KEY=$(_env MINIO_SECRET_KEY); MINIO_SECRET_KEY=${MINIO_SECRET_KEY:-vexa-secret-key}
PROJECT=$(_env COMPOSE_PROJECT_NAME); PROJECT=${PROJECT:-vexa}
NETWORK="${PROJECT}_vexa"

COMPOSE_CMD="docker compose --env-file $ENV_FILE -f $COMPOSE_FILE"
DATE=$(date -u +'%Y%m%dT%H%M%SZ')
mkdir -p "$BACKUP_DIR"

echo "── vexa backup $DATE ──  dir=$BACKUP_DIR  retention=${RETENTION_DAYS}d"

# 1. Postgres → gzipped SQL dump.
DB_OUT="$BACKUP_DIR/vexa-db-$DATE.sql.gz"
echo "  [+] pg_dump $DB_NAME → $DB_OUT"
$COMPOSE_CMD exec -T postgres pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$DB_OUT"
echo "      $(du -sh "$DB_OUT" | cut -f1)"

# 2. MinIO → mirror every bucket (recordings live here). A one-shot mc joins the
#    compose network and pulls the whole store into a dated dir.
MINIO_OUT="$BACKUP_DIR/minio-$DATE"
mkdir -p "$MINIO_OUT"
echo "  [+] mc mirror minio → $MINIO_OUT"
docker run --rm --network "$NETWORK" -v "$MINIO_OUT:/backup" \
    --entrypoint sh minio/mc:latest -c \
    "mc alias set src http://minio:9000 '$MINIO_ACCESS_KEY' '$MINIO_SECRET_KEY' >/dev/null && mc mirror --overwrite --quiet src /backup"
echo "      $(du -sh "$MINIO_OUT" | cut -f1)"

# 3. Retention prune.
echo "  [+] pruning backups older than ${RETENTION_DAYS}d"
find "$BACKUP_DIR" -maxdepth 1 -name 'vexa-db-*.sql.gz' -mtime "+$RETENTION_DAYS" -print -delete || true
find "$BACKUP_DIR" -maxdepth 1 -type d -name 'minio-*' -mtime "+$RETENTION_DAYS" -print -exec rm -rf {} + || true

echo "── done ──"
