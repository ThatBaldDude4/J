# J Diddles Seafood & Massage

An independent parody seafood spa with real accounts and saved **pretend** reservations. Plain HTML, CSS, and browser JavaScript; Express 5; PostgreSQL. No React, front-end framework, bundler, external fonts, analytics, payments, or map embed.

## Included

- Home, experience menu, three dedicated experience pages, story, booking, sign-in, registration, reservations, account, privacy, terms, and 404 pages.
- Original local SVG illustrations and responsive styling.
- Nickname/email/password registration, sign-in/out, 7-day database-backed sessions, and permanent account deletion.
- Live pretend availability, 1–4 guests, next 30 days, four daily UTC slots, 6 shared seats per slot, reservation history/filtering/cancellation.
- Salted scrypt password hashes, hashed opaque session tokens, session rotation, HttpOnly/SameSite cookies, CSRF tokens and origin checks, parameterized SQL, database rate limits, owner-scoped access, CSP and other Helmet headers.
- PostgreSQL transaction/advisory locking to prevent overbooking across multiple app instances.
- Cookie explanation and privacy information matching the included app. Optional operator/contact environment variables.
- Railway configuration, Dockerfile, optional local Postgres Compose service, integration tests.

## 1. Run locally

Install **Node.js 24 LTS** (minimum 22.14) and **PostgreSQL 16+**. If you have Docker, the included Compose file can run Postgres for you.

In the unzipped folder:

```sh
npm ci
```

Copy `.env.example` to `.env` using your file manager, or:

```sh
# macOS / Linux
cp .env.example .env
```

```powershell
# PowerShell
Copy-Item .env.example .env
```

Start a local Postgres database (optional if you already have one):

```sh
docker compose up -d db
```

The default `.env.example` connection matches Compose. If using another PostgreSQL instance, create an empty database and update `DATABASE_URL` in `.env`. Then run:

```sh
npm start
```

Open **http://localhost:3000**. Use this exact origin, not `file://` or `127.0.0.1`, because mutation requests enforce `PUBLIC_ORIGIN`. The server creates the tables automatically. `npm run dev` restarts the Express server when files change; refresh the browser after editing front-end files.

No accounts or reservations are seeded. Create an account through the website to try it.

**Changing the port?** Change both `PORT` and `PUBLIC_ORIGIN` to match. Stop with Ctrl+C. Keep `.env` private. The checked-in local database password is a development example, not a production credential.

## 2. Deploy on Railway

This project is designed for an Express app service and a Railway PostgreSQL service in the **same Railway project**. You don't need to host the database yourself.

1. Create a GitHub repository and upload the *contents* of this folder at the repository root. Include `package-lock.json`, `Dockerfile`, and `railway.json`. Do not upload `node_modules` or `.env`.
2. In Railway, create a project, add a PostgreSQL service, then add an app service from your GitHub repository. Railway uses the supplied Dockerfile. You may also use Railway CLI's `railway up` from this folder after linking an app service.
3. In the app service's networking settings, generate its public domain. Set the target port to the app's Railway-provided `PORT` if Railway asks. The server listens on `0.0.0.0` and honors `PORT`; don't hard-code a host-specific value.
4. Set these variables **on the app service**:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` (also set in Dockerfile) |
| `DATABASE_URL` | Reference your PostgreSQL service's `DATABASE_URL`, for example `${{Postgres.DATABASE_URL}}` if the database service is named `Postgres` |
| `PUBLIC_ORIGIN` | Your exact HTTPS origin, such as `https://your-app.up.railway.app`, with **no trailing slash** |
| `OPERATOR_NAME` | Your name or project/operator name for the privacy page |
| `PRIVACY_EMAIL` | A monitored privacy contact email for the privacy page |
| `DATABASE_SSL` | Leave unset for Railway's normal private PostgreSQL connection; use `require` only for a database endpoint configured with verified TLS |
| `TRUST_PROXY_HOPS` | Default `0`. See the proxy note below before changing. |

The reference variable uses Railway's service name; replace `Postgres` if your service has a different name. Never paste credentials into front-end files or commit them. Do not define `TEST_DATABASE_URL` in production.

5. Deploy/redeploy after setting the variables. A first attempted deployment may fail until `DATABASE_URL` and `PUBLIC_ORIGIN` are configured; this is expected. At startup, the app runs idempotent schema creation, then starts Express. `/healthz` reports database connectivity for Railway's health check.
6. Open your HTTPS domain. Register a test account, make a pretend booking, cancel it, sign out, sign back in, and delete the account. Confirm your operator details appear on `/privacy.html` before sharing publicly.

You do **not** need an app disk volume: all durable app records and sessions are in PostgreSQL. Keep the PostgreSQL service's persistent storage and configure its backups according to your retention policy. Application replicas share sessions, rate limits, and booking capacity through the database.

### Proxy and domain notes

Secure production cookies use the `__Host-` prefix, no Domain attribute, Path=/, SameSite=Lax, and HttpOnly. They require HTTPS. Changing domains requires signing in again and updating `PUBLIC_ORIGIN`. Only one canonical origin is supported; redirect any secondary domain at your hosting layer.

IP rate limiting defaults to the direct socket IP rather than trusting user-supplied forwarding headers. Behind Railway's proxy this can group visitors under a shared proxy limit. Set `TRUST_PROXY_HOPS` only after verifying the exact trusted proxy chain and that clients cannot directly reach Express. An incorrect hop count permits IP spoofing. The email/account-specific limits still apply independently. For a public site with significant traffic, add an appropriately configured ingress/WAF limit too.

## 3. Project layout

```text
j-diddles/
  public/                  Real HTML pages served by Express
    assets/                CSS, favicon, original local SVG artwork
    js/app.js              Plain JS for navigation, auth, booking, account flows
  server/
    index.js               Startup, graceful shutdown, DB initialization
    app.js                 Express routes, validation, cookies, CSRF, rate limits
    auth.js                Scrypt password hashing and cryptographic tokens
    db.js                  PostgreSQL pool and schema initialization
    schema.sql             Database tables and indexes
    catalog.js             API experience descriptions and reservation settings
  tests/integration.test.js
  .env.example
  compose.yaml             Optional local PostgreSQL
  Dockerfile
  railway.json
  package.json
  package-lock.json
  START-HERE.md
  README.md
  VERIFICATION.md
```

The informational experience copy is static HTML so it remains readable without JavaScript. If you change experience names/copy, update the corresponding HTML pages and `server/catalog.js`. If you change IDs, also update the booking select in `public/book.html`; keep old IDs resolvable or migrate existing reservation records. Capacity and slot times live in `server/catalog.js`. All reservation dates and times use **UTC**, visibly labeled on the site.

### API overview

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/session` | Create/read session and return CSRF token/current user |
| GET | `/api/session?passive=1` | Read session without creating a cookie for anonymous browsing |
| POST | `/api/register` | Create account and rotate session |
| POST | `/api/login` | Authenticate and rotate session |
| POST | `/api/logout` | Revoke current session |
| GET | `/api/experiences` | Experience catalogue, shared capacity, UTC times |
| GET | `/api/site` | Public operator/contact details, never credentials |
| GET | `/api/availability?date=YYYY-MM-DD` | Anonymous seat counts, no guest details |
| GET / POST | `/api/reservations` | Signed-in user's reservations / create a booking |
| POST | `/api/reservations/:id/cancel` | Cancel only an owned reservation |
| DELETE | `/api/account` | Password-confirmed deletion; cascades reservations/sessions |
| GET | `/healthz` | App/database health |

Mutations require JSON, a same-origin `Origin` header matching `PUBLIC_ORIGIN`, the session cookie, and `X-CSRF-Token` from `/api/session`. No CORS or cross-site credential access is enabled. The browser module handles these details.

## 4. Test

Use a **separate non-production PostgreSQL database**. Set `TEST_DATABASE_URL` in your local `.env` (the example points to your local Compose database). The test suite creates a random isolated schema, then drops only that schema afterward; it never truncates existing app tables.

```sh
npm test
```

The integration suite uses a real PostgreSQL server and covers registration/login, hashing, session rotation/logout, CSRF/origin rejection, owner isolation, booking validation, concurrent capacity, duplicates, cancellation, deletion, throttling, production cookie flags, static pages, and their local assets/links.

If a test process is killed, it may leave a `test_...` schema; remove that specific leftover schema in your test database if needed. Don't run tests against production.

## 5. Deliberate boundaries

- **All bookings are pretend.** No real services, charges, emails, calendar invites, map link, or Google Maps integration. You didn't provide a listing URL, so none is invented.
- **Accounts are real database records.** Emails are not verified; password reset, email delivery, MFA, social sign-in, and an admin dashboard are not included. The login page discloses the missing reset flow. Add verification and a mail provider if you need verified identities or password recovery.
- No payments, health information, phone numbers, or special requests are collected.
- Accounts/reservations remain until deletion. Sessions expire after 7 days (absolute, not sliding); temporary security counters expire after at most an hour. Cleanup runs on the next API request, at most hourly. Hosting logs and backups are controlled separately by the operator.
- Essential cookies require no optional tracking consent choice in this implementation. The notice explains the session cookie and local browser preference; it is not a general legal compliance guarantee. Review your actual hosting/logging, operator contact, legal requirements, and retention settings before public launch.
- The project does not automatically create a GitHub repo or deploy to Railway. The source is ready for you to upload and configure.

The name and artwork are independent fictional branding and make no claim of association with any real person or business. This package intentionally avoids a physical address, directions, invented customer reviews, or claims that the parody is a real establishment.
