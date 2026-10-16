# Design and guarantees

## Scheduling and data

Targets carry a due time, stable run UUID, claim token and lease. Workers use PostgreSQL row locks with `FOR UPDATE SKIP LOCKED`; claims commit before network I/O. Lease lifetime is timeout + 15 seconds. A crashed run retains its UUID when reclaimed. Persistence locks the target, checks the fencing token and enabled/archive state, then inserts one result per run and evaluates rules in the same transaction. A late worker cannot commit against a replacement token. Network execution may repeat after crash/lease expiration; exactly-once external execution is not promised. A paused worker can resume an already-started connection while its replacement executes. Only the current fenced claim may commit.

Normally there is one in-flight check per target. Next due is completion + interval + 0–5% positive jitter. Missed slots are coalesced into one due run; there is no catch-up burst. Startup resumes due targets without network discovery. Disabled/archived targets are never claimed. Editing invalidates any claim and resets current status; history remains. A single atomic result/alert/outbox commit either fully succeeds or rolls back. Database failure is an infrastructure error, not a fabricated target-down result; unfinished claims recover on expiry.

SQL migrations are ordered files applied in a transaction under an advisory lock. `schema_migrations` records versions. No prior database schema existed; legacy JSON stays untouched. The pool is bounded per process, uses acquisition/statement deadlines, and transactions always use one checked-out client with rollback/release.

## Status definitions

| State    | Definition                                                                                    |
| -------- | --------------------------------------------------------------------------------------------- |
| disabled | Monitoring intentionally paused, or archived (archived targets are hidden from normal lists). |
| unknown  | Enabled with no committed check since creation/edit.                                          |
| stale    | Last completion older than max(3 × interval, timeout + 5000 ms).                              |
| healthy  | Fresh latest result succeeded.                                                                |
| failing  | Fresh latest result failed.                                                                   |

Latency is null for failed checks, never zero to stand in for missing data. Measured duration uses a monotonic clock; lifecycle timestamps use UTC wall time. Worker freshness is a heartbeat within 45 seconds. Operations expose each recent worker, active work, last-minute check/failure counts, lag, pending deliveries and pool occupancy. Container worker health checks its own worker ID; the dashboard evaluates all worker rows. Stopping a worker does not erase data. Graceful shutdown stops claiming, finishes the bounded current batch and current delivery, then closes the pool; Compose allows 60 seconds before forced termination.

## Alerts and deliveries

Each target defaults to a down rule with three observed consecutive failures and two observed consecutive successes to recover. A latency rule can be added using the API. It uses the average of the last N completed checks, and evaluates only when all N succeeded. This is a sample-count window, not a time-weighted average. Insufficient samples/failed samples reset the latency breach/recovery counters. No timer fabricates a failure for stale/no-data targets. Consecutive thresholds refer to observed checks, not missed schedule slots. Existing incidents remain open while monitoring is disabled or stale, until explicit successful evaluation recovers them; acknowledgement records operator awareness without closing.

Only open/recovery transitions generate incident events and deliveries. Further failures do not flood notifications. Reopens within a rule's cooldown since the last notified open are recorded but suppress the new open notification; recoveries are always eligible. No periodic reminders are implemented. Changing a rule resets its counters and keeps any existing incident/history.

Pending deliveries are durably reserved using a 30-second lease and a new fencing token. Attempt reservation is persisted **before** external I/O; even interrupted deliveries consume the retry budget. Up to five attempts use 1, 2, 4, 8 second delays (16 seconds is the final recorded next time, but exhausted rows are never retried). Attempts retain success/error metadata; interrupted fifth attempts become exhausted after lease expiry. A 3-second request deadline, 64 KiB response cap, and destination policy apply. Non-2xx responses fail. The local sink marks delivery sent, logs its ID only and contacts nobody. Payload remains inspectable in PostgreSQL.

Probe work and delivery are separate durable queues, processed in successive worker iterations. Receiver failure cannot roll back a probe result. A slow receiver can delay its worker's next scan by at most the bounded delivery deadline; add workers or split the delivery loop if measured backlog requires it. Delivery is at-least-once in the presence of crashes: a receiver may accept a request before the worker can record success. `Idempotency-Key` is the delivery UUID; receivers must enforce it to deduplicate external effects. Email, reminders and multi-channel fanout are future work.

## Destination and access policy

The deployment boundary is a trusted single-operator local machine or private network behind a TLS reverse proxy. Native web binding defaults to loopback. A non-loopback binding requires a 24+ character bearer token; all `/api` reads and writes use that operator capability. Tokens live in browser memory and environment, not URLs/local storage/database/logs. Health endpoints expose only dependency availability. No sessions/cookies are used, so cookie CSRF does not apply; mutation bodies require JSON and there are no cross-origin CORS grants. Unauthenticated loopback mode validates the request hostname to resist DNS rebinding. Use TLS before any remote access. This is not a public multi-tenant service; no roles, rate limiter, login federation or public-internet deployment is promised.

Only an authenticated/trusted local operator can change targets. Every destination must match an exact hostname/IP allowlist. Private RFC1918 destinations are intentionally permitted when explicitly allowlisted. Unspecified, loopback, link-local/metadata, multicast, high reserved IPv4 and mapped IPv6 addresses are denied; explicit demo mode permits only loopback exceptions and forces sink delivery during configuration loading. All resolved addresses are checked, then one is pinned into the connection while the original TLS hostname remains intact. Resolution repeats every run, protecting against DNS changes. Redirects are treated as status responses and never followed. A DNS request can outlive its check deadline in the OS resolver, but no network probe is started if that deadline has expired. No target value becomes a shell command. URLs reject embedded credentials, query strings and fragments to reduce accidental secret storage; configure a non-secret health path.

Outbound allowlisting is not a complete network firewall. Operators must not allowlist sensitive internal services; destination DNS infrastructure remains trusted. Webhook endpoint/secret configuration is environment-only and should be reviewed before enabling real delivery. Demo and automated validation never contact real recipients.

## Decisions and future work

- Retain React/Express; update maintained compatible dependencies, use one npm workspace lockfile.
- Raw versioned SQL + node-postgres is the smallest established-tooling option because the original app had no ORM. PostgreSQL supplies durable coordination and transactions without a broker.
- Same-origin bounded polling replaces full-history Socket.IO bootstrap. Search/pagination/detail history have hard limits, with no overlapping refresh and capped exponential backoff.
- TCP/HTTP replace platform-dependent ICMP. ICMP needs a reviewed cross-platform implementation and container capability policy before reintroduction.
- No cache: current summary/list queries avoid cache invalidation ambiguity. Optimize only measured bottlenecks.
- Future: retention partitions/rollups for long history; dedicated notifier for large backlogs; stronger roles/auth and rate limits for wider deployment; archive/purge workflow; ICMP; email; time-window latency aggregates; longer soak and actual Docker/hosted CI evidence.

Official implementation references: [PostgreSQL SELECT/locking](https://www.postgresql.org/docs/18/sql-select.html), [node-postgres transactions](https://node-postgres.com/features/transactions), [Node HTTP](https://nodejs.org/docs/latest-v24.x/api/http.html).
