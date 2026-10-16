# Performance measurements

Measured on 2026-10-15. These are controlled one-minute local workloads, not a multi-hour soak, internet latency measurement, or production capacity guarantee. Raw measurements, query plans, payload sizes, CPU/memory observations and timeout/notification scenarios are retained in `benchmark-baseline.json`, `benchmark-tuned.json`, and `benchmark-tuned-with-rules.json`.

## Environment and workload

Windows 11 (10.0.26200), Intel Core i7-13700, 24 logical CPUs, 31.77 GiB RAM; Node 24.13.0 / npm 11.6.2; PostgreSQL 18.6. Native processes share the host with no enforced CPU/memory limit. PostgreSQL was initialized in an isolated local cluster with **40 max connections and 400 KiB shared_buffers**, verified with SHOW. This very small buffer setting is a property of this test environment, not a recommended production setting.

Two independent worker instances, each concurrency 8 and pool maximum 5, share PostgreSQL. The API has its own pool maximum 5. Workers and the API run in the same benchmark Node process with separate pools; separate OS worker processes are additionally covered by integration tests. Reported process CPU/RSS includes Node API/workers/receiver together, excludes the PostgreSQL server, and is not per-container resource usage.

Each staged workload has 50, 250 or 1,000 HTTP targets, interval 10,000 ms, timeout 500 ms, and 200 synthetic historical rows per target (10,000 / 50,000 / 200,000 history rows). A local controlled receiver delays success responses by 10 ms. Initial due times are spread over ten seconds. Ten concurrent readers alternate summary and 25-item list requests, with 25 ms think time, for 60 seconds per stage. This measures latency at a declared reader workload, not maximum saturation throughput. There is a one-second worker warmup; startup scheduling effects still contribute to the distributions.

The paired scheduling baseline/tuned runs intentionally omit per-target alert rule rows to isolate scheduling overhead; they still use the full result transaction and alert lookup. A separate 1,000-target run includes one default down rule on **every** target. Do not present the paired runs as full alert-enabled capacity measurements. The burst drill tests a single down incident and a temporarily failing notification receiver; it does not establish large-scale notification-fanout capacity.

## Budgets and observations

After the first measurements, provisional budgets were set to API p95 <500 ms with ten readers, unexpected API errors <1%, and schedule-lag p95 below the configured 10-second interval. With the original 500 ms worker scan delay, 1,000 targets missed the lag budget. The measured bottleneck was the gap between bounded batches; exposing and tuning `WORKER_POLL_MS=25` addressed it without increasing concurrency. The conservative default remains 500 ms for small installations.

|                    Targets | Worker scan delay | Summary p95 |   List p95 / p99 | API req/s | Probe checks/s |              Schedule lag p95 | Unexpected errors |
| -------------------------: | ----------------: | ----------: | ---------------: | --------: | -------------: | ----------------------------: | ----------------: |
|                         50 |            500 ms |     4.31 ms | 11.18 / 13.57 ms |    277.18 |           4.82 |                        479 ms |                 0 |
|                         50 |             25 ms |     4.74 ms | 10.70 / 13.07 ms |    302.53 |           4.80 |                         37 ms |                 0 |
|                        250 |            500 ms |     5.61 ms | 12.73 / 16.13 ms |    278.60 |          24.00 |                      1,852 ms |                 0 |
|                        250 |             25 ms |     5.01 ms |  9.62 / 11.52 ms |    310.38 |          23.55 |                         43 ms |                 0 |
|                      1,000 |            500 ms |     7.05 ms | 13.76 / 19.81 ms |    283.24 |          29.11 | **35,084 ms — missed budget** |                 0 |
|                      1,000 |             25 ms |     5.90 ms | 11.08 / 13.31 ms |    308.63 |          96.77 |                      6,168 ms |                 0 |
| 1,000 + default down rules |             25 ms |     9.34 ms | 15.49 / 19.84 ms |    280.61 |          96.99 |                      7,871 ms |                 0 |

All three provisional budgets passed in the one-minute 1,000-target alert-enabled run. This is the largest actually tested workload; no greater size or longer duration is claimed. Completion-relative schedules include jitter and do not promise exactly 100 checks/s. The 1,000-target tuned lag tail includes startup load; p99 with rules was 9,042 ms. Keep operating headroom and run longer tests on the intended machine before adopting this workload.

The alert-enabled run completed 5,824 checks and 16,850 successful API requests in 60.05 seconds. API query p95 was 5.99 ms; list uses two SQL queries, summary one, for 25,275 API SQL queries in that run. API pool occupancy peaked at 5/5; each worker pool is independently capped at 5. Overall server-side connection utilization was not continuously sampled. History EXPLAIN ANALYZE used the `(target_id, completed_at DESC)` index, returning 50 rows in 0.451 ms execution time (planning 3.97 ms). Plans include buffer observations in raw JSON. No caching was needed. There is no client-driven per-target query loop in summary/list, although the list query contains an indexed incident-count subquery for each of at most 100 returned targets.

Peak combined benchmark Node RSS was 224.10 MiB with rules; CPU accumulated 18,187 ms user + 6,750 ms system across the 60-second workload. Shared-host scheduling, cache/GC effects and other validation work may influence comparisons; these are single samples without statistical confidence intervals. PostgreSQL-specific resource usage and Docker resource limits were not measured.

## Timeout, receiver outage and UI traffic

- In the paired tuned run, a 200 ms hanging local check returned persisted-style failure category TIMEOUT after 213.83 ms. Deadlines bound network work but wall-clock overhead is not mathematically zero.
- A failing local webhook receiver produced two failed recorded attempts and one pending delivery. After receiver restoration and making that delivery due, it drained successfully in 12.52 ms (one successful attempt). This is a one-item backlog experiment; retries/backoff/exhaustion and interrupted attempts have independent automated coverage.
- Representative 25-target summary/list JSON was 63 + 13,511 bytes with rules. At one refresh per five seconds, this pair costs approximately 162,888 bytes/minute **excluding headers, operations/incidents requests and optional detail history**. The UI uses a 20-row list; the benchmark uses 25. Full dashboard traffic is therefore not identical to this pair.
- The actual production build initially bundled chart code eagerly: 508.36 KB JS / 152.53 KB gzip. Loading charts on demand reduced the initial entry to approximately 159 KB / 52 KB gzip; the detail chart adds approximately 352 KB / 102 KB gzip only when needed. Final exact asset sizes appear in VALIDATION.md. History requests remain capped; chart X positions use real timestamps and gaps mark failed checks or missing intervals.

## Reproduction (PowerShell)

Provision a separate disposable PostgreSQL database named **netmon_test_benchmark**. The harness refuses any other database and requires explicit reset opt-in. It drops that database's public schema between stages, never the development/production database.

```powershell
npm.cmd ci
$env:BENCHMARK_DATABASE_URL='postgresql://netmon:TEST_PASSWORD@127.0.0.1:5432/netmon_test_benchmark'
$env:NETMON_BENCHMARK_RESET='YES'
$env:BENCHMARK_SECONDS='60'
$env:BENCHMARK_COUNTS='50,250,1000'
$env:BENCHMARK_ALERT_RULES='false'
$env:BENCHMARK_LABEL='baseline'
$env:WORKER_POLL_MS='500'
npm.cmd run benchmark
$env:BENCHMARK_LABEL='tuned'
$env:WORKER_POLL_MS='25'
npm.cmd run benchmark
# Include standard target-down evaluation at the largest measured workload:
$env:BENCHMARK_LABEL='tuned-with-rules'
$env:BENCHMARK_COUNTS='1000'
$env:BENCHMARK_ALERT_RULES='true'
npm.cmd run benchmark
```

Use a fresh label to preserve existing reports. Durations 10–3600 seconds and target counts 1–1000 are supported; short smoke durations must not be described as sustained capacity tests. Reports are saved after every completed stage and marked incomplete until the full run finishes.

The first unbatched 200,000-row fixture insert exceeded the application's 5-second SQL statement deadline before the 1,000-target load started. The setup was changed to bounded 20-sample batches and the entire paired workload rerun. No benchmark values are fabricated or extrapolated from the aborted setup. Production SQL deadlines were retained.

The recorded load tests precede the final checked-out-connection error-handler correction. That correction adds connection-failure handling around transaction ownership; the entire performance workload was not rerun after it. Final reliability tests cover it. Treat these measurements as evidence for the tested configuration, not an exact performance guarantee for every subsequent revision.
