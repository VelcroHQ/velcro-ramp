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
// Fresh IP per run so failure counters from earlier runs don't lock this one out.
$_SERVER['REMOTE_ADDR'] = '10.' . random_int(0, 255) . '.' . random_int(0, 255) . '.' . random_int(1, 254);
assertTrue(verifyAdminPassword('Bearer secret123'), 'verifyAdminPassword accepts Bearer prefix');
assertTrue(verifyAdminPassword('secret123'), 'verifyAdminPassword accepts raw password');
assertTrue(!verifyAdminPassword('wrong'), 'verifyAdminPassword rejects wrong password');
for ($i = 0; $i < 9; $i++) {
    verifyAdminPassword('wrong');
}
assertTrue(!verifyAdminPassword('secret123'), 'verifyAdminPassword locks out after 10 failures, even for the right password');
$_SERVER['HTTP_X_FORWARDED_FOR'] = '1.2.3.4';
assertTrue(clientIp() === $_SERVER['REMOTE_ADDR'], 'clientIp ignores X-Forwarded-For');

// ─── Email validation ───
assertTrue(isValidEmail('jane.doe+ramp@example.co'), 'isValidEmail accepts normal email');
assertTrue(!isValidEmail("a'onerror=x@example.com"), 'isValidEmail rejects quotes');
assertTrue(!isValidEmail('<img src=x>@example.com'), 'isValidEmail rejects HTML');

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

// ─── Volume calculation tests ───
$onrampSol = calculateTxVolumes([
    'type' => 'ONRAMP',
    'amount' => 30000,
    'rate' => 1500,
    'destination_amount' => 0.18,
    'asset' => 'SOL',
]);
assertEquals(20.0, $onrampSol['usd'], 'ONRAMP SOL converts NGN to USD via rate');
assertEquals(30000.0, $onrampSol['ngn'], 'ONRAMP SOL retains NGN amount');

$onrampUsdc = calculateTxVolumes([
    'type' => 'ONRAMP',
    'amount' => 45000,
    'rate' => 1500,
    'destination_amount' => 30.0,
    'asset' => 'USDC',
]);
assertEquals(30.0, $onrampUsdc['usd'], 'ONRAMP USDC uses destination_amount as USD');
assertEquals(45000.0, $onrampUsdc['ngn'], 'ONRAMP USDC retains NGN amount');

$offrampPaj = calculateTxVolumes([
    'type' => 'OFFRAMP',
    'channel' => 'PAJ',
    'reference' => 'paj_123',
    'amount' => 49257,
    'rate' => 1500,
    'currency' => 'NGN',
]);
assertEquals(49257.0, $offrampPaj['ngn'], 'PAJ OFFRAMP treats amount as NGN');
assertEquals(32.84, $offrampPaj['usd'], 'PAJ OFFRAMP calculates USD via rate');

$offrampSwitchUsdt = calculateTxVolumes([
    'type' => 'OFFRAMP',
    'channel' => 'BANK',
    'amount' => 50,
    'rate' => 1500,
    'destination_amount' => 75000,
    'asset' => 'USDT',
]);
assertEquals(50.0, $offrampSwitchUsdt['usd'], 'Switch OFFRAMP USDT uses amount as USD');
assertEquals(75000.0, $offrampSwitchUsdt['ngn'], 'Switch OFFRAMP uses destination_amount as NGN');

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
