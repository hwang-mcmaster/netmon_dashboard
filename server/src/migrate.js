import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { database, transaction } from "./db.js";
export async function migrate(pool) {
  await transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(731902)");
    await db.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const dir = new URL("../migrations/", import.meta.url);
    for (const file of (await readdir(dir))
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      if (
        (
          await db.query("SELECT 1 FROM schema_migrations WHERE version=$1", [
            file,
          ])
        ).rowCount
      )
        continue;
      await db.query(await readFile(new URL(file, dir), "utf8"));
      await db.query("INSERT INTO schema_migrations(version) VALUES($1)", [
        file,
      ]);
    }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = database(config());
  try {
    await migrate(pool);
    console.log("Migrations applied");
  } finally {
    await pool.end();
  }
}
