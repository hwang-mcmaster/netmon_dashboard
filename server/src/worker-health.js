import { config } from "./config.js";
import { database } from "./db.js";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const pool = database(config());
try {
  const id = await readFile(path.join(tmpdir(), "netmon-worker-id"), "utf8");
  const r = await pool.query(
    "SELECT 1 FROM workers WHERE id=$1 AND heartbeat_at>now()-interval '45 seconds'",
    [id],
  );
  process.exitCode = r.rowCount ? 0 : 1;
} catch {
  process.exitCode = 1;
} finally {
  await pool.end();
}
