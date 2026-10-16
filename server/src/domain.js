import net from "node:net";
export class InputError extends Error {}
export function validateTarget(input = {}, c) {
  const {
    name,
    host,
    probe_type = "http",
    enabled = true,
    tags = [],
    interval_ms = 10000,
    timeout_ms = 2000,
    expected_status = 200,
    max_bytes = 65536,
    port = null,
  } = input;
  const invalid = () => {
    throw new InputError(
      "Invalid target: check name, destination, probe type, tags, interval, timeout and response settings",
    );
  };
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 100 ||
    typeof host !== "string" ||
    host.length > 2048 ||
    typeof enabled !== "boolean"
  )
    invalid();
  if (
    !["http", "tcp"].includes(probe_type) ||
    !Array.isArray(tags) ||
    tags.length > 10 ||
    tags.some((t) => typeof t !== "string" || !/^[\w-]{1,30}$/.test(t))
  )
    invalid();
  if (
    !Number.isInteger(interval_ms) ||
    interval_ms < 1000 ||
    interval_ms > 86400000 ||
    !Number.isInteger(timeout_ms) ||
    timeout_ms < 100 ||
    timeout_ms > 30000 ||
    timeout_ms >= interval_ms
  )
    invalid();
  if (
    !Number.isInteger(expected_status) ||
    expected_status < 100 ||
    expected_status > 599 ||
    !Number.isInteger(max_bytes) ||
    max_bytes < 1 ||
    max_bytes > 1048576
  )
    invalid();
  let hostname = host;
  if (probe_type === "http") {
    let u;
    try {
      u = new URL(host);
    } catch {
      invalid();
    }
    if (
      !["http:", "https:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.hash ||
      u.search
    )
      invalid();
    hostname = u.hostname.replace(/^\[|\]$/g, "");
  } else if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    (!net.isIP(host) && !/^[a-zA-Z0-9.-]+$/.test(host))
  )
    invalid();
  if (!c.allowedHosts.includes(hostname.toLowerCase()))
    throw new InputError("Destination hostname is not in PROBE_ALLOWED_HOSTS");
  return {
    name: name.trim(),
    host,
    probe_type,
    enabled,
    interval_ms,
    timeout_ms,
    expected_status,
    max_bytes,
    port: probe_type === "tcp" ? port : null,
    tags: [...new Set(tags)],
  };
}
export function status(target, now = Date.now()) {
  if (!target.enabled || target.deleted_at) return "disabled";
  if (!target.last_completed_at) return "unknown";
  if (
    now - new Date(target.last_completed_at).getTime() >
    Math.max(target.interval_ms * 3, target.timeout_ms + 5000)
  )
    return "stale";
  return target.outcome === "success" ? "healthy" : "failing";
}
export function transition(rule, bad, good, open) {
  const failures = bad ? rule.failures + 1 : 0;
  const successes = good ? rule.successes + 1 : 0;
  return {
    failures,
    successes,
    event:
      !open && failures >= rule.failure_threshold
        ? "open"
        : open && successes >= rule.recovery_threshold
          ? "recovery"
          : null,
  };
}
export function retryDelay(attempt) {
  return Math.min(300000, 1000 * 2 ** (attempt - 1));
}
export function pagination(query) {
  const page = Number(query.page ?? 1),
    size = Number(query.size ?? 25);
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    page > 10000 ||
    !Number.isInteger(size) ||
    size < 1 ||
    size > 100
  )
    throw new InputError("page must be 1–10000 and size 1–100");
  return { page, size, offset: (page - 1) * size };
}
