import { randomUUID } from "node:crypto";
import { transition } from "./domain.js";
export async function evaluate(db, target, result) {
  const rules = (
    await db.query("SELECT * FROM rules WHERE target_id=$1 FOR UPDATE", [
      target.id,
    ])
  ).rows;
  for (const rule of rules) {
    let bad = result.outcome === "failure",
      good = !bad;
    if (rule.kind === "latency") {
      const samples = (
        await db.query(
          "SELECT outcome,latency_ms FROM results WHERE target_id=$1 ORDER BY completed_at DESC LIMIT $2",
          [target.id, rule.window_samples],
        )
      ).rows;
      const enough =
        samples.length === rule.window_samples &&
        samples.every((r) => r.outcome === "success");
      const average =
        samples.reduce((s, r) => s + (r.latency_ms ?? 0), 0) / samples.length;
      bad = enough && average > rule.latency_threshold_ms;
      good = enough && !bad;
    }
    const incident = (
      await db.query(
        "SELECT * FROM incidents WHERE rule_id=$1 AND recovered_at IS NULL",
        [rule.id],
      )
    ).rows[0];
    const next = transition(rule, bad, good, Boolean(incident));
    await db.query("UPDATE rules SET failures=$2,successes=$3 WHERE id=$1", [
      rule.id,
      next.failures,
      next.successes,
    ]);
    if (!next.event) continue;
    const id = incident?.id || randomUUID();
    if (next.event === "open")
      await db.query(
        "INSERT INTO incidents(id,rule_id,target_id,opened_at,cause_run_id) VALUES($1,$2,$3,$4,$5)",
        [id, rule.id, target.id, result.completed_at, target.run_id],
      );
    else
      await db.query("UPDATE incidents SET recovered_at=$2 WHERE id=$1", [
        id,
        result.completed_at,
      ]);
    const event = (
      await db.query(
        "INSERT INTO incident_events(incident_id,kind,at,run_id) VALUES($1,$2,$3,$4) RETURNING id",
        [id, next.event, result.completed_at, target.run_id],
      )
    ).rows[0];
    // Recovery is never suppressed; cooldown suppresses repeat opens only. Every transition remains in history.
    if (
      next.event === "open" &&
      rule.last_notified_at &&
      new Date(result.completed_at) - new Date(rule.last_notified_at) <
        rule.cooldown_ms
    )
      continue;
    const payload = {
      version: 1,
      event: next.event,
      incident_id: id,
      target_id: target.id,
      name: target.name,
      rule: rule.kind,
      at: result.completed_at,
    };
    await db.query(
      "INSERT INTO deliveries(id,incident_id,event_id,payload) VALUES($1,$2,$3,$4)",
      [randomUUID(), id, event.id, payload],
    );
    if (next.event === "open")
      await db.query("UPDATE rules SET last_notified_at=$2 WHERE id=$1", [
        rule.id,
        result.completed_at,
      ]);
  }
}
