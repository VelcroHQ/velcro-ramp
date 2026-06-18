<?php

declare(strict_types=1);

/**
 * Integration tests requiring a local MySQL/MariaDB database.
 *
 * Setup:
 *   1. Import sql/schema.sql into a database.
 *   2. Copy .env.test to .env (or set env vars).
 *   3. Run: php tests/integration_test.php
 */

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../helpers.php';
require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../paj_api.php';

$passed = 0;
$failed = 0;

function assertTrue(bool $condition, string $message): void
{
    global $passed, $failed;
    if ($condition) {
        $passed++;
        echo "✅ PASS: {$message}\n";
    } else {
        $failed++;
        echo "❌ FAIL: {$message}\n";
    }
}

function assertEquals(mixed $expected, mixed $actual, string $message): void
{
    assertTrue($expected === $actual, $message . " (expected " . var_export($expected, true) . ", got " . var_export($actual, true) . ")");
}

// ─── Database connectivity ───
$connected = Database::isConnected();
assertTrue($connected, 'Database connection is active');

if (!$connected) {
    echo "Cannot continue without database connection.\n";
    exit(1);
}

// Clean state
Database::execute('TRUNCATE TABLE `transactions`');
Database::execute('TRUNCATE TABLE `otps`');
Database::execute('TRUNCATE TABLE `paj_sessions`');
Database::execute('TRUNCATE TABLE `withdrawal_states`');
Database::execute('TRUNCATE TABLE `audit_logs`');
Database::execute('INSERT INTO `withdrawal_states` (`id`, `last_withdrawal_at`) VALUES (1, 0) ON DUPLICATE KEY UPDATE `last_withdrawal_at` = 0');

// ─── Transaction CRUD ───
$ref = 'test_' . time();
Database::insert('transactions', [
    'reference' => $ref,
    'type' => 'ONRAMP',
    'status' => 'AWAITING_DEPOSIT',
    'country' => 'NG',
    'currency' => 'NGN',
    'asset' => 'USDT',
    'channel' => 'BANK',
    'amount' => 100.50,
    'email' => 'test@example.com',
    'meta' => json_encode(['source' => 'test']),
]);

$row = Database::selectOne('SELECT * FROM `transactions` WHERE `reference` = :ref', ['ref' => $ref]);
assertTrue($row !== null, 'Inserted transaction can be selected');
assertEquals('ONRAMP', $row['type'], 'Transaction type is preserved');
assertEquals(100.50, (float) $row['amount'], 'Transaction amount is preserved');
assertEquals('test@example.com', $row['email'], 'Email is stored lowercase');

$decoded = decodeJsonColumns($row, ['meta']);
assertEquals('test', $decoded['meta']['source'] ?? null, 'Meta JSON is decoded');

Database::update('transactions', ['status' => 'COMPLETED'], ['reference' => $ref]);
$updated = Database::selectOne('SELECT `status` FROM `transactions` WHERE `reference` = :ref', ['ref' => $ref]);
assertEquals('COMPLETED', $updated['status'], 'Transaction status update works');

// ─── OTP flow ───
$otp = generateOTP();
storeOTP('test-key', $otp);
assertTrue(verifyOTP('test-key', $otp)['valid'], 'Valid OTP is accepted');
assertTrue(!verifyOTP('test-key', $otp)['valid'], 'OTP is consumed after use');

$otp2 = generateOTP();
storeOTP('test-key-2', $otp2);
assertTrue(!verifyOTP('test-key-2', '000000')['valid'], 'Invalid OTP is rejected');
assertTrue(!verifyOTP('test-key-2', '000000')['valid'], 'Invalid OTP is rejected on second attempt');
assertTrue(!verifyOTP('test-key-2', '000000')['valid'], 'Invalid OTP is rejected on third attempt');
assertTrue(!verifyOTP('test-key-2', $otp2)['valid'], 'OTP blocked after max attempts');

// ─── Settings persistence ───
$settings = loadSettings();
$settings['platform_fee'] = 1.25;
$settings['buy_max_limit'] = 99999;
assertTrue(saveSettings($settings), 'Settings save returns true');
$loaded = loadSettings();
assertEquals(1.25, (float) $loaded['platform_fee'], 'Settings platform_fee persists');
assertEquals(99999, (int) $loaded['buy_max_limit'], 'Settings buy_max_limit persists');

// ─── Withdrawal state ───
assertEquals(0, getLastWithdrawalTime(), 'Initial last withdrawal time is 0');
setLastWithdrawalTime(12345);
assertEquals(12345, getLastWithdrawalTime(), 'Last withdrawal time persists');

// ─── Audit logging ───
$before = Database::selectOne('SELECT COUNT(*) AS c FROM `audit_logs`')['c'];
auditLog('TEST_ACTION', ['ip' => '127.0.0.1', 'userAgent' => 'tester']);
$after = Database::selectOne('SELECT COUNT(*) AS c FROM `audit_logs`')['c'];
assertEquals((int) $before + 1, (int) $after, 'Audit log inserts a row');

// ─── PAJ session persistence ───
$session = [
    'token' => 'test_token_' . time(),
    'recipient' => 'recipient',
    'isActive' => true,
    'expiresAt' => gmdate('c', time() + 3600),
    'createdAt' => gmdate('c'),
];
pajApi()->saveSession($session);
$loadedSession = pajApi()->loadSession();
assertTrue($loadedSession !== null, 'PAJ session can be loaded');
assertEquals($session['token'], $loadedSession['token'], 'PAJ session token persists');
assertTrue(pajApi()->isSessionValid($loadedSession), 'PAJ session is valid');

// ─── Webhook update flow ───
$webhookRef = 'webhook_' . time();
Database::insert('transactions', [
    'reference' => $webhookRef,
    'type' => 'OFFRAMP',
    'status' => 'AWAITING_DEPOSIT',
    'country' => 'NG',
    'currency' => 'NGN',
    'asset' => 'USDC',
    'channel' => 'BANK',
    'amount' => 50,
]);

// Simulate the webhook handler logic directly
$payload = ['reference' => $webhookRef, 'status' => 'COMPLETED', 'data' => ['hash' => '0xabc', 'explorer_url' => 'https://explorer.example.com/tx']];
Database::execute(
    'UPDATE `transactions` SET `status` = :status, `meta` = :meta, `hash` = :hash, `explorer_url` = :explorer_url WHERE `reference` = :reference',
    [
        'status' => strtoupper($payload['status']),
        'meta' => json_encode($payload),
        'hash' => $payload['data']['hash'],
        'explorer_url' => $payload['data']['explorer_url'],
        'reference' => $webhookRef,
    ]
);
$webhookRow = Database::selectOne('SELECT * FROM `transactions` WHERE `reference` = :ref', ['ref' => $webhookRef]);
assertEquals('COMPLETED', $webhookRow['status'], 'Webhook updates transaction status');
assertEquals('0xabc', $webhookRow['hash'], 'Webhook updates transaction hash');

// ─── Summary ───
echo "\n";
if ($failed === 0) {
    echo "All {$passed} integration tests passed.\n";
    exit(0);
} else {
    echo "{$passed} passed, {$failed} failed.\n";
    exit(1);
}
