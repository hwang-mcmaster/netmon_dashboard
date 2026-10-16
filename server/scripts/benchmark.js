import os from "node:os";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { database } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { app, createTarget } from "../src/api.js";
import { runWorker, deliverOne } from "../src/worker.js";
const url = process.env.BENCHMARK_DATABASE_URL;
if (
  !url ||
  new URL(url).pathname !== "/netmon_test_benchmark" ||
  process.env.NETMON_BENCHMARK_RESET !== "YES"
)
  throw new Error(
    "Requires isolated netmon_test_benchmark and NETMON_BENCHMARK_RESET=YES",
  );
const duration = Number(process.env.BENCHMARK_SECONDS || 60),
  pollMs = Number(process.env.WORKER_POLL_MS || 500),
  label = process.env.BENCHMARK_LABEL || "baseline";
if (!Number.isInteger(duration) || duration < 10 || duration > 3600)
  throw new Error("BENCHMARK_SECONDS must be 10–3600");
const c = {
  databaseUrl: url,
  poolMax: 5,
  allowedHosts: ["127.0.0.1"],
  demo: true,
  channel: "sink",
  token: "",
  concurrency: 8,
  pollMs,
  retentionDays: 30,
};
const counts = (process.env.BENCHMARK_COUNTS || "50,250,1000")
  .split(",")
  .map(Number);
if (counts.some((n) => !Number.isInteger(n) || n < 1 || n > 1000))
  throw new Error("BENCHMARK_COUNTS must contain integers 1–1000");
const withRules = process.env.BENCHMARK_ALERT_RULES === "true";
const pool = database(c);
let failing = false,
  receiverFail = true;
await mkdir(new URL("../../docs/", import.meta.url), { recursive: true });
const receiver = http.createServer((req, res) => {
  if (req.url === "/hang") return;
  if (req.url === "/notify") {
    res.writeHead(receiverFail ? 503 : 200);
    return res.end();
  }
  setTimeout(() => {
    res.writeHead(failing ? 503 : 200);
    res.end("synthetic");
  }, 10);
});
await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
const port = receiver.address().port;
const report = {
  label,
  at: new Date().toISOString(),
  environment: {
    platform: os.platform(),
    release: os.release(),
    cpu: os.cpus()[0].model,
    logical_cpus: os.cpus().length,
    total_ram_gb: os.totalmem() / 2 ** 30,
    node: process.version,
    postgres: (await pool.query("SELECT version() version")).rows[0].version,
    resource_limits:
      "Native shared Windows host, no enforced process limits; PostgreSQL max_connections=40, shared_buffers=400kB (initdb environment default)",
    workers: 2,
    concurrency_per_worker: 8,
    pool_max_per_process: 5,
    poll_ms: pollMs,
    interval_ms: 10000,
    timeout_ms: 500,
    history_per_target: 200,
    readers: 10,
    duration_seconds_per_stage: duration,
    down_rule_per_target: withRules,
  },
  stages: [],
};
const pct = (a, p) =>
  a.length
    ? [...a].sort((x, y) => x - y)[
        Math.min(a.length - 1, Math.ceil(a.length * p) - 1)
      ]
    : null;
let apiServer;
try {
  for (const count of counts) {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrate(pool);
    await pool.query(
      `INSERT INTO targets(id,name,host,probe_type,interval_ms,timeout_ms,tags,next_due)
   SELECT md5('benchmark'||g)::uuid,'Synthetic '||lpad(g::text,4,'0'),$1,'http',10000,500,ARRAY['benchmark'],now()+make_interval(secs=>(g%100)::double precision/10) FROM generate_series(1,$2) g`,
      [`http://127.0.0.1:${port}`, count],
    );
    if (withRules)
      await pool.query(
        "INSERT INTO rules(id,target_id,kind) SELECT md5(id::text||'down')::uuid,id,'down' FROM targets",
      );
    for (let first = 1; first <= 200; first += 20)
      await pool.query(
        `INSERT INTO results(run_id,target_id,scheduled_at,started_at,completed_at,outcome,latency_ms,worker_id)
   SELECT md5(t.id::text||g)::uuid,t.id,now()-make_interval(secs=>g*10),now()-make_interval(secs=>g*10),now()-make_interval(secs=>g*10),'success',10,$1 FROM targets t CROSS JOIN generate_series($2::int,$3::int) g`,
        [randomUUID(), first, first + 19],
      );
    await pool.query("ANALYZE targets; ANALYZE results");
    const apiPool = database(c);
    let queryCount = 0;
    const queryTimes = [];
    const original = apiPool.query.bind(apiPool);
    apiPool.query = async (...args) => {
      const t = performance.now();
      try {
        return await original(...args);
      } finally {
        queryCount++;
        queryTimes.push(performance.now() - t);
      }
    };
    apiServer = app(apiPool, c).listen(0, "127.0.0.1");
    await new Promise((r) => apiServer.once("listening", r));
    const base = `http://127.0.0.1:${apiServer.address().port}`;
    const controller = new AbortController();
    const workers = [
      runWorker(c, { signal: controller.signal }),
      runWorker(c, { signal: controller.signal }),
    ];
    await new Promise((r) => setTimeout(r, 1000));
    const timings = { summary: [], list: [] },
      payloads = { summary: 0, list: 0 };
    let errors = 0,
      maxPool = 0,
      maxRss = 0;
    const cpuStart = process.cpuUsage(),
      start = performance.now(),
      end = start + duration * 1000;
    const sampler = setInterval(() => {
      maxPool = Math.max(maxPool, apiPool.totalCount);
      maxRss = Math.max(maxRss, process.memoryUsage().rss);
    }, 200);
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        let i = 0;
        while (performance.now() < end) {
          const kind = i++ % 2 ? "list" : "summary",
            t = performance.now();
          try {
            const r = await fetch(
              `${base}/api/${kind === "list" ? "targets?size=25" : "summary"}`,
              { signal: AbortSignal.timeout(5000) },
            );
            const body = await r.text();
            if (!r.ok) errors++;
            payloads[kind] = Buffer.byteLength(body);
          } catch {
            errors++;
          }
          timings[kind].push(performance.now() - t);
          await new Promise((r) => setTimeout(r, 25));
        }
      }),
    );
    clearInterval(sampler);
    controller.abort();
    await Promise.all(workers);
    const seconds = (performance.now() - start) / 1000,
      cpu = process.cpuUsage(cpuStart);
    const runs = (
      await pool.query(
        `SELECT extract(epoch FROM started_at-scheduled_at)*1000 lag_ms,latency_ms,outcome FROM results WHERE worker_id<>$1 AND completed_at >= $2`,
        [
          "00000000-0000-0000-0000-000000000000",
          new Date(Date.now() - seconds * 1000),
        ],
      )
    ).rows;
    // Historical seed is excluded by its timestamps (newest is ten seconds before workload start).
    const api = Object.fromEntries(
      Object.entries(timings).map(([k, v]) => [
        k,
        {
          requests: v.length,
          p50_ms: pct(v, 0.5),
          p95_ms: pct(v, 0.95),
          p99_ms: pct(v, 0.99),
          payload_bytes: payloads[k],
        },
      ]),
    );
    const plans = (
      await pool.query(
        "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM results WHERE target_id=(SELECT id FROM targets LIMIT 1) ORDER BY completed_at DESC LIMIT 50",
      )
    ).rows[0]["QUERY PLAN"];
    report.stages.push({
      targets: count,
      history_rows: count * 200,
      elapsed_seconds: seconds,
      api,
      requests_per_second:
        Object.values(timings).reduce((s, a) => s + a.length, 0) / seconds,
      unexpected_errors: errors,
      error_rate:
        errors / Object.values(timings).reduce((s, a) => s + a.length, 0),
      probes: runs.length,
      probes_per_second: runs.length / seconds,
      schedule_lag: {
        p50_ms: pct(
          runs.map((r) => Number(r.lag_ms)),
          0.5,
        ),
        p95_ms: pct(
          runs.map((r) => Number(r.lag_ms)),
          0.95,
        ),
        p99_ms: pct(
          runs.map((r) => Number(r.lag_ms)),
          0.99,
        ),
      },
      api_queries: queryCount,
      api_query_p95_ms: pct(queryTimes, 0.95),
      api_pool_peak: maxPool,
      process_peak_rss_mb: maxRss / 2 ** 20,
      cpu_user_ms: cpu.user / 1000,
      cpu_system_ms: cpu.system / 1000,
      history_query_plan: plans,
      refresh_bytes_per_minute: 12 * (payloads.summary + payloads.list),
    });
    console.log(
      JSON.stringify({ stage: count, label, result: report.stages.at(-1) }),
    );
    await writeFile(
      new URL(`../../docs/benchmark-${label}.json`, import.meta.url),
      JSON.stringify({ ...report, incomplete: true }, null, 2),
    );
    await new Promise((r) => apiServer.close(r));
    await apiPool.end();
    apiServer = null;
  }
  // Controlled failure burst, timeouts, receiver outage and backlog drain.
  const drill = await createTarget(
    pool,
    {
      name: "Burst drill",
      host: `http://127.0.0.1:${port}`,
      interval_ms: 1000,
      timeout_ms: 200,
    },
    c,
  );
  await pool.query(
    "UPDATE rules SET failure_threshold=1,recovery_threshold=1 WHERE target_id=$1",
    [drill],
  );
  await pool.query("UPDATE targets SET enabled=false WHERE id<>$1", [drill]);
  const webhook = {
    ...c,
    channel: "webhook",
    webhook: `http://127.0.0.1:${port}/notify`,
  };
  await deliverOne(pool, webhook);
  const ctrl = new AbortController();
  failing = true;
  const worker = runWorker(webhook, { signal: ctrl.signal });
  await new Promise((r) => setTimeout(r, 1500));
  ctrl.abort();
  await worker;
  const backlog = (
    await pool.query(
      "SELECT count(*)::int n FROM deliveries WHERE status='pending'",
    )
  ).rows[0].n;
  receiverFail = false;
  await pool.query("UPDATE deliveries SET next_attempt_at=now()");
  const drain = performance.now();
  while (await deliverOne(pool, webhook)) {}
  report.failure_scenario = {
    temporary_receiver_failure: true,
    pending_after_failure: backlog,
    drain_ms: performance.now() - drain,
    attempt_history: (
      await pool.query(
        "SELECT success,count(*)::int n FROM delivery_attempts GROUP BY success",
      )
    ).rows,
  };
  const timeoutTarget = {
    host: `http://127.0.0.1:${port}/hang`,
    probe_type: "http",
    timeout_ms: 200,
    max_bytes: 1024,
    expected_status: 200,
  };
  const { probe } = await import("../src/probes.js");
  const t = performance.now();
  const r = await probe(timeoutTarget, c);
  report.timeout = {
    budget_ms: 200,
    elapsed_ms: performance.now() - t,
    outcome: r.outcome,
    error_code: r.error_code,
  };
  await mkdir(new URL("../../docs/", import.meta.url), { recursive: true });
  await writeFile(
    new URL(`../../docs/benchmark-${label}.json`, import.meta.url),
    JSON.stringify(report, null, 2),
  );
} finally {
  apiServer?.closeAllConnections();
  apiServer?.close();
  receiver.closeAllConnections();
  await new Promise((r) => receiver.close(r));
  await pool.end();
}
