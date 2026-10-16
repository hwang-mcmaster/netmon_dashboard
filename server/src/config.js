function integer(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${name}`);
  return value;
}
export function config() {
  const c = {
    databaseUrl: process.env.DATABASE_URL,
    poolMax: integer("DB_POOL_MAX", 5, 1, 20),
    host: process.env.HOST || "127.0.0.1",
    port: integer("PORT", 4000, 1, 65535),
    token: process.env.API_TOKEN || "",
    concurrency: integer("WORKER_CONCURRENCY", 4, 1, 32),
    pollMs: integer("WORKER_POLL_MS", 500, 25, 5000),
    allowedHosts: (process.env.PROBE_ALLOWED_HOSTS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    demo: process.env.DEMO_MODE === "true",
    channel: process.env.NOTIFICATION_CHANNEL || "sink",
    webhook: process.env.WEBHOOK_URL || "",
    webhookToken: process.env.WEBHOOK_TOKEN || "",
    retentionDays: integer("RETENTION_DAYS", 30, 1, 3650),
  };
  if (!c.databaseUrl) throw new Error("DATABASE_URL is required");
  if (
    !["127.0.0.1", "::1", "localhost"].includes(c.host) &&
    c.token.length < 24
  )
    throw new Error(
      "Non-loopback binding requires API_TOKEN of at least 24 characters",
    );
  if (!["sink", "webhook"].includes(c.channel))
    throw new Error("Invalid NOTIFICATION_CHANNEL");
  if (c.demo && c.channel !== "sink")
    throw new Error("Demo mode requires the local notification sink");
  if (c.channel === "webhook") {
    let u;
    try {
      u = new URL(c.webhook);
    } catch {
      throw new Error("WEBHOOK_URL is required for webhook delivery");
    }
    if (
      !["http:", "https:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      !c.allowedHosts.includes(u.hostname.replace(/^\[|\]$/g, "").toLowerCase())
    )
      throw new Error(
        "Webhook destination must use HTTP(S), omit embedded credentials, and match PROBE_ALLOWED_HOSTS",
      );
  }
  return c;
}
export function log(component, severity, event, fields = {}) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      severity,
      component,
      event,
      ...fields,
    }),
  );
}
