# J Diddles Seafood & Massage

A complete parody website, ready for you to deploy on Railway.

1. Unzip this folder.
2. Open **README.md** for local setup and Railway deployment.
3. Keep the included folder structure. The front end is in `public/`; Express is in `server/`.

You need Node.js 24 LTS (22.14+ also works) and PostgreSQL 16 or newer. No front-end build step is needed. The database tables are created automatically when the server starts.

**For Railway:** add a PostgreSQL service, connect its `DATABASE_URL` to the app, set `PUBLIC_ORIGIN` to your app's HTTPS origin, and add your operator name and privacy email. Exact steps and variable examples are in README.md.

The app is real. All services and bookings are explicitly pretend. No payments are collected.
