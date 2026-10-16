# NetMon modernization progress

## Audit and baseline (2026-10-15)

- Original Git working tree clean; no repository or ancestor AGENTS.md found.
- Express 4 / Node ES modules; React 18 / Vite 5. No lockfiles or tests.
- Web-process cron starts ICMP checks on startup and every ten seconds. Promise.all has no concurrency limit. History/latest are volatile; device JSON persists configuration only. Web requests do not directly trigger probes, but probes share the web process.
- Socket.IO bootstrap downloads all retained history; missing results render DOWN. CORS permits all origins. Ping passes Unix-specific arguments. No runtime version policy, DB, migrations, health, auth, Compose or CI.
- Original public/private device destinations must never be probed during validation. Legacy JSON preserved for explicit import.
- Baseline dependency installation/build in progress; no existing automated test command.

## Plan and gates

1. Persistence: versioned SQL migrations, targets/results/rules/incidents/events/outbox/worker tables; isolated PostgreSQL migration and constraint checks.
2. Workers: bounded HTTP/TCP, exact destination allowlist, pinned DNS, leased run identities with fencing; multiworker/crash tests.
3. Alerts: down/recovery and rolling latency rules; transactionally generated outbox, sink/webhook retries; transition/restart tests.
4. UI/API: same React/Express stack, paginated target configuration/history/status/incident flows; readiness and heartbeat; API and browser smoke.
5. Quality: Node tests on real PostgreSQL and local servers, lint/build/audit, deterministic resilience cases.
6. Operations/CI: one app image, explicit migration service, private DB, non-root runtime; hosted CI pending until observed.
7. Performance: controlled benchmark and actual report; no unsupported capacity claims.
8. Documentation: architecture, API, security, migration/backup, demo, screenshots if browser available.

No phase is complete until recorded checks pass. Compose execution requires Docker (not found on PATH). ICMP will be documented as a compatibility limitation rather than invoking OS commands from configurable inputs.

## Implementation and validation checkpoint

- Phases 1–3 implemented: transactional PostgreSQL migrations, persistent configuration/results/current state, rules/incidents/events, fenced leases and idempotent result persistence, bounded HTTP/TCP, destination policy, outbox with pre-I/O attempt reservation and crash-budget exhaustion.
- Phase 4 implemented: React configuration/status/history UI and bounded same-origin API, bearer access model, liveness/readiness and worker metrics. ICMP/Socket.IO compatibility changes explicitly documented. Actual desktop/mobile screenshots inspected.
- Quality: 6 unit/probe tests and 11 PostgreSQL integration tests pass, including two real worker processes and forced worker restart. Initial probe response-size race fixed; initial test pool lifecycle error fixed; retry isolation fixed. No baseline application tests existed.
- Browser lifecycle test passes. Desktop/mobile automated accessibility checks initially found low-contrast secondary text; corrected palette pending rerun. The earlier 3 browser tests passed before axe was added.
- Baseline original client build passed on Vite 5.4.21 (185.74 kB JS). Original server audit: 2 moderate; original client audit: 1 moderate/1 high. Updated npm workspace lockfile currently audits clean.
- New build succeeds. Lazy chart reduces initial JS from 508.36 kB (152.53 kB gzip) to 158.48 kB (51.52 kB gzip); chart loads separately, 351.77 kB (102.14 kB gzip).
- Compose and CI YAML parse/structural checks passed. Docker executable/Desktop not present; image build, Compose start/restart and container health remain UNVERIFIED. Hosted CI not observed. No deployment/push/real notifications/network scans.
- Performance: first run measured 50/250 targets but 1,000-target fixture bulk insert hit the enforced 5-second statement limit before workload. Replaced fixture setup with bounded batches; full rerun in progress. This is a fixture failure, not a measured 1,000-target service failure. Raw report is written after each completed stage.
- README, API, design/security/semantics, operations and reviewer demo drafted. Final validation/performance reports and original-repository synchronization remain pending.

## Final acceptance checkpoint

- Phases 0–5: implemented and required local checks passed. Final suite totals: 7 unit/probe tests, 12 real PostgreSQL tests, 4 browser tests. Database transport interruption/recovery, two real worker processes, forced worker restart, thresholds/cooldown/outbox retry exhaustion and partial UI failure covered. Desktop/mobile axe scans now pass; corrected screenshots captured.
- Phase 6: Dockerfile/Compose, non-root app, persistent database volume, migration dependency, health checks and native operations docs implemented. **Container execution gate remains UNVERIFIED: Docker is not installed.**
- Phase 7: GitHub Actions workflow includes locked install, format/lint/config/unit/PostgreSQL/browser/audit/secret scan and full Compose smoke. YAML structure and actionlint pass locally. **Hosted execution remains UNVERIFIED: no push or run observed.**
- Phase 8: complete paired 60-second 50/250/1,000-target runs recorded plus a separate 1,000-target run with a down rule on every target. At 1,000 with rules: list p95 15.49 ms, 96.99 probes/sec, p95 lag 7,871 ms, zero unexpected API errors. Baseline 500 ms worker scan missed the lag budget at 1,000; 25 ms tuning passes the provisional one-minute budgets. No long soak or larger capacity claim.
- Phase 9: README, API, architecture/design/security, operations, reviewer demo, performance and validation documentation complete. Backup/restore round trip passed into a NEW database: 5 targets, 1,400 results, 5 rules, 2 migrations. Demo seed and explicit disabled legacy import each rerun successfully without duplication.
- Source synchronized into original repository only after reconfirming clean Git state. Original legacy device JSON and Git history preserved. Final clean-install checks in the original checkout are in progress; record completion below.

### Acceptance checklist

- [x] Existing behavior audited; intentional ICMP/Socket.IO/API changes and migration steps documented.
- [x] PostgreSQL migrations, persistence, constraints and backup/restore verified.
- [x] Independent bounded monitoring; concurrent worker coordination and crash recovery verified.
- [x] Incident thresholds/recovery/deduplication/cooldown and durable delivery attempts/retries verified.
- [x] Responsive target/configuration/history/incident dashboard with status semantics and automated accessibility checks.
- [x] Destination validation, secret handling and trusted single-operator access boundary enforced/documented.
- [x] Unit, PostgreSQL integration, API and critical browser flows pass locally.
- [ ] Docker runtime/Compose restart verification: unavailable on this host; reproducible commands in README/VALIDATION.
- [x] CI configuration included and locally linted; hosted status accurately marked pending.
- [x] Actual performance measurements/raw data/reproduction and test limits documented.
- [x] Setup, operations, API, architecture, compatibility and reviewer demo documentation provided.
- [x] No real notifications, scans, push, merge or deployment; test resets isolated, legacy/development data preserved.
- [x] Remaining limitations and next verification commands are explicit.

### Resume notes

- Original checkout: `C:\Users\Gordon\Desktop\Documents\Github Repo\Network Monitoring Dashboard\netmon_dashboard`.
- Reviewable source changes are uncommitted; no push made. Staging copy remains in JOB/netmon-modernization.
- Implementation test cluster is separate, at JOB/.netmon-pg, loopback port 55439, local role netmon. Dev/test/e2e/benchmark/restore databases are distinct. Do not drop the development database or existing volume.
- Initial automatic approval review stopped a backup command due to account usage limit; no action ran then. User resumed, review succeeded, and backup/restore completed.

### Fresh-checkout reliability correction

The first original-checkout full run exposed a nondeterministic checked-out PostgreSQL client error between awaited statements. A worker could exit on the unhandled connection event; test cleanup could then wait forever for an already-fired exit. The transaction helper now handles connection errors throughout client ownership and destroys broken clients on release. Child cleanup recognizes exited processes and has a five-second bound. Added a deterministic regression terminating a checked-out backend between statements. All **13** PostgreSQL tests now pass in the original checkout, including transport outage and real worker recovery. Targeted outage checks were repeated. Original clean dependency installation, seven unit/probe tests, formatting/lint/config checks had already passed; final build/browser/audit resumed after the fix.

### Final original-repository results

Fresh `npm ci` succeeded in the original checkout. Formatting, ESLint and YAML/config checks passed; 7 unit/probe tests passed; all 13 PostgreSQL integration tests passed after the connection-error correction; the two outage regression cases passed again independently. Final production build succeeded. All 4 browser tests passed in the original checkout (17.0 seconds), including desktop/mobile axe scans, incident lifecycle and partial dashboard failure. Dependency audit found zero vulnerabilities. Git whitespace check passed and legacy `server/devices.json` has no diff. Secret scanning and actionlint passed; final documentation is included. Docker runtime and hosted CI remain unverified as stated above. No commit or push made.

### Running local preview

The final application is running from the original repository at http://127.0.0.1:4000. Verified readiness=ready and worker_available=true; summary: 2 healthy synthetic targets, 3 disabled legacy targets, 0 failing/unknown/stale. An ignored .env points only to the task-created development database on loopback 55439. Ignored .local-demo contains service logs, start identities and a safe stop helper; no credentials or local process metadata were added to Git. Final original-repository formatting and Gitleaks scans pass. All changes remain uncommitted and unpushed. The browser panel was requested through open_in_codex (queued for this chat).
