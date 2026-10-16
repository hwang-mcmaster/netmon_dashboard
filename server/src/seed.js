import { readFile } from "node:fs/promises";
import { config } from "./config.js";
import { database, transaction } from "./db.js";
import { createTarget } from "./api.js";
const c = config(),
  pool = database(c);
try {
  if (process.argv.includes("--legacy")) {
    const legacy = JSON.parse(
      await readFile(new URL("../devices.json", import.meta.url), "utf8"),
    );
    console.log(
      "Legacy ICMP entries preserved. Import as DISABLED TCP port 443; review protocol/port and allowlist before enabling.",
    );
    await transaction(pool, async (db) => {
      for (const d of legacy) {
        if (
          (
            await db.query("SELECT 1 FROM targets WHERE name=$1 AND host=$2", [
              d.name,
              d.host,
            ])
          ).rowCount
        )
          continue;
        await createTarget(
          db,
          {
            name: d.name,
            host: d.host,
            probe_type: "tcp",
            port: 443,
            enabled: false,
            tags: ["legacy"],
          },
          { ...c, allowedHosts: [d.host] },
        );
      }
    });
  } else {
    if (!c.demo || c.channel !== "sink")
      throw new Error("Seed requires DEMO_MODE=true and sink notifications");
    await transaction(pool, async (db) => {
      const demoHost = process.env.DEMO_TARGET_HOST || "127.0.0.1";
      for (const [name, host] of [
        ["Demo · storefront", `http://${demoHost}:8099/health`],
        ["Demo · recovery drill", `http://${demoHost}:8099/toggle`],
      ]) {
        if (
          (
            await db.query("SELECT 1 FROM targets WHERE name=$1 AND host=$2", [
              name,
              host,
            ])
          ).rowCount
        )
          continue;
        await createTarget(
          db,
          { name, host, tags: ["demo"], interval_ms: 2000, timeout_ms: 500 },
          c,
        );
      }
    });
  }
  console.log(
    "Seed completed (configuration only; worker generates real local results).",
  );
} finally {
  await pool.end();
}
