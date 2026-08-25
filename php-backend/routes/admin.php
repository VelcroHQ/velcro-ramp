<?php

declare(strict_types=1);

require_once __DIR__ . '/../switch_api.php';
require_once __DIR__ . '/../paj_api.php';
require_once __DIR__ . '/../poll_helpers.php';

function registerAdminRoutes(Router $router): void
{
    $router->get('/api/admin/stats', function () {
        requireAdminAuth();
        try {
            $totals = Database::selectOne("SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN `status` = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
                COUNT(DISTINCT CASE WHEN `wallet_address` IS NOT NULL AND `wallet_address` != '' THEN `wallet_address` END) AS wallets
            FROM `transactions`");

            $volumes = Database::selectOne("SELECT
                SUM(CASE WHEN `status` = 'COMPLETED' AND `type` = 'OFFRAMP' THEN `amount` ELSE 0 END) AS offramp_usd,
                SUM(CASE WHEN `status` = 'COMPLETED' AND `type` = 'OFFRAMP' THEN `destination_amount` ELSE 0 END) AS offramp_ngn,
                SUM(CASE WHEN `status` = 'COMPLETED' AND `type` = 'ONRAMP' THEN `amount` ELSE 0 END) AS onramp_ngn,
                SUM(CASE WHEN `status` = 'COMPLETED' AND `type` = 'ONRAMP' THEN `destination_amount` ELSE 0 END) AS onramp_usd
            FROM `transactions`");

            try {
                $feesData = switchApi()->getDeveloperFees();
            } catch (Throwable $e) {
                $feesData = ['data' => ['amount' => 0, 'currency' => 'USD']];
            }

            jsonResponse([
                'totalUsers' => (int) ($totals['wallets'] ?? 0),
                'allTransactions' => (int) ($totals['total'] ?? 0),
                'completedTransactions' => (int) ($totals['completed'] ?? 0),
                'totalVolumeUSD' => (float) (($volumes['offramp_usd'] ?? 0) + ($volumes['onramp_usd'] ?? 0)),
                'totalVolumeNGN' => (float) (($volumes['offramp_ngn'] ?? 0) + ($volumes['onramp_ngn'] ?? 0)),
                'developerFees' => $feesData['data'] ?? ['amount' => 0, 'currency' => 'USD'],
            ]);
        } catch (Throwable $e) {
            jsonResponse(['error' => clientErrorMessage($e)], 500);
        }
    });

    $router->get('/api/admin/config', function () {
        requireAdminAuth();
        jsonResponse([
            'developer_recipient' => DEVELOPER_RECIPIENT,
            'developer_asset' => DEVELOPER_WITHDRAW_ASSET,
            'developer_fee' => DEVELOPER_FEE,
            'withdrawal_allowed' => isWithdrawalAllowed(DEVELOPER_RECIPIENT),
        ]);
    });

    $router->get('/api/admin/transactions', function () {
        requireAdminAuth();
        try {
            $rows = Database::safeSelect('SELECT * FROM `transactions` ORDER BY `created_at` DESC LIMIT 200', [], []);
            foreach ($rows as &$row) {
                $row = decodeJsonColumns($row, ['beneficiary', 'meta']);
            }
            jsonResponse($rows);
        } catch (Throwable $e) {
            jsonResponse(['error' => clientErrorMessage($e)], 500);
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
            jsonResponse(['success' => false, 'error' => clientErrorMessage($e)], 500);
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
            jsonResponse(['success' => false, 'error' => clientErrorMessage($e)], 500);
        }
    });

    $router->get('/api/admin/users', function () {
        requireAdminAuth();
        try {
            $rows = Database::safeSelect("SELECT
                COALESCE(NULLIF(LOWER(TRIM(`email`)), ''), `wallet_address`, 'unknown') AS `id`,
                MIN(`created_at`) AS `created_at`,
                COUNT(*) AS `tx_count`,
                SUM(CASE WHEN `status` = 'COMPLETED' AND `type` = 'OFFRAMP' THEN `amount` ELSE 0 END) AS `total_volume`,
                SUM(CASE WHEN `status` = 'COMPLETED' AND `type` = 'OFFRAMP' THEN `destination_amount` ELSE 0 END) AS `total_volume_ngn_offramp`,
                SUM(CASE WHEN `status` = 'COMPLETED' AND `type` = 'ONRAMP' THEN `amount` ELSE 0 END) AS `total_volume_ngn_onramp`,
                SUM(CASE WHEN `status` = 'COMPLETED' AND `type` = 'ONRAMP' THEN `destination_amount` ELSE 0 END) AS `total_volume_usd_onramp`
            FROM `transactions`
            GROUP BY `id`
            ORDER BY `total_volume` DESC
            LIMIT 200", [], []);

            $users = array_map(static function ($r) {
                return [
                    'id' => $r['id'],
                    'created_at' => $r['created_at'],
                    'tx_count' => (int) $r['tx_count'],
                    'total_volume' => (float) $r['total_volume'] + (float) ($r['total_volume_usd_onramp'] ?? 0),
                    'total_volume_ngn' => (float) ($r['total_volume_ngn_offramp'] ?? 0) + (float) ($r['total_volume_ngn_onramp'] ?? 0),
                ];
            }, $rows);

            jsonResponse($users);
        } catch (Throwable $e) {
            jsonResponse(['error' => clientErrorMessage($e)], 500);
        }
    });

    $router->post('/api/admin/withdraw/otp', function () {
        requireAdminAuth();
        $ip = clientIp();
        rateLimitOrFail('withdraw_otp:' . $ip, 3, 60);
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
            jsonResponse(['success' => false, 'error' => clientErrorMessage($e)], 500);
        }
    });

    $router->post('/api/admin/withdraw', function () {
        requireAdminAuth();
        $ip = clientIp();
        rateLimitOrFail('withdraw:' . $ip, 3, 60);
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
            $tx = Database::selectOne('SELECT * FROM `transactions` WHERE `reference` = :reference', ['reference' => $reference]);
            if ($tx === null) {
                jsonResponse(['success' => false, 'error' => 'Transaction not found'], 404);
            }
            if (in_array($tx['status'], FINAL_STATUSES, true)) {
                jsonResponse(['success' => true, 'message' => 'Transaction already in final state', 'status' => $tx['status']]);
            }
            pollSingleTransaction($tx);
            $updated = Database::selectOne('SELECT * FROM `transactions` WHERE `reference` = :reference', ['reference' => $reference]);
            jsonResponse(['success' => true, 'status' => $updated['status'], 'previousStatus' => $tx['status']]);
        } catch (Throwable $e) {
            jsonResponse(['success' => false, 'error' => clientErrorMessage($e)], 500);
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
            jsonResponse(['error' => clientErrorMessage($e)], 500);
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
        return ['success' => false, 'error' => clientErrorMessage($e), 'statusCode' => 400];
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
