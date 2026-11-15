# POS (server, admin, shop)

Three independent folders: `server/` (API), `admin/` (admin panel), `shop/` (shop till, installable PWA).
Each has its own `package.json`, `.env` (copy from `.env.example`) and `npm install`.

## First run

```bash
cd server
docker compose up -d                  # Postgres on localhost:5433 (POS_DB_PASSWORD in .env must match DATABASE_URL)
npm install && npm run migrate
SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='a long password' npm run seed   # businesses + first admin
npm run dev                           # API (PORT in .env)

cd ../admin && npm install && npm run dev     # http://localhost:5173
cd ../shop  && npm install && npm run dev     # http://localhost:5174
```

`VITE_API_URL` in `admin/.env` and `shop/.env` must be the API URL ending in `/api`; the API's `CORS_ORIGINS` must list both apps.
`docker compose down -v` deletes the database.

## Who can do what
| | Shop manager | Admin |
|---|---|---|
| Sell, view sales, receive stock, correct stock, close the day | yes | yes |
| Products, prices, categories, suppliers | view | manage |
| Void a sale, users, reports (profit), audit log, business settings | no | yes |

A user can belong to both businesses (with a different role in each); the app asks which one at sign-in and the business switcher swaps between them.

## Product photos (Cloudflare R2)
Optional. In the Cloudflare dashboard: R2 > create a bucket > enable public access (the r2.dev URL for testing, a custom domain for production) >
create an API token with Object Read & Write for that bucket. Put the account id, key pair, bucket name and public URL in
`server/.env` (the five `R2_*` lines in `.env.example`) and restart the API. Admins then see a photo field on every product; the till and
product lists show the photos. Photos are resized in the browser (1024px WebP), checked and stored by the API, and served directly from R2.
No bucket CORS setup is needed. Without the R2 settings everything else works and the form says photos are off.

## M-Pesa prompts
At the till, choosing M-Pesa sends a payment prompt to the customer's phone; the sale completes once Safaricom confirms it, and the M-Pesa
receipt number is filled in automatically. Each paid prompt can be used on one sale only. A cashier can still type a code by hand (for
example when the network is down): that is saved as "unverified" and listed on the closing screen to check against the M-Pesa statement.
Admins see every prompt, and any that were paid but never reached a sale, under **M-Pesa** in the admin app.

- Development works out of the box with `MPESA_MODE=simulator` (no Safaricom account needed). See `.env.example` for the simulator's test numbers.
- Live: set `MPESA_MODE=daraja` and the `MPESA_*` values (sandbox first). Safaricom must be able to reach `MPESA_CALLBACK_BASE_URL` over https.
- One set of M-Pesa credentials is used for the whole system. Separate tills for Go-fish and Enyakin would need per-business settings (not built yet).

## Checks
`npm test` and `npm run typecheck` in each folder. Server tests use the `pos_test` database on the same Postgres as `DATABASE_URL`
(override with `TEST_DATABASE_URL`; its name must end in `_test` because tests empty it).

## Going live
- API: `NODE_ENV=production`, `npm run build && npm run migrate:prod && npm start`. It refuses to start with the example JWT secrets or
  an empty `CORS_ORIGINS`. Set `TRUST_PROXY` to the number of proxies in front. Serve over HTTPS only. Run `npm run seed:prod` once.
- Front ends: `npm run build` with `VITE_API_URL` set, serve `dist/` with a fallback to `index.html`.
- `GET /api/health` is the health probe (503 when the database is down). Back up the database on a schedule.

## Known limits
- The shop is online-only: it shows a banner when offline and cannot save sales until the connection returns. Retrying a sale is safe (idempotency key).
- Refresh tokens live in localStorage; move them to an httpOnly cookie if XSS risk matters more than convenience.
- Receipts print through the browser (no thermal-printer driver); M-Pesa payments are recorded by code, not verified against Safaricom.
