<?php

declare(strict_types=1);

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/db.php';

// ─── Response Helpers ───

/**
 * Send a JSON response and exit.
 *
 * @param array<string,mixed> $data
 */
function jsonResponse(array $data, int $statusCode = 200): never
{
    http_response_code($statusCode);
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

/**
 * Message safe to show the public: provider errors pass through (e.g. "amount below minimum"),
 * database errors are logged and hidden.
 */
function publicError(Throwable $e): string
{
    if ($e instanceof PDOException) {
        error_log('DB error: ' . $e->getMessage());
        return 'Internal server error';
    }
    return $e->getMessage();
}

// ─── CORS ───
function handleCors(): void
{
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if (in_array('*', CORS_ORIGINS, true)) {
        header('Access-Control-Allow-Origin: *');
    } elseif ($origin !== '' && in_array($origin, CORS_ORIGINS, true)) {
        header("Access-Control-Allow-Origin: {$origin}");
        header('Access-Control-Allow-Credentials: true');
    }
    header('Access-Control-Allow-Methods: GET, POST, PATCH, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization');
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
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
    // X-Forwarded-For / X-Real-IP are client-controlled, so only REMOTE_ADDR is trusted.
    // ponytail: behind a proxy (e.g. Cloudflare) this is the proxy IP; trust its header only if requests can't bypass it.
    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    return filter_var($ip, FILTER_VALIDATE_IP) ? $ip : 'unknown';
}

/**
 * Stricter than FILTER_VALIDATE_EMAIL, which accepts quotes and other characters
 * that break out of HTML/JS when the email is rendered in the dashboards.
 */
function isValidEmail(string $email): bool
{
    return (bool) preg_match('/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i', $email);
}

// ─── Admin Auth ───

/**
 * Checks the admin password. After 10 failures from one IP, every attempt
 * (even a correct one) is rejected until the 15-minute window rolls over.
 */
function verifyAdminPassword(string $input): bool
{
    $rlKey = 'admin_fail_' . clientIp();
    if (ADMIN_PASSWORD_HASH === '' || !rateLimitCheck($rlKey, 10, 900, true)) {
        return false;
    }
    $clean = preg_replace('/^Bearer\s+/i', '', trim($input));
    if (hash_equals(ADMIN_PASSWORD_HASH, hash('sha256', $clean))) {
        return true;
    }
    rateLimitCheck($rlKey, 10, 900);
    return false;
}

function requireAdminAuth(): void
{
    $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_GET['token'] ?? ($_GET['key'] ?? ''));
    if ($auth === '' && function_exists('apache_request_headers')) {
        $headers = apache_request_headers();
        $auth = $headers['Authorization'] ?? '';
    }
    if (!verifyAdminPassword($auth)) {
        auditLog('ADMIN_AUTH_FAIL', ['ip' => clientIp(), 'userAgent' => $_SERVER['HTTP_USER_AGENT'] ?? 'unknown']);
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

function getPajFee(): float
{
    $settings = loadSettings();
    $fee = (float) ($settings['paj_fee'] ?? $settings['platform_fee'] ?? DEVELOPER_FEE);
    return is_nan($fee) ? DEVELOPER_FEE : $fee;
}

function getPajRateMargin(): float
{
    $settings = loadSettings();
    $margin = (float) ($settings['paj_rate_margin'] ?? 0.0);
    return is_nan($margin) ? 0.0 : $margin;
}

function getDeveloperRecipientForAsset(?string $asset): string
{
    if ($asset === null || $asset === '') {
        return DEVELOPER_RECIPIENT;
    }

    $network = strtolower(explode(':', $asset)[0] ?? '');

    switch ($network) {
        case 'solana':
        case 'svm':
            return DEVELOPER_RECIPIENT_SVM !== '' ? DEVELOPER_RECIPIENT_SVM : DEVELOPER_RECIPIENT;
        case 'tron':
            return DEVELOPER_RECIPIENT_TRON !== '' ? DEVELOPER_RECIPIENT_TRON : DEVELOPER_RECIPIENT;
        case 'ethereum':
        case 'polygon':
        case 'arbitrum':
        case 'optimism':
        case 'base':
        case 'bnb':
        case 'bsc':
        case 'avalanche':
            return DEVELOPER_RECIPIENT_EVM !== '' ? DEVELOPER_RECIPIENT_EVM : DEVELOPER_RECIPIENT;
        default:
            return DEVELOPER_RECIPIENT;
    }
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

function rateLimitCheck(string $key, int $max = RATE_LIMIT_MAX_REQUESTS, int $window = RATE_LIMIT_WINDOW_SECONDS, bool $peek = false): bool
{
    // Prefer APCu for shared-hosting persistence across requests
    if (extension_loaded('apcu') && ini_get('apc.enabled')) {
        $cacheKey = 'velcro_rl_' . $key;
        $now = time();
        $windowKey = $cacheKey . '_' . (int) ($now / $window);
        $count = (int) apcu_fetch($windowKey);
        if ($count >= $max) {
            return false;
        }
        if (!$peek) {
            apcu_store($windowKey, $count + 1, $window);
        }
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
    if (!$peek) {
        @file_put_contents($file, (string) ($count + 1), LOCK_EX);
    }
    return true;
}

// ─── Telegram Real-Time Alerts ───

function sendTelegramAlert(string $htmlMessage): bool
{
    $settings = function_exists('loadSettings') ? loadSettings() : (function_exists('getSettings') ? getSettings() : []);
    $token = !empty($settings['telegram_bot_token']) ? trim((string) $settings['telegram_bot_token']) : (defined('TELEGRAM_BOT_TOKEN') ? TELEGRAM_BOT_TOKEN : '');
    $chatId = !empty($settings['telegram_chat_id']) ? trim((string) $settings['telegram_chat_id']) : (defined('TELEGRAM_CHAT_ID') ? TELEGRAM_CHAT_ID : '');
    $enabled = !empty($settings['telegram_alerts_enabled']) || ($token !== '' && $chatId !== '');

    if (!$enabled || $token === '' || $chatId === '') {
        return false;
    }

    try {
        $ch = curl_init("https://api.telegram.org/bot{$token}/sendMessage");
        $payload = json_encode([
            'chat_id' => $chatId,
            'text' => $htmlMessage,
            'parse_mode' => 'HTML',
            'disable_web_page_preview' => true,
        ]);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 4,
        ]);
        $res = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        return $code === 200;
    } catch (Throwable $e) {
        error_log('Telegram alert failed: ' . $e->getMessage());
        return false;
    }
}

function ensureReminderSchema(): void
{
    static $done = false;
    if ($done) {
        return;
    }
    $flag = BASE_PATH . '/data/.reminder_schema_v1';
    if (is_file($flag)) {
        $done = true;
        return;
    }
    try {
        Database::execute('ALTER TABLE `transactions` ADD COLUMN `reminder_sent_at` DATETIME NULL DEFAULT NULL AFTER `receipt_sent_at`');
    } catch (Throwable $e) {}
    @file_put_contents($flag, gmdate('c'));
    $done = true;
}

// ─── Mail ───

function mailConfigured(): bool
{
    return MAILHIVE_API_KEY !== '' || (SMTP_HOST !== '' && SMTP_USER !== '' && SMTP_PASS !== '') || function_exists('mail');
}

/** Sends one email: Mailhive Send API when MAILHIVE_API_KEY is set, SMTP when configured, or PHP mail() fallback. */
function sendEmailTo(string $to, string $subject, string $html, string $text): bool
{
    $to = strtolower(trim($to));
    if (!filter_var($to, FILTER_VALIDATE_EMAIL)) {
        error_log("sendEmailTo skipped invalid email: {$to}");
        return false;
    }

    // 1. Try Mailhive Send API when configured
    if (MAILHIVE_API_KEY !== '') {
        try {
            $from = MAIL_FROM !== '' ? MAIL_FROM : 'noreply@usevelcro.com';
            $res = httpRequest('POST', 'https://api.mailhive.africa/v1/send/emails', [
                'headers' => ['Authorization: Bearer ' . MAILHIVE_API_KEY],
                'body' => ['from' => 'Velcro <' . $from . '>', 'to' => $to, 'subject' => $subject, 'html' => $html, 'text' => $text],
                'timeout' => 15,
            ]);
            $suppressed = array_map('strtolower', (array) ($res['suppressed'] ?? []));
            if (!empty($res['id']) && !in_array($to, $suppressed, true)) {
                return true;
            }
            error_log("Mailhive suppressed or skipped delivery to {$to}: " . json_encode($res));
        } catch (Throwable $e) {
            error_log("Mailhive send failed for {$to}: " . $e->getMessage() . " — falling back to secondary transport");
        }
    }

    // 2. Try SMTP when configured
    if (SMTP_HOST !== '' && SMTP_USER !== '' && SMTP_PASS !== '') {
        try {
            if (smtpSend($to, $subject, $html, $text)) {
                return true;
            }
            error_log("SMTP send returned false for {$to} — falling back to mail()");
        } catch (Throwable $e) {
            error_log("SMTP send exception for {$to}: " . $e->getMessage() . " — falling back to mail()");
        }
    }

    // 3. Fallback to PHP mail()
    if (function_exists('mail')) {
        $boundary = md5(uniqid((string) time(), true));
        $from = MAIL_FROM !== '' ? MAIL_FROM : (SMTP_FROM !== '' ? SMTP_FROM : 'noreply@usevelcro.com');
        $cleanFrom = filter_var($from, FILTER_VALIDATE_EMAIL) ? $from : 'noreply@usevelcro.com';
        $headers = [
            'From: "Velcro" <' . $cleanFrom . '>',
            'Reply-To: ' . $cleanFrom,
            'Return-Path: ' . $cleanFrom,
            'MIME-Version: 1.0',
            'Content-Type: multipart/alternative; boundary="' . $boundary . '"',
            'X-Mailer: Velcro/1.2.0',
            'Auto-Submitted: auto-generated',
        ];
        $body = "--{$boundary}\r\n"
            . "Content-Type: text/plain; charset=UTF-8\r\n\r\n{$text}\r\n"
            . "--{$boundary}\r\n"
            . "Content-Type: text/html; charset=UTF-8\r\n\r\n{$html}\r\n"
            . "--{$boundary}--";
        $ok = @mail($to, $subject, $body, implode("\r\n", $headers), '-f' . $cleanFrom);
        if (!$ok) {
            // Retry without the -f flag in case hosting disallows custom envelope parameters
            $ok = @mail($to, $subject, $body, implode("\r\n", $headers));
        }
        return $ok;
    }

    error_log("No email transport succeeded for recipient: {$to}");
    return false;
}

function sendMail(string $subject, string $html, string $text): array
{
    if (!mailConfigured() || ADMIN_EMAIL === '') {
        return ['sent' => false, 'reason' => 'Email not configured'];
    }
    try {
        $sent = sendEmailTo(ADMIN_EMAIL, $subject, $html, $text);
        if ($sent || MAILHIVE_API_KEY !== '') {
            return ['sent' => $sent];
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
 * Verify Switch HMAC-SHA256 webhook signature.
 * Switch computes HMAC-SHA256 of the raw body using the SWITCH_SERVICE_KEY.
 *
 * @param string $rawBody
 * @param ?string $signatureHeader
 * @param string $serviceKey
 */
function verifySwitchWebhook(string $rawBody, ?string $signatureHeader, string $serviceKey): bool
{
    if ($serviceKey === '' || $signatureHeader === null || trim($signatureHeader) === '') {
        return false;
    }
    try {
        $expected = hash_hmac('sha256', $rawBody, $serviceKey);
        return hash_equals($expected, trim($signatureHeader));
    } catch (Throwable $e) {
        error_log('Switch webhook signature verification error: ' . $e->getMessage());
        return false;
    }
}

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
        // Matches the Node implementation:
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
            $errMsg = $data['message'] ?? $data['error'] ?? "HTTP error: {$status}";
            if (is_array($errMsg)) {
                $errMsg = json_encode($errMsg);
            }
            $lastErr = new Exception((string) $errMsg, $status);
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
    'PENDING' => 'AWAITING_DEPOSIT',
    'AWAITING_DEPOSIT' => 'AWAITING_DEPOSIT',
    'PAID' => 'DETECTED',
    'DETECTED' => 'DETECTED',
    'PROCESSING' => 'PROCESSING',
    'COMPLETED' => 'COMPLETED',
    'SUCCESS' => 'COMPLETED',
    'SUCCESSFUL' => 'COMPLETED',
    'DONE' => 'COMPLETED',
    'FAILED' => 'FAILED',
    'CANCELLED' => 'CANCELLED',
    'EXPIRED' => 'EXPIRED',
    'TRANSACTION.COMPLETED' => 'COMPLETED',
    'TRANSACTION.SUCCESSFUL' => 'COMPLETED',
    'TRANSACTION.FAILED' => 'FAILED',
];

function mapPajStatus(?string $raw): string
{
    $s = strtoupper(trim($raw ?? ''));
    return PAJ_STATUS_MAP[$s] ?? $s;
}

/**
 * Calculate accurate USD and NGN volume for any transaction row.
 *
 * @param array<string,mixed> $t
 * @return array{usd: float, ngn: float}
 */
function calculateTxVolumes(array $t): array
{
    $type = strtoupper((string) ($t['type'] ?? ''));
    $channel = strtoupper((string) ($t['channel'] ?? ''));
    $ref = (string) ($t['reference'] ?? '');
    $isPaj = ($channel === 'PAJ' || str_starts_with($ref, 'paj_') || str_starts_with($ref, 'pj_'));
    $currency = strtoupper((string) ($t['currency'] ?? ''));
    $rate = (float) ($t['rate'] ?? 0);
    if ($rate <= 0) {
        $rate = 1500.0;
    }
    $amount = (float) ($t['amount'] ?? 0);
    $destAmount = (float) ($t['destination_amount'] ?? 0);
    $asset = strtoupper((string) ($t['asset'] ?? ''));
    $destCurrency = strtoupper((string) ($t['destination_currency'] ?? ''));
    $isDollarAsset = in_array($asset, ['USDT', 'USDC', 'USD'], true) || in_array($currency, ['USD', 'USDT', 'USDC'], true) || in_array($destCurrency, ['USD', 'USDT', 'USDC'], true);

    $usd = 0.0;
    $ngn = 0.0;

    if ($type === 'ONRAMP') {
        // ONRAMP: User pays in fiat NGN (amount) to buy crypto
        $ngn = $amount;
        if ($isDollarAsset && $destAmount > 0) {
            $usd = $destAmount;
        } else {
            $usd = $amount / $rate;
        }
    } elseif ($type === 'OFFRAMP') {
        if ($isPaj || $currency === 'NGN') {
            // PAJ offramp: amount is stored as fiat NGN
            $ngn = $amount;
            $usd = $amount / $rate;
        } else {
            // Switch offramp:
            // destination_amount is NGN payout to user bank
            // amount is crypto/USD sold by user
            if ($destAmount > 0) {
                $ngn = $destAmount;
                $usd = ($isDollarAsset && $amount > 0) ? $amount : ($destAmount / $rate);
            } elseif ($isDollarAsset && $amount > 0) {
                $usd = $amount;
                $ngn = $amount * $rate;
            } else {
                $usd = $amount > 0 ? ($amount / $rate) : 0.0;
                $ngn = $usd * $rate;
            }
        }
    }

    return [
        'usd' => round($usd, 2),
        'ngn' => round($ngn, 2),
    ];
}

/**
 * Update a transaction record in the database with authoritative data from Switch.
 * Captures the actual crypto amount deposited (even if different from initial estimate),
 * the actual destination amount (NGN paid to bank or crypto sent to wallet),
 * the exact exchange rate, hash, and status.
 *
 * @param string $reference
 * @param array<string,mixed> $d Switch data payload
 * @return ?array The updated transaction row
 */
function updateSwitchTransactionFromData(string $reference, array $d): ?array
{
    if (empty($d) || empty($d['status'])) {
        return null;
    }

    $rawStatus = (string) $d['status'];
    $normalizedStatus = strtoupper(trim($rawStatus));
    if ($normalizedStatus === 'SUCCESS' || $normalizedStatus === 'SUCCESSFUL') {
        $normalizedStatus = 'COMPLETED';
    }

    $source = $d['source'] ?? [];
    $destination = $d['destination'] ?? [];
    $deposit = $d['deposit'] ?? [];
    $meta = $d['meta'] ?? [];

    if (isset($d['deposit'])) {
        if (isset($d['deposit']['note'])) {
            if (is_array($d['deposit']['note'])) {
                $d['deposit']['note'] = array_map(
                    static fn ($n) => is_string($n) ? str_replace(['30 minutes', '30 minute', '30-minute', '30 mins'], '60 minutes', $n) : $n,
                    $d['deposit']['note']
                );
            } elseif (is_string($d['deposit']['note'])) {
                $d['deposit']['note'] = str_replace(['30 minutes', '30 minute', '30-minute', '30 mins'], '60 minutes', $d['deposit']['note']);
            }
        }
        if (!empty($d['deposit']['expires_at'])) {
            $createdBase = !empty($tx['created_at']) ? strtotime((string) $tx['created_at']) : time();
            $d['deposit']['expires_at'] = gmdate('Y-m-d\TH:i:s.v\Z', $createdBase + 3600);
        }
    }

    $realRate = !empty($d['rate']) ? (float) $d['rate'] : null;
    $hash = $meta['hash'] ?? ($d['hash'] ?? null);
    $explorerUrl = $meta['explorer_url'] ?? ($d['explorer_url'] ?? null);
    $direction = strtoupper((string) ($d['type'] ?? ''));

    // Check existing transaction
    $tx = Database::selectOne(
        'SELECT * FROM `transactions` WHERE `reference` = :ref1 OR `switch_reference` = :ref2',
        ['ref1' => $reference, 'ref2' => $reference]
    );

    // If still not found, check if $d has reference or id
    if (!$tx && !empty($d['reference'])) {
        $dRef = (string) $d['reference'];
        $tx = Database::selectOne(
            'SELECT * FROM `transactions` WHERE `reference` = :ref1 OR `switch_reference` = :ref2',
            ['ref1' => $dRef, 'ref2' => $dRef]
        );
    }
    if (!$tx && !empty($d['id'])) {
        $dId = (string) $d['id'];
        $tx = Database::selectOne(
            'SELECT * FROM `transactions` WHERE `reference` = :ref1 OR `switch_reference` = :ref2',
            ['ref1' => $dId, 'ref2' => $dId]
        );
    }

    $isOfframp = ($tx && strtoupper((string)$tx['type']) === 'OFFRAMP') || $direction === 'OFFRAMP';

    if ($isOfframp) {
        // OFFRAMP (Sell crypto for NGN)
        $realCrypto = null;
        if (isset($source['amount']) && (float)$source['amount'] > 0) {
            $realCrypto = (float)$source['amount'];
        } elseif (isset($deposit['amount']) && (float)$deposit['amount'] > 0) {
            $realCrypto = (float)$deposit['amount'];
        }

        $realFiat = isset($destination['amount']) && (float)$destination['amount'] > 0 ? (float)$destination['amount'] : null;

        if (!$realRate && $realCrypto && $realFiat && $realCrypto > 0) {
            $realRate = $realFiat / $realCrypto;
        }

        $params = [
            'status' => $normalizedStatus,
            'real_crypto' => $realCrypto,
            'real_source_amount' => $realCrypto,
            'real_dest_amount' => $realFiat,
            'real_rate' => $realRate,
            'hash' => $hash,
            'explorer_url' => $explorerUrl,
            'meta' => jsonEncodeNullable($d),
        ];

        if ($tx && !empty($tx['id'])) {
            $whereSql = 'WHERE `id` = :id';
            $params['id'] = $tx['id'];
        } else {
            $whereSql = 'WHERE `reference` = :ref1 OR `switch_reference` = :ref2';
            $params['ref1'] = $reference;
            $params['ref2'] = $reference;
        }

        Database::safeExecute(
            "UPDATE `transactions` SET 
                `status` = :status,
                `amount` = COALESCE(:real_crypto, `amount`),
                `source_amount` = COALESCE(:real_source_amount, `source_amount`, `amount`),
                `destination_amount` = COALESCE(:real_dest_amount, `destination_amount`),
                `rate` = COALESCE(:real_rate, `rate`),
                `hash` = COALESCE(:hash, `hash`),
                `explorer_url` = COALESCE(:explorer_url, `explorer_url`),
                `meta` = :meta,
                `updated_at` = NOW()
            {$whereSql}",
            $params
        );
    } else {
        // ONRAMP (Buy crypto with NGN)
        $storedMeta = $tx['meta'] ?? [];
        if (is_string($storedMeta)) {
            $storedMeta = json_decode($storedMeta, true) ?: [];
        }
        $feePercent = (is_array($storedMeta) && isset($storedMeta['_velcro_onramp_fee_percent']))
            ? (float) $storedMeta['_velcro_onramp_fee_percent']
            : getPlatformFee();

        $d = normalizeSwitchOnrampAmount($d, $feePercent);
        $d['_velcro_onramp_fee_percent'] = $feePercent;
        $destination = $d['destination'] ?? [];
        $feeDev = $d['developer_fee']['amount'] ?? ($d['fee']['developer'] ?? null);

        $realFiat = isset($source['amount']) && (float)$source['amount'] > 0 ? (float)$source['amount'] : null;
        $realCrypto = isset($destination['amount']) && (float)$destination['amount'] > 0 ? (float)$destination['amount'] : null;

        if (!$realRate && $realCrypto && $realFiat && $realCrypto > 0) {
            $realRate = $realFiat / $realCrypto;
        }

        $params = [
            'status' => $normalizedStatus,
            'real_fiat' => $realFiat,
            'real_source_amount' => $realFiat,
            'real_crypto' => $realCrypto,
            'fee_developer' => $feeDev !== null ? (float) $feeDev : null,
            'real_rate' => $realRate,
            'hash' => $hash,
            'explorer_url' => $explorerUrl,
            'meta' => jsonEncodeNullable($d),
        ];

        if ($tx && !empty($tx['id'])) {
            $whereSql = 'WHERE `id` = :id';
            $params['id'] = $tx['id'];
        } else {
            $whereSql = 'WHERE `reference` = :ref1 OR `switch_reference` = :ref2';
            $params['ref1'] = $reference;
            $params['ref2'] = $reference;
        }

        Database::safeExecute(
            "UPDATE `transactions` SET 
                `status` = :status,
                `amount` = COALESCE(:real_fiat, `amount`),
                `source_amount` = COALESCE(:real_source_amount, `source_amount`, `amount`),
                `destination_amount` = COALESCE(:real_crypto, `destination_amount`),
                `fee_developer` = COALESCE(:fee_developer, `fee_developer`),
                `rate` = COALESCE(:real_rate, `rate`),
                `hash` = COALESCE(:hash, `hash`),
                `explorer_url` = COALESCE(:explorer_url, `explorer_url`),
                `meta` = :meta,
                `updated_at` = NOW()
            {$whereSql}",
            $params
        );
    }

    $finalTx = ($tx && !empty($tx['id']))
        ? Database::selectOne('SELECT * FROM `transactions` WHERE `id` = :id', ['id' => $tx['id']])
        : Database::selectOne('SELECT * FROM `transactions` WHERE `reference` = :ref1 OR `switch_reference` = :ref2', ['ref1' => $reference, 'ref2' => $reference]);

    if ($finalTx && $normalizedStatus === 'COMPLETED') {
        if (empty($finalTx['receipt_sent_at'])) {
            sendTransactionReceiptNow($finalTx);
        }
        try {
            $tType = $finalTx['type'];
            $tAmt = number_format((float) ($finalTx['amount'] ?? 0), 2);
            $tDest = number_format((float) ($finalTx['destination_amount'] ?? 0), 4);
            $tAsset = $finalTx['asset'] ?? 'USDT';
            $tEmail = !empty($finalTx['email']) ? "\n👤 <b>User:</b> {$finalTx['email']}" : '';
            $tRef = $finalTx['reference'];
            $tProfit = !empty($finalTx['fee_developer']) && (float) $finalTx['fee_developer'] > 0
                ? "\n💰 <b>Platform Fee:</b> " . number_format((float) $finalTx['fee_developer'], 4)
                : '';
            $tHash = !empty($finalTx['hash']) ? "\n🔗 <b>TX:</b> <code>" . substr((string) $finalTx['hash'], 0, 12) . "…</code>" : '';
            sendTelegramAlert("🚀 <b>Velcro Order Completed!</b>\n\n📌 <b>Type:</b> {$tType}\n💵 <b>Amount:</b> ₦{$tAmt} → {$tDest} {$tAsset}{$tProfit}{$tEmail}{$tHash}\n🆔 <b>Ref:</b> <code>{$tRef}</code>");
        } catch (Throwable $alertErr) {}
    }

    return $finalTx;
}

/** Convert Switch's gross onramp destination to the customer amount once.
 * Keep the fee snapshot in the stored payload so polling uses the order's fee.
 */
function normalizeSwitchOnrampAmount(array $data, float $feePercent): array
{
    if (isset($data['_velcro_onramp_fee_percent'])) {
        return $data;
    }
    if (isset($data['destination']['amount']) && is_numeric($data['destination']['amount'])) {
        $gross = (float) $data['destination']['amount'];
        $factor = $feePercent > 0 && $feePercent < 100 ? 1 - $feePercent / 100 : 1;
        $data['_velcro_onramp_gross_amount'] = $gross;
        $data['_velcro_onramp_fee_percent'] = $feePercent;
        $net = $gross * $factor;
        if ($feePercent > 0 && abs($net - round($net, 2)) < 0.00001) {
            $net = round($net, 2);
        } else {
            $net = round($net, 6);
        }
        $data['destination']['amount'] = $net;
    }
    return $data;
}

function buildExplorerUrl(string $hash, ?string $asset = null): string
{
    $hash = trim($hash);
    if ($hash === '') {
        return '';
    }
    $chain = 'solana';
    if ($asset !== null && $asset !== '') {
        $parts = explode(':', strtolower($asset));
        $chain = $parts[0];
    } elseif (str_starts_with($hash, '0x')) {
        $chain = 'base';
    }

    $map = [
        'solana' => "https://solscan.io/tx/{$hash}",
        'sol' => "https://solscan.io/tx/{$hash}",
        'ethereum' => "https://etherscan.io/tx/{$hash}",
        'eth' => "https://etherscan.io/tx/{$hash}",
        'bsc' => "https://bscscan.com/tx/{$hash}",
        'binance' => "https://bscscan.com/tx/{$hash}",
        'polygon' => "https://polygonscan.com/tx/{$hash}",
        'matic' => "https://polygonscan.com/tx/{$hash}",
        'arbitrum' => "https://arbiscan.io/tx/{$hash}",
        'base' => "https://basescan.org/tx/{$hash}",
        'tron' => "https://tronscan.org/#/transaction/{$hash}",
        'trx' => "https://tronscan.org/#/transaction/{$hash}",
        'optimism' => "https://optimistic.etherscan.io/tx/{$hash}",
        'avalanche' => "https://snowtrace.io/tx/{$hash}",
        'avax' => "https://snowtrace.io/tx/{$hash}",
    ];

    return $map[$chain] ?? (str_starts_with($hash, '0x') ? "https://basescan.org/tx/{$hash}" : "https://solscan.io/tx/{$hash}");
}

require_once __DIR__ . '/emails.php';
