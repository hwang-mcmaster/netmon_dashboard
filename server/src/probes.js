import dns from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";
const denied = new net.BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
])
  denied.addSubnet(ip, prefix, "ipv4");
for (const [ip, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fe80::", 10],
  ["ff00::", 8],
  ["::ffff:0:0", 96],
])
  denied.addSubnet(ip, prefix, "ipv6");
denied.addAddress("fd00:ec2::254", "ipv6");
denied.addAddress("100.100.100.200", "ipv4");
export async function destination(hostname, c) {
  hostname = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!c.allowedHosts.includes(hostname))
    throw Object.assign(new Error("Destination denied"), { code: "POLICY" });
  const addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await dns.lookup(hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some(
      (a) =>
        denied.check(a.address, a.family === 6 ? "ipv6" : "ipv4") &&
        !(c.demo && ["127.0.0.1", "::1"].includes(a.address)),
    )
  )
    throw Object.assign(new Error("Sensitive destination denied"), {
      code: "POLICY",
    });
  return addresses[0];
}
export async function request(
  url,
  c,
  {
    timeout = 2000,
    maxBytes = 65536,
    method = "GET",
    body,
    headers = {},
    signal,
  } = {},
) {
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw Object.assign(new Error("URL denied"), { code: "POLICY" });
  const a = await destination(u.hostname, c);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const req = (u.protocol === "https:" ? https : http).request(
      u,
      {
        method,
        headers,
        agent: false,
        signal,
        lookup: (_host, options, cb) =>
          options.all ? cb(null, [a]) : cb(null, a.address, a.family),
      },
      (res) => {
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            const error = Object.assign(new Error("Response too large"), {
              code: "MAX_BYTES",
            });
            reject(error);
            req.destroy(error);
          }
        });
        res.on("error", reject);
        res.on("end", () => resolve(res.statusCode));
      },
    );
    const timer = setTimeout(
      () =>
        req.destroy(
          Object.assign(new Error("Deadline exceeded"), { code: "TIMEOUT" }),
        ),
      timeout,
    );
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end(body);
  });
}
export async function probe(target, c) {
  const started_at = new Date();
  const start = performance.now();
  const controller = new AbortController();
  let timer;
  const operation = async () => {
    if (target.probe_type === "http") {
      const code = await request(target.host, c, {
        timeout: target.timeout_ms,
        maxBytes: target.max_bytes,
        signal: controller.signal,
      });
      if (code !== target.expected_status)
        throw Object.assign(new Error("Unexpected HTTP status"), {
          code: "HTTP_STATUS",
        });
    } else {
      const a = await destination(target.host, c);
      controller.signal.throwIfAborted();
      await new Promise((resolve, reject) => {
        const socket = net.connect({
          host: a.address,
          family: a.family,
          port: target.port,
          signal: controller.signal,
        });
        const deadline = setTimeout(
          () =>
            socket.destroy(
              Object.assign(new Error("Deadline exceeded"), {
                code: "TIMEOUT",
              }),
            ),
          target.timeout_ms,
        );
        socket.on("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.on("error", reject);
        socket.on("close", () => clearTimeout(deadline));
      });
    }
  };
  try {
    await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = Object.assign(new Error("Deadline exceeded"), {
            code: "TIMEOUT",
          });
          reject(error);
          controller.abort(error);
        }, target.timeout_ms);
      }),
    ]);
    return {
      started_at,
      completed_at: new Date(),
      outcome: "success",
      latency_ms: performance.now() - start,
      error_code: null,
      error_message: null,
    };
  } catch (error) {
    const allowed = [
      "TIMEOUT",
      "POLICY",
      "HTTP_STATUS",
      "MAX_BYTES",
      "ECONNREFUSED",
      "ENOTFOUND",
      "ECONNRESET",
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
    ];
    const error_code = allowed.includes(error.code)
      ? error.code
      : "PROBE_ERROR";
    return {
      started_at,
      completed_at: new Date(),
      outcome: "failure",
      latency_ms: null,
      error_code,
      error_message: error_code,
    };
  } finally {
    clearTimeout(timer);
  }
}
