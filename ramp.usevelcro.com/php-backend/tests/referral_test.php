<?php

declare(strict_types=1);

/**
 * Referral earnings checks against an in-memory SQLite DB (no MySQL needed).
 * Run with: php tests/referral_test.php
 */

$tmp = sys_get_temp_dir() . '/velcro_ref_test_' . getmypid();
@mkdir($tmp . '/data', 0777, true);
define('BASE_PATH', $tmp); // isolated settings/flag files
// ensureReferralSchema() is MySQL DDL; mark it done and build the tables below instead.
file_put_contents($tmp . '/data/.referral_schema_v1', 'test');

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../helpers.php';
require_once __DIR__ . '/../router.php';
require_once __DIR__ . '/../routes/referrals.php';

$pdo = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
(new ReflectionProperty(Database::class, 'pdo'))->setValue(null, $pdo);
$pdo->exec('CREATE TABLE transactions (id INTEGER PRIMARY KEY, type TEXT, channel TEXT, status TEXT, asset TEXT, amount REAL, destination_amount REAL, rate REAL, email TEXT, referrer_code TEXT, referral_fee_percent REAL)');
$pdo->exec('CREATE TABLE referrers (id INTEGER PRIMARY KEY, email TEXT UNIQUE, code TEXT UNIQUE, fee_percent REAL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)');
$pdo->exec("CREATE TABLE referral_withdrawals (id INTEGER PRIMARY KEY, email TEXT, amount_usd REAL, chain TEXT, address TEXT, status TEXT DEFAULT 'PENDING')");
$pdo->exec('CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, action TEXT, ip TEXT, user_agent TEXT, details TEXT)');

$failed = 0;
function check(bool $ok, string $msg): void
{
    global $failed;
    echo ($ok ? '✅' : '❌') . " {$msg}\n";
    $failed += $ok ? 0 : 1;
}
function near(float $a, float $b): bool
{
    return abs($a - $b) < 0.0001;
}

// ── Attribution ──
Database::insert('referrers', ['email' => 'amaka@example.com', 'code' => 'AMAKA234']);
Database::insert('referrers', ['email' => 'vip@example.com', 'code' => 'VIPVIP99', 'fee_percent' => 1.0]);
check(referralFieldsFor('amaka234', 'buyer@example.com') === ['referrer_code' => 'AMAKA234', 'referral_fee_percent' => 0.3], 'code matched case-insensitively, default 0.3% snapshotted');
check(referralFieldsFor('VIPVIP99', 'buyer@example.com')['referral_fee_percent'] === 1.0, 'per-referrer override fee is snapshotted');
check(referralFieldsFor('AMAKA234', 'Amaka@Example.com') === [], 'no self-referral');
check(referralFieldsFor('NOPE1234', 'buyer@example.com') === [], 'unknown code ignored');
check(referralFieldsFor("x' OR 1=1 --", 'buyer@example.com') === [], 'malformed code ignored');
check(referralFieldsFor('', null) === [], 'no code, no referral');

// ── USD volume per order shape ──
check(near(referralUsdVolume(['type' => 'OFFRAMP', 'channel' => 'BANK', 'asset' => 'solana:usdc', 'amount' => 7.6, 'destination_amount' => 10166.83, 'rate' => 1337.7], 1340), 7.6), 'Switch USDC sell: crypto amount is USD (not misread as naira)');
check(near(referralUsdVolume(['type' => 'ONRAMP', 'channel' => 'PAJ', 'asset' => 'USDC', 'amount' => 3000, 'destination_amount' => 2.2], 1340), 2.2), 'PAJ USDC buy: crypto delivered is USD');
check(near(referralUsdVolume(['type' => 'ONRAMP', 'channel' => 'PAJ', 'asset' => 'SOL', 'amount' => 13400, 'destination_amount' => 0.07], 1340), 10.0), 'PAJ SOL buy: naira paid / rate');
check(near(referralUsdVolume(['type' => 'OFFRAMP', 'channel' => 'PAJ', 'asset' => 'USDC', 'amount' => 26800, 'destination_amount' => null], 1340), 20.0), 'PAJ sell: amount is naira');
check(near(referralUsdVolume(['type' => 'OFFRAMP', 'channel' => 'BANK', 'asset' => 'solana:sol', 'amount' => 0.5, 'destination_amount' => 134000, 'rate' => 268000], 1340), 100.0), 'Switch SOL sell: naira payout / rate');

// ── Earnings: only COMPLETED, each at its own snapshotted % ──
$add = fn (string $status, float $pct, float $usdc) => Database::insert('transactions', ['type' => 'OFFRAMP', 'channel' => 'BANK', 'status' => $status, 'asset' => 'solana:usdc', 'amount' => $usdc, 'destination_amount' => $usdc * 1340, 'referrer_code' => 'AMAKA234', 'referral_fee_percent' => $pct]);
$add('COMPLETED', 0.3, 1000);   // $3.00
$add('COMPLETED', 0.5, 1000);   // $5.00 — older order at a different %
$add('FAILED', 0.3, 5000);      // nothing
$add('AWAITING_DEPOSIT', 0.3, 5000); // nothing yet
$amaka = referrerByEmail('amaka@example.com');
$s = referralSummary($amaka, 1340.0);
check($s['referred_orders'] === 4 && $s['completed_orders'] === 2, 'counts all referred orders, 2 completed');
check(near($s['earned_usd'], 8.0), 'earned $8.00 = 0.3% of $1000 + 0.5% of $1000; failed/pending earn nothing');
check(near($s['available_usd'], 8.0), 'available = earned when nothing withdrawn');

// ── Withdrawals reduce the balance; rejected ones don't ──
Database::insert('referral_withdrawals', ['email' => 'amaka@example.com', 'amount_usd' => 3.0, 'chain' => 'solana', 'address' => 'x', 'status' => 'APPROVED']);
Database::insert('referral_withdrawals', ['email' => 'amaka@example.com', 'amount_usd' => 4.0, 'chain' => 'solana', 'address' => 'x', 'status' => 'REJECTED']);
Database::insert('referral_withdrawals', ['email' => 'amaka@example.com', 'amount_usd' => 2.5, 'chain' => 'solana', 'address' => 'x', 'status' => 'PENDING']);
$s = referralSummary($amaka, 1340.0);
check(near($s['paid_usd'], 3.0) && near($s['pending_usd'], 2.5), 'paid and pending tracked');
check(near($s['available_usd'], 2.5), 'available = 8 − 3 paid − 2.5 pending (rejected returned to balance)');

// Rounds down to the cent: never pay out more than earned.
$pdo->exec('DELETE FROM referral_withdrawals');
$add('COMPLETED', 0.3, 3.333); // +$0.009999
$s = referralSummary($amaka, 1340.0);
check(near($s['available_usd'], 8.0), 'fractions of a cent are rounded down, not up');

// ── Payout address validation ──
check(isValidPayoutAddress('solana', 'BXNwUnjvNkGwgSK7hZw1fiEZQvcxfNiF3H88kZ3Exn6d'), 'valid Solana address');
check(!isValidPayoutAddress('solana', '0x52908400098527886E0F7030069857D2E4169EE7'), 'EVM address rejected on Solana');
check(isValidPayoutAddress('base', '0x52908400098527886E0F7030069857D2E4169EE7'), 'valid EVM address on Base');
check(!isValidPayoutAddress('ethereum', '0x5290<script>'), 'garbage rejected');

// ── Email verification tokens ──
$token = issueReferralToken('amaka@example.com');
check(referralTokenEmail($token) === 'amaka@example.com', 'token round-trips to its email');
[$b64, $sig] = explode('.', $token);
$forged = rtrim(strtr(base64_encode('thief@example.com|' . (time() + 3600)), '+/', '-_'), '=') . '.' . $sig;
check(referralTokenEmail($forged) === null, 'token with a swapped email is rejected');
$expiredPayload = 'amaka@example.com|' . (time() - 1);
$expired = rtrim(strtr(base64_encode($expiredPayload), '+/', '-_'), '=') . '.' . hash_hmac('sha256', $expiredPayload, referralAppKey());
check(referralTokenEmail($expired) === null, 'expired token is rejected');
check(referralTokenEmail('') === null && referralTokenEmail('garbage') === null, 'empty/garbage token is rejected');
check(strlen(referralOtpKey('refauth', str_repeat('a', 240) . '@example.com')) <= 100, 'OTP key fits the 100-char column for long emails');

echo "\n" . ($failed === 0 ? 'All referral checks passed.' : "{$failed} check(s) failed.") . "\n";
exit($failed === 0 ? 0 : 1);
