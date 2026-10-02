<?php

declare(strict_types=1);

require_once __DIR__ . '/../switch_api.php';
require_once __DIR__ . '/../paj_api.php';
require_once __DIR__ . '/../poll_helpers.php';

function registerAdminRoutes(Router $router): void
{
    $router->get('/api/admin/stats', function () {
        requireAdminAuth();
        $ip = clientIp();
        try {
            $statsRows = Database::safeSelect("
                SELECT 
                    COUNT(DISTINCT NULLIF(wallet_address, '')) AS total_users,
                    COUNT(*) AS all_transactions,
                    COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) AS completed_transactions,
                    COALESCE(SUM(CASE 
                        WHEN status = 'COMPLETED' AND type = 'ONRAMP' THEN 
                            CASE 
                                WHEN UPPER(asset) IN ('USDT', 'USDC') AND destination_amount > 0 THEN destination_amount 
                                ELSE (amount / COALESCE(NULLIF(rate, 0), 1500)) 
                            END
                        WHEN status = 'COMPLETED' AND type = 'OFFRAMP' AND (channel = 'PAJ' OR reference LIKE 'paj_%' OR reference LIKE 'pj_%') THEN 
                            (amount / COALESCE(NULLIF(rate, 0), 1500))
                        WHEN status = 'COMPLETED' AND type = 'OFFRAMP' THEN 
                            CASE 
                                WHEN UPPER(asset) IN ('USDT', 'USDC') AND amount > 0 THEN amount 
                                WHEN destination_amount > 0 THEN (destination_amount / COALESCE(NULLIF(rate, 0), 1500)) 
                                ELSE (amount / COALESCE(NULLIF(rate, 0), 1500)) 
                            END
                        ELSE 0 
                    END), 0) AS total_volume_usd,
                    COALESCE(SUM(CASE 
                        WHEN status = 'COMPLETED' AND type = 'ONRAMP' THEN amount
                        WHEN status = 'COMPLETED' AND type = 'OFFRAMP' AND (channel = 'PAJ' OR reference LIKE 'paj_%' OR reference LIKE 'pj_%') THEN amount
                        WHEN status = 'COMPLETED' AND type = 'OFFRAMP' THEN 
                            CASE 
                                WHEN destination_amount > 0 THEN destination_amount 
                                ELSE (amount * COALESCE(NULLIF(rate, 0), 1500)) 
                            END
                        ELSE 0 
                    END), 0) AS total_volume_ngn,
                    COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN COALESCE(fee_developer, 0) ELSE 0 END), 0) AS local_developer_fees
                FROM `transactions`
            ");
            $statsRow = $statsRows[0] ?? [];

            $totalUsers = (int) ($statsRow['total_users'] ?? 0);
            $allTransactions = (int) ($statsRow['all_transactions'] ?? 0);
            $completed = (int) ($statsRow['completed_transactions'] ?? 0);
            $volumeUSD = (float) ($statsRow['total_volume_usd'] ?? 0.0);
            $volumeNGN = (float) ($statsRow['total_volume_ngn'] ?? 0.0);
            $localFees = (float) ($statsRow['local_developer_fees'] ?? 0.0);

            try {
                $feesData = switchApi()->getDeveloperFees();
                $switchFee = (float) ($feesData['data']['amount'] ?? 0);
                $feeAmount = $switchFee > 0 ? $switchFee : $localFees;
                $feeCurrency = $feesData['data']['currency'] ?? 'USDC';
            } catch (Throwable $e) {
                $feeAmount = $localFees;
                $feeCurrency = 'USDC';
            }

            jsonResponse([
                'totalUsers' => $totalUsers,
                'allTransactions' => $allTransactions,
                'completedTransactions' => $completed,
                'totalVolumeUSD' => $volumeUSD,
                'totalVolumeNGN' => $volumeNGN,
                'developerFees' => ['amount' => $feeAmount, 'currency' => $feeCurrency],
            ]);
        } catch (Throwable $e) {
            error_log('/api/admin/stats error: ' . $e->getMessage());
            jsonResponse([
                'totalUsers' => 0,
                'allTransactions' => 0,
                'completedTransactions' => 0,
                'totalVolumeUSD' => 0.0,
                'totalVolumeNGN' => 0.0,
                'developerFees' => ['amount' => 0, 'currency' => 'USDC'],
                'error' => $e->getMessage(),
            ]);
        }
    });

    $router->get('/api/admin/config', function () {
        requireAdminAuth();
        jsonResponse([
            'developer_recipient' => DEVELOPER_RECIPIENT,
            'developer_asset' => DEVELOPER_WITHDRAW_ASSET,
            'developer_fee' => DEVELOPER_FEE,
            'switch_base_url' => SWITCH_BASE_URL,
            'withdrawal_allowed_recipients' => WITHDRAWAL_ALLOWED_RECIPIENTS,
            'withdrawal_allowed' => isWithdrawalAllowed(DEVELOPER_RECIPIENT),
        ]);
    });

    $router->get('/api/admin/transactions', function () {
        requireAdminAuth();
        try {
            $rows = Database::safeSelect('SELECT `id`, `reference`, `switch_reference`, `type`, `status`, `country`, `currency`, `asset`, `channel`, `amount`, `rate`, `destination_amount`, `deposit_address`, `deposit_bank_name`, `deposit_account_number`, `deposit_account_name`, `wallet_address`, `hash`, `explorer_url`, `email`, `created_at`, `updated_at`, `beneficiary` FROM `transactions` ORDER BY `created_at` DESC LIMIT 200', [], []);
            
            foreach ($rows as &$row) {
                $row = decodeJsonColumns($row, ['beneficiary']);
                if (empty($row['wallet_address']) && !empty($row['beneficiary'])) {
                    $ben = $row['beneficiary'];
                    $row['wallet_address'] = $ben['wallet_address'] ?? null;
                }
            }
            unset($row);

            jsonResponse($rows);
        } catch (Throwable $e) {
            jsonResponse(['error' => $e->getMessage()], 500);
        }
    });

    $router->post('/api/admin/fix-paj-channels', function () {
        requireAdminAuth();
        try {
            $rows = Database::safeSelect('SELECT * FROM `transactions`', [], []);
            $fixed = [];
            foreach ($rows as $tx) {
                $isPaj = ($tx['channel'] === 'PAJ') ||
                         (isset($tx['reference']) && str_starts_with((string)$tx['reference'], 'paj_')) ||
                         (isset($tx['deposit_bank_name']) && str_contains(strtolower((string)$tx['deposit_bank_name']), 'paj'));
                if ($isPaj && $tx['channel'] !== 'PAJ') {
                    Database::safeExecute('UPDATE `transactions` SET `channel` = :channel WHERE `id` = :id', ['channel' => 'PAJ', 'id' => $tx['id']]);
                    $fixed[] = $tx['reference'];
                }
            }
            jsonResponse(['success' => true, 'fixed' => count($fixed), 'references' => $fixed]);
        } catch (Throwable $e) {
            jsonResponse(['success' => false, 'error' => $e->getMessage()], 500);
        }
    });

    $router->post('/api/admin/fix-paj-statuses', function () {
        requireAdminAuth();
        try {
            $rows = Database::safeSelect('SELECT * FROM `transactions`', [], []);
            $fixed = [];
            foreach ($rows as $tx) {
                $isPaj = ($tx['channel'] === 'PAJ') ||
                         (isset($tx['reference']) && str_starts_with((string)$tx['reference'], 'paj_')) ||
                         (isset($tx['deposit_bank_name']) && str_contains(strtolower((string)$tx['deposit_bank_name']), 'paj'));
                if ($isPaj) {
                    $mapped = mapPajStatus($tx['status']);
                    if ($mapped && $mapped !== $tx['status']) {
                        Database::safeExecute('UPDATE `transactions` SET `status` = :status WHERE `id` = :id', ['status' => $mapped, 'id' => $tx['id']]);
                        $fixed[] = ['reference' => $tx['reference'], 'before' => $tx['status'], 'after' => $mapped];
                    }
                }
            }
            jsonResponse(['success' => true, 'fixed' => count($fixed), 'changes' => $fixed]);
        } catch (Throwable $e) {
            jsonResponse(['success' => false, 'error' => $e->getMessage()], 500);
        }
    });

    $router->post('/api/admin/sync-all-statuses', function () {
        requireAdminAuth();
        try {
            $pendingStatuses = ['PENDING', 'AWAITING_DEPOSIT', 'DETECTED', 'PROCESSING', 'INITIATED', 'CONFIRMED', 'RECEIVED', 'VERIFIED'];
            $placeholders = implode(',', array_fill(0, count($pendingStatuses), '?'));
            $rows = Database::safeSelect("SELECT * FROM `transactions` WHERE `status` IN ({$placeholders}) ORDER BY `created_at` DESC LIMIT 100", $pendingStatuses, []);
            $synced = [];
            foreach ($rows as $tx) {
                $ref = $tx['reference'] ?: ($tx['switch_reference'] ?? null);
                if (!$ref) continue;
                try {
                    $beforeStatus = $tx['status'];
                    pollSingleTransaction($tx);
                    $updated = Database::selectOne('SELECT `id`, `reference`, `status`, `amount`, `destination_amount` FROM `transactions` WHERE `id` = :id', ['id' => $tx['id']]);
                    if ($updated && $updated['status'] !== $beforeStatus) {
                        $synced[] = [
                            'reference' => $ref,
                            'before' => $beforeStatus,
                            'after' => $updated['status'],
                            'amount' => $updated['amount'],
                            'destination_amount' => $updated['destination_amount']
                        ];
                    }
                } catch (Throwable $e) {
                    error_log("Failed to sync tx {$ref}: " . $e->getMessage());
                }
            }
            jsonResponse(['success' => true, 'synced_count' => count($synced), 'synced' => $synced]);
        } catch (Throwable $e) {
            jsonResponse(['success' => false, 'error' => $e->getMessage()], 500);
        }
    });

    $router->get('/api/admin/users', function () {
        requireAdminAuth();
        try {
            $rows = Database::safeSelect('SELECT `email`, `wallet_address`, `beneficiary`, `meta`, `status`, `type`, `channel`, `reference`, `asset`, `currency`, `amount`, `rate`, `destination_amount`, `destination_currency`, `created_at` FROM `transactions` ORDER BY `created_at` DESC LIMIT 5000', [], []);
            $userMap = [];
            foreach ($rows as $t) {
                $wallet = $t['wallet_address'] ?? '';
                if (empty($wallet)) {
                    $ben = !empty($t['beneficiary']) ? (is_array($t['beneficiary']) ? $t['beneficiary'] : json_decode((string)$t['beneficiary'], true)) : [];
                    $meta = !empty($t['meta']) ? (is_array($t['meta']) ? $t['meta'] : json_decode((string)$t['meta'], true)) : [];
                    $wallet = $ben['wallet_address'] ?? ($meta['beneficiary']['wallet_address'] ?? ($meta['recipient'] ?? ($meta['destination']['address'] ?? '')));
                }
                $id = (!empty($t['email']) ? strtolower(trim($t['email'])) : '') ?: ($wallet ?: 'unknown');
                if (!isset($userMap[$id])) {
                    $userMap[$id] = [
                        'id' => $id,
                        'total_volume' => 0.0,
                        'total_volume_usd' => 0.0,
                        'total_volume_ngn' => 0.0,
                        'tx_count' => 0,
                        'created_at' => $t['created_at'],
                    ];
                }
                if ($t['status'] === 'COMPLETED') {
                    $vols = calculateTxVolumes($t);
                    $userMap[$id]['total_volume_usd'] += $vols['usd'];
                    $userMap[$id]['total_volume_ngn'] += $vols['ngn'];
                    $userMap[$id]['total_volume'] = $userMap[$id]['total_volume_usd'];
                }
                $userMap[$id]['tx_count']++;
                if ($t['created_at'] < $userMap[$id]['created_at']) {
                    $userMap[$id]['created_at'] = $t['created_at'];
                }
            }
            $users = array_values($userMap);
            usort($users, static fn ($a, $b) => $b['total_volume_usd'] <=> $a['total_volume_usd']);
            jsonResponse($users);
        } catch (Throwable $e) {
            jsonResponse(['error' => $e->getMessage()], 500);
        }
    });

    $router->post('/api/admin/withdraw/otp', function () {
        requireAdminAuth();
        $ip = clientIp();
        try {
            $otp = generateOTP();
            storeOTP('withdraw', $otp);
            $maskedRecipient = substr(DEVELOPER_RECIPIENT, 0, 6) . '...' . substr(DEVELOPER_RECIPIENT, -6);

            $emailText = "Velcro Admin — Withdrawal OTP\n\nCode: {$otp}\nRecipient: " . DEVELOPER_RECIPIENT . "\nExpires in 5 minutes.\n\nIf you did not request this, change your admin password immediately.";
            $emailHtml = "<div style=\"font-family:sans-serif;max-width:400px;margin:0 auto;padding:20px;border:1px solid #e5e7eb;border-radius:12px;\"><h2 style=\"color:#0D0D59;margin-bottom:8px;\">Velcro Admin</h2><p style=\"color:#64748b;font-size:14px;\">Withdrawal OTP</p><div style=\"background:#f4f7fe;padding:16px;border-radius:8px;text-align:center;margin:16px 0;\"><div style=\"font-size:32px;font-weight:700;color:#0D0D59;letter-spacing:4px;\">{$otp}</div><p style=\"font-size:12px;color:#94a3b8;margin-top:8px;\">Expires in 5 minutes</p></div><p style=\"font-size:13px;color:#64748b;\">Recipient: <code>" . DEVELOPER_RECIPIENT . "</code></p><p style=\"font-size:12px;color:#dc2626;margin-top:12px;\">If you did not request this, change your admin password immediately.</p></div>";

            $mailResult = sendMail('Velcro Admin — Withdrawal OTP', $emailHtml, $emailText);
            auditLog('WITHDRAW_OTP_SENT', ['ip' => $ip, 'recipient' => DEVELOPER_RECIPIENT, 'emailSent' => $mailResult['sent']]);

            jsonResponse([
                'success' => true,
                'message' => $mailResult['sent']
                    ? 'OTP sent to your admin email. Check your inbox.'
                    : 'OTP generated. (Email not configured — check server logs for the code.)',
                'emailConfigured' => $mailResult['sent'],
            ]);
        } catch (Throwable $e) {
            jsonResponse(['success' => false, 'error' => $e->getMessage()], 500);
        }
    });

    $router->post('/api/admin/withdraw', function () {
        requireAdminAuth();
        $ip = clientIp();
        $body = getJsonBody();
        $asset = body($body, 'asset');
        $otp = (string) body($body, 'otp', '');

        $otpCheck = verifyOTP('withdraw', $otp);
        if (!$otpCheck['valid']) {
            auditLog('WITHDRAW_BLOCKED_OTP', ['ip' => $ip, 'recipient' => DEVELOPER_RECIPIENT, 'reason' => $otpCheck['reason']]);
            jsonResponse(['success' => false, 'error' => $otpCheck['reason']], 403);
        }

        $result = executeWithdrawal($asset ?? DEVELOPER_WITHDRAW_ASSET, $ip, 'manual');
        $statusCode = $result['statusCode'] ?? ($result['success'] ? 200 : 400);
        jsonResponse($result, $statusCode);
    });

    $router->get('/api/admin/settings', function () {
        requireAdminAuth();
        jsonResponse(loadSettings());
    });

    $router->get('/api/admin/debug/last-payload', function () {
        requireAdminAuth();
        try {
            $last = Database::selectOne('SELECT * FROM `transactions` ORDER BY `created_at` DESC LIMIT 1');
            if ($last === null) {
                jsonResponse(['error' => 'No transactions found'], 404);
            }
            $last = decodeJsonColumns($last, ['beneficiary', 'meta']);
            jsonResponse($last);
        } catch (Throwable $e) {
            jsonResponse(['error' => $e->getMessage()], 500);
        }
    });

    $router->post('/api/admin/settings', function () {
        requireAdminAuth();
        $ip = clientIp();
        $body = getJsonBody();
        $settings = loadSettings();

        if (isset($body['buy_max_limit'])) {
            $limit = (int) $body['buy_max_limit'];
            if ($limit < 1000 || $limit > 10000000) {
                jsonResponse(['success' => false, 'error' => 'Buy max limit must be between 1,000 and 10,000,000'], 400);
            }
            $settings['buy_max_limit'] = $limit;
        }
        if (isset($body['sell_min_limit'])) {
            $min = (float) $body['sell_min_limit'];
            if ($min < 1 || $min > 100000) {
                jsonResponse(['success' => false, 'error' => 'Sell min limit must be between 1 and 100,000'], 400);
            }
            $settings['sell_min_limit'] = $min;
        }
        if (isset($body['sell_max_limit'])) {
            $max = (float) $body['sell_max_limit'];
            if ($max < 10 || $max > 1000000) {
                jsonResponse(['success' => false, 'error' => 'Sell max limit must be between 10 and 1,000,000'], 400);
            }
            $settings['sell_max_limit'] = $max;
        }
        if (isset($body['platform_fee'])) {
            $fee = (float) $body['platform_fee'];
            if ($fee < 0 || $fee > 10) {
                jsonResponse(['success' => false, 'error' => 'Fee must be between 0 and 10'], 400);
            }
            $settings['platform_fee'] = $fee;
        }
        if (isset($body['paj_email'])) {
            if (!filter_var($body['paj_email'], FILTER_VALIDATE_EMAIL)) {
                jsonResponse(['success' => false, 'error' => 'Invalid email format'], 400);
            }
            $settings['paj_email'] = $body['paj_email'];
        }
        if (isset($body['paj_usdt_enabled'])) {
            $settings['paj_usdt_enabled'] = (bool) $body['paj_usdt_enabled'];
        }
        if (isset($body['paj_usdc_enabled'])) {
            $settings['paj_usdc_enabled'] = (bool) $body['paj_usdc_enabled'];
        }

        if (saveSettings($settings)) {
            auditLog('SETTINGS_UPDATED', ['ip' => $ip, 'changes' => $body]);
            jsonResponse(['success' => true, ...$settings]);
        } else {
            jsonResponse(['success' => false, 'error' => 'Failed to save settings'], 500);
        }
    });

    $router->post('/api/admin/refresh-status/([a-zA-Z0-9_-]+)', function (string $reference) {
        requireAdminAuth();
        try {
            $tx = Database::selectOne(
                'SELECT * FROM `transactions` WHERE `reference` = :ref1 OR `switch_reference` = :ref2',
                ['ref1' => $reference, 'ref2' => $reference]
            );
            if ($tx === null) {
                jsonResponse(['success' => false, 'error' => 'Transaction not found'], 404);
            }
            if (in_array($tx['status'], FINAL_STATUSES, true)) {
                jsonResponse(['success' => true, 'message' => 'Transaction already in final state', 'status' => $tx['status'], 'transaction' => $tx]);
            }
            pollSingleTransaction($tx);
            $updated = Database::selectOne('SELECT * FROM `transactions` WHERE `id` = :id', ['id' => $tx['id']]);
            jsonResponse(['success' => true, 'status' => $updated['status'], 'previousStatus' => $tx['status'], 'transaction' => $updated]);
        } catch (Throwable $e) {
            jsonResponse(['success' => false, 'error' => $e->getMessage()], 500);
        }
    });

    // Endpoint called by admin UI but missing in original Node backend
    $router->get('/api/admin/audit', function () {
        requireAdminAuth();
        try {
            $rows = Database::safeSelect('SELECT * FROM `audit_logs` ORDER BY `created_at` DESC LIMIT 500', [], []);
            foreach ($rows as &$row) {
                $row = decodeJsonColumns($row, ['details']);
            }
            jsonResponse($rows);
        } catch (Throwable $e) {
            jsonResponse(['error' => $e->getMessage()], 500);
        }
    });

    // ─── Direct API Tools Endpoints ───

    $router->post('/api/admin/tools/aml-lookup', function () {
        requireAdminAuth();
        $ip = clientIp();
        $body = getJsonBody();
        $type = strtoupper((string) body($body, 'type', 'CRYPTO_WALLET'));

        $payload = ['type' => $type];
        if ($type === 'CRYPTO_WALLET') {
            $wallet = trim((string) body($body, 'wallet_address', ''));
            if ($wallet === '') {
                jsonResponse(['success' => false, 'error' => 'wallet_address is required for CRYPTO_WALLET screening'], 400);
            }
            $payload['wallet_address'] = $wallet;
        } elseif ($type === 'INDIVIDUAL') {
            $name = trim((string) body($body, 'name', ''));
            $country = strtoupper(trim((string) body($body, 'country', 'NG')));
            if ($name === '') {
                jsonResponse(['success' => false, 'error' => 'name is required for INDIVIDUAL screening'], 400);
            }
            $payload['name'] = $name;
            $payload['country'] = $country;
            if (!empty($body['date_of_birth'])) {
                $payload['date_of_birth'] = trim((string) $body['date_of_birth']);
            }
        } elseif ($type === 'BUSINESS') {
            $name = trim((string) body($body, 'name', ''));
            $country = strtoupper(trim((string) body($body, 'country', 'NG')));
            if ($name === '') {
                jsonResponse(['success' => false, 'error' => 'name is required for BUSINESS screening'], 400);
            }
            $payload['name'] = $name;
            $payload['country'] = $country;
            if (!empty($body['registration_number'])) {
                $payload['registration_number'] = trim((string) $body['registration_number']);
            }
        } else {
            jsonResponse(['success' => false, 'error' => 'Invalid screening type. Allowed: CRYPTO_WALLET, INDIVIDUAL, BUSINESS'], 400);
        }

        try {
            $result = switchApi()->amlLookup($payload);
            auditLog('AML_LOOKUP', ['ip' => $ip, 'type' => $type, 'subject' => $payload]);
            jsonResponse($result);
        } catch (Throwable $e) {
            jsonResponse(['success' => false, 'error' => $e->getMessage()], 400);
        }
    });

    $router->post('/api/admin/tools/resolve-bank', function () {
        requireAdminAuth();
        $body = getJsonBody();
        $provider = strtolower((string) body($body, 'provider', 'switch'));
        $country = strtoupper((string) body($body, 'country', 'NG'));
        $bankCode = trim((string) body($body, 'bank_code', ''));
        $accountNumber = trim((string) body($body, 'account_number', ''));

        if ($accountNumber === '' || $bankCode === '') {
            jsonResponse(['success' => false, 'error' => 'bank_code and account_number are required'], 400);
        }

        try {
            if ($provider === 'paj') {
                $res = pajApi()->resolveBankAccount($bankCode, $accountNumber);
                jsonResponse(['success' => true, 'data' => $res, 'provider' => 'paj']);
            } else {
                $res = switchApi()->lookupBeneficiary($country, [
                    'bank_code' => $bankCode,
                    'account_number' => $accountNumber,
                ]);
                jsonResponse($res);
            }
        } catch (Throwable $e) {
            jsonResponse(['success' => false, 'error' => $e->getMessage()], 400);
        }
    });

    $router->post('/api/admin/tools/check-status', function () {
        requireAdminAuth();
        $body = getJsonBody();
        $reference = trim((string) body($body, 'reference', ''));
        $provider = strtolower((string) body($body, 'provider', 'auto'));

        if ($reference === '') {
            jsonResponse(['success' => false, 'error' => 'reference is required'], 400);
        }

        $isPaj = ($provider === 'paj') || str_starts_with($reference, 'paj_');

        try {
            if ($isPaj) {
                $data = pajApi()->getTransactionStatus($reference);
                jsonResponse(['success' => true, 'provider' => 'paj', 'data' => $data]);
            } else {
                $data = switchApi()->getPaymentStatus($reference);
                jsonResponse($data);
            }
        } catch (Throwable $e) {
            jsonResponse(['success' => false, 'error' => $e->getMessage()], 400);
        }
    });

    $router->post('/api/admin/tools/quote', function () {
        requireAdminAuth();
        $body = getJsonBody();
        $provider = strtolower((string) body($body, 'provider', 'switch'));
        $direction = strtoupper((string) body($body, 'direction', 'OFFRAMP'));
        $amount = (float) body($body, 'amount', 100);
        $asset = (string) body($body, 'asset', 'base:usdc');
        $country = (string) body($body, 'country', 'NG');
        $currency = (string) body($body, 'currency', 'NGN');

        try {
            if ($provider === 'paj') {
                $rate = pajApi()->getRate($amount);
                jsonResponse(['success' => true, 'provider' => 'paj', 'data' => $rate]);
            } else {
                $res = switchApi()->getRate([
                    'direction' => $direction,
                    'asset' => $asset,
                    'country' => $country,
                    'currency' => $currency,
                    'channel' => ($country === 'GH' || $country === 'KE') ? 'MOBILEMONEY' : 'BANK',
                ]);
                jsonResponse($res);
            }
        } catch (Throwable $e) {
            jsonResponse(['success' => false, 'error' => $e->getMessage()], 400);
        }
    });

    $router->post('/api/admin/tools/fix-wallet-addresses', function () {
        requireAdminAuth();
        try {
            $rows = Database::safeSelect("SELECT `id`, `reference`, `wallet_address`, `beneficiary`, `meta` FROM `transactions` WHERE `wallet_address` IS NULL OR `wallet_address` = ''", [], []);
            $fixed = 0;
            foreach ($rows as $row) {
                $ben = !empty($row['beneficiary']) ? json_decode((string)$row['beneficiary'], true) : [];
                $meta = !empty($row['meta']) ? json_decode((string)$row['meta'], true) : [];
                $wallet = $ben['wallet_address'] ?? ($meta['beneficiary']['wallet_address'] ?? ($meta['recipient'] ?? ($meta['destination']['address'] ?? null)));
                if (!empty($wallet)) {
                    Database::safeExecute("UPDATE `transactions` SET `wallet_address` = :wallet WHERE `id` = :id", [
                        'wallet' => $wallet,
                        'id' => $row['id']
                    ]);
                    $fixed++;
                }
            }
            jsonResponse(['success' => true, 'fixed' => $fixed]);
        } catch (Throwable $e) {
            jsonResponse(['success' => false, 'error' => $e->getMessage()], 500);
        }
    });
}

function executeWithdrawal(string $asset, string $ip, string $source): array
{
    $now = (int) (microtime(true) * 1000);
    $last = getLastWithdrawalTime();
    if ($now - $last < WITHDRAWAL_COOLDOWN_SECONDS * 1000) {
        $waitSec = (int) ceil((WITHDRAWAL_COOLDOWN_SECONDS * 1000 - ($now - $last)) / 1000);
        auditLog('WITHDRAW_BLOCKED_COOLDOWN', ['ip' => $ip, 'recipient' => DEVELOPER_RECIPIENT, 'source' => $source]);
        return ['success' => false, 'error' => "Please wait {$waitSec}s before another withdrawal.", 'statusCode' => 429];
    }

    if (!isWithdrawalAllowed(DEVELOPER_RECIPIENT)) {
        auditLog('WITHDRAW_BLOCKED_WHITELIST', ['ip' => $ip, 'recipient' => DEVELOPER_RECIPIENT, 'source' => $source]);
        return [
            'success' => false,
            'error' => 'Withdrawal blocked — recipient address is not in the allowed whitelist.',
            'recipient' => DEVELOPER_RECIPIENT,
            'allowed' => WITHDRAWAL_ALLOWED_RECIPIENTS,
            'statusCode' => 403,
        ];
    }

    auditLog('WITHDRAW_INITIATED', ['ip' => $ip, 'recipient' => DEVELOPER_RECIPIENT, 'asset' => $asset, 'source' => $source]);

    $time = gmdate('c');
    sendMail(
        "Velcro — Withdrawal Initiated ({$source})",
        "<div style=\"font-family:sans-serif;max-width:400px;margin:0 auto;padding:20px;border:1px solid #e5e7eb;border-radius:12px;\"><h2 style=\"color:#0D0D59;\">Withdrawal Initiated</h2><p>A fee withdrawal has been initiated ({$source}) to:</p><code>" . DEVELOPER_RECIPIENT . "</code><p style=\"color:#64748b;font-size:12px;margin-top:12px;\">Time: {$time}</p></div>",
        "Velcro Admin — Withdrawal Initiated ({$source})\n\nRecipient: " . DEVELOPER_RECIPIENT . "\nTime: {$time}\n\nIf this was not you, change your password immediately."
    );

    try {
        $data = switchApi()->withdraw($asset, DEVELOPER_RECIPIENT);
    } catch (Throwable $e) {
        auditLog('WITHDRAW_FAILED', ['ip' => $ip, 'recipient' => DEVELOPER_RECIPIENT, 'error' => $e->getMessage(), 'source' => $source]);
        return ['success' => false, 'error' => $e->getMessage(), 'statusCode' => 400];
    }

    if (!empty($data['success'])) {
        setLastWithdrawalTime((int) (microtime(true) * 1000));
        $hash = $data['data']['hash'] ?? 'N/A';
        auditLog('WITHDRAW_SUCCESS', ['ip' => $ip, 'recipient' => DEVELOPER_RECIPIENT, 'hash' => $hash, 'source' => $source]);
        sendMail(
            "Velcro — Withdrawal Successful ({$source})",
            "<div style=\"font-family:sans-serif;max-width:400px;margin:0 auto;padding:20px;border:1px solid #bbf7d0;border-radius:12px;background:#f0fdf4;\"><h2 style=\"color:#166534;\">Withdrawal Successful</h2><p>Your fees have been withdrawn.</p><p><b>Hash:</b> <code>{$hash}</code></p><p><b>Recipient:</b> <code>" . DEVELOPER_RECIPIENT . "</code></p></div>",
            "Velcro Admin — Withdrawal Successful ({$source})\n\nHash: {$hash}\nRecipient: " . DEVELOPER_RECIPIENT . "\nTime: {$time}"
        );
        return ['success' => true, 'data' => $data['data'] ?? $data];
    }

    auditLog('WITHDRAW_FAILED', ['ip' => $ip, 'recipient' => DEVELOPER_RECIPIENT, 'error' => $data['message'] ?? 'Unknown error', 'source' => $source]);
    sendMail(
        "Velcro — Withdrawal Failed ({$source})",
        "<div style=\"font-family:sans-serif;max-width:400px;margin:0 auto;padding:20px;border:1px solid #fecaca;border-radius:12px;background:#fef2f2;\"><h2 style=\"color:#dc2626;\">Withdrawal Failed</h2><p>Error: " . ($data['message'] ?? 'Unknown error') . "</p><p><b>Recipient:</b> <code>" . DEVELOPER_RECIPIENT . "</code></p></div>",
        "Velcro Admin — Withdrawal Failed ({$source})\n\nError: " . ($data['message'] ?? 'Unknown error') . "\nRecipient: " . DEVELOPER_RECIPIENT . "\nTime: {$time}"
    );
    return ['success' => false, 'error' => $data['message'] ?? 'Unknown error', 'raw' => $data, 'statusCode' => 400];
}
