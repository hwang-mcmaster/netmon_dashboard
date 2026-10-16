import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { probe, destination } from "../src/probes.js";
const c = {
  allowedHosts: ["127.0.0.1", "169.254.169.254", "::ffff:127.0.0.1"],
  demo: true,
};
test("controlled HTTP/TCP success, refusal, timeout, response limit, status and redirect", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/hang") return;
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "http://169.254.169.254/" });
      return res.end();
    }
    if (req.url === "/large") return res.end("x".repeat(1000));
    res.writeHead(req.url === "/fail" ? 503 : 200);
    res.end("ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const t = {
    host: `http://127.0.0.1:${port}`,
    probe_type: "http",
    timeout_ms: 150,
    max_bytes: 100,
    expected_status: 200,
  };
  try {
    assert.equal((await probe(t, c)).outcome, "success");
    assert.equal(
      (await probe({ ...t, host: t.host + "/fail" }, c)).error_code,
      "HTTP_STATUS",
    );
    assert.equal(
      (await probe({ ...t, host: t.host + "/large" }, c)).error_code,
      "MAX_BYTES",
    );
    assert.equal(
      (await probe({ ...t, host: t.host + "/redirect" }, c)).error_code,
      "HTTP_STATUS",
    );
    const start = Date.now();
    assert.equal(
      (await probe({ ...t, host: t.host + "/hang" }, c)).error_code,
      "TIMEOUT",
    );
    assert.ok(Date.now() - start < 1000);
    assert.equal(
      (await probe({ ...t, probe_type: "tcp", host: "127.0.0.1", port }, c))
        .outcome,
      "success",
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  assert.equal(
    (await probe({ ...t, probe_type: "tcp", host: "127.0.0.1", port }, c))
      .error_code,
    "ECONNREFUSED",
  );
});
test("sensitive addresses denied outside explicit loopback demo, including mapped IPv6", async () => {
  await assert.rejects(destination("127.0.0.1", { ...c, demo: false }));
  await assert.rejects(destination("169.254.169.254", c));
  await assert.rejects(destination("::ffff:127.0.0.1", c));
  await assert.rejects(destination("example.com", c));
});
