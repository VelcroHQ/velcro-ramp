<?php

declare(strict_types=1);

/**
 * Velcro Ramp — PHP Backend Configuration
 *
 * Loads environment variables from a .env file. Designed for shared hosting
 * where Apache/Nginx sets the document root to this directory.
 */

if (!defined('BASE_PATH')) {
    define('BASE_PATH', __DIR__);
}

// Load .env file if present
$envFile = BASE_PATH . '/.env';
if (file_exists($envFile) && is_readable($envFile)) {
    $lines = file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#')) {
            continue;
        }
        $parts = explode('=', $line, 2);
        if (count($parts) !== 2) {
            continue;
        }
        [$key, $value] = $parts;
        $key = trim($key);
        $value = trim($value);
        // Remove surrounding quotes if present
        if (strlen($value) >= 2 && (($value[0] === '"' && $value[-1] === '"') || ($value[0] === "'" && $value[-1] === "'"))) {
            $value = substr($value, 1, -1);
        }
        // Standard dotenv behavior: do not overwrite existing environment variables
        if (!array_key_exists($key, $_ENV) && getenv($key) === false) {
            $_ENV[$key] = $value;
            putenv("{$key}={$value}");
        }
    }
}

function env(string $key, mixed $default = null): mixed
{
    $value = $_ENV[$key] ?? getenv($key);
    if ($value === false || $value === null || $value === '') {
        return $default;
    }
    return $value;
}

function envBool(string $key, bool $default = false): bool
{
    $value = env($key);
    if ($value === null) {
        return $default;
    }
    return in_array(strtolower((string)$value), ['true', '1', 'yes', 'on'], true);
}

function envInt(string $key, int $default = 0): int
{
    $value = env($key);
    if ($value === null) {
        return $default;
    }
    return (int) $value;
}

function envFloat(string $key, float $default = 0.0): float
{
    $value = env($key);
    if ($value === null) {
        return $default;
    }
    return (float) $value;
}

// ─── Core Application ───
define('APP_NAME', 'velcro-backend');
define('APP_VERSION', '1.2.0-php');
define('PORT', envInt('PORT', 3000));

// ─── Database ───
define('DB_HOST', env('DB_HOST', '127.0.0.1'));
define('DB_PORT', envInt('DB_PORT', 3306));
define('DB_NAME', env('DB_NAME', 'velcro_ramp'));
define('DB_USER', env('DB_USER', 'root'));
define('DB_PASS', env('DB_PASS', ''));
define('DB_CHARSET', 'utf8mb4');

// ─── Switch API ───
define('SWITCH_BASE_URL', env('SWITCH_BASE_URL', 'https://api.onswitch.xyz'));
define('SWITCH_SERVICE_KEY', env('SWITCH_SERVICE_KEY', ''));
define('SWITCH_WEBHOOK_SECRET', env('SWITCH_WEBHOOK_SECRET', ''));

// ─── PAJ Ramp ───
define('PAJ_API_KEY', env('PAJ_API_KEY', ''));
define('PAJ_ENV', env('PAJ_ENV', 'production'));
define('PAJ_WEBHOOK_SECRET', env('PAJ_WEBHOOK_SECRET', ''));
define('PAJ_EMAIL', env('PAJ_EMAIL', 'paj@usevelcro.com'));
define('PAJ_BASE_URL', env('PAJ_BASE_URL', 'https://api.paj.ramp')); // update when actual URL is known

// ─── Developer Fee / Withdrawal ───
define('DEVELOPER_FEE', envFloat('DEVELOPER_FEE', 0.5));
define('DEVELOPER_RECIPIENT', env('DEVELOPER_RECIPIENT', ''));
define('DEVELOPER_WITHDRAW_ASSET', env('DEVELOPER_WITHDRAW_ASSET', 'solana:usdc'));
define('WITHDRAWAL_ALLOWED_RECIPIENTS', array_map(
    'strtolower',
    array_filter(
        array_map('trim', explode(',', env('WITHDRAWAL_ALLOWED_RECIPIENTS', DEVELOPER_RECIPIENT))),
        'strlen'
    )
));
define('WITHDRAWAL_COOLDOWN_SECONDS', 60);

// ─── Admin ───
$adminPasswordRaw = env('ADMIN_PASSWORD', '');
if ($adminPasswordRaw === '') {
    // Do not fatal-exit here; shared hosts often run CLI differently.
    // The protected routes will simply be inaccessible until configured.
    define('ADMIN_PASSWORD_HASH', '');
} else {
    $clean = preg_replace('/^Bearer\s+/i', '', trim($adminPasswordRaw));
    if (str_starts_with($clean, 'sha256:')) {
        define('ADMIN_PASSWORD_HASH', substr($clean, 7));
    } else {
        define('ADMIN_PASSWORD_HASH', hash('sha256', $clean));
    }
}

// ─── CORS ───
$corsOrigins = env('CORS_ORIGINS', '*');
define('CORS_ORIGINS', $corsOrigins === '*' ? ['*'] : array_map('trim', explode(',', $corsOrigins)));

// ─── SMTP / Notifications ───
define('SMTP_HOST', env('SMTP_HOST', ''));
define('SMTP_PORT', envInt('SMTP_PORT', 587));
define('SMTP_USER', env('SMTP_USER', ''));
define('SMTP_PASS', env('SMTP_PASS', ''));
define('SMTP_FROM', env('SMTP_FROM', SMTP_USER));
define('ADMIN_EMAIL', env('ADMIN_EMAIL', ''));

// ─── Auto Withdrawal ───
define('AUTO_WITHDRAWAL_ENABLED', envBool('AUTO_WITHDRAWAL_ENABLED', false));
define('AUTO_WITHDRAWAL_SCHEDULE', env('AUTO_WITHDRAWAL_SCHEDULE', '0 0 * * *'));
define('AUTO_WITHDRAWAL_MIN_BALANCE', envFloat('AUTO_WITHDRAWAL_MIN_BALANCE', 1.0));

// ─── Callback / Hosting ───
define('CALLBACK_URL', rtrim(env('CALLBACK_URL', ''), '/'));

// ─── Security ───
define('RATE_LIMIT_WINDOW_SECONDS', 60);
define('RATE_LIMIT_MAX_REQUESTS', 60);

// ─── Default Settings ───
function defaultSettings(): array
{
    return [
        'platform_fee' => DEVELOPER_FEE,
        'buy_max_limit' => 1000000,
        'sell_min_limit' => 1,
        'sell_max_limit' => 10000,
        'paj_email' => PAJ_EMAIL,
        'paj_usdt_enabled' => false,
        'paj_usdc_enabled' => false,
    ];
}

// ─── Paths ───
define('SETTINGS_FILE', BASE_PATH . '/data/settings.json');
define('AUDIT_LOG_FILE', BASE_PATH . '/data/audit.log');
define('OTP_TABLE', 'otps');
define('PAJ_SESSION_TABLE', 'paj_sessions');
define('WITHDRAWAL_STATE_TABLE', 'withdrawal_states');
