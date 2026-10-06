<?php

declare(strict_types=1);

require_once __DIR__ . '/../paj_api.php';

if (!function_exists('getPajFee')) {
    function getPajFee(): float
    {
        $settings = loadSettings();
        return (float) ($settings['paj_fee'] ?? DEVELOPER_FEE);
    }
}

if (!function_exists('getPajRateMargin')) {
    function getPajRateMargin(): float
    {
        $settings = loadSettings();
        return (float) ($settings['paj_rate_margin'] ?? 0.0);
    }
}

function calculatePajDeveloperFee(float $fiatAmount, string $direction = 'ONRAMP'): float
{
    $feePercent = getPajFee();
    if ($feePercent <= 0 || $fiatAmount <= 0) {
        return 0.0;
    }
    $rate = 1350.0;
    try {
        $rates = pajApi()->getPajRate();
        $key = strtolower($direction) === 'offramp' ? 'offramp' : 'onramp';
        if (!empty($rates[$key]['rate']) && is_numeric($rates[$key]['rate']) && (float) $rates[$key]['rate'] > 0) {
            $rate = (float) $rates[$key]['rate'];
        }
    } catch (Throwable $e) {
        error_log('Failed to fetch live PAJ rate for fee calculation: ' . $e->getMessage());
    }
    $fee = ($fiatAmount / $rate) * ($feePercent / 100);
    $feeRounded = round($fee, 2);
    return ($feeRounded < 0.01 && $fee > 0) ? 0.01 : $feeRounded;
}

function registerPajRoutes(Router $router): void
{
    $router->get('/api/paj/assets', function () {
        if (!pajApi()->isConfigured()) {
            jsonResponse(errorResponse('PAJ module not available'), 503);
        }
        jsonResponse(successResponse(pajApi()->getAssets()));
    });

    $router->get('/api/paj/rate', function () {
        if (!pajApi()->isConfigured()) {
            jsonResponse(errorResponse('PAJ module not available'), 503);
        }
        try {
            $rate = pajApi()->getPajRate();
            $fee = getPajFee();
            $margin = getPajRateMargin();
            if (isset($rate['onramp']['rate']) && is_numeric($rate['onramp']['rate'])) {
                $rate['onramp']['raw_rate'] = (float) $rate['onramp']['rate'];
                $rate['onramp']['rate'] = (float) $rate['onramp']['rate'] + $margin;
            }
            if (isset($rate['offramp']['rate']) && is_numeric($rate['offramp']['rate'])) {
                $rate['offramp']['raw_rate'] = (float) $rate['offramp']['rate'];
                $rate['offramp']['rate'] = (float) $rate['offramp']['rate'] - $margin;
            }
            $rate['fee_percent'] = $fee;
            $rate['rate_margin'] = $margin;
            jsonResponse(successResponse($rate));
        } catch (Throwable $e) {
            jsonResponse(errorResponse(publicError($e)), 500);
        }
    });

    $router->post('/api/paj/value', function () {
        if (!pajApi()->isConfigured()) {
            jsonResponse(errorResponse('PAJ module not available'), 503);
        }
        $body = getJsonBody();
        $fiatAmount = body($body, 'fiatAmount');
        $mint = body($body, 'mint');
        if ($fiatAmount === null || !$mint) {
            jsonResponse(errorResponse('fiatAmount and mint are required'), 400);
        }
        try {
            $fiat = (float) $fiatAmount;
            $feePercent = getPajFee();
            $value = pajApi()->getTokenValue(1.0, $mint);
            $tokenRate = (float) ($value['tokenRate'] ?? 0);
            if ($tokenRate <= 0) {
                $pajRateData = pajApi()->getPajRate();
                $tokenRate = (float) ($pajRateData['onramp']['rate'] ?? 1363.5);
            }
            $grossCrypto = $tokenRate > 0 ? ($fiat / $tokenRate) : 0.0;
            // Value shown to the user is already minus developer profit
            $netCrypto = $grossCrypto * (1 - ($feePercent / 100));
            jsonResponse(successResponse([
                'fiatAmount' => $fiat,
                'tokenRate' => $tokenRate,
                'amount' => round($netCrypto, 6),
                'cryptoAmount' => round($netCrypto, 6),
                'gross_crypto' => round($grossCrypto, 6),
                'fee_percent' => $feePercent,
            ]));
        } catch (Throwable $e) {
            jsonResponse(errorResponse(publicError($e)), 500);
        }
    });

    $router->post('/api/paj/offramp-value', function () {
        if (!pajApi()->isConfigured()) {
            jsonResponse(errorResponse('PAJ module not available'), 503);
        }
        $body = getJsonBody();
        $amount = body($body, 'amount');
        $mint = body($body, 'mint');
        if ($amount === null || !$mint) {
            jsonResponse(errorResponse('amount and mint are required'), 400);
        }
        try {
            $feePercent = getPajFee();
            $value = pajApi()->getFiatValue((float) $amount, $mint);
            if (is_array($value)) {
                $value['fee_percent'] = $feePercent;
                if (isset($value['fiatAmount']) && is_numeric($value['fiatAmount']) && $feePercent > 0) {
                    $grossFiat = (float) $value['fiatAmount'];
                    $netFiat = $grossFiat * (1 - ($feePercent / 100));
                    $value['gross_fiat'] = $grossFiat;
                    $value['fiatAmount'] = round($netFiat, 2);
                }
            } elseif (is_numeric($value) && $feePercent > 0) {
                $value = round((float) $value * (1 - ($feePercent / 100)), 2);
            }
            jsonResponse(successResponse($value));
        } catch (Throwable $e) {
            jsonResponse(errorResponse(publicError($e)), 500);
        }
    });

    $router->post('/api/paj/initiate', function () {
        if (!pajApi()->isConfigured()) {
            jsonResponse(errorResponse('PAJ module not available'), 503);
        }
        $body = getJsonBody();
        $fiatAmount = body($body, 'fiatAmount');
        $recipient = body($body, 'recipient');
        $mint = body($body, 'mint');
        $email = strtolower(trim((string) body($body, 'email', '')));
        if ($fiatAmount === null || !$recipient || !$mint) {
            jsonResponse(errorResponse('fiatAmount, recipient, and mint are required'), 400);
        }
        if ($email !== '' && !isValidEmail($email)) {
            jsonResponse(errorResponse('Invalid email address'), 400);
        }
        if ((!$email || trim((string)$email) === '') && !empty($recipient)) {
            $found = Database::safeSelect("SELECT `email` FROM `transactions` WHERE LOWER(`wallet_address`) = LOWER(:wallet) AND `email` IS NOT NULL AND `email` != '' ORDER BY `id` DESC LIMIT 1", ['wallet' => trim((string)$recipient)], []);
            if (!empty($found[0]['email'])) {
                $email = $found[0]['email'];
            }
        }
        try {
            $totalInputAmount = (float) $fiatAmount;
            $feePercent = getPajFee();
            // Fee is always computed server-side; never accept it from the request.
            $businessUSDCFee = null;
            if ($feePercent > 0 && $totalInputAmount > 0) {
                $businessUSDCFee = max(0.01, calculatePajDeveloperFee($totalInputAmount, 'ONRAMP'));
            }

            $order = pajApi()->createOnrampOrder($totalInputAmount, $recipient, $mint, $businessUSDCFee);
            $d = $order ?? [];
            $assetInfo = null;
            foreach (pajApi()->getAssets() as $a) {
                if ($a['mint'] === $mint) {
                    $assetInfo = $a;
                    break;
                }
            }
            Database::safeInsert('transactions', [
                'reference' => $d['id'] ?? ('paj_' . bin2hex(random_bytes(8))),
                'type' => 'ONRAMP',
                'status' => mapPajStatus($d['status'] ?? null) ?: 'AWAITING_DEPOSIT',
                'country' => 'NG',
                'currency' => 'NGN',
                'asset' => $assetInfo ? $assetInfo['symbol'] : 'SOL',
                'channel' => 'PAJ',
                'amount' => isset($d['fiatAmount']) && (float) $d['fiatAmount'] > 0 ? (float) $d['fiatAmount'] : $totalInputAmount,
                'destination_amount' => isset($d['amount']) ? (float) $d['amount'] : null,
                'fee_developer' => $businessUSDCFee,
                'deposit_bank_name' => $d['bank'] ?? 'PAJ Partner Bank',
                'deposit_account_number' => $d['accountNumber'] ?? null,
                'deposit_account_name' => $d['accountName'] ?? null,
                'wallet_address' => $recipient,
                'email' => $email ? strtolower(trim($email)) : null,
                'meta' => jsonEncodeNullable($d),
            ] + referralFieldsFor(body($body, 'ref'), $email));
            jsonResponse(successResponse($order));
        } catch (Throwable $e) {
            jsonResponse(errorResponse(publicError($e)), 500);
        }
    });

    $router->post('/api/paj/sell', function () {
        if (!pajApi()->isConfigured()) {
            jsonResponse(errorResponse('PAJ module not available'), 503);
        }
        $body = getJsonBody();
        $fiatAmount = body($body, 'fiatAmount');
        $mint = body($body, 'mint');
        $bank = body($body, 'bank');
        $accountNumber = body($body, 'accountNumber');
        $email = strtolower(trim((string) body($body, 'email', '')));
        if ($fiatAmount === null || !$mint || !$bank || !$accountNumber) {
            jsonResponse(errorResponse('fiatAmount, mint, bank, and accountNumber are required'), 400);
        }
        if ($email !== '' && !isValidEmail($email)) {
            jsonResponse(errorResponse('Invalid email address'), 400);
        }
        if ((!$email || trim((string)$email) === '') && !empty($accountNumber)) {
            $found = Database::safeSelect("SELECT `email` FROM `transactions` WHERE `deposit_account_number` = :acc AND `email` IS NOT NULL AND `email` != '' ORDER BY `id` DESC LIMIT 1", ['acc' => trim((string)$accountNumber)], []);
            if (!empty($found[0]['email'])) {
                $email = $found[0]['email'];
            }
        }
        try {
            $feePercent = getPajFee();
            // Fee is always computed server-side; never accept it from the request.
            $businessUSDCFee = null;
            if ($feePercent > 0) {
                $businessUSDCFee = calculatePajDeveloperFee((float) $fiatAmount, 'OFFRAMP');
            }

            $order = pajApi()->createOfframpOrder((float) $fiatAmount, $mint, $bank, $accountNumber, $businessUSDCFee);
            $d = $order ?? [];
            $assetInfo = null;
            foreach (pajApi()->getAssets() as $a) {
                if ($a['mint'] === $mint) {
                    $assetInfo = $a;
                    break;
                }
            }
            Database::safeInsert('transactions', [
                'reference' => $d['id'] ?? ('paj_' . bin2hex(random_bytes(8))),
                'type' => 'OFFRAMP',
                'status' => mapPajStatus($d['status'] ?? null) ?: 'AWAITING_DEPOSIT',
                'country' => 'NG',
                'currency' => 'NGN',
                'asset' => $assetInfo ? $assetInfo['symbol'] : 'SOL',
                'channel' => 'PAJ',
                'amount' => $fiatAmount,
                'fee_developer' => $businessUSDCFee,
                'deposit_address' => $d['address'] ?? null,
                'beneficiary' => jsonEncodeNullable(['bank' => $bank, 'accountNumber' => $accountNumber, 'holder_name' => $d['accountName'] ?? 'Customer']),
                'email' => $email ? strtolower(trim($email)) : null,
                'meta' => jsonEncodeNullable($d),
            ] + referralFieldsFor(body($body, 'ref'), $email));
            jsonResponse(successResponse($order));
        } catch (Throwable $e) {
            jsonResponse(errorResponse(publicError($e)), 500);
        }
    });

    $router->get('/api/paj/banks', function () {
        try {
            $banks = pajApi()->getBanks();
            jsonResponse(successResponse($banks));
        } catch (Throwable $e) {
            $fallback = pajApi()->getFallbackBanks();
            jsonResponse(successResponse($fallback));
        }
    });

    $router->post('/api/paj/resolve', function () {
        if (!pajApi()->isConfigured()) {
            jsonResponse(errorResponse('PAJ module not available'), 503);
        }
        $body = getJsonBody();
        $bank = body($body, 'bank');
        $accountNumber = body($body, 'accountNumber');
        if (!$bank || !$accountNumber) {
            jsonResponse(errorResponse('bank and accountNumber are required'), 400);
        }
        try {
            $resolved = pajApi()->resolveBankAccount($bank, $accountNumber);
            jsonResponse(successResponse($resolved));
        } catch (Throwable $e) {
            jsonResponse(errorResponse(publicError($e)), 500);
        }
    });

    $router->get('/api/paj/status', function () {
        if (!pajApi()->isConfigured()) {
            jsonResponse(errorResponse('PAJ module not available'), 503);
        }
        $id = query('id');
        if (!$id) {
            jsonResponse(errorResponse('id is required'), 400);
        }
        try {
            $tx = pajApi()->getTransactionStatus($id);
            $d = $tx ?? [];
            $update = [
                'status' => mapPajStatus($d['status'] ?? null) ?: 'AWAITING_DEPOSIT',
                'meta' => jsonEncodeNullable($d),
            ];
            if (!empty($d['signature']) || !empty($d['hash'])) {
                $update['hash'] = $d['signature'] ?? $d['hash'];
            }
            if (!empty($d['recipient'])) {
                $update['wallet_address'] = $d['recipient'];
            }
            Database::safeExecute(
                'UPDATE `transactions` SET `status` = :status, `meta` = :meta, `hash` = COALESCE(:hash, `hash`), `wallet_address` = COALESCE(:wallet_address, `wallet_address`) WHERE `reference` = :id1 OR `switch_reference` = :id2',
                [
                    'status' => $update['status'],
                    'meta' => $update['meta'],
                    'hash' => $update['hash'] ?? null,
                    'wallet_address' => $update['wallet_address'] ?? null,
                    'id1' => $id,
                    'id2' => $id,
                ]
            );
            jsonResponse(successResponse($tx));
        } catch (Throwable $e) {
            jsonResponse(errorResponse(publicError($e)), 500);
        }
    });

    $router->get('/api/paj/session', function () {
        if (!pajApi()->isConfigured()) {
            jsonResponse(errorResponse('PAJ module not available'), 503);
        }
        jsonResponse(successResponse(pajApi()->getSessionStatus()));
    });

    // Admin PAJ session routes
    $router->post('/api/admin/paj/initiate', function () {
        requireAdminAuth();
        $ip = clientIp();
        if (!pajApi()->isConfigured()) {
            jsonResponse(['error' => 'PAJ module not available'], 503);
        }
        try {
            auditLog('PAJ_INITIATE', ['ip' => $ip]);
            $result = pajApi()->initiateSession();
            jsonResponse($result);
        } catch (Throwable $e) {
            jsonResponse(['error' => $e->getMessage()], 500);
        }
    });

    $router->post('/api/admin/paj/verify', function () {
        requireAdminAuth();
        $ip = clientIp();
        if (!pajApi()->isConfigured()) {
            jsonResponse(['error' => 'PAJ module not available'], 503);
        }
        $body = getJsonBody();
        $otp = body($body, 'otp');
        if (!$otp) {
            jsonResponse(['error' => 'OTP is required'], 400);
        }
        try {
            $result = pajApi()->verifySession($otp);
            jsonResponse($result);
        } catch (Throwable $e) {
            jsonResponse(['error' => $e->getMessage()], 500);
        }
    });
}
