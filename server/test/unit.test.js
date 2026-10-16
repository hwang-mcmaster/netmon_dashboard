import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import {
  validateTarget,
  status,
  transition,
  retryDelay,
  pagination,
} from "../src/domain.js";
const c = { allowedHosts: ["example.test", "127.0.0.1"] };
test("target validation bounds durations, tags, protocol, destination and response limits", () => {
  const valid = { name: "local", host: "http://example.test/health" };
  assert.equal(validateTarget(valid, c).timeout_ms, 2000);
  for (const patch of [
    { host: "file:///etc/passwd" },
    { host: "http://evil.test" },
    { host: "http://user:secret@example.test/" },
    { host: "http://example.test/?token=secret" },
    { interval_ms: 1000, timeout_ms: 2000 },
    { timeout_ms: 0 },
    { max_bytes: 2000000 },
    { tags: ["bad tag"] },
    { probe_type: "icmp" },
    { probe_type: "tcp", host: "example.test", port: 0 },
    { enabled: "yes" },
  ])
    assert.throws(() => validateTarget({ ...valid, ...patch }, c));
  assert.equal(
    validateTarget(
      { name: "tcp", host: "example.test", probe_type: "tcp", port: 443 },
      c,
    ).port,
    443,
  );
});
test("unknown, stale, disabled and failed states are distinct", () => {
  const t = { enabled: true, interval_ms: 1000, timeout_ms: 100 };
  assert.equal(status(t, 10000), "unknown");
  assert.equal(status({ ...t, enabled: false }), "disabled");
  assert.equal(
    status(
      { ...t, last_completed_at: new Date(9000), outcome: "success" },
      10000,
    ),
    "healthy",
  );
  assert.equal(
    status(
      { ...t, last_completed_at: new Date(9000), outcome: "failure" },
      10000,
    ),
    "failing",
  );
  assert.equal(
    status({ ...t, last_completed_at: new Date(0), outcome: "success" }, 10000),
    "stale",
  );
});
test("thresholds, flapping reset, unknown sample and recovery", () => {
  const rule = {
    failures: 1,
    successes: 0,
    failure_threshold: 3,
    recovery_threshold: 2,
  };
  assert.equal(transition(rule, true, false, false).event, null);
  assert.equal(
    transition({ ...rule, failures: 2 }, true, false, false).event,
    "open",
  );
  assert.equal(transition(rule, false, false, false).failures, 0);
  assert.equal(
    transition({ ...rule, successes: 1 }, false, true, true).event,
    "recovery",
  );
  assert.equal(
    transition({ ...rule, successes: 1 }, false, false, true).event,
    null,
  );
  assert.equal(
    transition({ ...rule, failures: 9 }, true, false, true).event,
    null,
  );
});
test("backoff bounded and pagination rejects oversized requests", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map(retryDelay),
    [1000, 2000, 4000, 8000, 16000],
  );
  assert.equal(retryDelay(30), 300000);
  assert.equal(pagination({ page: "2", size: "10" }).offset, 10);
  for (const q of [
    { page: 0 },
    { size: 101 },
    { size: "bad" },
    { page: 10001 },
  ])
    assert.throws(() => pagination(q));
});
test("runtime configuration refuses unsafe bindings, invalid bounds and demo webhooks", () => {
  const previous = { ...process.env };
  try {
    process.env.DATABASE_URL = "postgresql://local/test";
    process.env.HOST = "127.0.0.1";
    process.env.API_TOKEN = "";
    process.env.DEMO_MODE = "false";
    process.env.NOTIFICATION_CHANNEL = "sink";
    assert.equal(config().channel, "sink");
    process.env.HOST = "0.0.0.0";
    assert.throws(config, /API_TOKEN/);
    process.env.API_TOKEN = "test-token-with-at-least-24-characters";
    assert.equal(config().host, "0.0.0.0");
    process.env.WORKER_CONCURRENCY = "100";
    assert.throws(config, /WORKER_CONCURRENCY/);
    delete process.env.WORKER_CONCURRENCY;
    process.env.DEMO_MODE = "true";
    process.env.NOTIFICATION_CHANNEL = "webhook";
    assert.throws(config, /sink/);
    process.env.DEMO_MODE = "false";
    delete process.env.WEBHOOK_URL;
    assert.throws(config, /WEBHOOK_URL/);
  } finally {
    for (const k of Object.keys(process.env))
      if (!(k in previous)) delete process.env[k];
    Object.assign(process.env, previous);
  }
});
