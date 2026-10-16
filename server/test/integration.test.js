import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { database, transaction } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { createTarget, app } from "../src/api.js";
import { claim, persist, deliverOne, cleanup } from "../src/worker.js";
const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !/^netmon_test(?:_[a-z0-9]+)?$/.test(new URL(url).pathname.slice(1)) ||
  process.env.NETMON_TEST_RESET !== "YES"
)
  throw new Error(
    "Refusing test reset: TEST_DATABASE_URL must name netmon_test[_suffix] and NETMON_TEST_RESET=YES",
  );
const c = {
  databaseUrl: url,
  poolMax: 5,
  allowedHosts: ["127.0.0.1"],
  demo: true,
  channel: "sink",
  token: "test-token-with-at-least-24-characters",
  concurrency: 2,
  retentionDays: 30,
};
let pool, apiPool, server, base;
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Child shutdown timed out")),
      5000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGKILL");
  });
}
async function target(name = "test") {
  return transaction(pool, (db) =>
    createTarget(
      db,
      {
        name,
        host: "http://127.0.0.1:8099/health",
        interval_ms: 1000,
        timeout_ms: 100,
      },
      c,
    ),
  );
}
async function run(id, success, latency = 10) {
  await pool.query("UPDATE targets SET next_due=now() WHERE id=$1", [id]);
  const t = (await claim(pool, randomUUID(), 100)).find((t) => t.id === id);
  assert.ok(t);
  const now = new Date();
  await persist(pool, t, {
    started_at: now,
    completed_at: now,
    outcome: success ? "success" : "failure",
    latency_ms: success ? latency : null,
    error_code: success ? null : "TIMEOUT",
    error_message: success ? null : "TIMEOUT",
  });
  return t;
}
async function req(route, method = "GET", body, token = c.token) {
  const r = await fetch(base + route, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
}
before(async () => {
  pool = database(c);
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await migrate(pool);
  await migrate(pool);
  apiPool = database(c);
  server = app(apiPool, c).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  await pool?.end();
  await apiPool?.end();
});
test("migration, constraints, transaction rollback and connection restart persistence", async () => {
  const id = await target("persistent");
  await assert.rejects(
    pool.query("UPDATE targets SET timeout_ms=interval_ms WHERE id=$1", [id]),
    /check constraint/,
  );
  await assert.rejects(
    transaction(pool, async (db) => {
      await db.query("UPDATE targets SET name='rollback' WHERE id=$1", [id]);
      throw new Error("cancel");
    }),
  );
  await pool.end();
  pool = database(c);
  assert.equal(
    (await pool.query("SELECT name FROM targets WHERE id=$1", [id])).rows[0]
      .name,
    "persistent",
  );
  await pool.query("UPDATE targets SET enabled=false WHERE id=$1", [id]);
});
test("two claimers avoid duplicate scheduling; expired claim retains run identity and fences late result", async () => {
  const id = await target("claim");
  const [a, b] = await Promise.all([
    claim(pool, randomUUID(), 1),
    claim(pool, randomUUID(), 1),
  ]);
  assert.equal([...a, ...b].filter((t) => t.id === id).length, 1);
  const old = [...a, ...b].find((t) => t.id === id);
  assert.equal((await claim(pool, randomUUID(), 10)).length, 0);
  await pool.query(
    "UPDATE targets SET lease_until=now()-interval '1 second' WHERE id=$1",
    [id],
  );
  const current = (await claim(pool, randomUUID(), 1))[0];
  assert.equal(current.run_id, old.run_id);
  assert.notEqual(current.claim_token, old.claim_token);
  const now = new Date(),
    result = {
      started_at: now,
      completed_at: now,
      outcome: "success",
      latency_ms: 5,
      error_code: null,
      error_message: null,
    };
  assert.equal(await persist(pool, old, result), false);
  assert.equal(await persist(pool, current, result), true);
  assert.equal(await persist(pool, current, result), false);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM results WHERE target_id=$1",
        [id],
      )
    ).rows[0].n,
    1,
  );
  await pool.query("UPDATE targets SET enabled=false WHERE id=$1", [id]);
});
test("down thresholds, deduplication, recovery, cooldown and durable sink after restart", async () => {
  const id = await target("incident");
  await run(id, false);
  await run(id, false);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM incidents WHERE target_id=$1",
        [id],
      )
    ).rows[0].n,
    0,
  );
  await run(id, false);
  await run(id, false);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM incidents WHERE target_id=$1",
        [id],
      )
    ).rows[0].n,
    1,
  );
  await run(id, true);
  await run(id, true);
  assert.ok(
    (
      await pool.query(
        "SELECT recovered_at FROM incidents WHERE target_id=$1",
        [id],
      )
    ).rows[0].recovered_at,
  );
  await run(id, false);
  await run(id, false);
  await run(id, false);
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM deliveries")).rows[0].n,
    2,
    "repeat open suppressed during cooldown",
  );
  await pool.end();
  pool = database(c);
  while (await deliverOne(pool, c)) {}
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM deliveries WHERE status='sent'",
      )
    ).rows[0].n,
    2,
  );
  await pool.query("UPDATE targets SET enabled=false WHERE id=$1", [id]);
});
test("latency window requires enough successful samples; no data/stale never create incident", async () => {
  const id = await target("latency");
  await pool.query(
    "INSERT INTO rules(id,target_id,kind,failure_threshold,recovery_threshold,window_samples,latency_threshold_ms) VALUES($1,$2,'latency',1,1,3,100)",
    [randomUUID(), id],
  );
  await run(id, true, 200);
  await run(id, true, 200);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM incidents WHERE target_id=$1",
        [id],
      )
    ).rows[0].n,
    0,
  );
  await run(id, true, 200);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM incidents WHERE target_id=$1",
        [id],
      )
    ).rows[0].n,
    1,
  );
  await run(id, false);
  await run(id, true, 10);
  await run(id, true, 10);
  await run(id, true, 10);
  assert.ok(
    (
      await pool.query(
        "SELECT recovered_at FROM incidents WHERE target_id=$1",
        [id],
      )
    ).rows[0].recovered_at,
  );
  const unknown = await target("unknown");
  await pool.query(
    "UPDATE targets SET last_completed_at=now()-interval '1 hour' WHERE id=$1",
    [id],
  );
  assert.equal((await req(`/api/targets/${id}`)).body.target.state, "stale");
  assert.equal(
    (await req(`/api/targets/${unknown}`)).body.target.state,
    "unknown",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM incidents WHERE target_id=$1",
        [unknown],
      )
    ).rows[0].n,
    0,
  );
  await pool.query(
    "UPDATE targets SET enabled=false WHERE id=ANY($1::uuid[])",
    [[id, unknown]],
  );
});
test("API lifecycle, authentication, filters, limits, safe errors, acknowledgement, soft delete", async () => {
  assert.equal((await req("/api/targets", "GET", null, "bad")).status, 401);
  assert.equal(
    (
      await req("/api/targets", "POST", {
        name: "bad",
        host: "http://169.254.169.254",
      })
    ).status,
    400,
  );
  const created = await req("/api/targets", "POST", {
    name: "api unique",
    host: "http://127.0.0.1:8099/health",
    tags: ["api"],
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(
    (await req("/api/targets?tag=api&q=unique&size=1")).body.total,
    1,
  );
  for (const route of [
    "/api/targets?size=101",
    "/api/targets?state=broken",
    `/api/targets/${id}?hours=999`,
    "/api/targets/not-an-id",
  ])
    assert.equal((await req(route)).status, 400);
  assert.equal((await req(`/api/targets/${id}`)).body.target.state, "unknown");
  await pool.query(
    "UPDATE rules SET failures=2,successes=1 WHERE target_id=$1",
    [id],
  );
  assert.equal(
    (
      await req(`/api/targets/${id}`, "PUT", {
        name: "updated",
        host: "http://127.0.0.1:8099/health",
        enabled: false,
      })
    ).status,
    200,
  );
  assert.equal((await req(`/api/targets/${id}`)).body.target.state, "disabled");
  assert.equal(
    (await pool.query("SELECT failures FROM rules WHERE target_id=$1", [id]))
      .rows[0].failures,
    0,
  );
  const incident = (await pool.query("SELECT id FROM incidents LIMIT 1"))
    .rows[0];
  await req(`/api/incidents/${incident.id}/acknowledge`, "POST", {});
  await req(`/api/incidents/${incident.id}/acknowledge`, "POST", {});
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM incident_events WHERE incident_id=$1 AND kind='acknowledge'",
        [incident.id],
      )
    ).rows[0].n,
    1,
  );
  await req(`/api/targets/${id}`, "DELETE");
  assert.equal((await req(`/api/targets/${id}`)).status, 404);
  assert.ok(
    (await pool.query("SELECT deleted_at FROM targets WHERE id=$1", [id]))
      .rows[0].deleted_at,
  );
  assert.equal((await req("/health/live")).status, 200);
  assert.equal((await req("/health/ready")).status, 200);
  assert.equal((await req("/api/operations")).body.worker_available, false);
});
test("bounded notification retries, attempt history, exhausted receiver failure", async () => {
  const d = (await pool.query("SELECT id FROM deliveries LIMIT 1")).rows[0];
  await pool.query("UPDATE deliveries SET status='sent' WHERE id<>$1", [d.id]);
  await pool.query("DELETE FROM delivery_attempts WHERE delivery_id=$1", [
    d.id,
  ]);
  await pool.query(
    "UPDATE deliveries SET status='pending',attempts=0,next_attempt_at=now() WHERE id=$1",
    [d.id],
  );
  const receiver = http.createServer((_req, res) => {
    res.writeHead(503);
    res.end();
  });
  await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
  const webhook = {
    ...c,
    channel: "webhook",
    webhook: `http://127.0.0.1:${receiver.address().port}`,
  };
  // Directly injected test configuration permits only this controlled loopback receiver.
  try {
    for (let i = 0; i < 5; i++) {
      await pool.query(
        "UPDATE deliveries SET next_attempt_at=now() WHERE id=$1",
        [d.id],
      );
      await deliverOne(pool, webhook);
    }
  } finally {
    receiver.closeAllConnections();
    await new Promise((r) => receiver.close(r));
  }
  const final = (
    await pool.query("SELECT * FROM deliveries WHERE id=$1", [d.id])
  ).rows[0];
  assert.equal(final.status, "exhausted");
  assert.equal(final.attempts, 5);
  assert.equal(await deliverOne(pool, webhook), false);
});
test("bounded retention preserves incident history and clears expired cause references", async () => {
  await pool.query(
    "UPDATE results SET started_at=now()-interval '40 days',completed_at=now()-interval '40 days'",
  );
  const count = (await pool.query("SELECT count(*)::int n FROM results"))
    .rows[0].n;
  assert.equal(await cleanup(pool, 30, 2), 2);
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM results")).rows[0].n,
    count - 2,
  );
  assert.ok(
    (await pool.query("SELECT count(*)::int n FROM incidents")).rows[0].n > 0,
  );
});
test("interrupted fifth delivery attempt exhausts after lease expiration without a sixth send", async () => {
  const d = (await pool.query("SELECT id FROM deliveries LIMIT 1")).rows[0];
  await pool.query(
    "UPDATE deliveries SET status='pending',attempts=5,lease_until=now()-interval '1 second',next_attempt_at=now() WHERE id=$1",
    [d.id],
  );
  assert.equal(await deliverOne(pool, c), false);
  assert.equal(
    (await pool.query("SELECT status FROM deliveries WHERE id=$1", [d.id]))
      .rows[0].status,
    "exhausted",
  );
});
test("database connection interruption rolls back; pool reconnects", async () => {
  const client = await pool.connect();
  const pid = (await client.query("SELECT pg_backend_pid() pid")).rows[0].pid;
  const ended = new Promise((resolve) => client.once("error", resolve));
  await pool.query("SELECT pg_terminate_backend($1)", [pid]);
  await ended;
  client.release(true);
  assert.equal((await pool.query("SELECT 1 AS ok")).rows[0].ok, 1);
});
test("real worker process termination, lease expiry and restart recovery", async () => {
  const id = await target("restart"),
    receiver = http.createServer(() => {});
  await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
  await pool.query(
    "UPDATE targets SET host=$2,timeout_ms=3000,interval_ms=5000 WHERE id=$1",
    [id, `http://127.0.0.1:${receiver.address().port}`],
  );
  const env = {
    ...process.env,
    DATABASE_URL: url,
    PROBE_ALLOWED_HOSTS: "127.0.0.1",
    DEMO_MODE: "true",
    NOTIFICATION_CHANNEL: "sink",
    WORKER_CONCURRENCY: "1",
  };
  let child = spawn(process.execPath, ["src/worker.js"], {
    cwd: new URL("..", import.meta.url),
    env,
    stdio: "ignore",
  });
  async function until(fn) {
    for (let i = 0; i < 100; i++) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("wait timeout");
  }
  try {
    await until(async () =>
      Boolean(
        (await pool.query("SELECT claim_token FROM targets WHERE id=$1", [id]))
          .rows[0].claim_token,
      ),
    );
    await stopChild(child);
    const old = (
      await pool.query("SELECT run_id FROM targets WHERE id=$1", [id])
    ).rows[0].run_id;
    await pool.query(
      "UPDATE targets SET lease_until=now()-interval '1 second' WHERE id=$1",
      [id],
    );
    receiver.closeAllConnections();
    await new Promise((r) => receiver.close(r));
    child = spawn(process.execPath, ["src/worker.js"], {
      cwd: new URL("..", import.meta.url),
      env,
      stdio: "ignore",
    });
    await until(async () =>
      Boolean(
        (await pool.query("SELECT 1 FROM results WHERE run_id=$1", [old]))
          .rowCount,
      ),
    );
    assert.equal(
      (await pool.query("SELECT outcome FROM results WHERE run_id=$1", [old]))
        .rows[0].outcome,
      "failure",
    );
  } finally {
    await stopChild(child);
    receiver.closeAllConnections();
    receiver.close();
    await pool.query("UPDATE targets SET enabled=false WHERE id=$1", [id]);
  }
});
test("two real worker processes execute independent targets with no normal overlap", async () => {
  const active = new Map();
  let overlap = false;
  const receiver = http.createServer((req, res) => {
    const n = (active.get(req.url) || 0) + 1;
    active.set(req.url, n);
    if (n > 1) overlap = true;
    setTimeout(() => {
      active.set(req.url, active.get(req.url) - 1);
      res.end("ok");
    }, 50);
  });
  await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
  const ids = [await target("multi-a"), await target("multi-b")];
  for (const id of ids)
    await pool.query("UPDATE targets SET host=$2,timeout_ms=300 WHERE id=$1", [
      id,
      `http://127.0.0.1:${receiver.address().port}/${id}`,
    ]);
  const env = {
    ...process.env,
    DATABASE_URL: url,
    PROBE_ALLOWED_HOSTS: "127.0.0.1",
    DEMO_MODE: "true",
    NOTIFICATION_CHANNEL: "sink",
    WORKER_CONCURRENCY: "1",
    WORKER_POLL_MS: "25",
  };
  const children = [1, 2].map(() =>
    spawn(process.execPath, ["src/worker.js"], {
      cwd: new URL("..", import.meta.url),
      env,
      stdio: "ignore",
    }),
  );
  try {
    let total = 0;
    for (let i = 0; i < 100; i++) {
      total = (
        await pool.query(
          "SELECT count(*)::int n FROM results WHERE target_id=ANY($1::uuid[])",
          [ids],
        )
      ).rows[0].n;
      if (total >= 4) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(total >= 4);
    assert.equal(overlap, false);
    assert.equal(
      (
        await pool.query(
          "SELECT count(DISTINCT worker_id)::int n FROM results WHERE target_id=ANY($1::uuid[])",
          [ids],
        )
      ).rows[0].n,
      2,
    );
  } finally {
    await Promise.all(children.map(stopChild));
    receiver.closeAllConnections();
    await new Promise((r) => receiver.close(r));
    await pool.query(
      "UPDATE targets SET enabled=false WHERE id=ANY($1::uuid[])",
      [ids],
    );
  }
});

test("database transport outage makes readiness fail, preserves liveness and worker recovers", async () => {
  const original = new URL(url),
    connections = new Set();
  let unavailable = false;
  const proxy = net.createServer((socket) => {
    if (unavailable) {
      socket.destroy();
      return;
    }
    const upstream = net.connect(
      Number(original.port || 5432),
      original.hostname,
    );
    connections.add(socket);
    connections.add(upstream);
    socket.pipe(upstream);
    upstream.pipe(socket);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => {
      connections.delete(socket);
      upstream.destroy();
    });
    upstream.on("close", () => {
      connections.delete(upstream);
      socket.destroy();
    });
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const proxyUrl = new URL(url);
  proxyUrl.port = String(proxy.address().port);
  const receiver = http.createServer((_req, res) => res.end("ok"));
  await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
  const id = await target("database-outage");
  await pool.query("UPDATE targets SET host=$2,timeout_ms=300 WHERE id=$1", [
    id,
    `http://127.0.0.1:${receiver.address().port}`,
  ]);
  const proxyPool = database({ ...c, databaseUrl: proxyUrl.href }),
    web = app(proxyPool, c).listen(0, "127.0.0.1");
  await new Promise((r) => web.once("listening", r));
  const health = `http://127.0.0.1:${web.address().port}/health/`;
  const child = spawn(process.execPath, ["src/worker.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      DATABASE_URL: proxyUrl.href,
      PROBE_ALLOWED_HOSTS: "127.0.0.1",
      DEMO_MODE: "true",
      NOTIFICATION_CHANNEL: "sink",
      WORKER_POLL_MS: "100",
    },
    stdio: "ignore",
  });
  async function until(fn) {
    for (let i = 0; i < 100; i++) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("outage recovery timeout");
  }
  try {
    await until(async () =>
      Boolean(
        (await pool.query("SELECT 1 FROM results WHERE target_id=$1", [id]))
          .rowCount,
      ),
    );
    unavailable = true;
    for (const socket of connections) socket.destroy();
    assert.equal((await fetch(health + "ready")).status, 503);
    assert.equal((await fetch(health + "live")).status, 200);
    await new Promise((r) => setTimeout(r, 1500));
    unavailable = false;
    await until(async () => (await fetch(health + "ready")).status === 200);
    await until(async () =>
      Boolean(
        (
          await pool.query(
            "SELECT 1 FROM workers WHERE db_errors>0 AND heartbeat_at>now()-interval '5 seconds'",
          )
        ).rowCount,
      ),
    );
    await until(
      async () =>
        (
          await pool.query(
            "SELECT count(*)::int n FROM results WHERE target_id=$1",
            [id],
          )
        ).rows[0].n >= 2,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM results WHERE target_id=$1 AND outcome='failure'",
          [id],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await stopChild(child);
    web.closeAllConnections();
    await new Promise((r) => web.close(r));
    await proxyPool.end();
    for (const socket of connections) socket.destroy();
    await new Promise((r) => proxy.close(r));
    receiver.closeAllConnections();
    await new Promise((r) => receiver.close(r));
    await pool.query("UPDATE targets SET enabled=false WHERE id=$1", [id]);
  }
});

test("checked-out connection failure between statements rejects safely and reconnects", async () => {
  await assert.rejects(
    transaction(pool, async (client) => {
      const pid = (await client.query("SELECT pg_backend_pid() pid")).rows[0]
        .pid;
      await pool.query("SELECT pg_terminate_backend($1)", [pid]);
      await new Promise((r) => setTimeout(r, 50));
      await client.query("SELECT 1");
    }),
  );
  assert.equal((await pool.query("SELECT 1 AS ok")).rows[0].ok, 1);
});
