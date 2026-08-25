# Velcro Ramp — PHP Backend

Plain-PHP port of the Node.js/Express backend, designed for shared hosting
(cPanel/Plesk) or any LAMP/LEMP stack.

## What was ported

- All public API routes (`/api/*`)
- Admin dashboard routes (`/api/admin/*`)
- PAJ Ramp proxy routes (`/api/paj/*`)
- Switch and PAJ webhook handlers (`/webhook/*`)
- OTP, audit logging, admin auth, rate limiting, settings
- Background cron scripts: transaction poller, auto-withdrawal, OTP cleanup

## Requirements

- PHP 8.1 or newer (8.2+ recommended)
- MySQL 5.7+ or MariaDB 10.3+
- Apache with `mod_rewrite` enabled (or equivalent Nginx config)
- cURL extension enabled
- APCu extension recommended for rate limiting (falls back to files)

## Folder structure

```
php-backend/
├── .env.example          # Copy to .env and fill in
├── .htaccess             # Backend directory protection
├── index.php             # Entry point / router
├── config.php            # Environment loader
├── db.php                # PDO wrapper
├── helpers.php           # Shared helpers
├── router.php            # Minimal router
├── switch_api.php        # Switch API client
├── paj_api.php           # PAJ HTTP API client
├── poll_helpers.php      # Transaction polling logic
├── routes/
│   ├── public.php
│   ├── admin.php
│   ├── paj.php
│   └── webhooks.php
├── cron/
│   ├── poll.php
│   ├── auto_withdraw.php
│   └── cleanup_otps.php
├── sql/
│   ├── schema.sql
│   └── migrate.php       # MongoDB -> MySQL migration helper
└── data/                 # Runtime writable directory (gitignored)
    ├── settings.json
    ├── audit.log
    └── ratelimit/
```

## Deployment

See the root `DEPLOY.md` for the full production deployment guide.

Quick summary:

1. Set the web server document root to `public/`.
2. Create the MySQL database and user.
3. Import `sql/schema.sql`.
4. Copy `.env.example` to `.env` and fill in real values.
5. Make `data/` writable by PHP.
6. Set up cron jobs for `cron/poll.php`, `cron/auto_withdraw.php`, and
   `cron/cleanup_otps.php`.

## Frontend integration

The existing frontend (`public/index.html`) expects the API at the same origin.
`public/.htaccess` routes `/api/*` and `/webhook/*` to `php-backend/index.php`
and serves all other requests as static files.

If the frontend and backend must be on different domains, update the frontend's
`API_BASE` variable and set `CORS_ORIGINS` in `.env` to the frontend origin.
Do not use `CORS_ORIGINS=*` in production.

## Migrating data from MongoDB

1. Export the `transactions` collection from MongoDB to JSON.
2. Save it as `sql/transactions.json`.
3. Run `php sql/migrate.php`.
4. Verify counts with:
   ```sql
   SELECT COUNT(*) FROM transactions;
   ```

## Important notes

- **PAJ SDK:** The original Node backend used the proprietary `paj_ramp` npm
  package. This PHP port calls the PAJ HTTP API directly. Production base URL is
  `https://api.paj.cash`.
- **Webhook signatures** use the same algorithm as the Node backend:
  `hash('sha256', secret + json_encode(payload))`. Webhooks are rejected if the
  secret is not configured.
- **Never commit `.env`.** It contains secrets.
- On first deploy, test `/api/health` to confirm the database connection.

## Testing locally

Two test files are included.

### Unit tests (no database required)

```bash
cd php-backend
php tests/unit_test.php
```

Tests response helpers, OTP generation, admin auth, webhook signatures,
PAJ status mapping, and settings defaults.

### Integration tests (requires MySQL/MariaDB)

1. Create a local database and import the schema:
   ```bash
   mysql -u root -p -e "CREATE DATABASE velcro_test;"
   mysql -u root -p velcro_test < sql/schema.sql
   ```
2. Copy `.env.example` to `.env` and set the test database credentials.
3. Run integration tests:
   ```bash
   php tests/integration_test.php
   ```

Integration tests cover transaction CRUD, OTP flow, settings persistence,
withdrawal state, audit logging, PAJ session persistence, and webhook updates.

### Manual smoke test

```bash
# Same-origin frontend + API
php -S localhost:3000 -t public public/index.php

# Backend only
php -S localhost:8002 -t php-backend php-backend/index.php
```

In another terminal:

```bash
curl http://localhost:8002/api/health
curl http://localhost:8002/api/settings
```
