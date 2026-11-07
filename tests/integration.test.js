import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { createApp } from "../server/app.js";
import { migrate } from "../server/db.js";

// A dedicated temporary schema is created and removed; no existing user tables
// are touched. Never point tests at a production database.
const connectionString = process.env.TEST_DATABASE_URL;
const schema = `test_${randomUUID().replaceAll("-", "")}`;
let admin, pool, server, base;
const origin = "http://localhost:3000";
const accounts = [];
async function request(client, path, method = "GET", body, overrides = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(client?.cookie ? { Cookie: client.cookie } : {}),
      ...(method !== "GET"
        ? {
            Origin: origin,
            "Content-Type": "application/json",
            "X-CSRF-Token": client?.csrf ?? "",
          }
        : {}),
      ...overrides,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const setCookie = response.headers.get("set-cookie");
  if (client && setCookie) client.cookie = setCookie.split(";")[0];
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (client && data.csrfToken) client.csrf = data.csrfToken;
  return { status: response.status, data, headers: response.headers };
}
const day = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
const booking = (overrides = {}) => ({
  experienceId: "surf-and-soothe",
  date: day,
  time: "12:00",
  guests: 1,
  parodyAcknowledged: true,
  ...overrides,
});
const password = "some unique test password 2026!";
async function register(email, name = "Test diner") {
  const client = {};
  assert.equal((await request(client, "/api/session")).status, 200);
  const old = client.cookie;
  const response = await request(client, "/api/register", "POST", {
    name,
    email,
    password,
    parodyAcknowledged: true,
  });
  assert.equal(response.status, 201);
  assert.notEqual(client.cookie, old, "registration rotates the session");
  client.user = response.data.user;
  return client;
}

before(async () => {
  if (!connectionString)
    throw new Error(
      "Set TEST_DATABASE_URL to a dedicated PostgreSQL test database.",
    );
  admin = new pg.Pool({ connectionString });
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({
    connectionString,
    options: `-c search_path=${schema}`,
    max: 10,
  });
  await migrate(pool);
  const app = createApp(pool, { origin, production: false });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (admin) {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

test("public pages, original assets, and links all resolve; API never caches personal data", async () => {
  const files = await readdir(new URL("../public/", import.meta.url));
  for (const file of files.filter((file) => file.endsWith(".html"))) {
    const response = await request(null, `/${file}`);
    assert.equal(response.status, 200, file);
    assert.match(
      response.headers.get("content-security-policy"),
      /script-src 'self'/,
    );
    const html = await readFile(
      new URL(`../public/${file}`, import.meta.url),
      "utf8",
    );
    assert.match(html, /fictional|parody|pretend/);
    for (const match of html.matchAll(
      /(?:href|src)="(\/[^"?#]*)(?:[^"#]*)?"/g,
    )) {
      const result = await request(null, match[1]);
      assert.equal(result.status, 200, `${file} references ${match[1]}`);
    }
  }
  const response = await request(null, "/api/session?passive=1");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(
    response.headers.get("set-cookie"),
    null,
    "browsing does not create a cookie",
  );
  assert.equal((await request(null, "/not-a-page")).status, 404);
  assert.equal((await request(null, "/server/schema.sql")).status, 404);
  assert.equal((await request(null, "/.env")).status, 404);
});

test("registration, secure password storage, rotation, and case-insensitive email login", async () => {
  accounts.push(
    await register("Alpha@Example.com", "<script>alert(1)</script>"),
  );
  accounts.push(await register("beta@example.com"));
  accounts.push(await register("gamma@example.com"));
  const client = accounts[0];
  assert.equal(client.user.email, "alpha@example.com");
  assert.match(client.cookie, /^jd_session=[a-f0-9]{64}$/);
  const { rows } = await pool.query(
    "SELECT password_hash FROM users WHERE id = $1",
    [client.user.id],
  );
  assert.match(rows[0].password_hash, /^scrypt:/);
  assert.ok(!rows[0].password_hash.includes(password));
  assert.equal(
    (await request(client, "/api/session")).data.user.name,
    "<script>alert(1)</script>",
  );
  const fresh = {};
  await request(fresh, "/api/session");
  const response = await request(fresh, "/api/login", "POST", {
    email: "ALPHA@EXAMPLE.COM",
    password,
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.user.id, client.user.id);
});

test("auth endpoints reject weak credentials, missing acknowledgements, and unknown logins", async () => {
  const client = {};
  await request(client, "/api/session");
  assert.equal(
    (
      await request(client, "/api/register", "POST", {
        name: "A",
        email: "weak@example.com",
        password: "short",
        parodyAcknowledged: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(client, "/api/register", "POST", {
        name: "A",
        email: "noack@example.com",
        password,
        parodyAcknowledged: false,
      })
    ).status,
    400,
  );
  const wrong = await request(client, "/api/login", "POST", {
    email: "alpha@example.com",
    password: "wrong",
  });
  const unknown = await request(client, "/api/login", "POST", {
    email: "unknown@example.com",
    password: "wrong",
  });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.data, unknown.data);
});

test("cross-origin and missing CSRF requests are rejected, unauthenticated data is private", async () => {
  const client = accounts[0];
  assert.equal((await request(null, "/api/reservations")).status, 401);
  assert.equal(
    (
      await request(client, "/api/reservations", "POST", booking(), {
        Origin: "https://evil.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(client, "/api/reservations", "POST", booking(), {
        "X-CSRF-Token": "",
      })
    ).status,
    403,
  );
  assert.equal(
    (await request(client, "/api/reservations", "POST", null)).status,
    400,
  );
});

test("dates, slots, guest counts, experience IDs and parody consent are server-validated", async () => {
  for (const overrides of [
    { date: "2020-01-01" },
    { date: "2099-02-30" },
    { time: "09:00" },
    { guests: 5 },
    { guests: 1.5 },
    { experienceId: "made-up" },
    { parodyAcknowledged: false },
  ]) {
    const response = await request(
      accounts[0],
      "/api/reservations",
      "POST",
      booking(overrides),
    );
    assert.equal(response.status, 400, JSON.stringify(overrides));
  }
  assert.equal(
    (await request(null, "/api/availability?date=garbage")).status,
    400,
  );
});

test("concurrent bookings cannot exceed shared slot capacity, including different experiences", async () => {
  const results = await Promise.all([
    request(accounts[0], "/api/reservations", "POST", booking({ guests: 4 })),
    request(
      accounts[1],
      "/api/reservations",
      "POST",
      booking({ guests: 4, experienceId: "fin-ish-line" }),
    ),
  ]);
  assert.deepEqual(results.map((item) => item.status).sort(), [201, 409]);
  const winner = results[0].status === 201 ? 0 : 1;
  accounts[winner].reservation = results[winner].data.reservation;
  const availability = await request(null, `/api/availability?date=${day}`);
  assert.equal(availability.data.slots[0].remaining, 2);
  assert.equal(
    (
      await request(
        accounts[2],
        "/api/reservations",
        "POST",
        booking({ guests: 2 }),
      )
    ).status,
    201,
  );
  assert.equal(
    (await request(null, `/api/availability?date=${day}`)).data.slots[0]
      .remaining,
    0,
  );
});

test("one account cannot list or cancel another account’s reservations; cancellation frees capacity", async () => {
  const owner = accounts.find((client) => client.reservation);
  const other = accounts.find(
    (client) => client !== owner && !client.reservation,
  );
  const response = await request(other, "/api/reservations");
  assert.ok(
    !response.data.reservations.some(
      (item) => item.id === owner.reservation.id,
    ),
  );
  assert.equal(
    (
      await request(
        other,
        `/api/reservations/${owner.reservation.id}/cancel`,
        "POST",
        {},
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        owner,
        `/api/reservations/${owner.reservation.id}/cancel`,
        "POST",
        {},
      )
    ).status,
    200,
  );
  assert.equal(
    (await request(null, `/api/availability?date=${day}`)).data.slots[0]
      .remaining,
    4,
  );
  assert.equal(
    (
      await request(
        owner,
        `/api/reservations/${owner.reservation.id}/cancel`,
        "POST",
        {},
      )
    ).status,
    200,
    "cancel is idempotent",
  );
});

test("duplicate active slots are rejected without consuming seats; a cancelled slot can be rebooked", async () => {
  const client = accounts[0];
  const body = booking({ time: "16:00" });
  const first = await request(client, "/api/reservations", "POST", body);
  assert.equal(first.status, 201);
  assert.equal(
    (await request(client, "/api/reservations", "POST", body)).status,
    409,
  );
  assert.equal(
    (await request(null, `/api/availability?date=${day}`)).data.slots[2]
      .remaining,
    5,
  );
  await request(
    client,
    `/api/reservations/${first.data.reservation.id}/cancel`,
    "POST",
    {},
  );
  assert.equal(
    (await request(client, "/api/reservations", "POST", body)).status,
    201,
  );
});

test("sign-out invalidates the old session token", async () => {
  const client = accounts[1];
  const stolen = { ...client };
  assert.equal((await request(client, "/api/logout", "POST", {})).status, 200);
  assert.equal((await request(stolen, "/api/reservations")).status, 401);
});

test("account deletion requires the password and removes reservations and every session", async () => {
  const client = accounts[0],
    id = client.user.id;
  const oldCookie = client.cookie;
  assert.equal(
    (
      await request(client, "/api/account", "DELETE", {
        password: "incorrect password",
      })
    ).status,
    401,
  );
  assert.equal(
    (await request(client, "/api/account", "DELETE", { password })).status,
    200,
  );
  assert.equal(
    (await request({ cookie: oldCookie }, "/api/reservations")).status,
    401,
  );
  for (const table of ["reservations", "sessions"]) {
    assert.equal(
      (
        await pool.query(
          `SELECT COUNT(*)::int AS n FROM ${table} WHERE user_id = $1`,
          [id],
        )
      ).rows[0].n,
      0,
    );
  }
  assert.equal(
    (
      await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE id = $1", [
        id,
      ])
    ).rows[0].n,
    0,
  );
});

test("repeated failed sign-ins are rate limited", async () => {
  const client = {};
  await request(client, "/api/session");
  let last;
  for (let index = 0; index < 11; index++)
    last = await request(client, "/api/login", "POST", {
      email: "limited@example.com",
      password: "wrong",
    });
  assert.equal(last.status, 429);
  assert.ok(last.headers.has("retry-after"));
});

test("production enforces canonical HTTPS origin and Secure, HttpOnly session cookie", async () => {
  assert.throws(
    () => createApp(pool, { production: true, origin: "http://example.com" }),
    /https/,
  );
  const prod = createApp(pool, {
    production: true,
    origin: "https://example.com",
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => prod.once("listening", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${prod.address().port}/api/session`,
    );
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie, /^__Host-jd_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(response.headers.get("strict-transport-security"), /max-age/);
  } finally {
    await new Promise((resolve) => prod.close(resolve));
  }
});
