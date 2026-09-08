# Vexa backup, retention & tenant offboarding (AIM-1889)

Vexa keeps its own data outside Aimable: the **Postgres** DB (meetings,
transcripts, users/tokens) and the **MinIO** object store (recordings). Aimable's
own retention sweep does not touch it, so it needs its own backup + retention,
and a documented cleanup when a tenant is offboarded.

## Backup

`backup.sh` dumps Postgres (gzipped SQL) and mirrors every MinIO bucket into a
dated folder under the backup dir, then prunes anything older than the retention
window.

```bash
# manual
/opt/vexa/deploy/compose/scripts/backup.sh --dir /opt/vexa/backups --retention-days 30

# cron (daily 03:15 UTC)
15 3 * * * /opt/vexa/deploy/compose/scripts/backup.sh >> /var/log/vexa-backup.log 2>&1
```

Defaults: `--dir /opt/vexa/backups`, `--retention-days 30`. Reads DB/MinIO
credentials from `/opt/vexa/.env`. Store the backup dir on a volume separate
from the stack, or sync it off-host (e.g. `rclone`/`aws s3 sync`) for real
disaster recovery.

## Restore

- **Postgres:** `gunzip -c vexa-db-<ts>.sql.gz | docker compose --env-file /opt/vexa/.env -f deploy/compose/docker-compose.yml exec -T postgres psql -U postgres -d vexa` (or use `restore-prod-dump.sh` with an uncompressed dump).
- **MinIO:** `mc mirror` the dated `minio-<ts>/` folder back into the store (reverse of the backup's mirror).

## Retention

Backups are pruned to `--retention-days` (default 30). The live recordings
retention is Aimable's job per meeting (`MEETING_AUDIO_RETENTION_DAYS`); this
runbook only governs the **backup copies** of Vexa's own store.

## Tenant offboarding — data cleanup

Vexa's admin API has **no cascade-delete** for a user's data (only per-token,
per-recording, per-meeting deletes), so offboarding is a two-step manual
procedure until that lands:

1. **Revoke access (Aimable side):** deprovisioning the tenant's principals
   revokes their Vexa tokens (`MeetingProvisioningService.deprovision_user`), so
   no new bots can be started under them.
2. **Delete the data (Vexa host side):** for each of the tenant's Vexa users
   (synthetic emails `‹env›.‹tenant›.‹principal›@capture.aimable.internal`, see
   AIM-1890), delete their meetings + recordings. Enumerate via
   `admin/users/email/<email>` → their meeting ids, then the per-meeting /
   per-recording delete endpoints; or, for a full purge, drop the rows in
   Postgres by `user_id` and remove their MinIO objects with `mc rm --recursive`.
   **Take a fresh `backup.sh` first.**

> Follow-up worth filing: a Vexa admin endpoint that hard-deletes a user and
> cascades meetings + recordings, so step 2 becomes one authenticated call.
