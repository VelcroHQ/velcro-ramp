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
├── .htaccess             # Apache rewrite rules
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
│   └── schema.sql
└── data/                 # Runtime writable directory
    ├── settings.json
    ├── audit.log
    └── ratelimit/
```

## Deployment steps

1. **Create the MySQL database and user.**
2. **Import the schema:**
   ```bash
   mysql -u your_user -p your_db < sql/schema.sql
   ```
3. **Copy environment file:**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your real credentials.
4. **Upload the `php-backend/` folder** to your web host.
   - For shared hosting, upload the contents of `php-backend/` to `public_html/`.
   - Ensure `.htaccess` is uploaded.
5. **Make `data/` writable** by PHP (chmod 755 or 775).
6. **Set up cron jobs** in your hosting control panel:
   ```
   */10 * * * * /usr/bin/php /home/youruser/public_html/cron/poll.php >> /home/youruser/public_html/data/poll.log 2>&1
   0 0 * * *  /usr/bin/php /home/youruser/public_html/cron/auto_withdraw.php >> /home/youruser/public_html/data/withdraw.log 2>&1
   */5 * * * * /usr/bin/php /home/youruser/public_html/cron/cleanup_otps.php >> /home/youruser/public_html/data/cleanup.log 2>&1
   ```
   Adjust the PHP binary path and folder paths to match your host.

## Frontend integration

The existing frontend (`public/index.html`) expects the API at the same origin.
If you deploy the PHP backend to the same domain and upload the frontend files
alongside it, no code changes are needed.

If the frontend and backend are on different domains, update the frontend's
`API_BASE` variable to point to the PHP backend URL and set `CORS_ORIGINS`
accordingly in `.env`.

## Migrating data from MongoDB

1. Export the `transactions` collection from MongoDB to JSON.
2. Transform the export so stringified JSON fields (`beneficiary`, `meta`) are
   stored as JSON objects in MySQL JSON columns.
3. Import into the `transactions` table.
4. Verify counts with:
   ```sql
   SELECT COUNT(*) FROM transactions;
   ```

## Important notes

- **PAJ SDK:** The original Node backend used the proprietary `paj_ramp` npm
  package. This PHP port calls the PAJ HTTP API directly. You **must** set the
  correct `PAJ_BASE_URL` and verify the endpoint paths against the SDK's actual
  network traffic or PAJ documentation.
- **Webhook signatures** use the same algorithm as the Node backend:
  `hash('sha256', secret + json_encode(payload))`.
- **Never commit `.env`.** It contains secrets.
- On first deploy, test `/api/health` to confirm the database connection.

## Testing locally

Two test files are included.

### Unit tests (no database required)

```bash
php tests/unit_test.php
```

Tests response helpers, OTP generation, admin auth, webhook signatures,
PAJ status mapping, and settings defaults.

### Integration tests (requires MySQL/MariaDB)

A sample test environment is provided in `.env.test`. To run integration tests:

```bash
# 1. Create a local database and import the schema
mysql -u root -p -e "CREATE DATABASE velcro_test;"
mysql -u root -p velcro_test < sql/schema.sql

# 2. Copy the test environment file
cp .env.test .env

# 3. Run integration tests
php tests/integration_test.php
```

Integration tests cover transaction CRUD, OTP flow, settings persistence,
withdrawal state, audit logging, PAJ session persistence, and webhook updates.

### Manual smoke test

```bash
# Start the PHP dev server
php -S localhost:8000 index.php

# In another terminal:
curl http://localhost:8000/api/health
curl http://localhost:8000/api/settings
curl -H "Authorization: Bearer your_admin_password" http://localhost:8000/api/admin/config
```

## Nginx config (if not using Apache)

```nginx
location / {
    try_files $uri $uri/ /index.php?$query_string;
}
location ~ \.php$ {
    fastcgi_pass 127.0.0.1:9000;
    fastcgi_index index.php;
    include fastcgi_params;
}
```
