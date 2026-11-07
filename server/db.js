import pg from "pg";
import { readFile } from "node:fs/promises";

export function database() {
  if (!process.env.DATABASE_URL)
    throw new Error(
      "Set DATABASE_URL to your PostgreSQL connection URL. See README.md.",
    );
  // Railway private networking normally does not need TLS. External providers
  // may require DATABASE_SSL=require. Certificate verification stays enabled.
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.DATABASE_SSL === "require"
        ? { rejectUnauthorized: true }
        : undefined,
    max: 10,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
  });
}
export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('jdiddles-schema-v1'))",
    );
    await client.query(
      await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
