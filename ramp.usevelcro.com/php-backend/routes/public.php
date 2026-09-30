<?php

declare(strict_types=1);

require_once __DIR__ . '/../switch_api.php';

// ─── Public API Routes ───

function registerPublicRoutes(Router $router): void
{
    $router->get('/api/health', function () {
        jsonResponse(successResponse([
            'service' => APP_NAME,
            'version' => APP_VERSION,
            'db' => Database::isConnected() ? 'mysql' : 'offline',
            'dbConnected' => Database::isConnected(),
        ]));
    });

    $router->get('/api/assets', function () {
        $cacheFile = BASE_PATH . '/data/switch_assets_cache.json';
        $cacheTtl = 600; // 10 minutes cache

        // 1. Check if valid fresh cache exists
        if (file_exists($cacheFile) && (time() - filemtime($cacheFile)) < $cacheTtl) {
            $cached = @json_decode((string) file_get_contents($cacheFile), true);
            if (is_array($cached) && !empty($cached['offramp'])) {
                jsonResponse(successResponse($cached));
                return;
            }
        }

        // 2. Fetch live assets from Switch API
        try {
            $data = switchApi()->getAssets();
            $assets = $data['data'] ?? [];
        } catch (Throwable $e) {
            error_log('Switch /asset failed: ' . $e->getMessage());
            $assets = [];
        }

        // 3. Fallback to cached file if live fetch returned empty
        if (empty($assets) && file_exists($cacheFile)) {
            $cached = @json_decode((string) file_get_contents($cacheFile), true);
            if (is_array($cached) && !empty($cached['offramp'])) {
                jsonResponse(successResponse($cached));
                return;
            }
        }

        $blockchains = [];
        $offramp = [];
        $onramp = [];

        foreach ($assets as $asset) {
            $chainId = strtolower($asset['blockchain']['name'] ?? 'unknown');
            $chainName = $asset['blockchain']['name'] ?? 'Unknown';
            $symbol = $asset['code'] ?? '';
            $name = $asset['name'] ?? '';

            if (!isset($blockchains[$chainId])) {
                $blockchains[$chainId] = [
                    'id' => $chainId,
                    'name' => $chainName,
                    'type' => $asset['blockchain']['type'] ?? '',
                ];
            }

            if (!empty($asset['offramp_supported'])) {
                $offramp[$symbol] = $offramp[$symbol] ?? ['name' => $name, 'chains' => []];
                if (!in_array($chainId, $offramp[$symbol]['chains'], true)) {
                    $offramp[$symbol]['chains'][] = $chainId;
                }
            }
            if (!empty($asset['onramp_supported'])) {
                $onramp[$symbol] = $onramp[$symbol] ?? ['name' => $name, 'chains' => []];
                if (!in_array($chainId, $onramp[$symbol]['chains'], true)) {
                    $onramp[$symbol]['chains'][] = $chainId;
                }
            }
        }

        foreach ($offramp as $sym => &$info) {
            sort($info['chains']);
        }
        foreach ($onramp as $sym => &$info) {
            sort($info['chains']);
        }
        unset($info);

        $result = ['offramp' => $offramp, 'onramp' => $onramp, 'blockchains' => $blockchains];

        // Save fresh cache if result contains valid data
        if (!empty($offramp) || !empty($onramp)) {
            $dir = dirname($cacheFile);
            if (!is_dir($dir)) {
                @mkdir($dir, 0755, true);
            }
            @file_put_contents($cacheFile, json_encode($result, JSON_PRETTY_PRINT), LOCK_EX);
        }

        jsonResponse(successResponse($result));
    });

    $router->get('/api/rates', function () {
        try {
            $data = switchApi()->getRates([
                'country' => query('country'),
                'currency' => query('currency'),
            ]);
            jsonResponse($data);
        } catch (Throwable $e) {
            error_log('Switch /rates failed: ' . $e->getMessage());
            jsonResponse(successResponse([], 'Switch rates unavailable'));
        }
    });

    $router->get('/api/institutions', function () {
        try {
            $data = switchApi()->getInstitutions([
                'country' => query('country'),
                'currency' => query('currency'),
                'channel' => query('channel'),
            ]);
            jsonResponse($data);
        } catch (Throwable $e) {
            error_log('Switch /institutions failed: ' . $e->getMessage());
            jsonResponse(successResponse([], 'Switch institutions unavailable'));
        }
    });

    $router->post('/api/resolve', function () {
        $body = getJsonBody();
        $country = body($body, 'country');
        $beneficiary = body($body, 'beneficiary');
        if (!$country || !$beneficiary) {
            jsonResponse(errorResponse('country and beneficiary are required'), 400);
        }
        try {
            $data = switchApi()->lookupBeneficiary($country, $beneficiary);
            jsonResponse($data);
        } catch (Throwable $e) {
            $status = $e->getCode() >= 400 ? $e->getCode() : 400;
            jsonResponse([
                'status' => 'ERROR',
                'message' => $e->getMessage()
            ], $status);
        }
    });

    $router->get('/api/requirements', function () {
        $direction = query('direction');
        $country = query('country');
        if (!$direction || !$country) {
            jsonResponse(errorResponse('direction and country are required'), 400);
        }
        try {
            $data = switchApi()->getRequirements([
                'direction' => $direction,
                'country' => $country,
                'currency' => query('currency'),
                'type' => query('type'),
                'channel' => query('channel'),
            ]);
            jsonResponse($data);
        } catch (Throwable $e) {
            error_log('Switch /requirements failed: ' . $e->getMessage());
            jsonResponse(successResponse([], 'Switch requirements unavailable'));
        }
    });

    $router->post('/api/rate', function () {
        $body = getJsonBody();
        $direction = body($body, 'direction');
        $country = body($body, 'country');
        if (!$direction || !$country) {
            jsonResponse(errorResponse('direction and country are required'), 400);
        }
        try {
            $data = switchApi()->getRate($body);
            jsonResponse($data);
        } catch (Throwable $e) {
            $status = $e->getCode() >= 400 ? $e->getCode() : 400;
            jsonResponse([
                'status' => 'ERROR',
                'message' => $e->getMessage()
            ], $status);
        }
    });

    $router->post('/api/initiate', function () {
        $body = getJsonBody();
        $direction = body($body, 'direction');
        $amount = body($body, 'amount');
        $country = body($body, 'country');
        $asset = body($body, 'asset');

        if (!$direction || !$amount || !$country || !$asset) {
            jsonResponse(errorResponse('direction, amount, country, and asset are required'), 400);
        }

        $txRef = body($body, 'reference') ?? generateUuid();
        $callbackUrl = body($body, 'callback_url');
        $walletAddress = body($body, 'wallet_address');
        $email = body($body, 'email');
        $beneficiary = body($body, 'beneficiary');

        // If wallet_address wasn't at root, extract from beneficiary (used by onramp)
        if (empty($walletAddress) && is_array($beneficiary) && !empty($beneficiary['wallet_address'])) {
            $walletAddress = $beneficiary['wallet_address'];
        }

        try {
            $data = switchApi()->initiateOrder([
                'direction' => $direction,
                'amount' => $amount,
                'country' => $country,
                'asset' => $asset,
                'currency' => body($body, 'currency'),
                'channel' => body($body, 'channel'),
                'beneficiary' => $beneficiary,
                'reference' => $txRef,
                'reason' => body($body, 'reason'),
                'exact_output' => body($body, 'exact_output'),
                'callback_url' => $callbackUrl,
                'wallet_address' => $walletAddress,
            ]);
        } catch (Throwable $e) {
            $status = $e->getCode() >= 400 ? $e->getCode() : 400;
            jsonResponse([
                'status' => 'ERROR',
                'message' => $e->getMessage()
            ], $status);
        }

        $d = $data['data'] ?? [];
        $dep = $d['deposit'] ?? [];
        $fee = $d['fee'] ?? [];
        $src = $d['source'] ?? [];
        $dst = $d['destination'] ?? [];

        // Final fallback if Switch returned beneficiary wallet address
        if (empty($walletAddress) && $direction === 'ONRAMP') {
            $walletAddress = $d['beneficiary']['wallet_address']
                ?? ($d['destination']['address']
                ?? ($beneficiary['wallet_address'] ?? null));
        }

        $depositNote = $dep['note'] ?? null;
        if (is_array($depositNote)) {
            $depositNote = implode("\n", $depositNote);
        }

        try {
            Database::insert('transactions', [
                'reference' => $txRef,
                'switch_reference' => $d['id'] ?? ($d['reference'] ?? null),
                'type' => $direction,
                'status' => strtoupper($d['status'] ?? 'AWAITING_DEPOSIT'),
                'country' => $country,
                'currency' => body($body, 'currency') ?? ($direction === 'ONRAMP' ? ($src['currency'] ?? null) : ($dst['currency'] ?? null)) ?? 'NGN',
                'asset' => $asset,
                'channel' => body($body, 'channel') ?? 'BANK',
                'amount' => $amount,
                'rate' => $d['rate'] ?? null,
                'fee_total' => $fee['total'] ?? null,
                'fee_platform' => $fee['platform'] ?? null,
                'fee_developer' => $fee['developer'] ?? null,
                'source_amount' => $src['amount'] ?? null,
                'source_currency' => $src['currency'] ?? null,
                'destination_amount' => $dst['amount'] ?? null,
                'destination_currency' => $dst['currency'] ?? null,
                'deposit_address' => $dep['address'] ?? null,
                'deposit_bank_name' => $dep['bank_name'] ?? null,
                'deposit_account_number' => $dep['account_number'] ?? null,
                'deposit_account_name' => $dep['account_name'] ?? null,
                'deposit_note' => $depositNote,
                'beneficiary' => jsonEncodeNullable($beneficiary),
                'wallet_address' => $walletAddress,
                'callback_url' => $callbackUrl,
                'email' => $email ? strtolower(trim($email)) : null,
                'meta' => jsonEncodeNullable($d),
            ]);
        } catch (Throwable $e) {
            error_log('DB write failed in /api/initiate: ' . $e->getMessage());
            jsonResponse([
                'status' => 'ERROR',
                'message' => 'Failed to record transaction in database: ' . $e->getMessage()
            ], 500);
        }

        jsonResponse($data);
    });

    $router->get('/api/status', function () {
        $reference = query('reference');
        if (!$reference) {
            jsonResponse(errorResponse('reference is required'), 400);
        }
        try {
            $data = switchApi()->getPaymentStatus($reference);
            $d = $data['data'] ?? [];
            if (!empty($d['status'])) {
                $meta = $d['meta'] ?? [];
                $hash = $meta['hash'] ?? ($d['hash'] ?? null);
                $explorerUrl = $meta['explorer_url'] ?? ($d['explorer_url'] ?? null);
                Database::safeExecute(
                    'UPDATE `transactions` SET `status` = :status, `hash` = COALESCE(:hash, `hash`), `explorer_url` = COALESCE(:explorer_url, `explorer_url`), `meta` = COALESCE(:meta, `meta`) WHERE `reference` = :reference OR `switch_reference` = :reference',
                    [
                        'status' => strtoupper($d['status']),
                        'hash' => $hash,
                        'explorer_url' => $explorerUrl,
                        'meta' => jsonEncodeNullable($d),
                        'reference' => $reference,
                    ]
                );
            }
            jsonResponse($data);
        } catch (Throwable $e) {
            $status = $e->getCode() >= 400 ? $e->getCode() : 400;
            jsonResponse([
                'status' => 'ERROR',
                'message' => $e->getMessage()
            ], $status);
        }
    });

    $router->post('/api/cancel', function () {
        $body = getJsonBody();
        $reference = body($body, 'reference');
        if (!$reference) {
            jsonResponse(errorResponse('reference is required'), 400);
        }
        Database::safeExecute(
            'UPDATE `transactions` SET `status` = :status WHERE `reference` = :reference OR `switch_reference` = :reference',
            ['status' => 'CANCELLED', 'reference' => $reference]
        );
        jsonResponse(['success' => true, 'message' => 'Transaction cancelled']);
    });

    $router->post('/api/confirm', function () {
        $body = getJsonBody();
        $reference = body($body, 'reference');
        $hash = body($body, 'hash');
        if (!$reference) {
            jsonResponse(errorResponse('reference is required'), 400);
        }
        try {
            $data = switchApi()->confirmPayment($reference, $hash);
            $d = $data['data'] ?? [];
            
            // Always query live status from Switch immediately after confirm to get authoritative status
            try {
                $liveStatusData = switchApi()->getPaymentStatus($reference);
                if (!empty($liveStatusData['data']['status'])) {
                    $d = array_merge($d, $liveStatusData['data']);
                    $data = $liveStatusData;
                }
            } catch (Throwable $e) {
                error_log("Failed to fetch live status immediately after confirm for {$reference}: " . $e->getMessage());
            }

            $newStatus = strtoupper($d['status'] ?? 'PROCESSING');
            $meta = $d['meta'] ?? [];
            $explorerUrl = $meta['explorer_url'] ?? ($d['explorer_url'] ?? null);

            Database::safeExecute(
                'UPDATE `transactions` SET `status` = :status, `hash` = COALESCE(:hash, `hash`), `explorer_url` = COALESCE(:explorer_url, `explorer_url`), `meta` = COALESCE(:meta, `meta`) WHERE `reference` = :reference OR `switch_reference` = :reference',
                [
                    'status' => $newStatus,
                    'hash' => $hash ?: ($d['hash'] ?? null),
                    'explorer_url' => $explorerUrl,
                    'meta' => jsonEncodeNullable($d),
                    'reference' => $reference,
                ]
            );
            jsonResponse($data);
        } catch (Throwable $e) {
            $status = $e->getCode() >= 400 ? $e->getCode() : 400;
            jsonResponse([
                'status' => 'ERROR',
                'message' => $e->getMessage()
            ], $status);
        }
    });

    $router->get('/api/transactions', function () {
        $email = query('email');
        if (!$email) {
            jsonResponse(successResponse([]));
        }
        $type = query('type');
        $country = query('country');
        $status = query('status');
        $limit = max(1, min((int) query('limit', 50), 100));
        $offset = max(0, (int) query('offset', 0));

        $where = ['email = :email'];
        $params = ['email' => strtolower(trim($email))];
        if ($type) {
            $where[] = 'type = :type';
            $params['type'] = $type;
        }
        if ($country) {
            $where[] = 'country = :country';
            $params['country'] = $country;
        }
        if ($status) {
            $where[] = 'status = :status';
            $params['status'] = $status;
        }

        $sql = 'SELECT * FROM `transactions` WHERE ' . implode(' AND ', $where) .
               ' ORDER BY `created_at` DESC LIMIT :limit OFFSET :offset';
        $params['limit'] = $limit;
        $params['offset'] = $offset;

        try {
            $rows = Database::select($sql, $params);
            foreach ($rows as &$row) {
                $row = decodeJsonColumns($row, ['beneficiary', 'meta']);
                if (empty($row['wallet_address'])) {
                    $ben = $row['beneficiary'] ?? [];
                    $meta = $row['meta'] ?? [];
                    $row['wallet_address'] = $ben['wallet_address']
                        ?? ($meta['beneficiary']['wallet_address']
                        ?? ($meta['recipient']
                        ?? ($meta['destination']['address'] ?? null)));
                }
            }
            jsonResponse(successResponse($rows));
        } catch (Throwable $e) {
            jsonResponse(errorResponse($e->getMessage()), 500);
        }
    });

    $router->get('/api/transactions/([a-zA-Z0-9_-]+)', function (string $reference) {
        try {
            $row = Database::selectOne('SELECT * FROM `transactions` WHERE `reference` = :reference', ['reference' => $reference]);
            if ($row === null) {
                jsonResponse(errorResponse('Transaction not found', 404), 404);
            }
            $row = decodeJsonColumns($row, ['beneficiary', 'meta']);
            if (empty($row['wallet_address'])) {
                $ben = $row['beneficiary'] ?? [];
                $meta = $row['meta'] ?? [];
                $row['wallet_address'] = $ben['wallet_address']
                    ?? ($meta['beneficiary']['wallet_address']
                    ?? ($meta['recipient']
                    ?? ($meta['destination']['address'] ?? null)));
            }
            jsonResponse(successResponse($row));
        } catch (Throwable $e) {
            $status = $e->getCode() >= 400 ? $e->getCode() : 500;
            jsonResponse([
                'status' => 'ERROR',
                'message' => $e->getMessage()
            ], $status);
        }
    });

    $router->get('/api/history', function () {
        try {
            $data = switchApi()->getHistory([
                'limit' => query('limit', 20),
                'offset' => query('offset', 0),
                'status' => query('status'),
                'direction' => query('direction'),
            ]);
            jsonResponse($data);
        } catch (Throwable $e) {
            $status = $e->getCode() >= 400 ? $e->getCode() : 500;
            jsonResponse([
                'status' => 'ERROR',
                'message' => $e->getMessage()
            ], $status);
        }
    });

    $router->get('/api/settings', function () {
        $settings = loadSettings();
        jsonResponse(successResponse([
            'platform_fee' => (float) ($settings['platform_fee'] ?? DEVELOPER_FEE),
            'buy_max_limit' => (int) ($settings['buy_max_limit'] ?? 1000000),
            'sell_min_limit' => (float) ($settings['sell_min_limit'] ?? 1),
            'sell_max_limit' => (float) ($settings['sell_max_limit'] ?? 10000),
            'paj_usdt_enabled' => (bool) ($settings['paj_usdt_enabled'] ?? false),
            'paj_usdc_enabled' => (bool) ($settings['paj_usdc_enabled'] ?? false),
        ]));
    });
}

// Simple UUID v4 generator
function generateUuid(): string
{
    $data = random_bytes(16);
    $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
    $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
}
