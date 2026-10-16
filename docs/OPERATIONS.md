# Operations

## Migrations and recovery

Back up before every schema migration. Apply `npm run migrate` once before starting native services. Compose supplies a dedicated one-shot migration service; PostgreSQL advisory locking also prevents simultaneous migration execution. Both migrations are transactional. There are no automatic down-migrations: restoring into a separate empty database is the recovery path. Never edit an applied migration to change a running database; add the next version.

`server/devices.json` remains the legacy backup. Explicit `npm run seed -- --legacy` imports disabled TCP placeholders (443) with original names/hosts and a legacy tag; it cannot faithfully translate an ICMP destination into a known service port. Review before enabling. Import skips matching name/host and does not delete source data.

Native backup with PostgreSQL's tools (connection via your local role/password setup):

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\pg_dump.exe' -h 127.0.0.1 -U netmon -d netmon -Fc -f netmon.dump
# Restore into a NEW empty database; never overwrite the original without a verified backup.
& 'C:\Program Files\PostgreSQL\18\bin\createdb.exe' -h 127.0.0.1 -U netmon netmon_restore
& 'C:\Program Files\PostgreSQL\18\bin\pg_restore.exe' -h 127.0.0.1 -U netmon -d netmon_restore --no-owner netmon.dump
```

Compose backup avoids older PowerShell binary-redirection corruption:

```powershell
docker compose exec db pg_dump -U netmon -Fc -f /tmp/netmon.dump netmon
docker compose cp db:/tmp/netmon.dump ./netmon.dump
docker compose exec db createdb -U netmon netmon_restore
docker compose cp ./netmon.dump db:/tmp/netmon-restore.dump
docker compose exec db pg_restore -U netmon -d netmon_restore --no-owner /tmp/netmon-restore.dump
```

Verify restored counts/history on the separate database before switching DATABASE_URL. Restore tooling is provided; actual backup/restore round-trip evidence is in VALIDATION.md. Dumps may contain target configuration; protect their filesystem permissions and keep them out of Git. A full PostgreSQL-major upgrade requires the PostgreSQL-supported dump/restore or pg_upgrade procedure.

## Retention and deletion

Raw results older than RETENTION_DAYS are deleted in batches of at most 1000, once a minute per worker. The time index bounds selection. Foreign-key references from incident cause/events become null; durable incident transitions and delivery records remain. Cleanup commits are independent of probes. It produces WAL/dead tuples: monitor disk space and PostgreSQL autovacuum. At large ingestion rates the bounded deletion budget may lag; use measured partition/rollup work before claiming large-scale retention. Child reference indexes reduce deletion lookups.

Targets are soft archived. Incidents/events/attempts/worker identities are retained indefinitely; this preserves audit evidence but still grows storage. No destructive purge job is implemented. Operators should establish a backup/audit retention policy before long-term use. This project does not claim storage grows without bound safely.

## Troubleshooting and measurements

- **Unknown:** first check has not committed, or configuration was edited. Check enable state, hostname allowlist and running workers.
- **Stale / no fresh heartbeat:** inspect `/api/operations` and `docker compose logs worker`. Default freshness is 45 seconds; slow DB work or a stopped worker can cause staleness. Expired claims automatically recover; never manually erase results to restart monitoring.
- **Database unavailable:** liveness can stay healthy while readiness is 503. Workers log `iteration_failed`, count infrastructure errors, and retry after their scan delay. Credentials/URL are never logged. Recover the DB; do not classify the outage as target-down. Existing claims expire. Pool acquisition and statement deadlines prevent indefinite waiting.
- **Schedule lag:** operations shows oldest overdue schedule in ms; benchmark reports p50/p95/p99. Lower WORKER_POLL_MS or add workers only after checking DB connections/CPU; the interval is a completion-relative schedule, not an exact wall-clock cadence.
- **Notification failure:** inspect delivery status, attempts and last_error in operations. Five attempts exhaust; interrupted attempts also count. Fix configuration/receiver. No automatic infinite retry or public resend endpoint exists. Use a reviewed database operation to reschedule only after investigating possible duplicate delivery.
- **POLICY error:** exact allowlist missing, sensitive address resolved, or loopback attempted without DEMO_MODE. Never weaken the policy to enable network discovery. Public webhook demo is intentionally forbidden.
- **HTTP_STATUS:** endpoint returned something other than expected status, including redirects. Configure a direct health URL. **MAX_BYTES:** response exceeded its configured bound. **TIMEOUT:** configured deadline expired. **PROBE_ERROR:** sanitized TLS/network failure category.
- **Windows/ICMP:** native ping implementation was removed rather than executing user-defined shell arguments. HTTP and TCP require no raw socket privileges. Original ICMP entries stay preserved and disabled in optional import.
- **UI inaccessible / 401:** enter current API_TOKEN; the browser stores it in memory only. Restarting/reloading requires re-entry. Compose requires a token even though its published web port is loopback, because the container binds 0.0.0.0.
- **Empty Compose seed:** select the demo profile; allow `demo`, not `127.0.0.1`, in Compose. Containers have their own loopback. The provided compose example supplies the correct hostname.
- **Connection budget:** default web + two workers uses at most 15 persistent pooled connections, with migration/health/admin headroom. Do not exceed PostgreSQL max_connections when scaling replicas.

Logs are JSON with UTC timestamp/severity/component/event and worker/delivery/request identity where relevant. They omit credentials, target payloads, raw database errors and webhook tokens. `/api/operations` is a lightweight operational endpoint, not a Prometheus stack. Its rolling minute check/failure counts and worker totals allow throughput/failure-rate calculation; database error counts and pool occupancy distinguish infrastructure trouble.

Stop Compose with `docker compose down`; volumes persist. Native Ctrl+C drains bounded work. Forced process termination is safe for committed data and leaves fenced claims recoverable after expiration. Deleting volumes/databases is destructive and is not part of normal stopping or any automated production startup.
