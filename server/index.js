import { createApp } from "./app.js";
import { database, migrate } from "./db.js";
if (process.env.NODE_ENV === "production" && !process.env.PUBLIC_ORIGIN) {
  throw new Error(
    "Set PUBLIC_ORIGIN to your Railway HTTPS origin before starting in production.",
  );
}
const pool = database();
pool.on("error", () => console.error("Database pool connection error."));
await migrate(pool);
const port = Number(process.env.PORT || 3000);
const server = createApp(pool).listen(port, "0.0.0.0", () =>
  console.log(`J Diddles is listening on port ${port}.`),
);
server.requestTimeout = 15000;
server.headersTimeout = 10000;
async function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
