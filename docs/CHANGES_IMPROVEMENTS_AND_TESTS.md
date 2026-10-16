# NetMon Dashboard — Changes, Improvements, and Tests

**Project:** Network Monitoring Dashboard (`netmon_dashboard`)  
**Implementation date:** October 15, 2026  
**Repository:** `C:\Users\Gordon\Desktop\Documents\Github Repo\Network Monitoring Dashboard\netmon_dashboard`  
**Report scope:** Work performed during the dashboard modernization task. Test results describe checks actually executed during that task; creating this report did not rerun the application tests.

## 1. Summary

Modernized the existing Node/Express and React/Vite project into a database-backed monitoring application with independent workers, durable incidents and notification retries, a responsive dashboard, automated tests, deployment configuration, and operational documentation.

The original repository and Git history were preserved. Changes were left uncommitted and unpushed. The original `server/devices.json` was preserved unchanged. Only explicitly configured synthetic local targets were exercised; no network scan, real notification, deployment, push, or merge occurred.

**Executed automated tests: 24 passed — 7 unit/probe, 13 PostgreSQL integration, and 4 browser tests.** Build, formatting, lint, configuration validation, dependency audit, secret scanning, workflow linting, and backup/restore checks also passed. Docker execution and hosted CI remain unverified.

## 2. Original application and verified weaknesses

| Area                 | Original behavior / limitation                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Backend              | Express web server, Socket.IO, node-cron, OS ping dependency.                                                                       |
| Monitoring           | Startup and ten-second cron polling inside the web process. Probes were not directly request-triggered, but shared the web process. |
| Concurrency          | All enabled targets passed to `Promise.all`, without a configured concurrency bound.                                                |
| Storage              | Device configuration in JSON; latest results and history only in memory. Restart erased monitoring history.                         |
| Refresh              | Socket.IO bootstrap sent all retained history.                                                                                      |
| UI states            | A target without a result appeared down. No separate unknown/stale/disabled definitions.                                            |
| Portability          | Ping used Unix-specific command arguments; no validated container privilege strategy.                                               |
| Access               | Permissive CORS; no explicit operator authentication model.                                                                         |
| Quality / operations | No tests, lockfiles, database migrations, health endpoints, Compose stack, or CI workflow.                                          |

The original frontend dependency installation and build passed. Its startup monitoring was deliberately not run because it automatically contacted the legacy real destinations. Original audits reported two moderate server findings and one moderate/one high client finding.

## 3. Database and persistence changes

- Added PostgreSQL persistence using `pg`, with explicit SQL migrations and a migration-version table.
- Added transactional migration execution with a PostgreSQL advisory lock to serialize migration runners.
- Added bounded connection pools, acquisition and statement deadlines, rollback, and guaranteed client release.
- Added handling for checked-out connection errors between transaction statements; broken clients are destroyed rather than returned to the pool.
- Standardized lifecycle timestamps as timezone-aware UTC and durations/latency as milliseconds.
- Added foreign keys, unique identities, check constraints, and indexes for scheduling, recent history, tags, incidents, outbox delivery, and result retention.
- Added deterministic, explicitly invoked demo configuration seeding. Normal startup inserts no fake results.
- Added an explicit repeatable legacy import that leaves imported targets disabled for operator review.
- Added bounded raw-result retention: at most 1,000 old results per cleanup batch, once a minute per worker.
- Preserved incident audit history when old raw-result references are removed.
- Implemented soft target archive: stop monitoring and hide the target from normal lists while retaining history.

### Persisted entities

| Entity              | Purpose                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `targets`           | Configuration, due times, claim/lease state, and efficient current-state summary.                                    |
| `results`           | Stable run identity, target, scheduling/start/completion times, outcome, latency, sanitized errors, worker identity. |
| `rules`             | Down/latency thresholds, sample window, cooldown, and consecutive counters.                                          |
| `incidents`         | Open, acknowledgement, and recovery timestamps with causal result reference.                                         |
| `incident_events`   | Durable open, recovery, and acknowledgement transitions.                                                             |
| `deliveries`        | Notification payload, pending/sent/exhausted state, retry schedule, lease, and fencing identity.                     |
| `delivery_attempts` | Durable attempt number and success/failure/interruption metadata.                                                    |
| `workers`           | Heartbeat, active work, completed checks, failure counts, and database-error counts.                                 |
| `schema_migrations` | Applied migration versions.                                                                                          |

## 4. Independent monitoring workers

- Moved monitoring into a separately runnable worker process.
- Added HTTP/HTTPS status checks and TCP connection checks.
- Added configurable bounded concurrency, strict check deadlines, connection cleanup, and monotonic latency measurement.
- Added target interval, timeout, port, expected status, body-size, and tag validation.
- Retained HTTPS certificate verification.
- Added PostgreSQL row-lock claims using `FOR UPDATE SKIP LOCKED` for concurrent workers.
- Added stable run IDs, expiring leases, and new fencing tokens for reclaimed work.
- Made result persistence idempotent and reject late results from replaced claims.
- Prevented normal overlapping checks for a target. Expired claims recover after a crash.
- Coalesced overdue schedules rather than generating an unbounded catch-up burst.
- Added completion-relative scheduling with 0–5% positive jitter.
- Added configurable scheduling scan delay through `WORKER_POLL_MS`.
- Added graceful shutdown: stop claiming, finish bounded in-flight work, and close the pool.
- Added worker heartbeats, freshness detection, and container checks tied to the worker's own identity.
- Distinguished database/worker infrastructure errors from confirmed target failure.

**Guarantee boundary:** network checks can repeat after a crash or expired lease; exactly-once external network execution is not claimed. Only the current fenced claim can commit its result.

## 5. Alert and notification improvements

- Added configurable consecutive-failure opening and consecutive-success recovery thresholds.
- Default down rule: three failures to open and two successes to recover.
- Added optional rolling-sample average latency rules with a minimum complete successful sample window.
- Kept unknown/stale/no-data separate from confirmed target-down conditions.
- Added durable open/recovery/acknowledgement history.
- Added transition-based deduplication and reopen cooldown to reduce notification floods.
- Made probe result, rule evaluation, incident transition, and outbox insertion transactional.
- Added a safe local development sink and an operator-configured webhook channel.
- Reserved delivery attempts durably before external I/O, so interrupted attempts consume the retry budget.
- Added five-attempt limits, exponential retry delays, delivery leases, fenced completion, and exhausted status.
- Added recovery of an interrupted fifth attempt without issuing a sixth send.
- Added webhook timeouts, response-size limits, destination checks, sanitized errors, and idempotency-key headers.
- Exposed pending/failed/exhausted deliveries to operators.

**Deliberate scope:** demo configuration forces sink delivery; no real recipients were contacted. Email, reminders, and multi-channel fanout are future extensions. External delivery can duplicate after a crash; receivers must enforce the supplied idempotency key to deduplicate effects.

## 6. Dashboard and user-experience improvements

- Retained React/Vite and added a coherent responsive visual design, sidebar, overview totals, target table, incident panel, and operational panel.
- Added separate healthy, failing, unknown, stale, and disabled states with text plus color.
- Added name/destination search, exact tag filtering, state filters, stable ordering, and pagination.
- Added target create, edit, enable/disable, and archive flows with validation and understandable errors.
- Added target details with recent results, latency chart, configuration, alert rules, and incident history.
- Used real timestamps on the chart's horizontal axis and milliseconds on its latency axis.
- Marked chart gaps for failed checks or more than three intervals without a result; provided equivalent textual results.
- Added incident acknowledgement and recovery visibility.
- Added worker freshness, recent check/failure counts, schedule lag, and notification backlog/failure display.
- Added loading, empty, unavailable-worker, failed-refresh, and partial-refresh recovery states.
- Prevented overlapping polling, cleaned up requests/timers, applied request deadlines, and capped refresh backoff.
- Added visible keyboard focus, labeled controls, modal focus handling, Escape dismissal, focus return, and keyboard-focusable scrollable tables.
- Corrected secondary-text contrast based on automated accessibility findings.
- Captured and inspected actual desktop and mobile screenshots with synthetic data.
- Deferred chart loading to reduce initial JavaScript download.

### Status definitions

| State    | Meaning                                                                             |
| -------- | ----------------------------------------------------------------------------------- |
| Healthy  | Fresh latest check succeeded.                                                       |
| Failing  | Fresh latest check failed.                                                          |
| Unknown  | Enabled, but no committed result since creation/edit.                               |
| Stale    | Latest completion older than `max(3 × interval, timeout + 5,000 ms)`.               |
| Disabled | Monitoring intentionally paused. Archived targets are excluded from ordinary lists. |

Missing or failed latency is represented as null/“—”, not zero. Editing resets current state and alert counters while retaining historical records.

## 7. API and security improvements

### API surface

| Method             | Endpoint                         | Purpose                                                                        |
| ------------------ | -------------------------------- | ------------------------------------------------------------------------------ |
| GET                | `/health/live`                   | Process liveness independent of database availability.                         |
| GET                | `/health/ready`                  | Real database dependency check.                                                |
| GET                | `/api/summary`                   | State totals.                                                                  |
| GET / POST         | `/api/targets`                   | Bounded target search/list and validated creation.                             |
| GET / PUT / DELETE | `/api/targets/:id`               | Details/history, configuration replacement, soft archive.                      |
| PUT                | `/api/targets/:id/rules`         | Configure down/latency rules.                                                  |
| GET                | `/api/incidents`                 | Paginated active incidents.                                                    |
| POST               | `/api/incidents/:id/acknowledge` | Idempotent acknowledgement.                                                    |
| GET                | `/api/operations`                | Worker freshness, operational counters, pool occupancy, and delivery failures. |

### Protection and boundaries

- Added bounded page sizes, history windows, JSON body limits, identifier validation, and consistent sanitized error responses.
- Added correlation IDs and structured UTC/severity/component logs.
- Kept probe configuration restricted to the trusted operator.
- Defaulted native binding to loopback; required a 24+ character API token for non-loopback binding.
- Protected configured API access with bearer authentication. Browser tokens are held in memory.
- Removed permissive CORS grants. No cookie sessions are used; JSON is required for mutation bodies.
- Added hostname validation for unauthenticated loopback mode to resist DNS rebinding.
- Added restrictive browser response headers.
- Required an exact destination hostname/IP allowlist; empty allowlist permits no probe destinations.
- Blocked sensitive unspecified, loopback, link-local/metadata, multicast, reserved, and mapped-address cases, with explicit synthetic-loopback demo exceptions.
- Checked DNS answers and pinned the chosen destination address for a connection.
- Did not follow HTTP redirects.
- Rejected credentials/query strings/fragments in monitored HTTP URLs to reduce accidental secret storage.
- Kept webhook secrets in environment configuration and out of payloads/logs.
- Removed configurable target values from any shell-execution path.

**Deployment boundary:** trusted single-operator localhost/private use, not a public multi-user service. Broader exposure requires TLS and additional access hardening.

## 8. Dependencies and project tooling

- Added one npm workspace configuration and root lockfile for reproducible installation.
- Pinned dependency versions and documented Node 24.x support.
- Updated Express to 5.3.0; added `pg` 8.23.1.
- Retained React 18.3.1; updated Vite to 8.3.4, React plugin to 6.1.2, and Recharts to 3.10.1.
- Removed obsolete Socket.IO, cron, ping, and permissive-CORS runtime dependencies.
- Added ESLint, Prettier, YAML configuration checks, Playwright 1.64.1, and axe accessibility integration 4.14.0.
- Added portable root run/build/migrate/worker/seed/test commands and fixed legacy seed argument forwarding.
- Added ignore rules for secrets, build products, dependency directories, test artifacts, and local preview process metadata.

## 9. Docker, CI, and operations changes

- Added a multi-stage application Dockerfile with a non-root runtime.
- Added Compose services for PostgreSQL, one-shot migrations, web, worker, and optional synthetic demo receiver.
- Added persistent database storage, private database networking, loopback-published web port, health checks, restart policies, resource limits, and graceful shutdown allowance.
- Made dependent application startup wait for healthy PostgreSQL and successful migrations.
- Added GitHub Actions for locked installation, formatting, linting, configuration checks, unit/integration/browser tests, dependency audit, secret scanning, and complete Compose smoke.
- Added minimal workflow permissions, concurrency cancellation, timeouts, and failure artifacts/diagnostics.
- Added backup/restore, retention, troubleshooting, scheduling/delivery semantics, security, and safe stopping guidance.
- Added a five-minute synthetic failure-to-recovery reviewer demonstration.

**Not executed:** Docker image build, Compose startup/restart, container health verification, or a hosted GitHub Actions run. Docker was unavailable locally, and no push was performed. YAML parsing and local workflow linting did pass.

## 10. Full automated test inventory

### Unit and local probe tests — 7 passed

1. Target validation: names, destinations, schemes, credentials/query strings, TCP ports, intervals/timeouts, expected statuses, byte limits, tags, and enabled-state types.
2. Status calculation: unknown, healthy, failing, stale, and disabled remain distinct.
3. Alert decisions: failure threshold, counter reset, insufficient/unknown samples, deduplication, and recovery.
4. Retry and pagination decisions: bounded exponential backoff and invalid/oversized pagination rejection.
5. Runtime configuration: unsafe bind/token combinations, concurrency bounds, and forbidden demo webhook configuration.
6. Controlled HTTP/TCP probes: success, refused connection, strict timeout, oversized body, invalid HTTP status, and redirect response without redirect following.
7. Destination policy: sensitive addresses, non-demo loopback, mapped IPv6, and non-allowlisted host rejection.

### PostgreSQL integration and resilience tests — 13 passed

1. Migration/repeat migration, database constraints, transaction rollback, and persistence after pool restart.
2. Simultaneous claimers: no duplicate scheduling, stable reclaimed run identity, new fencing token, rejection of late results, and idempotent persistence.
3. Down threshold, duplicate prevention, successful recovery, reopen cooldown, and durable sink delivery after reconnect.
4. Latency window minimum sample count; failure/insufficient samples; stale and no-data behavior without fabricated incidents.
5. API target lifecycle, authentication, invalid input, filters, pagination/window limits, rule-counter reset on edit, acknowledgement idempotency, disabled state, soft archive, and health/operations responses.
6. Bounded webhook retry attempts and exhausted receiver failure with durable attempt history.
7. Bounded result retention while preserving incident history and clearing expired causal references safely.
8. Interrupted fifth delivery attempt becomes exhausted after lease expiry without a sixth send.
9. Database backend connection interruption and subsequent pool reconnection.
10. Actual worker process termination, lease expiry, restart, and recovery using the original stable run ID.
11. Two actual worker processes checking independent targets with no normal per-target overlap.
12. Injected database transport outage: readiness returns 503, liveness stays available, worker recovers, and healthy target checks are not fabricated as target failures.
13. Checked-out client failure between awaited transaction statements: safe rejection, broken-client disposal, and successful reconnect.

The transport-outage and checked-out-client regression cases also passed a separate repeat run after the final resilience correction.

### Browser tests — 4 passed

1. Create target → healthy checks → failure threshold → open incident → acknowledgement → recovery/history → disable → archive.
2. Partial operations-endpoint failure preserves working dashboard sections and recovers after the endpoint returns.
3. Desktop dashboard at 1440 × 1050: core content, worker health, keyboard focus, modal interaction, axe WCAG A/AA scan, and actual screenshot.
4. Mobile dashboard at 390 × 844: core content, no document-wide horizontal overflow, keyboard focus, modal interaction, axe WCAG A/AA scan, and actual screenshot.

Accessibility scans passed after contrast corrections. They do not replace a complete manual assistive-technology audit.

## 11. Additional executed checks

| Check                                            | Result                                                                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Fresh `npm.cmd ci` in original checkout          | Passed.                                                                                                        |
| `npm.cmd run format:check`                       | Passed.                                                                                                        |
| `npm.cmd run lint`                               | Passed.                                                                                                        |
| `npm.cmd run check:config`                       | Compose/workflow YAML parsing and required structure passed.                                                   |
| `npm.cmd run build`                              | Passed in original checkout.                                                                                   |
| `npm.cmd audit --audit-level=moderate`           | Zero reported vulnerabilities, including development dependencies, at execution time.                          |
| Gitleaks 8.30.1 source scan                      | No secrets found; redacted scanning used.                                                                      |
| actionlint 1.7.12 workflow validation            | Passed; Shellcheck/Pyflakes integrations were not available.                                                   |
| Demo seed twice                                  | Repeatable; no duplicate demo targets.                                                                         |
| Explicit legacy import twice                     | Repeatable; three legacy targets imported disabled.                                                            |
| Migration on fresh database and repeat migration | Passed.                                                                                                        |
| PostgreSQL custom-format backup/restore          | Restored into a new database: 5 targets, 1,400 results, 5 rules, 2 migration versions. Original data retained. |
| Git whitespace check                             | Passed.                                                                                                        |
| Legacy device JSON comparison                    | No change.                                                                                                     |
| Local preview readiness / worker health          | Ready; worker available; 2 healthy synthetic targets and 3 disabled legacy targets at handoff.                 |

### Issues found and corrected during validation

- HTTP oversized-response handling could race with normal completion; failure is now rejected explicitly before connection destruction.
- Test API pool ownership and notification fixture interference were corrected.
- Secondary-text contrast failures were fixed and browser accessibility checks rerun.
- An unbatched 200,000-row benchmark fixture insert exceeded the five-second SQL deadline; setup now uses bounded batches and the full measurements were rerun.
- Legacy seed arguments were not reaching the nested npm command; root seed invocation was corrected and the documented import command rerun.
- A fresh-checkout rerun exposed a checked-out PostgreSQL connection-error race and cleanup waiting on an already-exited child; transaction error ownership and bounded child cleanup were corrected, with a new deterministic regression.
- A final browser launch encountered the task's separately running demo receiver on port 8099; the temporary demo processes were stopped and browser checks rerun successfully.
- An empty example secret field caused a scanner false positive across a newline; example field order was corrected without disabling scanner rules.

## 12. Performance and payload results

### Test environment

Windows 11 / Intel Core i7-13700 / 24 logical CPUs / 31.77 GiB RAM; Node 24.13.0, npm 11.6.2, PostgreSQL 18.6. Native shared host; no enforced process CPU/memory limits. Isolated PostgreSQL used 40 max connections and 400 KiB shared buffers. The latter is the actual test environment, not a recommended production setting.

Two worker instances, concurrency 8 each, pool maximum 5 each; ten API readers; target interval 10 seconds; timeout 500 ms; 200 synthetic historical results per target; 60-second measurements. Reader requests alternate summary and 25-item list with 25 ms think time. API/workers/receiver share the benchmark Node process with separate pools; actual separate worker processes are tested independently.

### Measured scheduling improvement

Paired baseline/tuned scheduling runs omitted per-target rule rows to isolate scheduling overhead. An additional 1,000-target run included a default down rule on every target.

| Workload                              | Worker scan delay | List API p95 | Probe checks/sec |                  Schedule lag p95 | Unexpected API errors |
| ------------------------------------- | ----------------: | -----------: | ---------------: | --------------------------------: | --------------------: |
| 50 targets                            |            500 ms |     11.18 ms |             4.82 |                            479 ms |                     0 |
| 50 targets                            |             25 ms |     10.70 ms |             4.80 |                             37 ms |                     0 |
| 250 targets                           |            500 ms |     12.73 ms |            24.00 |                          1,852 ms |                     0 |
| 250 targets                           |             25 ms |      9.62 ms |            23.55 |                             43 ms |                     0 |
| 1,000 targets                         |            500 ms |     13.76 ms |            29.11 | **35,084 ms — missed lag budget** |                     0 |
| 1,000 targets                         |             25 ms |     11.08 ms |            96.77 |                          6,168 ms |                     0 |
| 1,000 targets with default down rules |             25 ms |     15.49 ms |            96.99 |                          7,871 ms |                     0 |

Provisional budgets: API p95 below 500 ms at ten readers, unexpected errors below 1%, and schedule-lag p95 below the ten-second interval. The one-minute alert-enabled 1,000-target run passed those budgets. This is not a long-term or production capacity guarantee.

Additional recorded observations:

- Alert-enabled 1,000-target run: 5,824 checks and 16,850 successful API requests in 60.05 seconds; list API p99 19.84 ms.
- API SQL query p95 5.99 ms; 25,275 API SQL queries; API pool peak 5/5.
- Indexed recent-history query returned 50 rows in 0.451 ms execution time; raw plans retained.
- Combined benchmark Node peak RSS 224.10 MiB; CPU 18,187 ms user + 6,750 ms system. PostgreSQL memory/CPU was not included.
- A 200 ms hanging local check returned TIMEOUT in approximately 213.83 ms in the paired tuned run.
- One-item notification receiver-outage drill recorded two failed attempts; after recovery, the pending delivery drained in 12.52 ms.
- Representative summary/list payload pair: approximately 162,888 bytes/minute at five-second refresh, excluding HTTP headers, operations/incidents requests, and detail history.

### Frontend download improvement

| Asset                     |      Before chart deferral |                                  Final build |
| ------------------------- | -------------------------: | -------------------------------------------: |
| Initial JavaScript        | 508.36 kB / 152.53 kB gzip |                    158.86 kB / 51.61 kB gzip |
| Deferred chart JavaScript | Included in initial bundle | 352.01 kB / 102.24 kB gzip, loaded on demand |
| CSS                       |                          — |                       8.45 kB / 2.70 kB gzip |

Raw benchmark JSON and full reproduction details are in `docs/PERFORMANCE.md`. Load measurements precede the final checked-out-connection error-handler correction; the entire workload was not rerun after that small resilience change. Final correctness tests cover the change. Host contention and startup effects affect these single-run distributions.

## 13. Files changed or added

Paths below are relative to the repository root.

### Existing files updated

- `README.md`: full setup, architecture, environment reference, tests, operations links, compatibility, and reviewer demo.
- `server/package.json`: maintained dependencies and server/worker/migration/seed/test scripts.
- `server/src/index.js`: web-only entry point and graceful shutdown.
- `client/package.json`: maintained frontend/build dependencies.
- `client/index.html`: language metadata and formatted document.
- `client/src/main.jsx`: retained React entry point, formatted.
- `client/src/App.jsx`: responsive monitoring/configuration/incident dashboard and bounded refresh.
- `client/vite.config.js`: loopback development server and same-origin API proxy.

### Backend files added

- `server/migrations/001_initial.sql`
- `server/migrations/002_delivery_attempts.sql`
- `server/src/config.js`
- `server/src/db.js`
- `server/src/migrate.js`
- `server/src/domain.js`
- `server/src/probes.js`
- `server/src/alerts.js`
- `server/src/worker.js`
- `server/src/worker-health.js`
- `server/src/api.js`
- `server/src/seed.js`
- `server/src/demo.js`
- `server/scripts/benchmark.js`

### Frontend files added

- `client/src/LatencyChart.jsx`
- `client/src/style.css`

### Tests and validation tooling added

- `server/test/unit.test.js`
- `server/test/probes.test.js`
- `server/test/integration.test.js`
- `e2e/dashboard.spec.js`
- `playwright.config.js`
- `scripts/e2e-server.js`
- `scripts/check-config.js`
- `eslint.config.js`

### Project, configuration, and deployment files added

- `package.json` and `package-lock.json`
- `.gitignore`, `.prettierignore`, `.dockerignore`
- `.env.example` and `.env.compose.example`
- `Dockerfile`
- `compose.yaml`
- `.github/workflows/ci.yml`

### Documentation and evidence added

- `PROGRESS.md`
- `docs/API.md`
- `docs/DESIGN.md`
- `docs/OPERATIONS.md`
- `docs/PERFORMANCE.md`
- `docs/VALIDATION.md`
- `docs/COMPLETION.md`
- `docs/benchmark-baseline.json`
- `docs/benchmark-tuned.json`
- `docs/benchmark-tuned-with-rules.json`
- `docs/screenshots/desktop.png`
- `docs/screenshots/mobile.png`
- This consolidated changes/improvements/tests report.

### Local-only artifacts, excluded from Git

- Ignored root `.env` for the task's synthetic local preview.
- `.local-demo/`: process identities, service logs, stop helper, and preview notes.
- Separate PostgreSQL data directory and development/test/browser/benchmark/restore databases in the JOB workspace.
- Temporary staging checkout and downloaded, checksum-verified validation tools in the JOB workspace.
- Dependency directories, built frontend assets, and browser test failure/report artifacts.

## 14. Compatibility changes and remaining gaps

- ICMP runtime checks were intentionally removed because the existing implementation depended on OS arguments/privileges without validated portable behavior. The original JSON remains intact. Explicit legacy import creates disabled TCP port-443 placeholders; every protocol/port must be reviewed before enabling.
- Socket.IO bootstrap/status and `/api/devices` were replaced by the bounded API listed above. Integrations must migrate.
- Docker image/Compose execution and restart persistence are unverified on this host; hosted CI is also unverified.
- No email channel, periodic reminder delivery, public multi-user roles, federation, or production-ready/high-availability claim.
- No multi-hour soak, larger-than-1,000-target load, large notification backlog/fanout capacity test, or continuous server-wide connection/resource profiling.
- Raw result cleanup is bounded; incident/event/attempt/worker audit rows retain indefinitely. Long-term purge/partition/rollup policy remains future work.
- The current access model assumes a trusted single operator on localhost/private infrastructure. Broader exposure requires TLS and stronger access/operational controls.
- All source changes remain reviewable and uncommitted; no external publication occurred.

## 15. Commands to reproduce verification

Run from the repository root. Provision separate disposable databases with the exact names below and replace credentials locally. Integration setup resets only the explicitly opted-in test database's public schema; never point it at development or production.

```powershell
npm.cmd ci
npm.cmd run format:check
npm.cmd run lint
npm.cmd run check:config
npm.cmd test

$env:TEST_DATABASE_URL='postgresql://netmon:TEST_PASSWORD@127.0.0.1:5432/netmon_test'
$env:NETMON_TEST_RESET='YES'
npm.cmd run test:integration

$env:E2E_DATABASE_URL='postgresql://netmon:TEST_PASSWORD@127.0.0.1:5432/netmon_test_e2e'
npx.cmd playwright install chromium
# Stop any other local demo/web processes using ports 8099 or 4000 first.
npm.cmd run test:e2e

npm.cmd run build
npm.cmd audit --audit-level=moderate
```

For setup, synthetic failure/recovery demonstration, Docker reproduction, backup/restore, benchmark parameters, and troubleshooting, see `README.md`, `docs/OPERATIONS.md`, and `docs/PERFORMANCE.md`.
