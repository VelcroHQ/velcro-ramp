<?php

declare(strict_types=1);

/**
 * Referrals: a user generates a code, orders placed through ?ref=CODE carry it,
 * and the referrer earns a % of each COMPLETED order's USD volume.
 * The % is snapshotted on the order at creation, so changing fees never rewrites past earnings.
 */

const REFERRAL_DEFAULT_FEE = 0.3;
const REFERRAL_MIN_WITHDRAWAL_USD = 3.0;
const REFERRAL_CHAINS = [
    'solana' => 'Solana',
    'base' => 'Base',
    'ethereum' => 'Ethereum',
    'polygon' => 'Polygon',
    'arbitrum' => 'Arbitrum',
    'bsc' => 'BNB Chain',
];

/** Creates the referral tables/columns on first use, so deploys need no manual SQL. */
function ensureReferralSchema(): void
{
    static $done = false;
    $flag = BASE_PATH . '/data/.referral_schema_v1';
    if ($done || file_exists($flag)) {
        $done = true;
        return;
    }
    $pdo = Database::pdo();
    $pdo->exec("CREATE TABLE IF NOT EXISTS `referrers` (
        `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `email` VARCHAR(255) NOT NULL UNIQUE,
        `code` VARCHAR(16) NOT NULL UNIQUE,
        `fee_percent` DECIMAL(6,3) DEFAULT NULL,
        `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $pdo->exec("CREATE TABLE IF NOT EXISTS `referral_withdrawals` (
        `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `email` VARCHAR(255) NOT NULL,
        `amount_usd` DECIMAL(18,6) NOT NULL,
        `chain` VARCHAR(20) NOT NULL,
        `address` VARCHAR(128) NOT NULL,
        `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        `payout_hash` VARCHAR(255) DEFAULT NULL,
        `note` VARCHAR(255) DEFAULT NULL,
        `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
        `processed_at` DATETIME DEFAULT NULL,
        KEY `idx_email` (`email`),
        KEY `idx_status` (`status`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    foreach ([
        'ADD COLUMN `referrer_code` VARCHAR(16) DEFAULT NULL',
        'ADD COLUMN `referral_fee_percent` DECIMAL(6,3) DEFAULT NULL',
        'ADD KEY `idx_referrer_code` (`referrer_code`)',
    ] as $alter) {
        try {
            $pdo->exec("ALTER TABLE `transactions` {$alter}");
        } catch (PDOException $e) {
            // 1060 duplicate column / 1061 duplicate key: already migrated.
            if (!in_array((int) ($e->errorInfo[1] ?? 0), [1060, 1061], true)) {
                throw $e;
            }
        }
    }
    @file_put_contents($flag, gmdate('c'));
    $done = true;
}

function getReferralFee(): float
{
    $fee = (float) (loadSettings()['referral_fee'] ?? REFERRAL_DEFAULT_FEE);
    return is_nan($fee) ? REFERRAL_DEFAULT_FEE : $fee;
}

function referrerByEmail(string $email): ?array
{
    return Database::selectOne('SELECT * FROM `referrers` WHERE `email` = :e', ['e' => strtolower(trim($email))]);
}

/**
 * Columns to add to a new transaction row when the order came through a referral link.
 * Unknown codes and self-referrals are ignored; a referral problem never blocks an order.
 *
 * @return array<string,mixed>
 */
function referralFieldsFor(mixed $code, ?string $buyerEmail): array
{
    $code = strtoupper(trim((string) $code));
    if (!preg_match('/^[A-Z0-9]{4,16}$/', $code)) {
        return [];
    }
    try {
        ensureReferralSchema();
        $ref = Database::selectOne('SELECT `email`, `code`, `fee_percent` FROM `referrers` WHERE `code` = :c', ['c' => $code]);
    } catch (Throwable $e) {
        error_log('Referral lookup failed: ' . $e->getMessage());
        return [];
    }
    if (!$ref || ($buyerEmail && strtolower(trim($buyerEmail)) === $ref['email'])) {
        return [];
    }
    return [
        'referrer_code' => $ref['code'],
        'referral_fee_percent' => $ref['fee_percent'] !== null ? (float) $ref['fee_percent'] : getReferralFee(),
    ];
}

/**
 * USD value of an order for referral purposes.
 * Dollar stablecoins: the crypto side is the USD value. Anything else: the naira side / USD-NGN rate.
 * ponytail: non-stable orders use today's rate, not the rate at order time; snapshot USD on the order if that drift matters.
 *
 * @param array<string,mixed> $t
 */
function referralUsdVolume(array $t, float $usdNgn): float
{
    $type = strtoupper((string) $t['type']);
    $isPaj = strtoupper((string) ($t['channel'] ?? '')) === 'PAJ';
    $amount = (float) $t['amount'];
    $dest = (float) ($t['destination_amount'] ?? 0);
    $asset = (string) $t['asset'];
    $symbol = strtoupper(str_contains($asset, ':') ? explode(':', $asset)[1] : $asset);
    if (in_array($symbol, ['USDT', 'USDC', 'USDG', 'PYUSD', 'DAI'], true)) {
        if ($type === 'ONRAMP' && $dest > 0) {
            return $dest;            // crypto delivered
        }
        if ($type === 'OFFRAMP' && !$isPaj && $amount > 0) {
            return $amount;          // Switch sell: amount is the crypto sent
        }
    }
    // Naira side: onramp and PAJ rows store NGN in `amount`; Switch sells store the NGN payout in destination_amount.
    $ngn = ($type === 'ONRAMP' || $isPaj) ? $amount : ($dest > 0 ? $dest : $amount * (float) ($t['rate'] ?? 0));
    return $usdNgn > 0 ? $ngn / $usdNgn : 0.0;
}

/** Live USD→NGN rate (PAJ sell rate), fetched once per request; 1500 if PAJ is unreachable (same fallback as the stats). */
function referralUsdNgnRate(): float
{
    static $rate = null;
    if ($rate === null) {
        $rate = 1500.0;
        try {
            $live = (float) (pajApi()->getPajRate()['offramp']['rate'] ?? 0);
            if ($live > 0) {
                $rate = $live;
            }
        } catch (Throwable $e) {
            error_log('Referral USD rate fetch failed: ' . $e->getMessage());
        }
    }
    return $rate;
}

/**
 * Earnings and balance for one referrer.
 * ponytail: recomputed from orders on every read; store per-order earnings if referrers reach thousands of orders.
 *
 * @param array<string,mixed> $referrer
 * @return array<string,mixed>
 */
function referralSummary(array $referrer, ?float $usdNgn = null): array
{
    $rows = Database::select(
        'SELECT `type`, `channel`, `rate`, `amount`, `destination_amount`, `asset`, `status`, `referral_fee_percent`
         FROM `transactions` WHERE `referrer_code` = :c',
        ['c' => $referrer['code']]
    );
    $earned = 0.0;
    $volume = 0.0;
    $completed = 0;
    foreach ($rows as $t) {
        if (strtoupper((string) $t['status']) !== 'COMPLETED') {
            continue; // referral fee only on successful orders
        }
        $usd = referralUsdVolume($t, $usdNgn ?? referralUsdNgnRate());
        $completed++;
        $volume += $usd;
        $earned += $usd * (float) $t['referral_fee_percent'] / 100;
    }
    $w = Database::selectOne(
        "SELECT COALESCE(SUM(CASE WHEN `status` = 'APPROVED' THEN `amount_usd` END), 0) AS paid,
                COALESCE(SUM(CASE WHEN `status` = 'PENDING' THEN `amount_usd` END), 0) AS pending
         FROM `referral_withdrawals` WHERE `email` = :e",
        ['e' => $referrer['email']]
    );
    $paid = (float) ($w['paid'] ?? 0);
    $pending = (float) ($w['pending'] ?? 0);
    // Round down to the cent so we never pay out more than was earned.
    $available = max(0.0, floor(($earned - $paid - $pending) * 100) / 100);

    return [
        'code' => $referrer['code'],
        'email' => $referrer['email'],
        'fee_percent' => $referrer['fee_percent'] !== null ? (float) $referrer['fee_percent'] : getReferralFee(),
        'fee_is_custom' => $referrer['fee_percent'] !== null,
        'referred_orders' => count($rows),
        'completed_orders' => $completed,
        'volume_usd' => round($volume, 2),
        'earned_usd' => round($earned, 2),
        'paid_usd' => round($paid, 2),
        'pending_usd' => round($pending, 2),
        'available_usd' => $available,
        'created_at' => $referrer['created_at'],
    ];
}

/** @return array<int,array<string,mixed>> */
function referralWithdrawalsFor(string $email): array
{
    return Database::select(
        'SELECT `id`, `amount_usd`, `chain`, `address`, `status`, `payout_hash`, `note`, `created_at`, `processed_at`
         FROM `referral_withdrawals` WHERE `email` = :e ORDER BY `id` DESC LIMIT 20',
        ['e' => $email]
    );
}

function isValidPayoutAddress(string $chain, string $address): bool
{
    return $chain === 'solana'
        ? (bool) preg_match('/^[1-9A-HJ-NP-Za-km-z]{32,44}$/', $address)
        : (bool) preg_match('/^0x[a-fA-F0-9]{40}$/', $address);
}

function referralView(array $referrer): array
{
    return referralSummary($referrer) + [
        'min_withdrawal_usd' => REFERRAL_MIN_WITHDRAWAL_USD,
        'chains' => REFERRAL_CHAINS,
        'withdrawals' => referralWithdrawalsFor($referrer['email']),
    ];
}

/** Request email from the body/query, validated. Ends the request on bad input. */
function referralEmailFrom(mixed $raw): string
{
    $email = strtolower(trim((string) $raw));
    if (!isValidEmail($email)) {
        jsonResponse(errorResponse('A valid email is required'), 400);
    }
    return $email;
}

function registerReferralRoutes(Router $router): void
{
    // ─── User ───

    $router->get('/api/referral/me', function () {
        $email = referralEmailFrom(query('email'));
        try {
            ensureReferralSchema();
            $ref = referrerByEmail($email);
            jsonResponse(successResponse($ref ? referralView($ref) : ['code' => null, 'fee_percent' => getReferralFee()]));
        } catch (Throwable $e) {
            jsonResponse(errorResponse(publicError($e)), 500);
        }
    });

    $router->post('/api/referral/link', function () {
        $email = referralEmailFrom(body(getJsonBody(), 'email'));
        if (!rateLimitCheck('ref_link_' . clientIp(), 20, 3600)) {
            jsonResponse(errorResponse('Too many requests. Try again later.', 429), 429);
        }
        try {
            ensureReferralSchema();
            $ref = referrerByEmail($email);
            // Unambiguous alphabet (no 0/O, 1/I/L) since people read codes aloud.
            $alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
            for ($i = 0; !$ref && $i < 5; $i++) {
                $code = '';
                for ($j = 0; $j < 8; $j++) {
                    $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
                }
                try {
                    Database::insert('referrers', ['email' => $email, 'code' => $code]);
                } catch (PDOException $e) {
                    // duplicate code (or the same email created concurrently): retry / re-read
                }
                $ref = referrerByEmail($email);
            }
            if (!$ref) {
                jsonResponse(errorResponse('Could not create a referral link. Try again.', 500), 500);
            }
            auditLog('REFERRAL_LINK_CREATED', ['email' => $email, 'code' => $ref['code']]);
            jsonResponse(successResponse(referralView($ref)));
        } catch (Throwable $e) {
            jsonResponse(errorResponse(publicError($e)), 500);
        }
    });

    // Emails aren't verified, so payouts need a one-time code sent to the referrer's inbox.
    $router->post('/api/referral/withdraw/otp', function () {
        $email = referralEmailFrom(body(getJsonBody(), 'email'));
        if (!rateLimitCheck('ref_otp_' . $email, 5, 3600)) {
            jsonResponse(errorResponse('Too many code requests. Try again in an hour.', 429), 429);
        }
        if (SMTP_HOST === '' || SMTP_USER === '' || SMTP_PASS === '') {
            jsonResponse(errorResponse('Withdrawals are temporarily unavailable.', 503), 503);
        }
        try {
            ensureReferralSchema();
            $ref = referrerByEmail($email);
            if (!$ref) {
                jsonResponse(errorResponse('No referral account for this email', 404), 404);
            }
            $summary = referralSummary($ref);
            if ($summary['pending_usd'] > 0) {
                jsonResponse(errorResponse('You already have a withdrawal awaiting approval.'), 400);
            }
            if ($summary['available_usd'] < REFERRAL_MIN_WITHDRAWAL_USD) {
                jsonResponse(errorResponse('Minimum withdrawal is $' . number_format(REFERRAL_MIN_WITHDRAWAL_USD, 2)), 400);
            }
            $otp = generateOTP();
            storeOTP('refwd:' . $email, $otp);
            $amount = number_format($summary['available_usd'], 2);
            $sent = smtpSend(
                $email,
                'Your Velcro withdrawal code',
                "<div style=\"font-family:sans-serif;max-width:400px;margin:0 auto;padding:20px\"><h2 style=\"color:#0D0D59\">Withdrawal code</h2><p>Use this code to withdraw \${$amount} USDC of referral earnings:</p><div style=\"font-size:32px;font-weight:700;letter-spacing:6px;color:#0D0D59;background:#f4f7fe;padding:16px;border-radius:10px;text-align:center\">{$otp}</div><p style=\"color:#64748b;font-size:13px\">Expires in 5 minutes. If you didn't request this, ignore this email.</p></div>",
                "Your Velcro withdrawal code: {$otp}\nAmount: \${$amount} USDC\nExpires in 5 minutes."
            );
            if (!$sent) {
                jsonResponse(errorResponse('Could not send the code. Try again shortly.', 502), 502);
            }
            jsonResponse(successResponse(['sent' => true], 'Code sent to ' . $email));
        } catch (Throwable $e) {
            jsonResponse(errorResponse(publicError($e)), 500);
        }
    });

    $router->post('/api/referral/withdraw', function () {
        $body = getJsonBody();
        $email = referralEmailFrom(body($body, 'email'));
        $chain = strtolower(trim((string) body($body, 'chain', '')));
        $address = trim((string) body($body, 'address', ''));
        if (!isset(REFERRAL_CHAINS[$chain])) {
            jsonResponse(errorResponse('Choose a supported network'), 400);
        }
        if (!isValidPayoutAddress($chain, $address)) {
            jsonResponse(errorResponse('That address is not valid for ' . REFERRAL_CHAINS[$chain]), 400);
        }
        try {
            ensureReferralSchema();
            $ref = referrerByEmail($email);
            if (!$ref) {
                jsonResponse(errorResponse('No referral account for this email', 404), 404);
            }
            $otpCheck = verifyOTP('refwd:' . $email, (string) body($body, 'otp', ''));
            if (!$otpCheck['valid']) {
                jsonResponse(errorResponse($otpCheck['reason']), 403);
            }
            $summary = referralSummary($ref);
            if ($summary['pending_usd'] > 0) {
                jsonResponse(errorResponse('You already have a withdrawal awaiting approval.'), 400);
            }
            if ($summary['available_usd'] < REFERRAL_MIN_WITHDRAWAL_USD) {
                jsonResponse(errorResponse('Minimum withdrawal is $' . number_format(REFERRAL_MIN_WITHDRAWAL_USD, 2)), 400);
            }
            Database::insert('referral_withdrawals', [
                'email' => $email,
                'amount_usd' => $summary['available_usd'],
                'chain' => $chain,
                'address' => $address,
            ]);
            auditLog('REFERRAL_WITHDRAW_REQUESTED', ['email' => $email, 'amount_usd' => $summary['available_usd'], 'chain' => $chain, 'address' => $address]);
            $amount = number_format($summary['available_usd'], 2);
            sendMail(
                'Referral withdrawal request — $' . $amount,
                "<p><b>{$email}</b> requested <b>\${$amount} USDC</b> on " . REFERRAL_CHAINS[$chain] . " to <code>{$address}</code>.</p><p>Approve or reject it in the admin dashboard under Referrals.</p>",
                "{$email} requested \${$amount} USDC on " . REFERRAL_CHAINS[$chain] . " to {$address}. Review it in the admin dashboard under Referrals."
            );
            jsonResponse(successResponse(referralView($ref), 'Withdrawal requested'));
        } catch (Throwable $e) {
            jsonResponse(errorResponse(publicError($e)), 500);
        }
    });

    // ─── Admin ───

    $router->get('/api/admin/referrals', function () {
        requireAdminAuth();
        try {
            ensureReferralSchema();
            $referrers = array_map('referralSummary', Database::select('SELECT * FROM `referrers` ORDER BY `id` DESC'));
            $withdrawals = Database::select('SELECT * FROM `referral_withdrawals` ORDER BY (`status` = \'PENDING\') DESC, `id` DESC LIMIT 200');
            jsonResponse([
                'default_fee_percent' => getReferralFee(),
                'min_withdrawal_usd' => REFERRAL_MIN_WITHDRAWAL_USD,
                'chains' => REFERRAL_CHAINS,
                'referrers' => $referrers,
                'withdrawals' => $withdrawals,
            ]);
        } catch (Throwable $e) {
            jsonResponse(['error' => $e->getMessage()], 500);
        }
    });

    // Per-referrer fee override; null resets to the default. Applies to new orders only.
    $router->post('/api/admin/referrals/fee', function () {
        requireAdminAuth();
        $body = getJsonBody();
        $code = strtoupper(trim((string) body($body, 'code', '')));
        $fee = body($body, 'fee_percent');
        if ($fee !== null && $fee !== '') {
            if (!is_numeric($fee) || (float) $fee < 0 || (float) $fee > 10) {
                jsonResponse(['success' => false, 'error' => 'Fee must be between 0 and 10%'], 400);
            }
            $fee = (float) $fee;
        } else {
            $fee = null;
        }
        ensureReferralSchema();
        $count = Database::execute('UPDATE `referrers` SET `fee_percent` = :f WHERE `code` = :c', ['f' => $fee, 'c' => $code]);
        if ($count === 0 && !Database::selectOne('SELECT 1 FROM `referrers` WHERE `code` = :c', ['c' => $code])) {
            jsonResponse(['success' => false, 'error' => 'Referrer not found'], 404);
        }
        auditLog('REFERRAL_FEE_UPDATED', ['code' => $code, 'fee_percent' => $fee]);
        jsonResponse(['success' => true]);
    });

    $router->post('/api/admin/referral-withdrawals/(\d+)', function (string $id) {
        requireAdminAuth();
        $body = getJsonBody();
        $action = (string) body($body, 'action', '');
        if (!in_array($action, ['approve', 'reject'], true)) {
            jsonResponse(['success' => false, 'error' => 'Action must be approve or reject'], 400);
        }
        ensureReferralSchema();
        // Only PENDING requests can change, so a double click can't approve twice.
        $count = Database::execute(
            "UPDATE `referral_withdrawals` SET `status` = :s, `payout_hash` = :h, `note` = :n, `processed_at` = NOW()
             WHERE `id` = :id AND `status` = 'PENDING'",
            [
                's' => $action === 'approve' ? 'APPROVED' : 'REJECTED',
                'h' => trim((string) body($body, 'payout_hash', '')) ?: null,
                'n' => mb_substr(trim((string) body($body, 'note', '')), 0, 255) ?: null,
                'id' => (int) $id,
            ]
        );
        if ($count === 0) {
            jsonResponse(['success' => false, 'error' => 'Request not found or already processed'], 409);
        }
        auditLog('REFERRAL_WITHDRAW_' . strtoupper($action === 'approve' ? 'APPROVED' : 'REJECTED'), ['id' => (int) $id]);
        jsonResponse(['success' => true]);
    });
}
