<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

/**
 * HostFi sell pipeline against a mock HostFi (tests/support/hostfi_mock.php) and the real routes
 * over SQLite: address → verified deposit → swap → payout → completed, plus every safety rule.
 * Run with: php tests/hostfi_test.php
 */

$tmp = sys_get_temp_dir() . '/velcro_hostfi_test_' . getmypid();
@mkdir($tmp . '/data', 0777, true);
$mockState = $tmp . '/mock.json';
file_put_contents($mockState, '');
foreach (['.referral_schema_v1', '.receipt_schema_v1', '.hostfi_schema_v1'] as $flag) {
    file_put_contents($tmp . '/data/' . $flag, 'test'); // MySQL DDL; tables built below instead
}

$mockPort = random_int(20000, 30000);
$appPort = random_int(30001, 40000);
putenv('VELCRO_TEST_BASE=' . $tmp);
putenv('HOSTFI_MOCK_STATE=' . $mockState);
putenv("HOSTFI_BASE_URL=http://127.0.0.1:{$mockPort}");
putenv('HOSTFI_CLIENT_ID=test-client');
putenv('HOSTFI_CLIENT_SECRET=test-secret');
putenv('HOSTFI_WEBHOOK_SECRET=hook-secret');
putenv('ADMIN_PASSWORD=correct-horse');
putenv('PAJ_API_KEY=');

$pdo = new PDO('sqlite:' . $tmp . '/test.db', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
$pdo->exec('CREATE TABLE transactions (id INTEGER PRIMARY KEY, reference TEXT UNIQUE, switch_reference TEXT, type TEXT, status TEXT, country TEXT, currency TEXT, asset TEXT, channel TEXT,
    amount REAL, rate REAL, fee_total REAL, fee_platform REAL, fee_developer REAL, source_amount REAL, source_currency TEXT, destination_amount REAL, destination_currency TEXT,
    deposit_address TEXT, deposit_bank_name TEXT, deposit_account_number TEXT, deposit_account_name TEXT, deposit_note TEXT, beneficiary TEXT, wallet_address TEXT, hash TEXT,
    explorer_url TEXT, callback_url TEXT, meta TEXT, email TEXT, referrer_code TEXT, referral_fee_percent REAL, receipt_sent_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)');
$pdo->exec('CREATE TABLE hostfi_deposits (id INTEGER PRIMARY KEY, deposit_ref TEXT NOT NULL UNIQUE, order_ref TEXT, address TEXT, currency TEXT, network TEXT, amount REAL, tx_hash TEXT,
    status TEXT DEFAULT \'RECEIVED\', ngn_amount REAL, payout_amount REAL, swap_ref TEXT, swap_pair_ref TEXT, payout_ref TEXT, payout_client_ref TEXT, payout_attempts INTEGER DEFAULT 0, note TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)');
$pdo->exec('CREATE TABLE referrers (id INTEGER PRIMARY KEY, email TEXT UNIQUE, code TEXT UNIQUE, fee_percent REAL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)');
$pdo->exec('CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, action TEXT, ip TEXT, user_agent TEXT, details TEXT)');

$log = $tmp . '/server.log';
$serve = static fn (int $port, string $router) => proc_open([PHP_BINARY, '-S', "127.0.0.1:{$port}", $router], [['pipe', 'r'], ['file', $log, 'a'], ['file', $log, 'a']], $pipes);
$mock = $serve($mockPort, __DIR__ . '/support/hostfi_mock.php');
$app = $serve($appPort, __DIR__ . '/support/security_router.php');
foreach ([$mockPort, $appPort] as $port) {
    for ($i = 0; $i < 50 && !@fsockopen('127.0.0.1', $port); $i++) {
        usleep(100000);
    }
}

function call(int $port, string $method, string $path, ?array $body = null, string $auth = '', string $extraHeaders = ''): array
{
    $ctx = stream_context_create(['http' => [
        'method' => $method,
        'header' => "Content-Type: application/json\r\n" . ($auth !== '' ? "Authorization: {$auth}\r\n" : '') . $extraHeaders,
        'content' => $body === null ? '' : json_encode($body),
        'ignore_errors' => true,
        'timeout' => 30,
    ]]);
    $raw = file_get_contents("http://127.0.0.1:{$port}{$path}", false, $ctx);
    preg_match('/\d{3}/', $http_response_header[0] ?? '', $m);
    return [(int) ($m[0] ?? 0), json_decode((string) $raw, true) ?? []];
}

$failed = 0;
function check(bool $ok, string $msg): void
{
    global $failed;
    echo ($ok ? '✅' : '❌') . " {$msg}\n";
    $failed += $ok ? 0 : 1;
}
function near(float $a, float $b, float $eps = 0.01): bool
{
    return abs($a - $b) < $eps;
}

// Webhook calls carry the secret HostFi echoes from the subscription, like the real thing.
$app_ = static fn (string $method, string $path, ?array $body = null, string $auth = '') => call($GLOBALS['appPort'], $method, $path, $body, $auth, str_starts_with($path, '/webhook/') ? "x-auth-secret: hook-secret\r\n" : '');
$mock_ = static fn (string $path, array $body = []) => call($GLOBALS['mockPort'], 'POST', $path, $body)[1];
$deposit = static fn (string $ref) => $pdo->query("SELECT * FROM hostfi_deposits WHERE deposit_ref = " . $pdo->quote($ref))->fetch();
$order = static fn (string $ref) => $pdo->query("SELECT * FROM transactions WHERE reference = " . $pdo->quote($ref))->fetch();
$state = static fn () => $mock_('/__test/state');
$hook = static fn (string $ref, string $address, string $currency = 'BTC', float $amount = 0.001) => $app_('POST', '/webhook/hostfi', [
    'event' => 'CRYPTO_DEPOSIT',
    'data' => ['reference' => $ref, 'amount' => ['currency' => $currency, 'value' => $amount], 'metadata' => [['name' => 'address', 'value' => $address]]],
]);
$sellBtc = static fn (float $amount = 0.001) => $app_('POST', '/api/hostfi/sell', [
    'asset' => 'BTC', 'network' => 'BTC', 'amount' => $amount, 'bankCode' => '100004', 'bankName' => 'OPay', 'accountNumber' => '0123456789', 'email' => 'ada@example.com',
]);

try {
    // ── Catalogue and settings ──
    [, $res] = $app_('GET', '/api/settings');
    check(($res['data']['hostfi_assets'] ?? null) === ['BTC', 'ETH'], 'settings: BTC and ETH on by default, SOL/USDT/USDC off');
    check((int) ($res['data']['sell_timer_minutes']['BTC'] ?? 0) === 120, 'settings: BTC timer is 2 hours');

    [, $res] = $app_('GET', '/api/hostfi/assets');
    $btc = array_values(array_filter($res['data'] ?? [], fn ($a) => $a['symbol'] === 'BTC'))[0] ?? [];
    check(count($res['data'] ?? []) === 2 && ($btc['networks'][0]['code'] ?? '') === 'BTC' && ($btc['networks'][0]['chain'] ?? '') === 'bitcoin', 'assets: BTC on the bitcoin network, ETH listed');
    check(near((float) ($btc['ngn_per_unit'] ?? 0), 150000000 * 0.995, 1) && near((float) ($btc['usd_per_unit'] ?? 0), 100000, 1), 'assets: live-format HostFi rate (single object, string) read, 0.5% fee taken off');
    check(near((float) ($btc['ngn_per_unit_gross'] ?? 0), 150000000, 1), "assets: HostFi's own rate (before our fee) is returned for display");

    [$code, $res] = $app_('POST', '/api/hostfi/resolve', ['bankCode' => '100004', 'bankName' => 'OPay', 'accountNumber' => '0123456789']);
    check($code === 200 && ($res['data']['accountName'] ?? '') === 'ADA LOVELACE', 'resolve: account name comes from HostFi lookup');
    [$code] = $app_('POST', '/api/hostfi/resolve', ['bankCode' => '999999', 'bankName' => 'Nope Bank', 'accountNumber' => '0123456789']);
    check($code === 400, 'resolve: bank HostFi does not support is rejected');

    // ── Order creation guards ──
    [$code] = $app_('POST', '/api/hostfi/sell', ['asset' => 'SOL', 'network' => 'SOL', 'amount' => 1, 'bankCode' => '100004', 'accountNumber' => '0123456789']);
    check($code === 400, 'sell: SOL rejected while its HostFi toggle is off');
    [$code] = $sellBtc(1);
    check($code === 400, 'sell: $100,000 of BTC rejected by the $10,000 sell limit');
    [$code] = $app_('POST', '/api/hostfi/sell', ['asset' => 'BTC', 'network' => 'ERC20', 'amount' => 0.001, 'bankCode' => '100004', 'accountNumber' => '0123456789']);
    check($code === 400, 'sell: network the coin cannot be received on is rejected');

    // ── Happy path ──
    [$code, $res] = $sellBtc();
    $ref = (string) ($res['data']['reference'] ?? '');
    $addr = (string) ($res['data']['address'] ?? '');
    $row = $order($ref);
    $meta = json_decode((string) $row['meta'], true);
    check($code === 200 && $addr === 'ADDR_' . $ref && ($res['data']['expires_in'] ?? 0) === 7200, 'sell: fresh address per order (customId = order ref), 2-hour window');
    check($row['channel'] === 'HOSTFI' && $row['asset'] === 'bitcoin:btc' && $row['status'] === 'AWAITING_DEPOSIT', 'sell: order stored as a HOSTFI bitcoin:btc sell');
    check(($meta['hostfi']['bank']['bankId'] ?? '') === 'NG::100004' && ($meta['hostfi']['bank']['accountName'] ?? '') === 'ADA LOVELACE', 'sell: payout bank (HostFi id + verified name) bound to the order');

    $forgedBody = ['event' => 'CRYPTO_DEPOSIT', 'data' => ['reference' => 'forged-0']];
    [$noSecret] = call($appPort, 'POST', '/webhook/hostfi', $forgedBody);
    [$badSecret] = call($appPort, 'POST', '/webhook/hostfi', $forgedBody, '', "x-auth-secret: wrong\r\n");
    check($noSecret === 401 && $badSecret === 401, 'webhook: missing or wrong x-auth-secret is refused (401)');

    [, $res] = $hook('forged-1', $addr);
    check(($res['verified'] ?? null) === false && !$deposit('forged-1') && count($state()['swaps']) === 0, 'webhook: deposit HostFi does not know about is ignored (no swap)');

    $mock_('/__test/deposit', ['reference' => 'dep-1', 'address' => $addr, 'currency' => 'BTC', 'amount' => 0.001, 'network' => 'BTC']);
    $hook('dep-1', $addr, 'BTC', 5.0); // payload amount lies; HostFi's record (0.001) must win
    $d = $deposit('dep-1');
    $st = $state();
    check($d && $d['status'] === 'PAYOUT_PENDING' && near((float) $d['amount'], 0.001, 1e-9), 'deposit: verified with HostFi, amount taken from HostFi not the payload');
    check(count($st['swaps']) === 1 && near((float) $st['swaps'][0]['value'], 0.001, 1e-9), 'deposit: swapped exactly the received BTC to NGN');
    $payout = array_values($st['payouts'])[0] ?? [];
    check(count($st['payouts']) === 1 && near((float) ($payout['amount']['value'] ?? 0), 149200) && ($payout['recipient']['bankId'] ?? '') === 'NG::100004', 'deposit: ₦149,200 (₦150,000 − 0.5% − ₦50 payout fee) paid to the order\'s bank');
    check($order($ref)['status'] === 'PROCESSING', 'order: PROCESSING while the payout is in flight');

    $hook('dep-1', $addr);
    $st = $state();
    check(count($st['swaps']) === 1 && count($st['payouts']) === 1, 'webhook delivered twice: still one swap and one payout');

    $mock_('/__test/set', ['payout_overrides' => [$d['payout_client_ref'] => 'WITHDRAWAL_SUCCESS']]);
    $app_('POST', '/webhook/hostfi', ['event' => 'FIAT_WITHDRAWAL', 'data' => ['clientReference' => $d['payout_client_ref'], 'status' => 'WITHDRAWAL_SUCCESS']]);
    $row = $order($ref);
    check($deposit('dep-1')['status'] === 'PAID' && $row['status'] === 'COMPLETED', 'payout webhook: deposit PAID, order COMPLETED');
    check(near((float) $row['destination_amount'], 149200) && near((float) $row['amount'], 0.001, 1e-9) && $row['hash'] === 'tx-dep-1', 'order: real amounts and on-chain hash recorded');
    [, $res] = $app_('GET', '/api/transactions/' . $ref);
    check(($res['data']['status'] ?? '') === 'COMPLETED', 'status endpoint serves HostFi orders without asking Switch');

    // ── Safety rules ──
    $mock_('/__test/deposit', ['reference' => 'dep-2', 'address' => $addr, 'currency' => 'BTC', 'amount' => 0.002]);
    $hook('dep-2', $addr);
    check($deposit('dep-2')['status'] === 'REVIEW' && count($state()['swaps']) === 1 && $order($ref)['status'] === 'COMPLETED', 'repeat deposit to a paid order: held for review, order stays COMPLETED');

    [, $login] = $app_('POST', '/api/admin/login', ['password' => 'correct-horse']);
    $admin = 'Bearer ' . ($login['token'] ?? '');
    [, $res] = $app_('GET', '/api/admin/hostfi', null, $admin);
    check(($res['deposits'][0]['deposit_ref'] ?? '') === 'dep-2' && ($res['environment'] ?? '') === 'live', 'admin: review queue lists the held deposit first');
    [$code] = $app_('POST', '/api/admin/hostfi/deposits/' . $deposit('dep-2')['id'] . '/retry', null, $admin);
    $st = $state();
    check($code === 200 && count($st['swaps']) === 2 && count($st['payouts']) === 2 && $deposit('dep-2')['status'] === 'PAYOUT_PENDING', 'admin "Approve & pay": held deposit swapped and paid out');

    [, $res] = $app_('POST', '/api/hostfi/sell', ['asset' => 'ETH', 'network' => 'ERC20', 'amount' => 0.01, 'bankCode' => '000013', 'bankName' => 'GTBank', 'accountNumber' => '0123456789']);
    $ethAddr = (string) ($res['data']['address'] ?? '');
    $mock_('/__test/deposit', ['reference' => 'dep-3', 'address' => $ethAddr, 'currency' => 'USDT', 'amount' => 20]);
    $hook('dep-3', $ethAddr, 'USDT', 20);
    check($deposit('dep-3')['status'] === 'REVIEW' && str_contains((string) $deposit('dep-3')['note'], 'USDT'), 'wrong coin sent to an ETH order: held for review');

    [, $res] = $sellBtc();
    $lateRef = (string) $res['data']['reference'];
    $app_('POST', '/api/cancel', ['reference' => $lateRef]);
    check($order($lateRef)['status'] === 'CANCELLED', 'user pressed "Start over": order CANCELLED');
    $mock_('/__test/deposit', ['reference' => 'dep-4', 'address' => $res['data']['address'], 'currency' => 'BTC', 'amount' => 0.001]);
    $hook('dep-4', $res['data']['address']);
    check($deposit('dep-4')['status'] === 'PAYOUT_PENDING' && $order($lateRef)['status'] === 'PROCESSING', 'late deposit to a cancelled order: still paid to that order\'s bank');

    // ── Payouts: never paid twice, re-payout only once HostFi confirms the last one failed ──
    $retry = static fn (array $d) => $app_('POST', '/api/admin/hostfi/deposits/' . $d['id'] . '/retry', null, $admin);
    $mock_('/__test/set', ['fail_payouts' => true]);
    [, $res] = $sellBtc();
    $mock_('/__test/deposit', ['reference' => 'dep-5', 'address' => $res['data']['address'], 'currency' => 'BTC', 'amount' => 0.001]);
    $hook('dep-5', $res['data']['address']);
    check($deposit('dep-5')['status'] === 'PAYOUT_UNCERTAIN' && (int) $deposit('dep-5')['payout_attempts'] === 1, 'payout request errors: PAYOUT_UNCERTAIN (not retried blind), swap kept');
    $mock_('/__test/set', ['fail_payouts' => false]);
    $payoutsBefore = count($state()['payouts']);
    $retry($deposit('dep-5'));
    check($deposit('dep-5')['status'] === 'PAYOUT_PENDING' && count($state()['swaps']) === 4 && count($state()['payouts']) === $payoutsBefore + 1, 'admin retry after HostFi has no record of attempt 1: one new payout, no second swap');

    $d5 = $deposit('dep-5');
    $mock_('/__test/set', ['payout_overrides' => [$d5['payout_client_ref'] => 'WITHDRAWAL_FAILED']]);
    $app_('POST', '/webhook/hostfi', ['event' => 'FIAT_WITHDRAWAL', 'data' => ['clientReference' => $d5['payout_client_ref']]]);
    $payoutsBefore = count($state()['payouts']);
    $app_('POST', '/webhook/hostfi', ['event' => 'FIAT_WITHDRAWAL', 'data' => ['clientReference' => $d5['payout_client_ref']]]);
    $app_('GET', '/api/transactions/' . $d5['order_ref']);
    check($deposit('dep-5')['status'] === 'PAYOUT_FAILED' && count($state()['payouts']) === $payoutsBefore, 'payout failure webhook: PAYOUT_FAILED, nothing re-sent automatically');
    $retry($deposit('dep-5'));
    $d5 = $deposit('dep-5');
    $payouts = array_values($state()['payouts']);
    check($d5['status'] === 'PAYOUT_PENDING' && (int) $d5['payout_attempts'] === 3 && count($payouts) === $payoutsBefore + 1 && near((float) end($payouts)['amount']['value'], 149200), 'admin re-payout after a confirmed failure: same ₦149,200, new attempt reference');

    // HostFi actually paid, but we think it failed (e.g. a lost webhook): retry must not pay again.
    $mock_('/__test/set', ['payout_overrides' => [$d5['payout_client_ref'] => 'WITHDRAWAL_SUCCESS']]);
    $pdo->exec("UPDATE hostfi_deposits SET status = 'PAYOUT_FAILED' WHERE id = " . (int) $d5['id']);
    $payoutsBefore = count($state()['payouts']);
    [, $res] = $retry($deposit('dep-5'));
    check(($res['outcome'] ?? '') === 'already_paid' && $deposit('dep-5')['status'] === 'PAID' && count($state()['payouts']) === $payoutsBefore, 'retry when HostFi shows the last payout succeeded: marked PAID, nothing re-sent');

    // ── Swaps HostFi finishes later: payout waits for the swap webhook ──
    $mock_('/__test/set', ['swap_status' => 'PENDING']);
    [, $res] = $sellBtc();
    $mock_('/__test/deposit', ['reference' => 'dep-6', 'address' => $res['data']['address'], 'currency' => 'BTC', 'amount' => 0.001]);
    $payoutsBefore = count($state()['payouts']);
    $hook('dep-6', $res['data']['address']);
    $d6 = $deposit('dep-6');
    check($d6['status'] === 'SWAP_PENDING' && count($state()['payouts']) === $payoutsBefore, 'pending swap: no payout until HostFi confirms the swap');
    $swapHook = ['transactions' => [['reference' => $d6['swap_ref'], 'swapPairReference' => $d6['swap_pair_ref'], 'type' => 'CREDIT', 'status' => 'SUCCESS', 'amount' => ['currency' => 'NGN', 'value' => 9999999]]]];
    $app_('POST', '/webhook/hostfi', $swapHook);
    check($deposit('dep-6')['status'] === 'SWAP_PENDING' && count($state()['payouts']) === $payoutsBefore, 'swap webhook claiming SUCCESS is ignored while HostFi still shows the swap pending');
    $mock_('/__test/set', ['swap_overrides' => [$d6['swap_ref'] => 'SUCCESS'], 'swap_status' => 'SUCCESS']);
    $app_('POST', '/webhook/hostfi', $swapHook);
    $paid = array_values(array_filter($state()['payouts'], fn ($p) => str_starts_with($p['clientReference'], $d6['order_ref'])));
    check($deposit('dep-6')['status'] === 'PAYOUT_PENDING' && count($paid) === 1 && near((float) $paid[0]['amount']['value'], 149200), "swap webhook after HostFi confirms: paid from HostFi's ₦150,000, not the payload's ₦9,999,999");

    // ── Customer view and customer retry (History / order screen) ──
    $ref6 = $d6['order_ref'];
    $mock_('/__test/set', ['payout_overrides' => [$deposit('dep-6')['payout_client_ref'] => 'WITHDRAWAL_FAILED']]);
    $app_('POST', '/webhook/hostfi', ['event' => 'FIAT_WITHDRAWAL', 'data' => ['clientReference' => $deposit('dep-6')['payout_client_ref']]]);
    [, $res] = $app_('GET', '/api/transactions/' . $ref6);
    $prog = $res['data']['hostfi_progress'][0] ?? [];
    check(($prog['converted'] ?? '') === 'done' && ($prog['payout'] ?? '') === 'failed' && ($prog['can_retry'] ?? false) === true, 'order progress shows received → converted → payout failed, retry offered');
    check(!str_contains(json_encode($res['data']['hostfi_progress']), '0123456789') && !isset($prog['payout_client_ref']), 'progress exposes no bank account or internal payout references');
    [, $res] = $app_('GET', '/api/transactions?email=ada@example.com');
    $listed = array_values(array_filter($res['data'] ?? [], fn ($t) => $t['reference'] === $ref6))[0] ?? [];
    check(($listed['hostfi_progress'][0]['payout'] ?? '') === 'failed', 'History list carries the same progress');

    $payoutsBefore = count($state()['payouts']);
    // Someone tries to redirect the retry to another account: those fields are ignored.
    [$code, $res] = $app_('POST', '/api/hostfi/orders/' . $ref6 . '/retry', ['accountNumber' => '9999999999', 'bankCode' => '000013', 'amount' => 5000000]);
    $payouts = array_values($state()['payouts']);
    $new = end($payouts);
    check($code === 200 && count($payouts) === $payoutsBefore + 1 && ($res['data']['progress'][0]['payout'] ?? '') === 'pending', 'customer retry: payout re-sent, progress back to pending');
    check(($new['recipient']['accountNumber'] ?? '') === '0123456789' && ($new['recipient']['bankId'] ?? '') === 'NG::100004' && near((float) $new['amount']['value'], 149200), "customer retry pays the order's own bank and amount; other account/amount in the request ignored");
    [$code] = $app_('POST', '/api/hostfi/orders/' . $ref6 . '/retry');
    check($code === 429 && count($state()['payouts']) === $payoutsBefore + 1, 'second retry within 5 minutes is refused');
    [$code] = $app_('POST', '/api/hostfi/orders/' . $ref . '/retry');
    check($code === 400 || $code === 429, 'retry on an order with no failed payout does nothing');

    // ── Status checks never move money ──
    [, $res] = $sellBtc();
    $pdo->exec("INSERT INTO hostfi_deposits (deposit_ref, order_ref, address, currency, amount, status) VALUES ('dep-7', " . $pdo->quote($res['data']['reference']) . ", 'x', 'BTC', 0.001, 'RECEIVED')");
    $swapsBefore = count($state()['swaps']);
    $app_('GET', '/api/transactions/' . $res['data']['reference']);
    check($deposit('dep-7')['status'] === 'RECEIVED' && count($state()['swaps']) === $swapsBefore, 'status endpoint is read-only: no swap or payout triggered');

    // ── Admin toggles ──
    $app_('POST', '/api/admin/settings', ['hostfi_assets' => ['SOL' => true, 'BTC' => false]], $admin);
    [, $res] = $app_('GET', '/api/settings');
    check(($res['data']['hostfi_assets'] ?? null) === ['ETH', 'SOL'], 'admin toggles: BTC killed, SOL moved to HostFi');
    [$code] = $sellBtc();
    check($code === 400, 'BTC kill switch blocks new BTC sells');
    [$code] = $app_('POST', '/api/admin/settings', ['sell_timer_minutes' => ['BTC' => 5]], $admin);
    check($code === 400, 'sell timer below 15 minutes is rejected');
} finally {
    proc_terminate($app);
    proc_terminate($mock);
}

echo $failed === 0 ? "\nAll HostFi checks passed.\n" : "\n{$failed} HostFi check(s) FAILED. Server log: {$log}\n";
exit($failed === 0 ? 0 : 1);
