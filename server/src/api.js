import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { transaction } from "./db.js";
import { InputError, pagination, status, validateTarget } from "./domain.js";
import { log } from "./config.js";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
export async function createTarget(db, input, c) {
  const t = validateTarget(input, c),
    id = randomUUID();
  await db.query(
    `INSERT INTO targets(id,name,host,probe_type,enabled,interval_ms,timeout_ms,expected_status,max_bytes,port,tags)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id,
      t.name,
      t.host,
      t.probe_type,
      t.enabled,
      t.interval_ms,
      t.timeout_ms,
      t.expected_status,
      t.max_bytes,
      t.port,
      t.tags,
    ],
  );
  await db.query("INSERT INTO rules(id,target_id,kind) VALUES($1,$2,'down')", [
    randomUUID(),
    id,
  ]);
  return id;
}
export function app(pool, c) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (!c.token && !["localhost", "127.0.0.1", "[::1]"].includes(req.hostname))
      return res.status(403).json({ error: "Local hostname required" });
    req.correlationId = randomUUID();
    res.set("X-Request-Id", req.correlationId);
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    res.set(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
    );
    next();
  });
  app.use(express.json({ limit: "16kb" }));
  app.get("/health/live", (_req, res) => res.json({ status: "alive" }));
  app.get(
    "/health/ready",
    wrap(async (_req, res) => {
      await pool.query("SELECT 1");
      res.json({ status: "ready" });
    }),
  );
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (c.token) {
      const supplied = Buffer.from(
        (req.get("Authorization") || "").replace(/^Bearer /, ""),
      );
      const expected = Buffer.from(c.token);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        return res.status(401).json({ error: "Authentication required" });
    }
    // No cookies, no cross-origin CORS grants; browser mutation requests require JSON.
    if (
      ["POST", "PUT", "PATCH"].includes(req.method) &&
      !req.is("application/json")
    )
      return res.status(415).json({ error: "application/json required" });
    next();
  });
  app.param("id", (req, res, next, id) =>
    uuid.test(id)
      ? next()
      : res.status(400).json({ error: "Invalid identifier" }),
  );
  const statusSql = `CASE WHEN NOT t.enabled THEN 'disabled' WHEN t.last_completed_at IS NULL THEN 'unknown'
  WHEN t.last_completed_at < now()-make_interval(secs => greatest(t.interval_ms*3,t.timeout_ms+5000)::double precision/1000) THEN 'stale'
  WHEN t.outcome='success' THEN 'healthy' ELSE 'failing' END`;
  app.get(
    "/api/summary",
    wrap(async (_req, res) => {
      const rows = (
        await pool.query(
          `SELECT ${statusSql} AS state,count(*)::int AS count FROM targets t WHERE deleted_at IS NULL GROUP BY state`,
        )
      ).rows;
      res.json(
        Object.assign(
          { healthy: 0, failing: 0, unknown: 0, disabled: 0, stale: 0 },
          Object.fromEntries(rows.map((r) => [r.state, r.count])),
        ),
      );
    }),
  );
  app.get(
    "/api/targets",
    wrap(async (req, res) => {
      const p = pagination(req.query),
        q = req.query.q || "",
        tag = req.query.tag || "",
        state = req.query.state || "";
      if (
        typeof q !== "string" ||
        q.length > 100 ||
        typeof tag !== "string" ||
        tag.length > 30 ||
        !["", "healthy", "failing", "unknown", "disabled", "stale"].includes(
          state,
        )
      )
        throw new InputError("Invalid filter");
      const where = `t.deleted_at IS NULL AND (t.name ILIKE '%'||$1||'%' OR t.host ILIKE '%'||$1||'%') AND ($2='' OR $2=ANY(t.tags)) AND ($3='' OR ${statusSql}=$3)`;
      const data = await pool.query(
        `SELECT t.*,${statusSql} AS state,(SELECT count(*)::int FROM incidents i WHERE i.target_id=t.id AND recovered_at IS NULL) AS active_incidents FROM targets t WHERE ${where} ORDER BY t.name,t.id LIMIT $4 OFFSET $5`,
        [q, tag, state, p.size, p.offset],
      );
      const total = (
        await pool.query(
          `SELECT count(*)::int AS count FROM targets t WHERE ${where}`,
          [q, tag, state],
        )
      ).rows[0].count;
      res.json({
        items: data.rows.map(publicTarget),
        total,
        page: p.page,
        size: p.size,
      });
    }),
  );
  app.post(
    "/api/targets",
    wrap(async (req, res) => {
      const id = await transaction(pool, (db) => createTarget(db, req.body, c));
      res.status(201).json({ id });
    }),
  );
  app.get(
    "/api/targets/:id",
    wrap(async (req, res) => {
      const hours = Number(req.query.hours ?? 24),
        p = pagination(req.query);
      if (!Number.isInteger(hours) || hours < 1 || hours > 168)
        throw new InputError("hours must be 1–168");
      const target = (
        await pool.query(
          "SELECT * FROM targets WHERE id=$1 AND deleted_at IS NULL",
          [req.params.id],
        )
      ).rows[0];
      if (!target) return res.status(404).json({ error: "Target not found" });
      const results = (
        await pool.query(
          `SELECT * FROM results WHERE target_id=$1 AND completed_at>=now()-make_interval(hours => $2) ORDER BY completed_at DESC LIMIT $3 OFFSET $4`,
          [target.id, hours, p.size, p.offset],
        )
      ).rows;
      const incidents = (
        await pool.query(
          "SELECT * FROM incidents WHERE target_id=$1 ORDER BY opened_at DESC LIMIT 50",
          [target.id],
        )
      ).rows;
      const rules = (
        await pool.query(
          "SELECT * FROM rules WHERE target_id=$1 ORDER BY kind",
          [target.id],
        )
      ).rows;
      res.json({
        target: { ...publicTarget(target), state: status(target) },
        results,
        incidents,
        rules,
        page: p.page,
        size: p.size,
        hours,
      });
    }),
  );
  app.put(
    "/api/targets/:id",
    wrap(async (req, res) => {
      const t = validateTarget(req.body, c);
      const result = await transaction(pool, async (db) => {
        const updated = await db.query(
          `UPDATE targets SET name=$2,host=$3,probe_type=$4,enabled=$5,interval_ms=$6,timeout_ms=$7,expected_status=$8,max_bytes=$9,port=$10,tags=$11,
   updated_at=now(),next_due=now(),run_id=NULL,claim_token=NULL,lease_until=NULL,scheduled_at=NULL,last_completed_at=NULL,outcome=NULL,latency_ms=NULL,error_code=NULL
   WHERE id=$1 AND deleted_at IS NULL`,
          [
            req.params.id,
            t.name,
            t.host,
            t.probe_type,
            t.enabled,
            t.interval_ms,
            t.timeout_ms,
            t.expected_status,
            t.max_bytes,
            t.port,
            t.tags,
          ],
        );
        if (updated.rowCount)
          await db.query(
            "UPDATE rules SET failures=0,successes=0 WHERE target_id=$1",
            [req.params.id],
          );
        return updated;
      });
      res
        .status(result.rowCount ? 200 : 404)
        .json(
          result.rowCount ? { updated: true } : { error: "Target not found" },
        );
    }),
  );
  app.delete(
    "/api/targets/:id",
    wrap(async (req, res) => {
      const r = await pool.query(
        "UPDATE targets SET enabled=false,deleted_at=now(),claim_token=NULL,lease_until=NULL WHERE id=$1 AND deleted_at IS NULL",
        [req.params.id],
      );
      res
        .status(r.rowCount ? 200 : 404)
        .json(r.rowCount ? { deleted: true } : { error: "Target not found" });
    }),
  );
  app.put(
    "/api/targets/:id/rules",
    wrap(async (req, res) => {
      const {
        kind = "down",
        failure_threshold = 3,
        recovery_threshold = 2,
        latency_threshold_ms = 500,
        window_samples = 5,
        cooldown_ms = 60000,
      } = req.body;
      if (
        !["down", "latency"].includes(kind) ||
        ![failure_threshold, recovery_threshold, window_samples].every(
          (n) => Number.isInteger(n) && n >= 1 && n <= 100,
        ) ||
        !Number.isInteger(latency_threshold_ms) ||
        latency_threshold_ms < 1 ||
        latency_threshold_ms > 3600000 ||
        !Number.isInteger(cooldown_ms) ||
        cooldown_ms < 0 ||
        cooldown_ms > 86400000
      )
        throw new InputError("Invalid alert rule");
      await transaction(pool, async (db) => {
        if (
          !(
            await db.query(
              "SELECT 1 FROM targets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
              [req.params.id],
            )
          ).rowCount
        )
          throw new InputError("Target not found");
        await db.query(
          `INSERT INTO rules(id,target_id,kind,failure_threshold,recovery_threshold,latency_threshold_ms,window_samples,cooldown_ms)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(target_id,kind) DO UPDATE SET failure_threshold=$4,recovery_threshold=$5,latency_threshold_ms=$6,window_samples=$7,cooldown_ms=$8,failures=0,successes=0`,
          [
            randomUUID(),
            req.params.id,
            kind,
            failure_threshold,
            recovery_threshold,
            latency_threshold_ms,
            window_samples,
            cooldown_ms,
          ],
        );
      });
      res.json({ updated: true });
    }),
  );
  app.get(
    "/api/incidents",
    wrap(async (req, res) => {
      const p = pagination(req.query);
      res.json({
        items: (
          await pool.query(
            `SELECT i.*,t.name,r.kind FROM incidents i JOIN targets t ON t.id=i.target_id JOIN rules r ON r.id=i.rule_id WHERE i.recovered_at IS NULL ORDER BY i.opened_at DESC LIMIT $1 OFFSET $2`,
            [p.size, p.offset],
          )
        ).rows,
      });
    }),
  );
  app.post(
    "/api/incidents/:id/acknowledge",
    wrap(async (req, res) => {
      await transaction(pool, async (db) => {
        const r = await db.query(
          "UPDATE incidents SET acknowledged_at=now() WHERE id=$1 AND acknowledged_at IS NULL RETURNING id",
          [req.params.id],
        );
        if (r.rowCount)
          await db.query(
            "INSERT INTO incident_events(incident_id,kind) VALUES($1,'acknowledge')",
            [req.params.id],
          );
      });
      res.json({ acknowledged: true });
    }),
  );
  app.get(
    "/api/operations",
    wrap(async (_req, res) => {
      const workers = (
        await pool.query(
          "SELECT *,heartbeat_at>now()-interval '45 seconds' AS fresh FROM workers ORDER BY heartbeat_at DESC LIMIT 20",
        )
      ).rows;
      const deliveries = (
        await pool.query(
          "SELECT id,incident_id,status,attempts,last_error,next_attempt_at FROM deliveries WHERE status<>'sent' ORDER BY next_attempt_at LIMIT 100",
        )
      ).rows;
      const metrics = (
        await pool.query(`SELECT (SELECT count(*)::int FROM targets WHERE lease_until>now()) AS active_work,
   (SELECT count(*)::int FROM results WHERE completed_at>now()-interval '1 minute') AS probes_last_minute,
   (SELECT count(*)::int FROM results WHERE completed_at>now()-interval '1 minute' AND outcome='failure') AS failures_last_minute,
   (SELECT greatest(0,extract(epoch FROM now()-min(next_due))*1000) FROM targets WHERE enabled AND deleted_at IS NULL) AS oldest_schedule_lag_ms,
   (SELECT count(*)::int FROM deliveries WHERE status='pending') AS delivery_backlog`)
      ).rows[0];
      res.json({
        worker_available: workers.some((w) => w.fresh),
        workers,
        deliveries,
        metrics,
        pool: {
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
        },
      });
    }),
  );
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Route not found" }),
  );
  const dist = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../client/dist",
  );
  app.use(express.static(dist));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(dist, "index.html")),
  );
  app.use((error, req, res, _next) => {
    const bad =
      error instanceof InputError ||
      error.type === "entity.parse.failed" ||
      error.type === "entity.too.large";
    log("api", bad ? "warn" : "error", "request_failed", {
      correlation_id: req.correlationId,
    });
    res.status(bad ? 400 : 503).json({
      error: bad
        ? error instanceof InputError
          ? error.message
          : "Invalid JSON body"
        : "Service unavailable",
      request_id: req.correlationId,
    });
  });
  return app;
}
function publicTarget(t) {
  const {
    run_id: _run,
    claim_token: _token,
    lease_until: _lease,
    scheduled_at: _scheduled,
    ...publicFields
  } = t;
  return publicFields;
}
