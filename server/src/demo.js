import http from "node:http";
let failing = false;
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/control/fail") failing = true;
  if (req.method === "POST" && req.url === "/control/recover") failing = false;
  res.writeHead(req.url === "/toggle" && failing ? 503 : 200, {
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify({ synthetic: true, failing }));
});
server.listen(8099, process.env.DEMO_HOST || "127.0.0.1", () =>
  console.log(
    "Synthetic demo receiver on port 8099; never expose this control server publicly.",
  ),
);
for (const s of ["SIGINT", "SIGTERM"]) process.once(s, () => server.close());
