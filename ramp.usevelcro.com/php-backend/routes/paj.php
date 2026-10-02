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
    return round($fee, 2);
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
            jsonResponse(errorResponse($e->getMessage()), 500);
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
            $feePercent = getPajFee();
            $value = pajApi()->getTokenValue((float) $fiatAmount, $mint);
            if (is_array($value)) {
                $value['fee_percent'] = $feePercent;
                if (isset($value['amount']) && is_numeric($value['amount']) && $feePercent > 0) {
                    $grossAmount = (float) $value['amount'];
                    $netAmount = $grossAmount * (1 - ($feePercent / 100));
                    $value['gross_amount'] = $grossAmount;
                    $value['amount'] = round($netAmount, 6);
                }
            } elseif (is_numeric($value) && $feePercent > 0) {
                $value = round((float) $value * (1 - ($feePercent / 100)), 6);
            }
            jsonResponse(successResponse($value));
        } catch (Throwable $e) {
            jsonResponse(errorResponse($e->getMessage()), 500);
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
            jsonResponse(errorResponse($e->getMessage()), 500);
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
        $email = body($body, 'email');
        if ($fiatAmount === null || !$recipient || !$mint) {
            jsonResponse(errorResponse('fiatAmount, recipient, and mint are required'), 400);
        }
        try {
            $totalInputAmount = (float) $fiatAmount;
            $feePercent = getPajFee();
            $businessUSDCFee = null;
            $pajCryptoFiat = $totalInputAmount;

            if (isset($body['businessUSDCFee']) && is_numeric($body['businessUSDCFee'])) {
                $businessUSDCFee = (float) $body['businessUSDCFee'];
            } elseif ($feePercent > 0 && $totalInputAmount > 0) {
                // Fetch live PAJ onramp rate for accurate conversion
                $rate = 1360.0;
                try {
                    $rates = pajApi()->getPajRate();
                    if (!empty($rates['onramp']['rate']) && is_numeric($rates['onramp']['rate']) && (float) $rates['onramp']['rate'] > 0) {
                        $rate = (float) $rates['onramp']['rate'];
                    }
                } catch (Throwable $e) {
                    error_log('Failed to fetch live PAJ rate for fee deduction: ' . $e->getMessage());
                }

                // In PAJ onramp, any businessUSDCFee passed to /pub/onramp is converted to NGN at PAJ's rate
                // and added to the deposit invoice.
                // To ensure the user transfers EXACTLY what they entered ($totalInputAmount) without surcharges,
                // the fee is calculated inside the amount:
                // feeUSDC is calculated, and the fiatAmount sent to PAJ is reduced by its NGN equivalent
                // so that (pajCryptoFiat + addedFeeNgn) == $totalInputAmount!
                $feeUsd = ($totalInputAmount * ($feePercent / 100)) / $rate;
                $businessUSDCFee = round($feeUsd, 2);
                if ($businessUSDCFee <= 0) {
                    $businessUSDCFee = null;
                }
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
                'reference' => $d['id'] ?? ('paj_' . time()),
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
            ]);
            jsonResponse(successResponse($order));
        } catch (Throwable $e) {
            jsonResponse(errorResponse($e->getMessage()), 500);
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
        $email = body($body, 'email');
        if ($fiatAmount === null || !$mint || !$bank || !$accountNumber) {
            jsonResponse(errorResponse('fiatAmount, mint, bank, and accountNumber are required'), 400);
        }
        try {
            $feePercent = getPajFee();
            $businessUSDCFee = null;
            if (isset($body['businessUSDCFee']) && is_numeric($body['businessUSDCFee'])) {
                $businessUSDCFee = (float) $body['businessUSDCFee'];
            } elseif ($feePercent > 0) {
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
                'reference' => $d['id'] ?? ('paj_' . time()),
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
            ]);
            jsonResponse(successResponse($order));
        } catch (Throwable $e) {
            jsonResponse(errorResponse($e->getMessage()), 500);
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
            jsonResponse(errorResponse($e->getMessage()), 500);
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
                'UPDATE `transactions` SET `status` = :status, `meta` = :meta, `hash` = :hash, `wallet_address` = :wallet_address WHERE `reference` = :id1 OR `switch_reference` = :id2',
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
            jsonResponse(errorResponse($e->getMessage()), 500);
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
