import { config, log } from "./config.js";
import { database } from "./db.js";
import { app } from "./api.js";
const c = config(),
  pool = database(c);
const server = app(pool, c).listen(c.port, c.host, () =>
  log("web", "info", "listening", { port: c.port }),
);
server.requestTimeout = 10000;
server.headersTimeout = 10000;
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    const timeout = setTimeout(() => process.exit(1), 10000).unref();
    server.close(async () => {
      await pool.end();
      clearTimeout(timeout);
    });
  });
