<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

/**
 * Velcro Merchant accounts and applications over the real routes and SQLite: sign-up with an
 * emailed code, password sign-in, reset (which signs out other sessions), Google sign-in refused
 * without a client ID, store-name rules, applying, and admin approval.
 * Run with: php tests/merchant_test.php
 */

$tmp = sys_get_temp_dir() . '/velcro_merchant_test_' . getmypid();
@mkdir($tmp . '/data', 0777, true);
foreach (['.referral_schema_v1', '.merchant_schema_v1', '.store_schema_v1'] as $flag) {
    file_put_contents($tmp . '/data/' . $flag, 'test'); // MySQL DDL; tables built below instead
}

$appPort = random_int(40001, 50000);
putenv('VELCRO_TEST_BASE=' . $tmp);
putenv('ADMIN_PASSWORD=correct-horse');
putenv('GOOGLE_CLIENT_ID=');
putenv('PAJ_API_KEY=');
putenv('MERCHANT_LOGO_DIR=' . $tmp . '/logos');

$pdo = new PDO('sqlite:' . $tmp . '/test.db', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
$pdo->exec('CREATE TABLE otps (otp_key TEXT PRIMARY KEY, code TEXT, expires_at INTEGER, attempts INTEGER DEFAULT 0)');
$pdo->exec('CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, action TEXT, ip TEXT, user_agent TEXT, details TEXT)');
$pdo->exec("CREATE TABLE merchants (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, slug TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'DRAFT',
    business_name TEXT, business_type TEXT, registration_number TEXT, contact_name TEXT, phone TEXT, website TEXT,
    monthly_volume TEXT, description TEXT, brand TEXT, pricing TEXT, terms_accepted_at TEXT, terms_ip TEXT, review_note TEXT, reviewed_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)");
$pdo->exec('CREATE TABLE store_customers (id INTEGER PRIMARY KEY, merchant_id INTEGER NOT NULL, email TEXT NOT NULL, password_hash TEXT, google_sub TEXT, name TEXT,
    token_version INTEGER NOT NULL DEFAULT 1, last_login_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE (merchant_id, email), UNIQUE (merchant_id, google_sub))');
$pdo->exec('CREATE TABLE merchant_accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT, google_sub TEXT UNIQUE, name TEXT,
    token_version INTEGER NOT NULL DEFAULT 1, last_login_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)');

$log = $tmp . '/server.log';
$app = proc_open([PHP_BINARY, '-S', "127.0.0.1:{$appPort}", __DIR__ . '/support/security_router.php'], [['pipe', 'r'], ['file', $log, 'a'], ['file', $log, 'a']], $pipes);
for ($i = 0; $i < 50 && !@fsockopen('127.0.0.1', $appPort); $i++) {
    usleep(100000);
}

function call(int $port, string $method, string $path, ?array $body = null, array $headers = []): array
{
    $h = "Content-Type: application/json\r\n";
    foreach ($headers as $k => $v) {
        $h .= "{$k}: {$v}\r\n";
    }
    $ctx = stream_context_create(['http' => ['method' => $method, 'header' => $h, 'content' => $body === null ? '' : json_encode($body), 'ignore_errors' => true, 'timeout' => 30]]);
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

$app_ = static fn (string $method, string $path, ?array $body = null, array $headers = []) => call($GLOBALS['appPort'], $method, $path, $body, $headers);
// The emailed code, without email: put a known code where storeOTP() would.
$code = static function (string $purpose, string $email) use ($pdo): string {
    $key = $purpose . ':' . substr(hash('sha256', $email), 0, 40);
    $pdo->prepare('INSERT OR REPLACE INTO otps (otp_key, code, expires_at, attempts) VALUES (?, ?, ?, 0)')->execute([$key, '123456', (int) (microtime(true) * 1000) + 300000]);
    return '123456';
};
$auth = static fn (string $token) => ['X-Merchant-Token' => $token];
// A real (tiny, solid-colour) PNG, so the upload check has something genuine to decode.
$png = static function (int $w, int $h): string {
    $chunk = static fn (string $type, string $data) => pack('N', strlen($data)) . $type . $data . pack('N', crc32($type . $data));
    $rows = str_repeat("\0" . str_repeat("\xa8\xcf\x45", $w), $h);
    return "\x89PNG\r\n\x1a\n" . $chunk('IHDR', pack('NNCCCCC', $w, $h, 8, 2, 0, 0, 0)) . $chunk('IDAT', gzcompress($rows)) . $chunk('IEND', '');
};
$email = 'shop@example.com';

try {
    // ── Sign-up, sign-in, reset ──
    [, $res] = $app_('GET', '/api/merchant/config');
    check(array_key_exists('google_client_id', $res['data'] ?? []) && $res['data']['google_client_id'] === null, 'config: no Google client ID → Google sign-in hidden');

    [$c] = $app_('POST', '/api/merchant/auth/signup', ['email' => $email, 'otp' => $code('merchsignup', $email), 'password' => 'short']);
    check($c === 400, 'sign-up: weak password refused');
    [$c] = $app_('POST', '/api/merchant/auth/signup', ['email' => $email, 'otp' => '000000', 'password' => 'GoodPass123']);
    check($c === 403, 'sign-up: wrong email code refused');
    [$c, $res] = $app_('POST', '/api/merchant/auth/signup', ['email' => $email, 'otp' => $code('merchsignup', $email), 'password' => 'GoodPass123']);
    $token = (string) ($res['data']['token'] ?? '');
    $hash = (string) $pdo->query("SELECT password_hash FROM merchant_accounts WHERE email = 'shop@example.com'")->fetchColumn();
    check($c === 200 && $token !== '' && password_verify('GoodPass123', $hash) && !str_contains($hash, 'GoodPass123'), 'sign-up: code + password creates the account, password stored hashed');
    [$c] = $app_('POST', '/api/merchant/auth/signup', ['email' => $email, 'otp' => $code('merchsignup', $email), 'password' => 'OtherPass456']);
    check($c === 409, 'sign-up: an existing account can’t be taken over by signing up again');

    [$c] = $app_('POST', '/api/merchant/auth/login', ['email' => $email, 'password' => 'WrongPass1']);
    check($c === 401, 'sign-in: wrong password refused');
    [$c, $res] = $app_('POST', '/api/merchant/auth/login', ['email' => 'SHOP@example.com', 'password' => 'GoodPass123']);
    $token2 = (string) ($res['data']['token'] ?? '');
    check($c === 200 && $token2 !== '', 'sign-in: right password (email case ignored)');
    [$c, $res] = $app_('GET', '/api/merchant/me', null, $auth($token2));
    check($c === 200 && ($res['data']['email'] ?? '') === $email && ($res['data']['merchant']['status'] ?? '') === 'DRAFT'
        && ($res['data']['merchant']['pricing']['BTC']['buy'] ?? null) == 1 && ($res['data']['merchant']['checklist']['verified'] ?? true) === false,
        'me: signed in to a draft store with default prices, not yet verified');
    [$c] = $app_('GET', '/api/merchant/me', null, $auth('forged.token'));
    check($c === 401, 'me: forged token refused');

    [$c, $res] = $app_('POST', '/api/merchant/auth/reset/code', ['email' => 'nobody@example.com']);
    check($c === 200, 'reset code: same answer for an unknown email (no account fishing)');
    [$c, $res] = $app_('POST', '/api/merchant/auth/reset', ['email' => $email, 'otp' => $code('merchreset', $email), 'password' => 'NewPass789']);
    $token3 = (string) ($res['data']['token'] ?? '');
    [$cOld] = $app_('GET', '/api/merchant/me', null, $auth($token2));
    [$cNew] = $app_('GET', '/api/merchant/me', null, $auth($token3));
    [$cLogin] = $app_('POST', '/api/merchant/auth/login', ['email' => $email, 'password' => 'GoodPass123']);
    check($c === 200 && $cOld === 401 && $cNew === 200 && $cLogin === 401, 'reset: new password works, old password and every old session signed out');
    $token = $token3;

    [$c] = $app_('POST', '/api/merchant/auth/google', ['credential' => 'aaa.bbb.ccc']);
    check($c === 401, 'Google sign-in refused while no client ID is configured');

    // ── Store name ──
    foreach (['admin' => false, 'velcro-shop' => false, 'my--shop' => false, 'ab' => false, 'Northline_X' => false, 'binanceng' => false, 'northline' => true] as $slug => $want) {
        [, $res] = $app_('GET', '/api/merchant/slug-check?slug=' . rawurlencode($slug));
        check(($res['data']['available'] ?? null) === $want, "store name '{$slug}': " . ($want ? 'available' : 'refused (' . ($res['data']['reason'] ?? '?') . ')'));
    }

    // ── Branding ──
    [$c] = $app_('POST', '/api/merchant/brand', ['name' => 'Northline Exchange', 'slug' => 'northline', 'color' => 'red'], $auth($token));
    check($c === 400, 'brand: invalid colour refused');
    [$c] = $app_('POST', '/api/merchant/brand', ['name' => 'Northline Exchange', 'slug' => 'northline', 'logo' => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='], $auth($token));
    check($c === 400, 'brand: SVG logo refused (only PNG/JPG/WebP)');
    [$c] = $app_('POST', '/api/merchant/brand', ['name' => 'Northline Exchange', 'slug' => 'northline', 'logo' => 'data:image/png;base64,' . base64_encode('not really a png')], $auth($token));
    check($c === 400, 'brand: a file that only claims to be a PNG is refused');
    [$c, $res] = $app_('POST', '/api/merchant/brand', ['name' => 'Northline Exchange', 'slug' => 'northline', 'color' => '#6366F1', 'logo' => 'data:image/png;base64,' . base64_encode($png(64, 64))], $auth($token));
    $logo = (string) ($res['data']['brand']['logo'] ?? '');
    check($c === 200 && ($res['data']['brand']['color'] ?? '') === '#6366f1' && preg_match('#^/merchant/logos/\d+-[0-9a-f]{12}\.png$#', $logo) && is_file($tmp . '/logos/' . basename($logo))
        && ($res['data']['storefront_url'] ?? '') !== '' && ($res['data']['checklist']['branded'] ?? false) === true, 'brand: name, address, colour and a real PNG logo saved');
    [$c, $res] = $app_('POST', '/api/merchant/brand', ['name' => 'Northline Exchange', 'slug' => 'northline', 'remove_logo' => true], $auth($token));
    clearstatcache(); // the earlier is_file() answer for this path is cached
    check($c === 200 && array_key_exists('logo', $res['data']['brand'] ?? []) && $res['data']['brand']['logo'] === null && !is_file($tmp . '/logos/' . basename($logo)), 'brand: removing the logo deletes the file');

    // ── Prices ──
    [$c] = $app_('POST', '/api/merchant/pricing', ['coins' => ['BTC' => ['buy' => 9]]], $auth($token));
    check($c === 400, 'pricing: markup above the cap refused');
    [$c] = $app_('POST', '/api/merchant/pricing', ['coins' => ['DOGE' => ['buy' => 1]]], $auth($token));
    check($c === 400, 'pricing: unknown coin refused');
    [$c, $res] = $app_('POST', '/api/merchant/pricing', ['coins' => ['BTC' => ['buy' => 1.5, 'sell' => 0.75], 'ETH' => ['sell_on' => false]]], $auth($token));
    $pr = $res['data']['pricing'] ?? [];
    check($c === 200 && ($pr['BTC']['buy'] ?? 0) == 1.5 && ($pr['BTC']['sell'] ?? 0) == 0.75 && ($pr['ETH']['sell_on'] ?? true) === false && ($pr['ETH']['buy_on'] ?? false) === true
        && ($res['data']['checklist']['priced'] ?? false) === true, 'pricing: markups and switches saved per coin and side');
    // Velcro's rates per $1 (fee included), seeded as the provider cache would be.
    file_put_contents($tmp . '/data/.merchant_rates.json', json_encode(['at' => time(), 'rates' => [
        'BTC' => ['provider' => 'hostfi', 'buy' => 1500.0, 'sell' => 1480.0], 'ETH' => ['provider' => 'hostfi', 'buy' => 1500.0, 'sell' => 1480.0],
        'SOL' => ['provider' => 'paj', 'buy' => 1510.0, 'sell' => 1470.0], 'USDT' => ['provider' => 'switch', 'buy' => 1505.0, 'sell' => 1475.0],
        'USDC' => ['provider' => 'switch', 'buy' => 1505.0, 'sell' => 1475.0],
    ]]));
    [$c, $res] = $app_('GET', '/api/merchant/prices', null, $auth($token));
    check($c === 200 && ($res['data']['rates']['BTC']['buy'] ?? 0) == 1500 && ($res['data']['rates']['SOL']['provider'] ?? '') === 'paj' && ($res['data']['rates']['USDT']['provider'] ?? '') === 'switch',
        'prices: Velcro rate per $1 for each coin, from its provider (BTC HostFi, SOL PAJ, USDT Switch)');
    [, $res] = $app_('GET', '/api/merchant/storefront/northline', null, $auth($token));
    $btc = $res['data']['coins']['BTC'] ?? [];
    check(($btc['buy_rate'] ?? 0) == 1522.5 && ($btc['sell_rate'] ?? 0) == 1468.9 && !array_key_exists('velcro_buy_rate', $btc) && !isset($res['data']['coins']['ETH']['sell_rate'])
        && ($res['data']['store']['rate_display'] ?? '') === 'final',
        'store (owner preview): customer rate = Velcro rate + markup ($1 = ₦1,522.50 buy at 1.5%, ₦1,468.90 sell at 0.75%); base rate hidden; ETH sell off');
    [$c] = $app_('POST', '/api/merchant/pricing', ['display' => 'sideways'], $auth($token));
    [$c2, $res] = $app_('POST', '/api/merchant/pricing', ['display' => 'breakdown'], $auth($token));
    [, $sf] = $app_('GET', '/api/merchant/storefront/northline', null, $auth($token));
    check($c === 400 && $c2 === 200 && ($res['data']['rate_display'] ?? '') === 'breakdown' && ($res['data']['pricing']['BTC']['buy'] ?? 0) == 1.5
        && ($sf['data']['coins']['BTC']['velcro_buy_rate'] ?? 0) == 1500 && ($sf['data']['coins']['BTC']['buy_markup_percent'] ?? 0) == 1.5,
        'rate display: "Velcro rate + markup" saved without touching markups; store then shows base rate and markup');
    [$c] = $app_('GET', '/api/merchant/storefront/northline');
    check($c === 404, 'store not live to the public until approved');

    // ── Verification (KYB) ──
    $kyb = [
        'business_name' => 'Northline Exchange Ltd', 'business_type' => 'registered', 'registration_number' => 'RC123456',
        'contact_name' => 'Ada Obi', 'phone' => '+234 810 000 0000', 'monthly_volume' => '1m_10m', 'agree_terms' => true,
    ];
    [$c] = $app_('POST', '/api/merchant/verification', $kyb);
    check($c === 401, 'verification: needs sign-in');
    [$c] = $app_('POST', '/api/merchant/verification', ['agree_terms' => false] + $kyb, $auth($token));
    check($c === 400, 'verification: terms must be accepted');
    [$c] = $app_('POST', '/api/merchant/verification', ['registration_number' => ''] + $kyb, $auth($token));
    check($c === 400, 'verification: a registered business needs its CAC number');
    [$c, $res] = $app_('POST', '/api/merchant/verification', $kyb, $auth($token));
    check($c === 200 && ($res['data']['status'] ?? '') === 'PENDING' && ($res['data']['slug'] ?? '') === 'northline' && ($res['data']['brand']['name'] ?? '') === 'Northline Exchange',
        'verification: submitted with the store address already chosen; store name kept');

    // Someone else can't take the same store address.
    $other = 'other@example.com';
    [, $res] = $app_('POST', '/api/merchant/auth/signup', ['email' => $other, 'otp' => $code('merchsignup', $other), 'password' => 'OtherPass456']);
    $otherToken = (string) ($res['data']['token'] ?? '');
    [, $res] = $app_('GET', '/api/merchant/slug-check?slug=northline', null, $auth($otherToken));
    [$c] = $app_('POST', '/api/merchant/brand', ['name' => 'Copycat', 'slug' => 'northline'], $auth($otherToken));
    check(($res['data']['available'] ?? null) === false && $c === 409, 'store address already taken: shown as taken, saving it refused');
    [, $res] = $app_('GET', '/api/merchant/slug-check?slug=northline', null, $auth($token));
    check(($res['data']['available'] ?? null) === true, 'store address: still available to the merchant who holds it');

    // ── Admin review ──
    [, $login] = $app_('POST', '/api/admin/login', ['password' => 'correct-horse']);
    $admin = ['Authorization' => 'Bearer ' . ($login['token'] ?? '')];
    [$c] = $app_('GET', '/api/admin/merchants');
    check($c === 401, 'admin merchant list: needs admin');
    [, $res] = $app_('GET', '/api/admin/merchants', null, $admin);
    $byEmail = array_column($res['merchants'] ?? [], null, 'email');
    $id = (int) ($byEmail[$email]['id'] ?? 0);
    check(($res['merchants'][0]['email'] ?? '') === $email && ($byEmail[$email]['status'] ?? '') === 'PENDING' && ($byEmail[$other]['status'] ?? '') === 'DRAFT',
        'admin: pending verification listed first, draft stores listed too');
    [$c] = $app_('POST', '/api/admin/merchants/' . (int) $byEmail[$other]['id'] . '/status', ['status' => 'APPROVED'], $admin);
    check($c === 400, 'admin: a draft store that never submitted verification can’t be approved');
    [$c] = $app_('POST', "/api/admin/merchants/{$id}/status", ['status' => 'REJECTED'], $admin);
    check($c === 400, 'admin: rejecting needs a reason');
    [$c] = $app_('POST', "/api/admin/merchants/{$id}/status", ['status' => 'REJECTED', 'note' => 'CAC number not found'], $admin);
    [, $res] = $app_('GET', '/api/merchant/me', null, $auth($token));
    check($c === 200 && ($res['data']['merchant']['status'] ?? '') === 'REJECTED' && ($res['data']['merchant']['review_note'] ?? '') === 'CAC number not found', 'admin reject: merchant sees the status and reason');
    [$c, $res] = $app_('POST', '/api/merchant/verification', ['registration_number' => 'RC654321'] + $kyb, $auth($token));
    check($c === 200 && ($res['data']['status'] ?? '') === 'PENDING', 'rejected merchant fixes the details: back to pending');
    $app_('POST', "/api/admin/merchants/{$id}/status", ['status' => 'APPROVED'], $admin);
    [$c] = $app_('POST', '/api/merchant/verification', $kyb, $auth($token));
    [$cSlug] = $app_('POST', '/api/merchant/brand', ['name' => 'Northline Exchange', 'slug' => 'northline-2'], $auth($token));
    [$cName, $res] = $app_('POST', '/api/merchant/brand', ['name' => 'Northline X', 'slug' => 'northline'], $auth($token));
    check($c === 400 && $cSlug === 400 && $cName === 200 && ($res['data']['status'] ?? '') === 'APPROVED' && ($res['data']['checklist']['verified'] ?? false) === true,
        'approved: verification locked, address fixed, name and look still editable');

    // ── Store customers: separate accounts per store ──
    $storeCode = static function (int $merchantId, string $purpose, string $em) use ($pdo): string {
        $key = $purpose . $merchantId . ':' . substr(hash('sha256', $em), 0, 40);
        $pdo->prepare('INSERT OR REPLACE INTO otps (otp_key, code, expires_at, attempts) VALUES (?, ?, ?, 0)')->execute([$key, '654321', (int) (microtime(true) * 1000) + 300000]);
        return '654321';
    };
    $shopper = 'buyer@example.com';
    [$c, $res] = $app_('GET', '/api/merchant/storefront/northline');
    check($c === 200 && ($res['data']['store']['name'] ?? '') === 'Northline X' && array_key_exists('google_client_id', $res['data'] ?? []), 'approved store is public');
    [$c] = $app_('POST', '/api/store/northline/auth/signup', ['email' => $shopper, 'otp' => '000000', 'password' => 'Shopper123']);
    check($c === 403, 'store sign-up: wrong code refused');
    [$c, $res] = $app_('POST', '/api/store/northline/auth/signup', ['email' => $shopper, 'otp' => $storeCode($id, 'stsu', $shopper), 'password' => 'Shopper123']);
    $shopToken = (string) ($res['data']['token'] ?? '');
    check($c === 200 && $shopToken !== '', 'store sign-up: code + password creates a Northline customer');
    [$c, $res] = $app_('GET', '/api/store/northline/me', null, ['X-Store-Token' => $shopToken]);
    check($c === 200 && ($res['data']['customer']['email'] ?? '') === $shopper, 'store customer signed in');
    [$c] = $app_('POST', '/api/store/northline/auth/login', ['email' => $shopper, 'password' => 'Wrong1234']);
    [$c2, $res] = $app_('POST', '/api/store/northline/auth/login', ['email' => $shopper, 'password' => 'Shopper123']);
    check($c === 401 && $c2 === 200, 'store sign-in: wrong password refused, right one works');
    [$c] = $app_('GET', '/api/store/northline/me', null, ['X-Merchant-Token' => $token]);
    check($c === 401, 'a merchant token is not a customer token');
    [$c] = $app_('POST', '/api/store/nostore/auth/login', ['email' => $shopper, 'password' => 'Shopper123']);
    check($c === 404, 'unknown store: 404');

    // A second approved store: the same email is a separate account there.
    $app_('POST', '/api/merchant/brand', ['name' => 'Other Store', 'slug' => 'otherstore'], $auth($otherToken));
    $app_('POST', '/api/merchant/verification', ['business_name' => 'Other Ltd', 'slug' => 'otherstore'] + $kyb, $auth($otherToken));
    [, $res] = $app_('GET', '/api/admin/merchants', null, $admin);
    $byEmail = array_column($res['merchants'] ?? [], null, 'email');
    $otherId = (int) ($byEmail[$other]['id'] ?? 0);
    $app_('POST', "/api/admin/merchants/{$otherId}/status", ['status' => 'APPROVED'], $admin);
    [$c] = $app_('GET', '/api/store/otherstore/me', null, ['X-Store-Token' => $shopToken]);
    [$c2] = $app_('POST', '/api/store/otherstore/auth/login', ['email' => $shopper, 'password' => 'Shopper123']);
    check($c === 401 && $c2 === 401, "Northline's customer token and password don't work at another store");
    [$c] = $app_('POST', '/api/store/otherstore/auth/signup', ['email' => $shopper, 'otp' => $storeCode($otherId, 'stsu', $shopper), 'password' => 'Different99']);
    [$cA] = $app_('POST', '/api/store/northline/auth/login', ['email' => $shopper, 'password' => 'Shopper123']);
    [$cB] = $app_('POST', '/api/store/otherstore/auth/login', ['email' => $shopper, 'password' => 'Different99']);
    check($c === 200 && $cA === 200 && $cB === 200, 'same email at two stores: two separate accounts with their own passwords');

    [$c, $res] = $app_('POST', '/api/store/northline/auth/reset', ['email' => $shopper, 'otp' => $storeCode($id, 'strs', $shopper), 'password' => 'NewShop456']);
    [$cOld] = $app_('GET', '/api/store/northline/me', null, ['X-Store-Token' => $shopToken]);
    check($c === 200 && $cOld === 401, 'store password reset signs out old sessions');

    [, $res] = $app_('GET', '/api/merchant/customers', null, $auth($token));
    check(($res['data']['total'] ?? 0) === 1 && ($res['data']['customers'][0]['email'] ?? '') === $shopper, "merchant sees only their own store's customers");
    [, $res] = $app_('GET', "/api/admin/merchants/{$id}/customers", null, $admin);
    [, $list] = $app_('GET', '/api/admin/merchants', null, $admin);
    $counts = array_column($list['merchants'] ?? [], 'customers', 'email');
    check(count($res['customers'] ?? []) === 1 && (int) ($counts[$email] ?? 0) === 1 && (int) ($counts[$other] ?? 0) === 1, 'admin: customers per store, and a count on the merchants list');
} finally {
    proc_terminate($app);
}

echo $failed === 0 ? "\nAll merchant checks passed.\n" : "\n{$failed} merchant check(s) FAILED. Server log: {$log}\n";
exit($failed === 0 ? 0 : 1);
