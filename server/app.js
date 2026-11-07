import express from "express";
import helmet from "helmet";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  hash,
  token,
  passwordHash,
  passwordMatches,
  validPassword,
} from "./auth.js";
import { experiences, times, capacity } from "./catalog.js";

const publicDirectory = fileURLToPath(new URL("../public", import.meta.url));
const DAY = 86400000;
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const requireThat = (test, status, message) => {
  if (!test) throw new HttpError(status, message);
};
const userView = (user) =>
  user ? { id: user.id, name: user.name, email: user.email } : null;
const emailValue = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const columns =
  "id, experience_id, to_char(day, 'YYYY-MM-DD') AS day, time, guests, status, created_at";

export function createApp(pool, options = {}) {
  const production =
    options.production ?? process.env.NODE_ENV === "production";
  const origin =
    options.origin ?? process.env.PUBLIC_ORIGIN ?? "http://localhost:3000";
  const canonical = new URL(origin);
  if (
    canonical.origin !== origin ||
    (production && canonical.protocol !== "https:")
  ) {
    throw new Error(
      "PUBLIC_ORIGIN must be an origin without a trailing slash; use https:// in production.",
    );
  }
  const cookieName = production ? "__Host-jd_session" : "jd_session";
  const cookieOptions = {
    httpOnly: true,
    secure: production,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * DAY,
  };
  const app = express();
  app.disable("x-powered-by");
  // Keep the default direct socket IP for rate limiting. Only opt in when the
  // deployment has exactly this many trusted proxies and direct ingress is blocked.
  const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
  if (proxyHops > 0 && Number.isInteger(proxyHops))
    app.set("trust proxy", proxyHops);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: production ? [] : null,
        },
      },
      strictTransportSecurity: production ? undefined : false,
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    }),
  );
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use("/api", express.json({ limit: "8kb", strict: true }));
  const dummyHash = passwordHash(token());
  let lastCleanup = 0;
  app.get("/healthz", async (req, res) => {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  });
  // Expired authentication state and temporary abuse-prevention data are removed
  // on the next API request (at most one cleanup per hour per process).
  app.use("/api", async (req, res, next) => {
    if (Date.now() - lastCleanup > 3600000) {
      lastCleanup = Date.now();
      await pool.query("DELETE FROM sessions WHERE expires_at <= NOW()");
      await pool.query("DELETE FROM rate_limits WHERE expires_at <= NOW()");
    }
    const cookie = req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    if (cookie && /^[a-f0-9]{64}$/.test(cookie)) {
      const result = await pool.query(
        `SELECT s.*, u.name, u.email FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE token_hash = $1 AND expires_at > NOW()`,
        [hash(cookie)],
      );
      req.session = result.rows[0];
      if (req.session?.user_id)
        req.user = {
          id: req.session.user_id,
          name: req.session.name,
          email: req.session.email,
        };
    }
    next();
  });

  async function limit(req, res, bucket, maximum, seconds, identity = req.ip) {
    const key = hash(`${bucket}:${identity}`);
    const { rows } = await pool.query(
      `INSERT INTO rate_limits(key, hits, expires_at) VALUES($1, 1, NOW() + $2 * INTERVAL '1 second')
      ON CONFLICT(key) DO UPDATE SET hits = CASE WHEN rate_limits.expires_at <= NOW() THEN 1 ELSE rate_limits.hits + 1 END,
      expires_at = CASE WHEN rate_limits.expires_at <= NOW() THEN NOW() + $2 * INTERVAL '1 second' ELSE rate_limits.expires_at END RETURNING hits`,
      [key, seconds],
    );
    if (rows[0].hits > maximum) {
      res.set("Retry-After", String(seconds));
      throw new HttpError(429, "Too many attempts. Please try again later.");
    }
  }
  async function newSession(req, res, userId = null) {
    const raw = token(),
      csrf = token();
    // Revoke the old anonymous/authenticated session before issuing a fresh one.
    if (req.session)
      await pool.query("DELETE FROM sessions WHERE token_hash = $1", [
        req.session.token_hash,
      ]);
    await pool.query(
      "INSERT INTO sessions(token_hash, user_id, csrf_token, expires_at) VALUES($1, $2, $3, NOW() + INTERVAL '7 days')",
      [hash(raw), userId, csrf],
    );
    res.cookie(cookieName, raw, cookieOptions);
    return csrf;
  }
  const auth = (req, res, next) => {
    requireThat(req.user, 401, "Please sign in to continue.");
    next();
  };
  app.get("/api/session", async (req, res) => {
    if (!req.session && req.query.passive !== "1")
      await limit(req, res, "new-session", 100, 900);
    const csrfToken =
      req.session?.csrf_token ??
      (req.query.passive === "1" ? null : await newSession(req, res));
    res.json({ user: userView(req.user), csrfToken });
  });
  app.use("/api", (req, res, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      requireThat(
        req.headers.origin === origin,
        403,
        "This request must come from this website.",
      );
      requireThat(
        equal(req.headers["x-csrf-token"], req.session?.csrf_token),
        403,
        "Your session expired. Refresh the page and try again.",
      );
      requireThat(req.is("application/json"), 415, "Please send JSON.");
      requireThat(
        req.body && typeof req.body === "object" && !Array.isArray(req.body),
        400,
        "Please send a JSON object.",
      );
    }
    next();
  });

  app.get("/api/experiences", (req, res) =>
    res.json({ experiences, times, capacity, timezone: "UTC" }),
  );
  app.get("/api/site", (req, res) => {
    const operatorName = (process.env.OPERATOR_NAME ?? "").slice(0, 120);
    const email = process.env.PRIVACY_EMAIL ?? "";
    const privacyEmail =
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254
        ? email
        : "";
    res.json({ operatorName, privacyEmail });
  });
  app.post("/api/register", async (req, res) => {
    await limit(req, res, "register", 10, 3600);
    const { name, password, parodyAcknowledged } = req.body;
    const email = emailValue(req.body.email);
    requireThat(
      typeof name === "string" &&
        name.trim().length >= 1 &&
        name.trim().length <= 60,
      400,
      "Enter a name between 1 and 60 characters.",
    );
    requireThat(
      email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
      400,
      "Enter a valid email address.",
    );
    requireThat(
      validPassword(password),
      400,
      "Use a password between 12 and 128 characters.",
    );
    requireThat(
      parodyAcknowledged === true,
      400,
      "Please acknowledge that this is a fictional parody.",
    );
    const id = randomUUID();
    try {
      await pool.query(
        "INSERT INTO users(id, name, email, password_hash) VALUES($1, $2, $3, $4)",
        [id, name.trim(), email, await passwordHash(password)],
      );
    } catch (error) {
      if (error.code === "23505")
        throw new HttpError(
          409,
          "Unable to create an account with these details. Try signing in instead.",
        );
      throw error;
    }
    const csrfToken = await newSession(req, res, id);
    res.status(201).json({ user: { id, name: name.trim(), email }, csrfToken });
  });
  app.post("/api/login", async (req, res) => {
    await limit(req, res, "login-ip", 30, 900);
    const email = emailValue(req.body.email);
    await limit(req, res, "login-email", 10, 900, email);
    const password = req.body.password;
    requireThat(
      typeof password === "string" &&
        password.length <= 128 &&
        email.length <= 254,
      400,
      "Invalid email or password.",
    );
    const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [
      email,
    ]);
    const user = rows[0];
    const matches = await passwordMatches(
      password,
      user?.password_hash ?? (await dummyHash),
    );
    requireThat(user && matches, 401, "Invalid email or password.");
    const csrfToken = await newSession(req, res, user.id);
    res.json({ user: userView(user), csrfToken });
  });
  app.post("/api/logout", async (req, res) => {
    await pool.query("DELETE FROM sessions WHERE token_hash = $1", [
      req.session.token_hash,
    ]);
    res.clearCookie(cookieName, {
      httpOnly: true,
      secure: production,
      sameSite: "lax",
      path: "/",
    });
    res.json({ ok: true });
  });

  function validateDay(day) {
    const earliest = new Date();
    earliest.setUTCHours(0, 0, 0, 0);
    earliest.setUTCDate(earliest.getUTCDate() + 1);
    const latest = new Date(earliest.getTime() + 29 * DAY);
    const parsed = new Date(`${day}T00:00:00Z`);
    requireThat(
      typeof day === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(day) &&
        !Number.isNaN(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === day &&
        parsed >= earliest &&
        parsed <= latest,
      400,
      "Choose a date from tomorrow through the next 30 days (UTC).",
    );
  }
  async function availability(day) {
    const { rows } = await pool.query(
      "SELECT time, SUM(guests)::int AS booked FROM reservations WHERE day = $1 AND status = 'confirmed' GROUP BY time",
      [day],
    );
    return times.map((time) => ({
      time,
      remaining:
        capacity - (rows.find((row) => row.time === time)?.booked ?? 0),
    }));
  }
  app.get("/api/availability", async (req, res) => {
    validateDay(req.query.date);
    res.json({
      date: req.query.date,
      timezone: "UTC",
      slots: await availability(req.query.date),
    });
  });
  app.get("/api/reservations", auth, async (req, res) => {
    const { rows } = await pool.query(
      `SELECT ${columns} FROM reservations WHERE user_id = $1 ORDER BY day DESC, time DESC, created_at DESC`,
      [req.user.id],
    );
    res.json({ reservations: rows });
  });
  app.post("/api/reservations", auth, async (req, res) => {
    await limit(req, res, "booking", 30, 3600, req.user.id);
    const { experienceId, date, time, guests, parodyAcknowledged } = req.body;
    requireThat(
      experiences.some((item) => item.id === experienceId),
      400,
      "Choose an experience.",
    );
    validateDay(date);
    requireThat(times.includes(time), 400, "Choose an available time.");
    requireThat(
      Number.isInteger(guests) && guests >= 1 && guests <= 4,
      400,
      "Choose between 1 and 4 guests.",
    );
    requireThat(
      parodyAcknowledged === true,
      400,
      "Acknowledge that this booking is pretend.",
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // One shared capacity across all experiences. PostgreSQL serializes writes
      // to this slot even across multiple Express instances on Railway.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${date}:${time}`,
      ]);
      const { rows } = await client.query(
        "SELECT COALESCE(SUM(guests), 0)::int AS booked FROM reservations WHERE day = $1 AND time = $2 AND status = 'confirmed'",
        [date, time],
      );
      requireThat(
        rows[0].booked + guests <= capacity,
        409,
        "That slot just filled up. Choose another time or fewer guests.",
      );
      const id = randomUUID();
      const result = await client.query(
        `INSERT INTO reservations(id, user_id, experience_id, day, time, guests) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${columns}`,
        [id, req.user.id, experienceId, date, time, guests],
      );
      await client.query("COMMIT");
      res.status(201).json({ reservation: result.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505")
        throw new HttpError(
          409,
          "You already have a pretend reservation at this time.",
        );
      throw error;
    } finally {
      client.release();
    }
  });
  app.post("/api/reservations/:id/cancel", auth, async (req, res) => {
    requireThat(
      /^[a-f0-9-]{36}$/.test(req.params.id),
      404,
      "Reservation not found.",
    );
    const { rows } = await pool.query(
      "UPDATE reservations SET status = 'cancelled' WHERE id = $1 AND user_id = $2 RETURNING id",
      [req.params.id, req.user.id],
    );
    requireThat(rows.length, 404, "Reservation not found.");
    res.json({ ok: true });
  });
  app.delete("/api/account", auth, async (req, res) => {
    await limit(req, res, "delete-account", 5, 900, req.user.id);
    requireThat(
      validPassword(req.body.password),
      400,
      "Enter your current password.",
    );
    const { rows } = await pool.query(
      "SELECT password_hash FROM users WHERE id = $1",
      [req.user.id],
    );
    requireThat(
      rows[0] &&
        (await passwordMatches(req.body.password, rows[0].password_hash)),
      401,
      "Incorrect password.",
    );
    await pool.query("DELETE FROM users WHERE id = $1", [req.user.id]);
    res.clearCookie(cookieName, {
      httpOnly: true,
      secure: production,
      sameSite: "lax",
      path: "/",
    });
    res.json({ ok: true });
  });
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "Endpoint not found." }),
  );
  app.use(
    express.static(publicDirectory, {
      dotfiles: "deny",
      index: "index.html",
      maxAge: 0,
    }),
  );
  app.use((req, res) =>
    res.status(404).sendFile(`${publicDirectory}/404.html`),
  );
  app.use((error, req, res, next) => {
    let status = error.status ?? 500;
    if (error.type === "entity.parse.failed") status = 400;
    const message =
      status >= 500
        ? "Something went wrong. Please try again shortly."
        : error.type === "entity.parse.failed"
          ? "Invalid JSON request."
          : error.message;
    // Never log request bodies, credentials, SQL details, or database URLs.
    if (status >= 500)
      console.error("Request failed", error.code ?? error.name);
    res.status(status).json({ error: message });
  });
  return app;
}
