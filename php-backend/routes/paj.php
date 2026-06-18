<?php

declare(strict_types=1);

require_once __DIR__ . '/../paj_api.php';

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
            $value = pajApi()->getTokenValue((float) $fiatAmount, $mint);
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
            $order = pajApi()->createOnrampOrder((float) $fiatAmount, $recipient, $mint);
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
                'amount' => $fiatAmount,
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
            $order = pajApi()->createOfframpOrder((float) $fiatAmount, $mint, $bank, $accountNumber);
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
        if (!pajApi()->isConfigured()) {
            jsonResponse(errorResponse('PAJ module not available'), 503);
        }
        try {
            $banks = pajApi()->getBanks();
            jsonResponse(successResponse($banks));
        } catch (Throwable $e) {
            jsonResponse(errorResponse($e->getMessage()), 500);
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
                'UPDATE `transactions` SET `status` = :status, `meta` = :meta, `hash` = :hash, `wallet_address` = :wallet_address WHERE `reference` = :id OR `switch_reference` = :id',
                [
                    'status' => $update['status'],
                    'meta' => $update['meta'],
                    'hash' => $update['hash'] ?? null,
                    'wallet_address' => $update['wallet_address'] ?? null,
                    'id' => $id,
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
