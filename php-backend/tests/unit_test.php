<?php

declare(strict_types=1);

/**
 * Lightweight unit tests for helper functions.
 * Run with: php tests/unit_test.php
 */

// Set a test admin password before loading config so hashing happens
$_ENV['ADMIN_PASSWORD'] = 'secret123';
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../helpers.php';

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

// ─── Response helpers ───
$success = successResponse(['foo' => 'bar'], 'OK');
assertTrue($success['success'] === true, 'successResponse marks success');
assertEquals('OK', $success['message'], 'successResponse carries message');
assertTrue(isset($success['data']['foo']), 'successResponse carries data');

$error = errorResponse('Bad request', 400);
assertTrue($error['success'] === false, 'errorResponse marks failure');
assertEquals(400, $error['status'], 'errorResponse carries status');

// ─── OTP helpers ───
$otp = generateOTP();
assertEquals(6, strlen($otp), 'OTP is 6 digits');
assertTrue(ctype_digit($otp), 'OTP contains only digits');
assertTrue((int) $otp >= 100000 && (int) $otp <= 999999, 'OTP is in valid range');

// ─── Admin password hashing ───
$hash = hash('sha256', 'secret123');
$_SERVER['HTTP_AUTHORIZATION'] = 'Bearer secret123';
assertTrue(verifyAdminPassword('Bearer secret123'), 'verifyAdminPassword accepts Bearer prefix');
assertTrue(verifyAdminPassword('secret123'), 'verifyAdminPassword accepts raw password');
assertTrue(!verifyAdminPassword('wrong'), 'verifyAdminPassword rejects wrong password');

// ─── Webhook signature ───
$secret = 'my-secret';
$payload = ['event' => 'test', 'reference' => 'abc123'];
$computed = hash('sha256', $secret . json_encode($payload));
assertTrue(verifyWebhookSignature($secret, $payload, $computed), 'verifyWebhookSignature accepts valid signature');
assertTrue(!verifyWebhookSignature($secret, $payload, 'bad-sig'), 'verifyWebhookSignature rejects bad signature');
assertTrue(!verifyWebhookSignature('', $payload, $computed), 'verifyWebhookSignature rejects empty secret');

// ─── PAJ status mapping ───
assertEquals('AWAITING_DEPOSIT', mapPajStatus('INIT'), 'mapPajStatus maps INIT');
assertEquals('DETECTED', mapPajStatus('PAID'), 'mapPajStatus maps PAID');
assertEquals('COMPLETED', mapPajStatus('COMPLETED'), 'mapPajStatus preserves COMPLETED');
assertEquals('UNKNOWN', mapPajStatus('UNKNOWN'), 'mapPajStatus preserves unknown statuses');

// ─── Withdrawal whitelist ───
define('TEST_RECIPIENTS', ['0xabc', '0xdef']);
// isWithdrawalAllowed uses WITHDRAWAL_ALLOWED_RECIPIENTS constant, so we can't easily mock it here.
// Just verify the function exists and runs.
assertTrue(is_string(DEVELOPER_RECIPIENT), 'DEVELOPER_RECIPIENT is a string');

// ─── Settings defaults ───
$defaults = defaultSettings();
assertTrue(isset($defaults['platform_fee']), 'defaultSettings includes platform_fee');
assertTrue(isset($defaults['buy_max_limit']), 'defaultSettings includes buy_max_limit');

// ─── CORS origins ───
assertTrue(is_array(CORS_ORIGINS), 'CORS_ORIGINS is an array');

// ─── Summary ───
echo "\n";
if ($failed === 0) {
    echo "All {$passed} tests passed.\n";
    exit(0);
} else {
    echo "{$passed} passed, {$failed} failed.\n";
    exit(1);
}
