# Velcro Ramp — Deployment Guide (PHP Backend)

The backend has been rewritten from Node.js/Express/MongoDB to plain PHP 8.1+
with MySQL (PDO). This guide covers deploying to a shared host or VPS.

## Requirements

- PHP 8.1 or newer with extensions: `pdo`, `pdo_mysql`, `curl`, `openssl`, `mbstring`
- MySQL 5.7+ or MariaDB 10.3+
- Apache with `mod_rewrite` and `mod_headers` (or Nginx with equivalent rules)
- HTTPS in production (required for webhooks and admin safety)

## Recommended Apache Setup

Set the document root to the `public/` directory:

```apache
DocumentRoot "/var/www/velcro/public"
<Directory "/var/www/velcro/public">
    AllowOverride All
    Require all granted
</Directory>
```

The included `public/.htaccess` will:
- Serve static assets directly
- Route `/api/*` and `/webhook/*` to `public/index.php`, which loads
  `php-backend/index.php`
- Add security headers and block access to hidden files

### Admin dashboard placement

The admin dashboard lives in `admin/`. If the document root is `public/`, you
have two options:

1. **Copy `admin/` into `public/admin/`** and configure `admin/.htaccess` with
   an additional HTTP Basic Auth password (recommended).
2. **Serve `admin/` from a separate subdomain or VPN-only location** and update
   the frontend's `API_BASE` if the API is on a different origin.

Never expose the admin dashboard to the public internet without extra protection.

## Fallback: Cannot Change Document Root

If your host forces the project root as the document root, use the root
`.htaccess` instead. It maps requests into `public/` and routes API calls to
`php-backend/index.php`. This is less secure and should only be used if the
recommended setup is impossible.

## Environment Variables

1. Copy `php-backend/.env.example` to `php-backend/.env`.
2. Fill in real values. Never commit `.env`.

Critical values:

```ini
DB_HOST=localhost
DB_PORT=3306
DB_NAME=velcro_ramp
DB_USER=velcro_user
DB_PASS=<strong_random_password>

SWITCH_SERVICE_KEY=<live_switch_key>
SWITCH_WEBHOOK_SECRET=<strong_random_secret>

PAJ_API_KEY=<live_paj_key>
PAJ_WEBHOOK_SECRET=<strong_random_secret>
PAJ_BASE_URL=https://api.paj.cash

ADMIN_PASSWORD=<very_strong_password>
DEVELOPER_RECIPIENT=<your_solana_wallet>
CALLBACK_URL=https://usevelcro.xyz
CORS_ORIGINS=https://usevelcro.xyz
```

## Database Setup

1. Create the database and user.
2. Import the schema:

```bash
mysql -u velcro_user -p velcro_ramp < php-backend/sql/schema.sql
```

3. If migrating from the old MongoDB backend, export `transactions` from MongoDB
   to `php-backend/sql/transactions.json` and run:

```bash
cd php-backend/sql && php migrate.php
```

## Webhook Configuration

Configure these endpoints in your Switch and PAJ dashboards:

- Switch: `https://usevelcro.xyz/webhook/switch`
- PAJ: `https://usevelcro.xyz/webhook/paj`

The webhook secrets must match `SWITCH_WEBHOOK_SECRET` and `PAJ_WEBHOOK_SECRET`.
Webhook signature verification is mandatory; requests are rejected if secrets are
not configured.

## Cron Jobs

Set up these cron jobs on the server:

```cron
# Poll pending transactions every 2 minutes
*/2 * * * * cd /var/www/velcro/php-backend && php cron/poll.php >> /var/log/velcro/poll.log 2>&1

# Auto-withdrawal (disabled by default; enable with AUTO_WITHDRAWAL_ENABLED=true)
0 0 * * * cd /var/www/velcro/php-backend && php cron/auto_withdraw.php >> /var/log/velcro/withdraw.log 2>&1

# Clean up expired OTPs every hour
0 * * * * cd /var/www/velcro/php-backend && php cron/cleanup_otps.php >> /var/log/velcro/cleanup.log 2>&1
```

Ensure `/var/log/velcro/` exists and is writable, or redirect logs outside the
web root.

## Production Checklist

- [ ] `.env` is in place and not committed.
- [ ] Database schema is imported and user has limited privileges.
- [ ] HTTPS certificate is installed.
- [ ] Webhook secrets are configured in both `.env` and provider dashboards.
- [ ] Admin password is strong and stored only in `.env`.
- [ ] `CORS_ORIGINS` is set to your frontend origin (not `*`).
- [ ] `CALLBACK_URL` matches your public HTTPS domain.
- [ ] `php-backend/data/` is writable by the web server but not web-accessible.
- [ ] `php-backend/tools/` (local portable stack) is NOT uploaded to production.
- [ ] `php-backend/tests/` is NOT uploaded to production or is blocked by the web server.
- [ ] Directory indexing is disabled.
- [ ] Error logs are monitored.

## Local Development

```bash
cd php-backend
php -S localhost:8002 -t . index.php
```

For the full same-origin experience (frontend + API):

```bash
php -S localhost:3000 -t public public/index.php
```

## Removed Legacy Files

The following have been removed from the current tree:

- `server.js`, `paj.js`, `package.json` — old Node backend
- `deploy.bat`, `deploy.ps1`, `deploy.sh`, `deploy_clean.bat`, `deploy_update.sh` — old VPS deploy scripts
- `scratch/inspect_last_tx.js`, `scratch/inspect_paj.js` — MongoDB/PAJ SDK diagnostics
- `php-backend/tests/compare_backends.js` — Node-vs-PHP parity harness
- `php-backend/.env.test` — committed test secrets

Old VPS details may still exist in git history. If any secret in that history
was real, rotate it immediately.
