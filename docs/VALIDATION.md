# Executed validation and remaining checks

Implementation date: 2026-10-15. Source changes retain Express/Node and React/Vite. The original working tree was clean; no existing tests or lockfiles existed. Baseline startup was deliberately not executed because it automatically probes the real legacy destinations. Original client dependency installation and production build passed. Baseline dependency audits reported two moderate server findings and one moderate/one high client finding.

## Actual checks

| Check                                    | Result                                                                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci` / pinned workspace dependencies | Installed successfully; one root lockfile. Final original-checkout installation is recorded in PROGRESS.md.                                                                           |
| `npm run lint`                           | Pass. JavaScript syntax/structural ESLint checks. No TypeScript conversion/type-check claim.                                                                                          |
| `npm run format:check`                   | Final result recorded in PROGRESS.md after final documentation formatting.                                                                                                            |
| `npm run check:config`                   | Compose and workflow YAML parse/required structural checks pass. This is not Compose execution.                                                                                       |
| `npm test`                               | **7 passed**: target/config bounds, state semantics, thresholds, retry/pagination, local HTTP/TCP success/refusal/timeout/status/body bounds/redirect policy, sensitive destinations. |
| `npm run test:integration`               | **13 passed**, using actual PostgreSQL 18.6, never SQLite.                                                                                                                            |
| `npm run test:e2e`                       | **4 passed**: full target/incident/recovery/archive lifecycle; partial refresh failure/recovery; desktop/mobile, focus operation and automated WCAG A/AA checks.                      |
| `npm run build`                          | Pass. React/Vite production assets built; chart code loaded on demand.                                                                                                                |
| `npm audit --audit-level=moderate`       | **0 vulnerabilities** at execution time, including development dependencies. This is a point-in-time dependency report.                                                               |
| Gitleaks 8.30.1 directory scan, redacted | Pass: no leaks. Initial false positive combined an empty WEBHOOK_TOKEN example with the next line; reordered example fields, no scanner rule disabled.                                |
| actionlint 1.7.12, workflow file         | Pass. Shellcheck/pyflakes integrations unavailable and explicitly not run.                                                                                                            |
| Clean PostgreSQL migrate; repeat migrate | Pass. Transactional version table and advisory serialization.                                                                                                                         |
| Demo seed twice; legacy import twice     | Pass: exactly 2 demo + 3 disabled legacy targets. Root argument forwarding fixed and the documented legacy command rerun. Original JSON unchanged.                                    |
| PostgreSQL backup/restore                | Pass: pg_dump custom-format snapshot restored into a **new** database, containing 5 targets, 1,400 results, 5 rules and 2 migration versions. Original database preserved.            |
| Benchmarks                               | Paired 60-second 50/250/1,000-target runs and supplemental 1,000-target run with default down rules. See PERFORMANCE.md and raw JSON.                                                 |
| Screenshots                              | Captured from the working synthetic application and visually inspected at desktop/mobile widths.                                                                                      |

The PostgreSQL suite covers constraints, rollback, pool reconnect/persistence, simultaneous claims, stable run identity, stale-token fencing and idempotent commits; down/recovery/deduplication/cooldown; latency minimum sample window; stale/no-data; API validation/auth/filter/pagination/lifecycle; acknowledgement idempotency; webhook retry exhaustion and interrupted fifth attempt; bounded result retention and incident preservation; backend connection interruption; a forcibly terminated/restarted actual worker process; two actual worker processes with no normal target overlap; and database transport interruption with 503 readiness, independent liveness, worker recovery and no fabricated target failures; plus checked-out connection failure between statements with safe rejection/reconnection.

Browser checks run on Chromium 156 through Playwright 1.64.1, with axe-core integration 4.14.0, at 1440×1050 and 390×844. Secondary text contrast failures were fixed and the scans rerun to pass. Focus, labels, status text and mobile overflow were checked; these scans do not constitute a complete manual assistive-technology audit. Latency chart uses real timestamps and retains textual result equivalents.

Initial implementation test failures (response-size resolution race, test pool ownership, retry fixture interference, contrast) were corrected and required suites rerun. The first benchmark's bulk fixture statement timeout is documented; the complete workload was rerun with bounded fixture batches. None is presented as a passing pre-existing test.

## Explicitly unverified or limited

- **Docker image build, Compose startup/restart, in-container health and Windows Docker Desktop workflow:** unavailable because Docker is not installed on the implementation host. Configuration/CI steps are included; run `docker compose --profile demo up --build -d --wait`, seed, inspect health, then restart and verify retained history on a Docker-equipped machine. Phase 6's runtime gate is unverified.
- **Hosted GitHub Actions:** workflow added and locally linted, but no push or hosted run was authorized/observed. Phase 7's hosted gate is pending. The workflow runs a full Compose smoke after native tests; it publishes/deploys nothing.
- **Long soak, broad failure bursts, large notification backlog, PostgreSQL resource profiling and overall connection utilization:** not measured. One-minute controlled workload results are explicitly scoped.
- **Live external webhook/email:** no real recipients contacted. Controlled local webhook receiver tests pass; email is a future extension.
- **ICMP:** intentionally removed from runtime, with legacy JSON preserved and disabled TCP placeholders available through explicit import. Native shell ping/container privilege behavior is not claimed.
- **Public/multi-user deployment:** unsupported; single-operator token capability and trusted local/private boundary documented. Use TLS/access hardening before broader access.
- **Retention:** raw results have bounded cleanup; incident/event/attempt/worker audit rows retain indefinitely. A destructive archive-purge workflow is future work.

No push, merge, deployment, network scan, destructive operation against legacy/development data, or real notification occurred. The only schema resets were explicitly opted-in isolated test/benchmark schemas. The original repository and its Git history are preserved.

A fresh-install rerun exposed a checked-out-client error race during transport interruption and an already-exited-child cleanup wait. Both were fixed, a deterministic regression was added, and all 13 PostgreSQL tests passed again in the original repository. The targeted outage/regression checks were repeated before delivery.

Final production assets from the original checkout: entry JS 158.86 kB (51.61 kB gzip), deferred chart JS 352.01 kB (102.24 kB gzip), CSS 8.45 kB (2.70 kB gzip). An initial final browser launch found the task's separate demo receiver occupying port 8099; temporary demo processes were stopped and the browser run repeated. This was local test orchestration, not an application assertion failure.
