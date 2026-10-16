import { spawn } from "node:child_process";
import { database } from "../server/src/db.js";
import { migrate } from "../server/src/migrate.js";
const url = process.env.E2E_DATABASE_URL;
if (!url || !/^netmon_test_e2e$/.test(new URL(url).pathname.slice(1)))
  throw new Error("E2E_DATABASE_URL must name isolated netmon_test_e2e");
const pool = database({ databaseUrl: url, poolMax: 2 });
await migrate(pool);
await pool.end();
const env = {
  ...process.env,
  DATABASE_URL: url,
  HOST: "127.0.0.1",
  PORT: "4000",
  API_TOKEN: "",
  PROBE_ALLOWED_HOSTS: "127.0.0.1",
  DEMO_MODE: "true",
  NOTIFICATION_CHANNEL: "sink",
  WORKER_CONCURRENCY: "4",
};
const children = [];
const seed = spawn(process.execPath, ["server/src/seed.js"], {
  env,
  stdio: "inherit",
});
await new Promise((resolve, reject) =>
  seed.once("exit", (code) =>
    code === 0 ? resolve() : reject(new Error("seed failed")),
  ),
);
for (const file of [
  "server/src/demo.js",
  "server/src/worker.js",
  "server/src/index.js",
])
  children.push(spawn(process.execPath, [file], { env, stdio: "inherit" }));
function stop() {
  for (const child of children) child.kill();
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
process.once("exit", stop);
for (const child of children)
  child.once("exit", () => {
    stop();
    process.exitCode = 1;
  });
