<?php

declare(strict_types=1);

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/db.php';

// ─── Response Helpers ───

/**
 * Add common security headers. Called automatically by jsonResponse().
 */
function securityHeaders(): void
{
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    header('X-XSS-Protection: 0');
    if (isProduction() && !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') {
        header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
    }
}

/**
 * Send a JSON response and exit.
 *
 * @param array<string,mixed> $data
 */
function jsonResponse(array $data, int $statusCode = 200): never
{
    http_response_code($statusCode);
    securityHeaders();
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

/**
 * Standard success response wrapper.
 *
 * @param mixed $data
 */
function successResponse(mixed $data, string $message = 'Success'): array
{
    return [
        'success' => true,
        'message' => $message,
        'timestamp' => gmdate('c'),
        'data' => $data,
    ];
}

/**
 * Standard error response wrapper.
 */
function errorResponse(string $message, int $status = 400): array
{
    return [
        'success' => false,
        'message' => $message,
        'timestamp' => gmdate('c'),
        'status' => $status,
    ];
}

// ─── CORS ───
function handleCors(): void
{
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin !== '' && in_array($origin, CORS_ORIGINS, true)) {
        header("Access-Control-Allow-Origin: {$origin}");
        header('Access-Control-Allow-Credentials: true');
        header('Vary: Origin');
    }
    header('Access-Control-Allow-Methods: GET, POST, PATCH, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization');
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
}

/**
 * Return a client-safe error message. In production, hide internal details.
 */
function clientErrorMessage(Throwable $e, string $fallback = 'Internal server error'): string
{
    if (!isProduction()) {
        return $e->getMessage();
    }
    $msg = strtolower($e->getMessage());
    // Whitelist safe, user-actionable messages
    $safe = [
        'required',
        'invalid',
        'not found',
        'unauthorized',
        'too many requests',
        'not configured',
        'expired',
    ];
    foreach ($safe as $word) {
        if (str_contains($msg, $word)) {
            return $e->getMessage();
        }
    }
    return $fallback;
}

// ─── Request Helpers ───

/**
 * Get the parsed JSON body or an empty array.
 *
 * @return array<string,mixed>
 */
function getJsonBody(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return [];
    }
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

/**
 * Get a value from the JSON body.
 */
function body(array $body, string $key, mixed $default = null): mixed
{
    return $body[$key] ?? $default;
}

/**
 * Get a query parameter.
 */
function query(string $key, mixed $default = null): mixed
{
    return $_GET[$key] ?? $default;
}

/**
 * Get client IP.
 */
function clientIp(): string
{
    $keys = ['HTTP_X_FORWARDED_FOR', 'HTTP_X_REAL_IP', 'REMOTE_ADDR'];
    foreach ($keys as $key) {
        if (!empty($_SERVER[$key])) {
            $ips = explode(',', $_SERVER[$key]);
            $ip = trim($ips[0]);
            if (filter_var($ip, FILTER_VALIDATE_IP)) {
                return $ip;
            }
        }
    }
    return 'unknown';
}

// ─── Admin Auth ───

function verifyAdminPassword(string $input): bool
{
    if (ADMIN_PASSWORD_HASH === '') {
        return false;
    }
    $clean = preg_replace('/^Bearer\s+/i', '', trim($input));
    return hash('sha256', $clean) === ADMIN_PASSWORD_HASH;
}

function requireAdminAuth(): void
{
    $ip = clientIp();
    rateLimitOrFail('admin_auth:' . $ip, 10, 60);

    $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? $_SERVER['HTTP_X_AUTHORIZATION'] ?? $_SERVER['HTTP_X_ADMIN_TOKEN'] ?? '';
    if ($auth === '' && function_exists('apache_request_headers')) {
        $headers = apache_request_headers();
        $auth = $headers['Authorization'] ?? $headers['REDIRECT_HTTP_AUTHORIZATION'] ?? $headers['X-Authorization'] ?? $headers['X-Admin-Token'] ?? '';
    }
    if (!verifyAdminPassword($auth)) {
        auditLog('ADMIN_AUTH_FAIL', ['ip' => $ip, 'userAgent' => $_SERVER['HTTP_USER_AGENT'] ?? 'unknown']);
        jsonResponse(['error' => 'Unauthorized'], 401);
    }
}

// ─── Audit Logging ───

function auditLog(string $action, array $details = []): void
{
    try {
        Database::insert('audit_logs', [
            'action' => $action,
            'ip' => $details['ip'] ?? clientIp(),
            'user_agent' => $details['userAgent'] ?? ($_SERVER['HTTP_USER_AGENT'] ?? 'unknown'),
            'details' => jsonEncodeNullable($details),
        ]);
    } catch (Throwable $e) {
        error_log('Audit log failed: ' . $e->getMessage());
    }

    // Also keep a file-based rotated log for shared-hosting convenience
    rotateFileLog(AUDIT_LOG_FILE, 5 * 1024 * 1024);
    $entry = [
        'timestamp' => gmdate('c'),
        'action' => $action,
        'ip' => $details['ip'] ?? clientIp(),
        'userAgent' => $details['userAgent'] ?? ($_SERVER['HTTP_USER_AGENT'] ?? 'unknown'),
    ] + $details;
    @file_put_contents(AUDIT_LOG_FILE, json_encode($entry) . "\n", FILE_APPEND | LOCK_EX);
}

function rotateFileLog(string $path, int $maxBytes): void
{
    if (!file_exists($path)) {
        return;
    }
    if (filesize($path) >= $maxBytes) {
        @rename($path, $path . '.' . time() . '.old');
    }
}

// ─── Settings ───

/**
 * Load settings from file, merged with defaults.
 *
 * @return array<string,mixed>
 */
function loadSettings(): array
{
    $defaults = defaultSettings();
    $file = SETTINGS_FILE;
    if (!file_exists($file)) {
        return $defaults;
    }
    $content = @file_get_contents($file);
    if ($content === false || $content === '') {
        return $defaults;
    }
    $data = json_decode($content, true);
    if (!is_array($data)) {
        return $defaults;
    }
    return array_merge($defaults, $data);
}

function saveSettings(array $settings): bool
{
    $dir = dirname(SETTINGS_FILE);
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    $written = @file_put_contents(SETTINGS_FILE, json_encode($settings, JSON_PRETTY_PRINT), LOCK_EX);
    return $written !== false;
}

function getPlatformFee(): float
{
    $settings = loadSettings();
    $fee = (float) ($settings['platform_fee'] ?? DEVELOPER_FEE);
    return is_nan($fee) ? DEVELOPER_FEE : $fee;
}

// ─── OTP ───

function generateOTP(): string
{
    return str_pad((string) random_int(100000, 999999), 6, '0', STR_PAD_LEFT);
}

function storeOTP(string $key, string $code): void
{
    $expires = (int) (microtime(true) * 1000) + (5 * 60 * 1000);
    Database::execute(
        'INSERT INTO `' . OTP_TABLE . '` (`otp_key`, `code`, `expires_at`, `attempts`) ' .
        'VALUES (:key, :code, :expires, 0) ' .
        'ON DUPLICATE KEY UPDATE `code` = :new_code, `expires_at` = :new_expires, `attempts` = 0',
        ['key' => $key, 'code' => $code, 'expires' => $expires, 'new_code' => $code, 'new_expires' => $expires]
    );
}

function verifyOTP(string $key, string $input): array
{
    $row = Database::selectOne(
        'SELECT * FROM `' . OTP_TABLE . '` WHERE `otp_key` = :key',
        ['key' => $key]
    );
    if ($row === null) {
        return ['valid' => false, 'reason' => 'No OTP requested. Click "Get OTP" first.'];
    }
    $now = (int) (microtime(true) * 1000);
    if ((int) $row['expires_at'] < $now) {
        Database::execute('DELETE FROM `' . OTP_TABLE . '` WHERE `otp_key` = :key', ['key' => $key]);
        return ['valid' => false, 'reason' => 'OTP expired. Request a new one.'];
    }
    if ((int) $row['attempts'] >= 3) {
        Database::execute('DELETE FROM `' . OTP_TABLE . '` WHERE `otp_key` = :key', ['key' => $key]);
        return ['valid' => false, 'reason' => 'Too many failed attempts. Request a new OTP.'];
    }
    if ((string) $row['code'] !== trim($input)) {
        Database::execute(
            'UPDATE `' . OTP_TABLE . '` SET `attempts` = `attempts` + 1 WHERE `otp_key` = :key',
            ['key' => $key]
        );
        $remaining = 3 - ((int) $row['attempts'] + 1);
        return ['valid' => false, 'reason' => 'Invalid OTP. ' . $remaining . ' attempts remaining.'];
    }
    Database::execute('DELETE FROM `' . OTP_TABLE . '` WHERE `otp_key` = :key', ['key' => $key]);
    return ['valid' => true];
}

function cleanupExpiredOtps(): void
{
    $now = (int) (microtime(true) * 1000);
    Database::execute('DELETE FROM `' . OTP_TABLE . '` WHERE `expires_at` < :now', ['now' => $now]);
}

// ─── Withdrawal State ───

function getLastWithdrawalTime(): int
{
    $row = Database::selectOne('SELECT `last_withdrawal_at` FROM `withdrawal_states` WHERE `id` = 1');
    return (int) ($row['last_withdrawal_at'] ?? 0);
}

function setLastWithdrawalTime(int $timestamp): void
{
    Database::execute(
        'UPDATE `withdrawal_states` SET `last_withdrawal_at` = :ts WHERE `id` = 1',
        ['ts' => $timestamp]
    );
}

function isWithdrawalAllowed(string $address): bool
{
    if (empty(WITHDRAWAL_ALLOWED_RECIPIENTS)) {
        return true;
    }
    return in_array(strtolower($address), WITHDRAWAL_ALLOWED_RECIPIENTS, true);
}

// ─── Rate Limiting (simple in-memory + APCu fallback) ───

function rateLimitCheck(string $key, int $max = RATE_LIMIT_MAX_REQUESTS, int $window = RATE_LIMIT_WINDOW_SECONDS): bool
{
    if ($max <= 0) {
        return true;
    }
    // Prefer APCu for shared-hosting persistence across requests
    if (extension_loaded('apcu') && ini_get('apc.enabled')) {
        $cacheKey = 'velcro_rl_' . $key;
        $now = time();
        $windowKey = $cacheKey . '_' . (int) ($now / $window);
        $count = (int) apcu_fetch($windowKey);
        if ($count >= $max) {
            return false;
        }
        apcu_store($windowKey, $count + 1, $window);
        return true;
    }
    // Fallback: file-based rate limit (slower, but works everywhere)
    $dir = BASE_PATH . '/data/ratelimit';
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    $now = time();
    $file = $dir . '/' . preg_replace('/[^a-z0-9_-]/i', '_', $key) . '_' . (int) ($now / $window) . '.json';
    $count = 0;
    if (file_exists($file)) {
        $count = (int) @file_get_contents($file);
    }
    if ($count >= $max) {
        return false;
    }
    @file_put_contents($file, (string) ($count + 1), LOCK_EX);
    return true;
}

/**
 * Rate-limit helper that immediately responds with 429 when exceeded.
 */
function rateLimitOrFail(string $key, int $max = RATE_LIMIT_MAX_REQUESTS, int $window = RATE_LIMIT_WINDOW_SECONDS): void
{
    if (!rateLimitCheck($key, $max, $window)) {
        auditLog('RATE_LIMITED', ['ip' => clientIp(), 'key' => $key]);
        jsonResponse(['success' => false, 'error' => 'Too many requests. Please slow down.'], 429);
    }
}

// ─── Mail ───

function sendMail(string $subject, string $html, string $text): array
{
    if (SMTP_HOST === '' || SMTP_USER === '' || SMTP_PASS === '' || ADMIN_EMAIL === '') {
        return ['sent' => false, 'reason' => 'SMTP not configured'];
    }
    try {
        // Try a direct SMTP submission first (works on most shared hosts).
        $sent = smtpSend(ADMIN_EMAIL, $subject, $html, $text);
        if ($sent) {
            return ['sent' => true];
        }
        // Fallback to mail() if SMTP failed.
        $headers = [
            'From: "Velcro Admin" <' . SMTP_FROM . '>',
            'Reply-To: ' . SMTP_FROM,
            'MIME-Version: 1.0',
            'Content-Type: text/html; charset=UTF-8',
        ];
        $sent = mail(ADMIN_EMAIL, $subject, $html, implode("\r\n", $headers));
        return ['sent' => $sent, 'reason' => $sent ? 'ok' : 'mail() returned false'];
    } catch (Throwable $e) {
        error_log('Email send failed: ' . $e->getMessage());
        return ['sent' => false, 'error' => $e->getMessage()];
    }
}

/**
 * Minimal SMTP client using fsockopen. Supports TLS on port 465/587.
 */
function smtpSend(string $to, string $subject, string $html, string $text): bool
{
    $host = SMTP_HOST;
    $port = SMTP_PORT;
    $user = SMTP_USER;
    $pass = SMTP_PASS;
    $from = SMTP_FROM;

    $timeout = 15;
    $isTls = in_array($port, [465, 587], true);
    $prefix = $isTls && $port === 465 ? 'ssl://' : '';

    $fp = @fsockopen($prefix . $host, $port, $errno, $errstr, $timeout);
    if (!$fp) {
        error_log("SMTP connect failed: {$errstr} ({$errno})");
        return false;
    }

    $read = function () use ($fp): string {
        $data = '';
        while ($line = fgets($fp, 512)) {
            $data .= $line;
            if (substr($line, 3, 1) === ' ') {
                break;
            }
        }
        return $data;
    };
    $cmd = function (string $command) use ($fp, $read): string {
        fwrite($fp, $command . "\r\n");
        return $read();
    };
    $expect = function (string $response, string $expected): bool {
        return str_starts_with($response, $expected);
    };

    $boundary = md5(uniqid((string) time(), true));
    $message = "MIME-Version: 1.0\r\n";
    $message .= "Content-Type: multipart/alternative; boundary=\"{$boundary}\"\r\n";
    $message .= "\r\n--{$boundary}\r\n";
    $message .= "Content-Type: text/plain; charset=UTF-8\r\n\r\n{$text}\r\n";
    $message .= "--{$boundary}\r\n";
    $message .= "Content-Type: text/html; charset=UTF-8\r\n\r\n{$html}\r\n";
    $message .= "--{$boundary}--\r\n";

    $read();
    if (!$expect($cmd('EHLO ' . gethostname()), '250')) {
        fclose($fp);
        return false;
    }
    if ($isTls && $port === 587) {
        if (!$expect($cmd('STARTTLS'), '220')) {
            fclose($fp);
            return false;
        }
        if (!stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
            fclose($fp);
            return false;
        }
        if (!$expect($cmd('EHLO ' . gethostname()), '250')) {
            fclose($fp);
            return false;
        }
    }
    if (!$expect($cmd('AUTH LOGIN'), '334')) {
        fclose($fp);
        return false;
    }
    if (!$expect($cmd(base64_encode($user)), '334')) {
        fclose($fp);
        return false;
    }
    if (!$expect($cmd(base64_encode($pass)), '235')) {
        fclose($fp);
        return false;
    }
    if (!$expect($cmd('MAIL FROM:<' . $from . '>'), '250')) {
        fclose($fp);
        return false;
    }
    if (!$expect($cmd('RCPT TO:<' . $to . '>'), '250')) {
        fclose($fp);
        return false;
    }
    if (!$expect($cmd('DATA'), '354')) {
        fclose($fp);
        return false;
    }

    $data = "To: {$to}\r\n";
    $data .= "From: \"Velcro Admin\" <{$from}>\r\n";
    $data .= "Subject: {$subject}\r\n";
    $data .= $message;
    $data .= "\r\n.\r\n";
    $response = $cmd($data);
    $cmd('QUIT');
    fclose($fp);

    return $expect($response, '250');
}

// ─── Webhook Signature Verification ───

/**
 * Verify HMAC-SHA256 webhook signature.
 *
 * @param array<string,mixed> $payload
 */
function verifyWebhookSignature(string $secret, array $payload, ?string $signatureHeader, string $algorithm = 'sha256'): bool
{
    if ($secret === '' || $signatureHeader === null || $signatureHeader === '') {
        return false;
    }
    try {
        // Matches the Node implementation exactly:
        // crypto.createHash(alg).update(secret + JSON.stringify(payload)).digest('hex')
        $computed = hash($algorithm, $secret . json_encode($payload));
        return hash_equals($computed, $signatureHeader);
    } catch (Throwable $e) {
        error_log('Webhook signature verification error: ' . $e->getMessage());
        return false;
    }
}

// ─── HTTP Client ───

/**
 * Make an HTTP request using cURL and return decoded JSON.
 *
 * @param array<string,mixed> $options
 * @return array<string,mixed>
 */
function httpRequest(string $method, string $url, array $options = []): array
{
    $headers = $options['headers'] ?? [];
    $body = $options['body'] ?? null;
    $timeout = $options['timeout'] ?? 30;
    $retries = $options['retries'] ?? 0;

    $lastErr = null;
    for ($attempt = 0; $attempt <= $retries; $attempt++) {
        $ch = curl_init();
        curl_setopt($ch, CURLOPT_URL, $url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, $timeout);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
        
        $caPath = __DIR__ . '/cacert.pem';
        if (file_exists($caPath)) {
            curl_setopt($ch, CURLOPT_CAINFO, $caPath);
        }

        curl_setopt($ch, CURLOPT_CUSTOMREQUEST, strtoupper($method));

        if ($body !== null) {
            if (is_array($body)) {
                $body = json_encode($body);
                $headers[] = 'Content-Type: application/json';
            }
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }

        if (!empty($headers)) {
            curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
        }

        $response = curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);

        if ($response === false) {
            $lastErr = new Exception('cURL error: ' . $err);
            if ($attempt < $retries) {
                usleep((int) (pow(2, $attempt) * 1000000));
                continue;
            }
            throw $lastErr;
        }

        $data = json_decode($response, true);
        if ($data === null && $response !== '') {
            $data = ['raw' => $response];
        }

        if ($status >= 400) {
            $lastErr = new Exception($data['message'] ?? "HTTP error: {$status}", $status);
            $isRetryable = $status >= 500 || $status === 0;
            if ($isRetryable && $attempt < $retries) {
                usleep((int) (pow(2, $attempt) * 1000000));
                continue;
            }
            throw $lastErr;
        }

        return $data ?? [];
    }

    throw $lastErr ?? new Exception('Unknown HTTP error');
}

// ─── Status Mapping ───

const FINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'];
const POLLABLE_STATUSES = ['PENDING', 'AWAITING_DEPOSIT', 'DETECTED', 'PROCESSING', 'INITIATED', 'CONFIRMED', 'RECEIVED', 'VERIFIED'];

const PAJ_STATUS_MAP = [
    'INIT' => 'AWAITING_DEPOSIT',
    'PAID' => 'DETECTED',
    'PROCESSING' => 'PROCESSING',
    'COMPLETED' => 'COMPLETED',
    'FAILED' => 'FAILED',
    'CANCELLED' => 'CANCELLED',
];

function mapPajStatus(?string $raw): string
{
    $s = strtoupper($raw ?? '');
    return PAJ_STATUS_MAP[$s] ?? $s;
}
