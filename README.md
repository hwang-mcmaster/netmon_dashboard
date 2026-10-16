# Network Monitoring Dashboard · NetMon

A local network operations console for checking explicitly configured HTTP/HTTPS services and TCP ports. NetMon keeps configuration, check history, incidents, and delivery attempts in PostgreSQL. Independent workers collect results even when nobody has the dashboard open.

The original Node/Express + React/Vite application is retained. This is a demonstrable portfolio application, not a claim of production readiness or high availability. See [validation](docs/VALIDATION.md), [performance](docs/PERFORMANCE.md), and [progress](PROGRESS.md) for measured evidence and remaining checks.

![Actual dashboard with synthetic demo data](docs/screenshots/desktop.png)

## What works

- HTTP status checks, HTTPS certificate verification, bounded response bodies, TCP connection checks.
- Durable target configuration, paginated results, incident history, soft archive, search and tags.
- Healthy / failing / unknown / stale / disabled states; worker freshness and delivery failures.
- Leased, fenced scheduling across workers; crash recovery; idempotent result commits.
- Consecutive down/recovery rules and rolling sample latency rules; acknowledgement, deduplicated transitions and cooldown.
- Durable notification outbox with a development sink and explicitly configured webhook delivery.
- Mobile/desktop dashboard, labeled latency charts, bounded polling, API access token when bound beyond localhost.
- Versioned SQL migrations, isolated PostgreSQL tests, browser lifecycle tests, Compose and GitHub Actions configuration.

## Architecture

```mermaid
flowchart LR
  Browser[React dashboard] -->|same-origin HTTP API / 5s polling| Web[Express web]
  Web --> DB[(PostgreSQL)]
  Worker[Independent bounded workers] -->|claim / fenced result transaction| DB
  Worker -->|allowlisted HTTP or TCP| Targets[Configured targets]
  DB -->|durable delivery outbox| Worker
  Worker --> Sink[Local delivery sink or explicit webhook]
```

PostgreSQL coordinates work; no Redis/task broker is needed for this size of project. Web requests never perform checks. The same image runs web, migration, and worker commands. See [design decisions](docs/DESIGN.md).

## Native quick start (Windows PowerShell)

Prerequisites: Node **24.x** (validated with 24.13.0), npm 11, PostgreSQL **18.x** (validated with 18.6). Create an empty `netmon` database and a login role permitted to migrate its schema. Never point test commands at this database.

From this repository root:

```powershell
Copy-Item .env.example .env
# Edit .env: set DATABASE_URL with your database user/password.
# For the local demo keep PROBE_ALLOWED_HOSTS=127.0.0.1, DEMO_MODE=true, NOTIFICATION_CHANNEL=sink.
npm.cmd ci
npm.cmd run migrate
npm.cmd run build
npm.cmd run seed
```

Run these in three separate PowerShell windows, from the repository root:

```powershell
npm.cmd run demo
npm.cmd start
npm.cmd run worker
```

Open http://127.0.0.1:4000. The seed is explicit, repeatable, and creates configuration only. No fake results are inserted on production startup. The worker must run to collect actual synthetic checks. For client development, `npm.cmd run dev -w client` opens Vite on http://127.0.0.1:5173 with same-origin API proxying. Ctrl+C stops each native process.

Linux/macOS use `npm` instead of `npm.cmd`; the scripts themselves are portable. PostgreSQL provisioning depends on your installation. All application times are stored as timezone-aware UTC; the UI displays browser-local time. Durations and latency use milliseconds.

## Docker Desktop / Compose

Docker execution has **not been verified on the implementation machine**, because Docker was unavailable. The configuration is included for reproduction and CI validation.

```powershell
Copy-Item .env.compose.example .env
# Set POSTGRES_PASSWORD and a random API_TOKEN of at least 24 characters.
docker compose --profile demo up --build -d
docker compose run --rm web node server/src/seed.js
docker compose ps
```

Open http://127.0.0.1:4000 and enter your API token when prompted. PostgreSQL has no published host port; the web port binds only to host loopback. The demo profile adds a private synthetic receiver named `demo`. A one-shot migration service must finish successfully before web/worker startup. An ordinary restart preserves configuration/results in the `pgdata` volume. The app runs as the non-root `node` user; resource limits and connection counts are bounded.

Stop with `docker compose down`. This preserves the database volume. Deleting volumes is a separate destructive operation; back up first. See [operations](docs/OPERATIONS.md).

## Five-minute reviewer demo

1. Start services and explicitly seed as above. Wait for both demo targets to become healthy.
2. Open **Demo · recovery drill** to view results and latency. The default down rule opens after three failures and recovers after two successes.
3. Native demo: `Invoke-RestMethod -Method Post http://127.0.0.1:8099/control/fail`.
4. Observe failing status, an open incident, and the sink delivery in worker logs. Acknowledge the incident in the dashboard. Sink records are marked sent without contacting a recipient.
5. Native demo: `Invoke-RestMethod -Method Post http://127.0.0.1:8099/control/recover`. Inspect recovered incident history and success samples.
6. Disable the target in Edit. Stop the worker and wait at least 45 seconds to see unavailable-worker health; enabled targets become stale after their freshness window. Start the worker again.

Compose demo controls (receiver stays private):

```powershell
docker compose exec demo node -e "fetch('http://127.0.0.1:8099/control/fail',{method:'POST'})"
docker compose exec demo node -e "fetch('http://127.0.0.1:8099/control/recover',{method:'POST'})"
```

The demo controller is intentionally unauthenticated and must stay on loopback or the private Compose network. It is excluded from ordinary production startup unless the demo profile is selected.

## Configuration

Copy an example to `.env`; do not commit it. Root npm scripts load `.env` from the repository root through their server workspace commands. Direct `node server/src/...` invocations require exported environment variables. Compose supplies environment directly.

| Variable               | Default / purpose                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`         | Required PostgreSQL connection string. Percent-encode password punctuation. No application logging of its value.                  |
| `DB_POOL_MAX`          | 5 per process, range 1–20; budget sum of all replicas plus migration/health/admin connections.                                    |
| `HOST` / `PORT`        | `127.0.0.1` / `4000`; non-loopback binding requires a token.                                                                      |
| `API_TOKEN`            | Optional only for loopback; at least 24 characters required beyond loopback. Single operator capability, not multiple user roles. |
| `PROBE_ALLOWED_HOSTS`  | Empty means no destinations permitted. Exact comma-separated DNS names/IPs, no wildcards. Covers probes and webhooks.             |
| `DEMO_MODE`            | `false`; explicit `true` permits allowlisted loopback and requires sink delivery at startup.                                      |
| `DEMO_TARGET_HOST`     | `127.0.0.1`; explicit seed destination, `demo` in Compose.                                                                        |
| `DEMO_HOST`            | `127.0.0.1`; receiver bind address, `0.0.0.0` only inside private Compose demo container.                                         |
| `WORKER_CONCURRENCY`   | 4, range 1–32 per worker.                                                                                                         |
| `WORKER_POLL_MS`       | 500, range 25–5000; scheduling scan delay, tune using measured results.                                                           |
| `RETENTION_DAYS`       | 30, range 1–3650; bounded raw result cleanup.                                                                                     |
| `NOTIFICATION_CHANNEL` | `sink`; `webhook` requires explicit operator configuration and is forbidden in demo mode.                                         |
| `WEBHOOK_URL`          | Operator-configured endpoint; allowlist and destination rules apply. No redirects followed.                                       |
| `WEBHOOK_TOKEN`        | Optional bearer secret, stored in environment only; never included in payloads/logs.                                              |
| `POSTGRES_PASSWORD`    | Compose only; required, no source default.                                                                                        |

For private network monitoring, allow only the exact intended hostnames and review their resolved addresses. Configuration is operator-only. Do not enable broad network discovery. Sensitive ranges (loopback, link-local/metadata, unspecified, multicast, IPv4-mapped IPv6) are blocked, except explicit demo loopback. DNS resolutions are checked and the chosen address is pinned for that connection. HTTP redirects are not followed. See [security and semantics](docs/DESIGN.md).

## Tests and CI

```powershell
npm.cmd run lint
npm.cmd run format:check
npm.cmd test
# Provision separate disposable databases named netmon_test and netmon_test_e2e first.
$env:TEST_DATABASE_URL='postgresql://netmon:TEST_PASSWORD@127.0.0.1:5432/netmon_test'
$env:NETMON_TEST_RESET='YES'
npm.cmd run test:integration
$env:E2E_DATABASE_URL='postgresql://netmon:TEST_PASSWORD@127.0.0.1:5432/netmon_test_e2e'
npx.cmd playwright install chromium
npm.cmd run test:e2e
npm.cmd run build
npm.cmd audit --audit-level=moderate
```

Integration setup **drops only the explicitly opted-in test database's public schema**. A strict database-name check and `NETMON_TEST_RESET=YES` are both required. Use a dedicated test login with no development/production database privileges. Browser tests use local ports 4000 and 8099; stop other demo servers first. Their isolated database is required to be named `netmon_test_e2e`.

CI installs the lockfile, runs lint/format/unit/PostgreSQL/browser checks, audits dependencies, scans secrets, and builds/smokes the Docker image. No deployment or registry publication is configured. Hosted CI has not been run or observed. JavaScript is retained; there is no separate TypeScript check. [Validation](docs/VALIDATION.md) records actual commands/results.

## Compatibility and further documentation

The original `server/devices.json` is unchanged and no legacy target is auto-probed. Explicit import:

```powershell
npm.cmd run seed -- --legacy
```

ICMP configuration is imported as **disabled TCP port 443 placeholders**; review every port/protocol and allowlist before enabling. Original ICMP-specific behavior is not retained: it depended on OS ping privileges/Unix flags and has no portable, validated container implementation here. No legacy history existed on disk. Socket.IO bootstrap/status and `/api/devices` are replaced by the bounded API documented in [API reference](docs/API.md). The original project was pre-migration, so versioned SQL starts from an empty application schema.

- [API contracts and example payloads](docs/API.md)
- [Scheduling, alert semantics, security, design decisions and future work](docs/DESIGN.md)
- [Backup/restore, retention and troubleshooting](docs/OPERATIONS.md)
- [Performance reproduction and measurements](docs/PERFORMANCE.md)
- [Actual validation and limitations](docs/VALIDATION.md)
- [Durable acceptance checklist](PROGRESS.md)
