# Verification

Tested with Node.js v24.22.1 and PostgreSQL 17 in an isolated local container.

- 12 PostgreSQL integration tests passed.
- All HTML pages and locally linked pages/assets returned successful HTTP responses (404 behavior separately checked).
- Password hashing, session rotation/invalidation, account deletion cascades, owner-scoped access, CSRF/origin checks, rate limits, booking validation, duplicate prevention, and concurrent shared-capacity booking were exercised.
- Production Secure/HttpOnly/SameSite cookies, HTTPS-origin validation, CSP, and HSTS were checked.
- Server and browser JavaScript syntax was checked.
- Production entry-point startup, automatic schema creation, database health check, and graceful shutdown passed.
- `npm audit --omit=dev` reported no known dependency vulnerabilities at packaging time.

The managed environment did not expose its required browser QA tool. No interactive browser/layout/accessibility verification was performed. Before sharing a live Railway deployment, try the full registration → booking → cancellation → logout/login → deletion flow on desktop and mobile browsers.

Railway deployment was not performed; it requires your Railway project, database variables, public domain, and operator/privacy contact details. No deployment credentials or real user data are included.
