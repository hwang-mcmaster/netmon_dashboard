import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config, log } from "./config.js";
import { database, transaction } from "./db.js";
import { probe, request } from "./probes.js";
import { evaluate } from "./alerts.js";
import { retryDelay } from "./domain.js";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function claim(pool, workerId, limit) {
  return transaction(pool, async (db) => {
    const rows = (
      await db.query(
        `SELECT * FROM targets WHERE enabled AND deleted_at IS NULL AND next_due<=now()
   AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_due,id FOR UPDATE SKIP LOCKED LIMIT $1`,
        [limit],
      )
    ).rows;
    for (const t of rows) {
      t.run_id ||= randomUUID();
      t.claim_token = randomUUID();
      t.worker_id = workerId;
      t.scheduled_at ||= t.next_due;
      await db.query(
        `UPDATE targets SET run_id=$2,claim_token=$3,scheduled_at=$4,
    lease_until=now()+make_interval(secs => (timeout_ms+15000)::double precision/1000) WHERE id=$1`,
        [t.id, t.run_id, t.claim_token, t.scheduled_at],
      );
    }
    return rows;
  });
}
export async function persist(pool, t, r) {
  return transaction(pool, async (db) => {
    const current = (
      await db.query("SELECT * FROM targets WHERE id=$1 FOR UPDATE", [t.id])
    ).rows[0];
    if (
      !current ||
      current.claim_token !== t.claim_token ||
      !current.enabled ||
      current.deleted_at
    )
      return false;
    const inserted = await db.query(
      `INSERT INTO results(run_id,target_id,scheduled_at,started_at,completed_at,outcome,latency_ms,error_code,error_message,worker_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(run_id) DO NOTHING`,
      [
        t.run_id,
        t.id,
        t.scheduled_at,
        r.started_at,
        r.completed_at,
        r.outcome,
        r.latency_ms,
        r.error_code,
        r.error_message,
        t.worker_id,
      ],
    );
    if (inserted.rowCount) await evaluate(db, t, r);
    await db.query(
      `UPDATE targets SET last_completed_at=$2,outcome=$3,latency_ms=$4,error_code=$5,
   run_id=NULL,claim_token=NULL,lease_until=NULL,scheduled_at=NULL,
   next_due=now()+make_interval(secs => interval_ms::double precision/1000 * (1+random()*0.05)) WHERE id=$1`,
      [t.id, r.completed_at, r.outcome, r.latency_ms, r.error_code],
    );
    return Boolean(inserted.rowCount);
  });
}
export async function deliverOne(pool, c) {
  const item = await transaction(pool, async (db) => {
    await db.query(
      "UPDATE deliveries SET status='exhausted',last_error='DELIVERY_INTERRUPTED' WHERE status='pending' AND attempts>=5 AND lease_until<now()",
    );
    const d = (
      await db.query(`SELECT * FROM deliveries WHERE status='pending' AND next_attempt_at<=now()
   AND attempts<5 AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1`)
    ).rows[0];
    if (!d) return null;
    d.claim_token = randomUUID();
    d.attempts++;
    await db.query(
      "UPDATE deliveries SET attempts=$3,claim_token=$2,lease_until=now()+interval '30 seconds',last_error='DELIVERY_IN_FLIGHT' WHERE id=$1",
      [d.id, d.claim_token, d.attempts],
    );
    await db.query(
      "INSERT INTO delivery_attempts(delivery_id,attempt_number,success,error_code) VALUES($1,$2,false,'DELIVERY_INTERRUPTED_OR_IN_FLIGHT')",
      [d.id, d.attempts],
    );
    return d;
  });
  if (!item) return false;
  let error = null;
  try {
    if (c.channel === "webhook") {
      const code = await request(c.webhook, c, {
        method: "POST",
        timeout: 3000,
        maxBytes: 65536,
        signal: AbortSignal.timeout(3000),
        body: JSON.stringify(item.payload),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": item.id,
          ...(c.webhookToken
            ? { Authorization: `Bearer ${c.webhookToken}` }
            : {}),
        },
      });
      if (code < 200 || code >= 300)
        throw new Error("Receiver rejected request");
    }
  } catch {
    error = "DELIVERY_FAILED";
  }
  await transaction(pool, async (db) => {
    const locked = (
      await db.query("SELECT * FROM deliveries WHERE id=$1 FOR UPDATE", [
        item.id,
      ])
    ).rows[0];
    if (locked.claim_token !== item.claim_token) return;
    const attempt = locked.attempts;
    await db.query(
      "UPDATE delivery_attempts SET success=$3,error_code=$4 WHERE delivery_id=$1 AND attempt_number=$2",
      [item.id, attempt, !error, error],
    );
    await db.query(
      `UPDATE deliveries SET attempts=$2,status=$3,last_error=$4,lease_until=NULL,claim_token=NULL,
   next_attempt_at=now()+make_interval(secs => $5::double precision/1000),delivered_at=$6 WHERE id=$1`,
      [
        item.id,
        attempt,
        error ? (attempt >= 5 ? "exhausted" : "pending") : "sent",
        error,
        retryDelay(attempt),
        error ? null : new Date(),
      ],
    );
  });
  log(
    "delivery",
    error ? "warn" : "info",
    c.channel === "sink" ? "sink_delivery" : "delivery_attempt",
    { delivery_id: item.id, success: !error },
  );
  return true;
}
export async function cleanup(pool, days, batch = 1000) {
  const result = await pool.query(
    `DELETE FROM results WHERE run_id IN (SELECT run_id FROM results
  WHERE completed_at<now()-make_interval(days => $1) ORDER BY completed_at LIMIT $2)`,
    [days, batch],
  );
  return result.rowCount;
}
export async function runWorker(c, { signal, healthFile } = {}) {
  const pool = database(c),
    id = randomUUID();
  let stopping = false,
    active = 0,
    completed = 0,
    failures = 0,
    dbErrors = 0,
    lastCleanup = 0;
  const stop = () => {
    stopping = true;
  };
  signal?.addEventListener("abort", stop, { once: true });
  if (healthFile) await writeFile(healthFile, id, "utf8");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  log("worker", "info", "started", {
    worker_id: id,
    concurrency: c.concurrency,
  });
  try {
    while (!stopping) {
      try {
        await pool.query(
          `INSERT INTO workers(id,active,completed,failures,db_errors) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(id) DO UPDATE SET heartbeat_at=now(),active=$2,completed=$3,failures=$4,db_errors=$5`,
          [id, active, completed, failures, dbErrors],
        );
        const work = await claim(pool, id, c.concurrency);
        active = work.length;
        await pool.query("UPDATE workers SET active=$2 WHERE id=$1", [
          id,
          active,
        ]);
        const settled = await Promise.allSettled(
          work.map(async (t) => {
            const r = await probe(t, c);
            try {
              if (await persist(pool, t, r)) {
                completed++;
                if (r.outcome === "failure") failures++;
              }
            } finally {
              active--;
            }
          }),
        );
        if (settled.some((r) => r.status === "rejected"))
          throw new Error("Persistence failed");
        if (!stopping) await deliverOne(pool, c);
        if (Date.now() - lastCleanup > 60000) {
          await cleanup(pool, c.retentionDays);
          lastCleanup = Date.now();
        }
      } catch {
        dbErrors++;
        log("worker", "error", "iteration_failed", { worker_id: id });
      }
      if (!stopping)
        await new Promise((resolve) => setTimeout(resolve, c.pollMs ?? 500));
    }
  } finally {
    await pool
      .query(
        "UPDATE workers SET active=0,heartbeat_at=now()-interval '1 day' WHERE id=$1",
        [id],
      )
      .catch(() => {});
    await pool.end();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    signal?.removeEventListener("abort", stop);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  await runWorker(config(), {
    healthFile: path.join(tmpdir(), "netmon-worker-id"),
  });
