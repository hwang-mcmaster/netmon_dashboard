import pg from "pg";
import { log } from "./config.js";
export function database(c) {
  const pool = new pg.Pool({
    connectionString: c.databaseUrl,
    max: c.poolMax,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10000,
    statement_timeout: 5000,
    application_name: "netmon",
  });
  pool.on("error", () => log("database", "error", "idle_connection_error"));
  return pool;
}
export async function transaction(pool, fn) {
  const client = await pool.connect();
  // A checked-out client can fail between awaited statements, when no query
  // promise is present to receive the connection error.
  let broken = false;
  const onError = () => {
    broken = true;
  };
  client.on("error", onError);
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.removeListener("error", onError);
    client.release(broken);
  }
}
