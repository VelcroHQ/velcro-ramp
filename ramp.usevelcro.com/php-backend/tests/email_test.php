<?php

declare(strict_types=1);

/**
 * Email template + receipt checks (SQLite, no MySQL or mail server needed).
 * Run with: php tests/email_test.php [dir-to-save-rendered-html]
 */

$tmp = sys_get_temp_dir() . '/velcro_email_test_' . getmypid();
@mkdir($tmp . '/data', 0777, true);
define('BASE_PATH', $tmp);
file_put_contents($tmp . '/data/.receipt_schema_v1', 'test'); // schema built below instead of MySQL ALTER
// Point mail at an invalid Mailhive key: sends are attempted and fail fast, which is what the claim logic must survive.
putenv('MAILHIVE_API_KEY=invalid_test_key');

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../helpers.php';

$failed = 0;
function check(bool $ok, string $msg): void
{
    global $failed;
    echo ($ok ? '✅' : '❌') . " {$msg}\n";
    $failed += $ok ? 0 : 1;
}

$buy = ['id' => 1, 'reference' => '6ac02ee288a14b0c9e3f75bf35', 'type' => 'ONRAMP', 'channel' => 'PAJ', 'status' => 'COMPLETED', 'asset' => 'SOL', 'amount' => 3000, 'destination_amount' => 0.0171, 'wallet_address' => 'HFempdQ1nW3kq7x9yP2Lr8sM3MAbD', 'hash' => '5rdxWvMywQFuZCDUsknJ5rdxWvMywQFu', 'email' => 'ada@example.com', 'updated_at' => '2026-10-06 14:20:00'];
$sell = ['id' => 2, 'reference' => 'fdbafb37-e743-4d76-bfa8-06707fce6d64', 'type' => 'OFFRAMP', 'channel' => 'BANK', 'status' => 'COMPLETED', 'asset' => 'solana:usdc', 'amount' => 7.600166, 'destination_amount' => 10166.83, 'beneficiary' => json_encode(['holder_name' => 'Oshiokpekhai Kamal Shehu', 'account_number' => '8107861652', 'bank_code' => '100004']), 'email' => 'kamal@example.com', 'updated_at' => '2026-10-06 12:55:00'];
$pajSell = ['id' => 3, 'reference' => 'pj_abc', 'type' => 'OFFRAMP', 'channel' => 'PAJ', 'status' => 'COMPLETED', 'asset' => 'USDC', 'amount' => 26800, 'destination_amount' => null, 'beneficiary' => ['bank' => '999', 'accountNumber' => '0123456789', 'holder_name' => 'Customer'], 'email' => 'x@example.com', 'updated_at' => '2026-10-06 10:00:00'];

[$subject, $html, $text] = receiptEmail($buy);
check($subject === 'Receipt: 0.0171 SOL delivered', 'buy receipt subject');
check(str_contains($html, '₦3,000.00') && str_contains($html, 'https://solscan.io/tx/5rdxWvMywQFuZCDUsknJ5rdxWvMywQFu'), 'buy receipt: amount paid + Solscan button for PAJ (Solana)');
check(str_contains($text, 'You received: 0.0171 SOL'), 'buy receipt has a plain-text version');

[$subject, $html] = receiptEmail($sell);
check($subject === 'Receipt: ₦10,166.83 sent to your bank', 'Switch sell: naira payout from destination_amount');
check(str_contains($html, '7.600166 USDC') && str_contains($html, 'OPay') && str_contains($html, '•••• 1652') && !str_contains($html, '8107861652'), 'Switch sell: crypto sold, bank name, account masked to last 4');

[$subject, $html] = receiptEmail($pajSell);
check($subject === 'Receipt: ₦26,800.00 sent to your bank' && !str_contains($html, 'Customer'), 'PAJ sell: naira from amount, placeholder holder name hidden');

[$xssHtml] = renderEmail(['title' => '<script>alert(1)</script>', 'rows' => [['Wallet', '"><img src=x onerror=alert(1)>']]]);
check(!str_contains($xssHtml, '<script>') && !str_contains($xssHtml, '<img src=x'), 'all values are HTML-escaped');

if (!empty($argv[1])) {
    @mkdir($argv[1], 0777, true);
    file_put_contents($argv[1] . '/receipt-buy.html', receiptEmail($buy)[1]);
    file_put_contents($argv[1] . '/receipt-sell.html', receiptEmail($sell)[1]);
    file_put_contents($argv[1] . '/code.html', renderEmail(['eyebrow' => 'Verification', 'title' => 'Your Velcro verification code', 'intro' => 'Use this code to open your Velcro referral profile:', 'code' => '482913', 'outro' => "This code expires in 5 minutes. If you didn't request it, you can safely ignore this email."])[0]);
}

// ── Receipts are claimed once ──
$pdo = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
$pdo->sqliteCreateFunction('NOW', fn () => gmdate('Y-m-d H:i:s'), 0);
(new ReflectionProperty(Database::class, 'pdo'))->setValue(null, $pdo);
$pdo->exec('CREATE TABLE transactions (id INTEGER PRIMARY KEY, reference TEXT, type TEXT, channel TEXT, status TEXT, asset TEXT, amount REAL, destination_amount REAL, wallet_address TEXT, hash TEXT, explorer_url TEXT, beneficiary TEXT, email TEXT, created_at TEXT, updated_at TEXT, receipt_sent_at TEXT)');
foreach ([$buy, $sell] as $t) {
    Database::insert('transactions', ['id' => $t['id'], 'reference' => $t['reference'], 'type' => $t['type'], 'channel' => $t['channel'], 'status' => 'COMPLETED', 'asset' => $t['asset'], 'amount' => $t['amount'], 'destination_amount' => $t['destination_amount'], 'email' => $t['email'], 'updated_at' => $t['updated_at']]);
}
Database::insert('transactions', ['id' => 10, 'reference' => 'old', 'type' => 'ONRAMP', 'status' => 'COMPLETED', 'asset' => 'SOL', 'amount' => 1, 'email' => 'old@example.com', 'receipt_sent_at' => '2026-01-01 00:00:00']);
Database::insert('transactions', ['id' => 11, 'reference' => 'pending', 'type' => 'ONRAMP', 'status' => 'PROCESSING', 'asset' => 'SOL', 'amount' => 1, 'email' => 'p@example.com']);
Database::insert('transactions', ['id' => 12, 'reference' => 'noemail', 'type' => 'ONRAMP', 'status' => 'COMPLETED', 'asset' => 'SOL', 'amount' => 1, 'email' => '']);

sendPendingReceipts(10);
$claimed = array_column(Database::select('SELECT id FROM transactions WHERE receipt_sent_at IS NOT NULL AND id <> 10 ORDER BY id'), 'id');
check($claimed === [1, 2], 'only new COMPLETED orders with an email are claimed (not pending, not email-less, not already sent)');
$before = Database::selectOne('SELECT receipt_sent_at FROM transactions WHERE id = 1')['receipt_sent_at'];
sendPendingReceipts(10);
check(Database::selectOne('SELECT receipt_sent_at FROM transactions WHERE id = 1')['receipt_sent_at'] === $before, 'second run sends nothing again (no duplicate receipts)');
check(Database::selectOne('SELECT updated_at FROM transactions WHERE id = 2')['updated_at'] === '2026-10-06 12:55:00', "claiming doesn't change the order's updated_at");

// ── Campaigns ──
file_put_contents($tmp . '/data/.campaign_schema_v1', 'test');
$pdo->exec("CREATE TABLE email_campaigns (id INTEGER PRIMARY KEY, subject TEXT, preheader TEXT, title TEXT, body TEXT, cta_label TEXT, cta_url TEXT, status TEXT DEFAULT 'SENDING', created_at TEXT, finished_at TEXT)");
$pdo->exec("CREATE TABLE email_campaign_recipients (id INTEGER PRIMARY KEY, campaign_id INTEGER, email TEXT, status TEXT DEFAULT 'PENDING', sent_at TEXT, UNIQUE(campaign_id, email))");
$pdo->exec('CREATE TABLE email_unsubscribes (email TEXT PRIMARY KEY, created_at TEXT)');

$tok = unsubscribeToken('Ada@Example.com');
check($tok === unsubscribeToken('ada@example.com') && $tok !== unsubscribeToken('eve@example.com'), 'unsubscribe token is per-address and case-insensitive');
check(str_contains(unsubscribeUrl('ada@example.com'), 'e=ada%40example.com&t=' . $tok), 'unsubscribe URL carries email + signature');

Database::insert('transactions', ['id' => 20, 'reference' => 'x1', 'type' => 'ONRAMP', 'status' => 'FAILED', 'asset' => 'SOL', 'amount' => 1, 'email' => ' KAMAL@example.com ']);
Database::insert('transactions', ['id' => 21, 'reference' => 'x2', 'type' => 'ONRAMP', 'status' => 'FAILED', 'asset' => 'SOL', 'amount' => 1, 'email' => 'not-an-email']);
Database::insert('email_unsubscribes', ['email' => 'old@example.com']);
$audience = campaignAudience();
sort($audience);
check($audience === ['ada@example.com', 'kamal@example.com', 'p@example.com'], 'audience: distinct, lowercased, valid, unsubscribes removed');

[$campaignHtml, $campaignText] = renderCampaign(['subject' => 'S', 'title' => 'Big news', 'body' => "First paragraph.\n\nSecond <b>para</b>.", 'cta_label' => 'Try it', 'cta_url' => 'https://ramp.usevelcro.com'], 'ada@example.com');
check(substr_count($campaignHtml, 'line-height:1.7') === 2 && str_contains($campaignHtml, '&lt;b&gt;para') && str_contains($campaignHtml, 'Unsubscribe'), 'campaign: paragraphs split, HTML escaped, unsubscribe link in footer');
check(str_contains($campaignHtml, 'email-assets/instagram.png') && str_contains($campaignText, 'Unsubscribe: '), 'campaign: social icons + plain-text unsubscribe');

$cid = (int) Database::insert('email_campaigns', ['subject' => 'S', 'title' => 'T', 'body' => 'B']);
foreach ($audience as $em) {
    Database::insert('email_campaign_recipients', ['campaign_id' => $cid, 'email' => $em]);
}
Database::insert('email_unsubscribes', ['email' => 'p@example.com']); // unsubscribes after the campaign started
sendCampaignBatch(2);
check((int) Database::selectOne("SELECT COUNT(*) AS n FROM email_campaign_recipients WHERE status = 'PENDING'")['n'] === 1, 'batch processes only its limit');
sendCampaignBatch(10);
$st = array_column(Database::select('SELECT email, status FROM email_campaign_recipients ORDER BY email'), 'status', 'email');
check($st['p@example.com'] === 'SKIPPED', 'address unsubscribed mid-campaign is skipped');
check(Database::selectOne('SELECT status FROM email_campaigns WHERE id = :id', ['id' => $cid])['status'] === 'SENT', 'campaign marked SENT when nothing is pending');
check(sendCampaignBatch(10) === 0, 'nothing is sent twice');

echo "\n" . ($failed === 0 ? 'All email checks passed.' : "{$failed} check(s) failed.") . "\n";
exit($failed === 0 ? 0 : 1);
