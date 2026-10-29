<?php

declare(strict_types=1);

// Fake HostFi API for tests/hostfi_test.php, run with `php -S`. State lives in a JSON file so the
// test can register real deposits, change payout outcomes and count swaps/payouts.
if (PHP_SAPI !== 'cli-server') {
    http_response_code(404);
    exit;
}

$stateFile = (string) getenv('HOSTFI_MOCK_STATE');
$fp = fopen($stateFile, 'c+');
flock($fp, LOCK_EX);
$state = json_decode((string) stream_get_contents($fp), true) ?: ['deposits' => [], 'swaps' => [], 'payouts' => [], 'payout_status' => 'WITHDRAWAL_PENDING', 'fail_payouts' => false, 'swap_status' => 'SUCCESS', 'swap_overrides' => []];

$method = $_SERVER['REQUEST_METHOD'];
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
parse_str((string) parse_url($_SERVER['REQUEST_URI'], PHP_URL_QUERY), $query);
$body = json_decode(file_get_contents('php://input') ?: '', true) ?: [];

$respond = static function (int $code, array $data) use (&$state, $fp): never {
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode($state));
    flock($fp, LOCK_UN);
    http_response_code($code);
    header('Content-Type: application/json');
    header('Access-Control-Allow-Origin: *'); // lets a browser e2e drive the /__test controls
    echo json_encode($data);
    exit;
};
$asset = static fn (string $code, array $networks) => [
    'id' => 'asset-' . strtolower($code),
    'balance' => 1000,
    'currency' => ['code' => $code, 'name' => $code, 'networks' => array_map(fn ($n) => ['network' => $n, 'activities' => ['DEPOSIT', 'WITHDRAW']], $networks)],
];
// Naira per coin. Like the live API, `rate` is toCurrency per one fromCurrency.
$ngnRates = ['BTC' => 150000000, 'ETH' => 5000000, 'USDT' => 1500, 'USDC' => 1500, 'SOL' => 300000];

if ($method === 'OPTIONS') {
    header('Access-Control-Allow-Headers: Content-Type');
    $respond(204, []);
}

// ── Test controls ──
if ($path === '/__test/deposit') {
    $state['deposits'][$body['reference']] = $body;
    $respond(200, ['ok' => true]);
}
if ($path === '/__test/set') {
    $state = array_merge($state, $body);
    $respond(200, ['ok' => true]);
}
if ($path === '/__test/state') {
    $respond(200, $state);
}

if (($_SERVER['HTTP_X_AUTH_TOKEN'] ?? '') !== 'test-token' && $path !== '/auth/token') {
    $respond(401, ['code' => 'UNAUTHORIZED', 'message' => 'Bad token']);
}

switch (true) {
    case $method === 'POST' && $path === '/auth/token':
        $ok = ($body['clientId'] ?? '') === 'test-client' && ($body['clientSecret'] ?? '') === 'test-secret';
        $ok ? $respond(200, ['token' => 'test-token', 'expiresIn' => 3600]) : $respond(401, ['code' => 'UNAUTHORIZED', 'message' => 'Bad credentials']);

    case $method === 'GET' && $path === '/v1/assets':
        $respond(200, ['assets' => [
            $asset('BTC', ['BTC']), $asset('ETH', ['ERC20']), $asset('USDT', ['TRC20', 'ERC20']),
            $asset('USDC', ['ERC20']), $asset('SOL', ['SOL']), $asset('NGN', []),
        ]]);

    case $method === 'GET' && $path === '/v1/conversions':
        // Live API: with both currencies it returns one object with the rate as a string.
        // Coin→USD exists for BTC/SOL/USDT/USDC but not ETH, as on the live API.
        $usdRates = ['BTC' => 100000, 'SOL' => 200, 'USDT' => 1, 'USDC' => 1];
        if (strtoupper($query['toCurrency'] ?? '') === 'USD') {
            $usd = $usdRates[strtoupper($query['fromCurrency'] ?? '')] ?? null;
            $usd ? $respond(200, ['fromCurrency' => $query['fromCurrency'], 'toCurrency' => 'USD', 'rate' => (string) $usd]) : $respond(400, ['code' => 'BAD_REQUEST', 'message' => 'We could not find any matching rates for your selected currency pair']);
        }
        if (strtoupper($query['fromCurrency'] ?? '') === 'NGN') {
            $per = $ngnRates[strtoupper($query['toCurrency'] ?? '')] ?? null;
            $per ? $respond(200, ['fromCurrency' => 'NGN', 'toCurrency' => $query['toCurrency'], 'rate' => (string) (1 / $per)]) : $respond(400, ['code' => 'CURRENCY_NOT_SUPPORTED', 'message' => 'No conversion was found']);
        }
        $rate = $ngnRates[strtoupper($query['fromCurrency'] ?? '')] ?? null;
        $rate ? $respond(200, ['fromCurrency' => $query['fromCurrency'], 'toCurrency' => 'NGN', 'isMarketRate' => false, 'rate' => (string) $rate]) : $respond(400, ['code' => 'CURRENCY_NOT_SUPPORTED', 'message' => 'No conversion was found']);

    case $method === 'POST' && $path === '/v1/collections/crypto/addresses':
        $respond(200, ['id' => 'addr-' . $body['customId'], 'address' => 'ADDR_' . $body['customId'], 'network' => $body['network'], 'memo' => null, 'identifier' => $body['customId']]);

    case $method === 'GET' && preg_match('#^/v1/collections/transactions/(.+)$#', $path, $m) === 1:
        $d = $state['deposits'][$m[1]] ?? null;
        $d ? $respond(200, [
            'reference' => $d['reference'], 'status' => $d['status'] ?? 'SUCCESS', 'type' => 'CREDIT', 'category' => 'CRYPTO_DEPOSIT',
            'amount' => ['currency' => $d['currency'], 'value' => $d['amount']],
            'recipientAccountNumber' => $d['recipientAccountNumber'] ?? null,
            'metadata' => ($d['currency'] === 'NGN')
                ? array_values(array_filter([isset($d['customId']) ? ['name' => 'customId', 'value' => $d['customId']] : null]))
                : [['name' => 'address', 'value' => $d['address']], ['name' => 'network', 'value' => $d['network'] ?? 'BTC'], ['name' => 'transactionId', 'value' => 'tx-' . $d['reference']]],
        ]) : $respond(404, ['code' => 'RESOURCE_NOT_FOUND', 'message' => 'Not found']);

    case $method === 'POST' && $path === '/v1/collections/fiat/channels':
        $state['channels'][] = $body;
        $respond(200, ['id' => 'chan-' . $body['customId'], 'reference' => 'chanref-' . $body['customId'], 'type' => 'BANK_TRANSFER', 'bankName' => 'Wema Bank',
            'accountNumber' => (string) (9000000000 + count($state['channels'])), 'accountName' => 'VELCRO CHECKOUT', 'currency' => 'NGN']);

    case $method === 'GET' && $path === '/v1/payout/methods':
        $nets = ['SOL' => [['SOL', 0.003, 0.006]], 'BTC' => [['BTC', 0.00001, 0.000014]], 'ETH' => [['ERC20', 0.0003, 0.0001], ['BASE', 0.0004, 0.0001]]];
        $cur = strtoupper($query['sourceCurrency'] ?? '');
        $respond(200, ['methods' => array_map(fn ($n) => ['type' => 'CRYPTO', 'enabled' => true, 'network' => $n[0], 'sourceCurrency' => $cur, 'targetCurrency' => $cur,
            'fee' => ['min' => 0, 'max' => 0, 'percent' => 0, 'flat' => $n[1]], 'limits' => ['min' => $n[2], 'max' => 1000000]], $nets[$cur] ?? [])]);

    case $method === 'POST' && $path === '/v1/assets/swap':
        $from = $body['source']['currency'];
        $to = $body['target']['currency'];
        $value = (float) $body['amount']['value'];
        // Coin → naira for sells, naira → coin for buys.
        $ngn = $from === 'NGN' ? round($value / $ngnRates[$to], 8) : round($value * $ngnRates[$from], 2);
        $n = count($state['swaps']) + 1;
        $credit = ['reference' => "swap-c-{$n}", 'swapPairReference' => "pair-{$n}", 'type' => 'CREDIT', 'category' => 'SWAP', 'status' => $state['swap_status'] ?? 'SUCCESS', 'amount' => ['currency' => $to, 'value' => $ngn]];
        $state['swaps'][] = ['from' => $from, 'value' => $value, 'ngn' => $ngn, 'credit' => $credit];
        $respond(200, ['transactions' => [
            $credit,
            ['reference' => "swap-d-{$n}", 'swapPairReference' => "pair-{$n}", 'type' => 'DEBIT', 'category' => 'SWAP', 'status' => $credit['status'], 'amount' => ['currency' => $from, 'value' => $value]],
        ]]);

    case $method === 'GET' && preg_match('#^/v1/assets/transactions/(.+)$#', $path, $m) === 1:
        foreach ($state['swaps'] as $sw) {
            if ($sw['credit']['reference'] === $m[1]) {
                $sw['credit']['status'] = $state['swap_overrides'][$m[1]] ?? $sw['credit']['status'];
                $respond(200, $sw['credit']);
            }
        }
        $respond(404, ['code' => 'RESOURCE_NOT_FOUND', 'message' => 'Not found']);

    case $method === 'GET' && $path === '/v1/payout/banks/NG/list':
        $respond(200, ['banks' => [['bankId' => 'NG::100004', 'bankName' => 'OPAY'], ['bankId' => 'NG::000013', 'bankName' => 'Guaranty Trust Bank']]]);

    case $method === 'POST' && $path === '/v1/payout/accounts/lookup':
        $respond(200, ['bankId' => $body['bankId'], 'accountNumber' => $body['accountNumber'], 'accountName' => 'ADA LOVELACE']);

    case $method === 'POST' && $path === '/v1/payout/transactions':
        $ref = $body['clientReference'];
        if (isset($state['payouts'][$ref])) {
            $respond(400, ['code' => 'DUPLICATE_TRANSACTION', 'message' => 'Duplicate transaction']);
        }
        if ($state['fail_payouts']) {
            $respond(503, ['code' => 'SERVER_ERROR', 'message' => 'Payout provider down']);
        }
        $state['payouts'][$ref] = ['reference' => 'po-' . count($state['payouts']), 'clientReference' => $ref, 'amount' => ['value' => $body['amount'], 'currency' => $body['currency']], 'recipient' => $body['recipient'], 'status' => $state['payout_status'],
            'metadata' => [['name' => 'transactionId', 'value' => 'chain-tx-' . $ref]]];
        $respond(200, $state['payouts'][$ref]);

    case $method === 'GET' && preg_match('#^/v1/payout/transactions/(.+)$#', $path, $m) === 1:
        $p = $state['payouts'][$m[1]] ?? null;
        if (!$p) {
            $respond(404, ['code' => 'RESOURCE_NOT_FOUND', 'message' => 'Not found']);
        }
        $p['status'] = $state['payout_overrides'][$m[1]] ?? $p['status'];
        $respond(200, $p);
}
$respond(404, ['code' => 'RESOURCE_NOT_FOUND', 'message' => "No mock for {$method} {$path}"]);
