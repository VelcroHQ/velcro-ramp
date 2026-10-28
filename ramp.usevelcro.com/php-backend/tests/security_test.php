<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

/**
 * Order-status and admin-auth checks against the real routes (php -S + SQLite, no MySQL needed).
 * Run with: php tests/security_test.php
 */

$tmp = sys_get_temp_dir() . '/velcro_sec_test_' . getmypid();
@mkdir($tmp . '/data', 0777, true);
define('BASE_PATH', $tmp);
putenv('VELCRO_TEST_BASE=' . $tmp);
putenv('ADMIN_PASSWORD=correct-horse');
putenv('PAJ_API_KEY='); // PAJ unreachable: nothing may complete an order on the client's word

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../helpers.php';

$pdo = new PDO('sqlite:' . $tmp . '/test.db', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$pdo->exec('CREATE TABLE transactions (id INTEGER PRIMARY KEY, reference TEXT, switch_reference TEXT, type TEXT, channel TEXT, status TEXT, asset TEXT, hash TEXT, explorer_url TEXT, wallet_address TEXT, meta TEXT, email TEXT, updated_at TEXT)');
$pdo->exec('CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, action TEXT, ip TEXT, user_agent TEXT, details TEXT)');
$pdo->exec("INSERT INTO transactions (reference, type, channel, status, asset, email) VALUES ('paj_abc123', 'ONRAMP', 'PAJ', 'AWAITING_DEPOSIT', 'USDC', 'a@example.com')");

$port = random_int(20000, 40000);
$server = proc_open([PHP_BINARY, '-S', "127.0.0.1:{$port}", __DIR__ . '/support/security_router.php'], [['pipe', 'r'], ['file', $tmp . '/server.log', 'a'], ['file', $tmp . '/server.log', 'a']], $pipes);
for ($i = 0; $i < 50 && !@fsockopen('127.0.0.1', $port); $i++) {
    usleep(100000);
}

function post(int $port, string $path, array $body, string $auth = ''): array
{
    $ctx = stream_context_create(['http' => [
        'method' => 'POST',
        'header' => "Content-Type: application/json\r\n" . ($auth !== '' ? "Authorization: {$auth}\r\n" : ''),
        'content' => json_encode($body),
        'ignore_errors' => true,
    ]]);
    $raw = file_get_contents("http://127.0.0.1:{$port}{$path}", false, $ctx);
    preg_match('/\d{3}/', $http_response_header[0] ?? '', $m);
    return [(int) ($m[0] ?? 0), json_decode((string) $raw, true) ?? []];
}

function get(int $port, string $path, string $auth): int
{
    $ctx = stream_context_create(['http' => ['header' => "Authorization: {$auth}\r\n", 'ignore_errors' => true]]);
    file_get_contents("http://127.0.0.1:{$port}{$path}", false, $ctx);
    preg_match('/\d{3}/', $http_response_header[0] ?? '', $m);
    return (int) ($m[0] ?? 0);
}

$failed = 0;
function check(bool $ok, string $msg): void
{
    global $failed;
    echo ($ok ? '✅' : '❌') . " {$msg}\n";
    $failed += $ok ? 0 : 1;
}

try {
    // ── /api/confirm cannot complete a PAJ order ──
    [$code, $res] = post($port, '/api/confirm', ['reference' => 'paj_abc123', 'hash' => 'fakehash']);
    $status = $pdo->query("SELECT status FROM transactions WHERE reference = 'paj_abc123'")->fetchColumn();
    check($code === 200 && $status === 'AWAITING_DEPOSIT', 'confirm on an unpaid PAJ order leaves it AWAITING_DEPOSIT');
    check(($res['status'] ?? null) === 'AWAITING_DEPOSIT', 'confirm reports the real status back');

    // ── Admin login issues a token; the token works, tampering does not ──
    [$code] = post($port, '/api/admin/login', ['password' => 'wrong']);
    check($code === 401, 'wrong password is rejected');
    [$code, $res] = post($port, '/api/admin/login', ['password' => 'correct-horse']);
    $token = (string) ($res['token'] ?? '');
    check($code === 200 && str_starts_with($token, 'adm1.') && !str_contains($token, 'correct-horse'), 'login returns a token, not the password');
    check(get($port, '/api/admin/config', "Bearer {$token}") === 200, 'token opens admin routes');
    check(get($port, '/api/admin/config', 'Bearer ' . substr($token, 0, -1) . (str_ends_with($token, '0') ? '1' : '0')) === 401, 'tampered token is rejected');
    $parts = explode('.', $token);
    check(get($port, '/api/admin/config', "Bearer adm1." . (time() - 10) . ".{$parts[2]}") === 401, 'expired token is rejected');
} finally {
    proc_terminate($server);
}

echo $failed === 0 ? "\nAll security checks passed.\n" : "\n{$failed} security check(s) FAILED.\n";
exit($failed === 0 ? 0 : 1);
