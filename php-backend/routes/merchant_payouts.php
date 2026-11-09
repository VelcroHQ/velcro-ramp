<?php

declare(strict_types=1);

// Velcro Merchant earnings: the markup on completed store orders builds a balance the merchant
// withdraws in naira (to a bank account HostFi has checked) or USDC (to a wallet). Like referral
// payouts, Velcro sends the money by hand and then marks the request paid in the admin.

const MERCHANT_MIN_WITHDRAWAL_USD = 2.0;

function ensureMerchantPayoutSchema(): void
{
    static $done = false;
    $flag = BASE_PATH . '/data/.merchant_payouts_v1';
    if ($done || file_exists($flag)) {
        $done = true;
        return;
    }
    $pdo = Database::pdo();
    $sqlite = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite';
    $pdo->exec('CREATE TABLE IF NOT EXISTS `merchant_withdrawals` (
        `id` ' . ($sqlite ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'INT UNSIGNED AUTO_INCREMENT PRIMARY KEY') . ',
        `merchant_id` INT NOT NULL,
        `amount_ngn` DECIMAL(18,2) NOT NULL,
        `amount_usd` DECIMAL(18,6) NOT NULL,
        `rate` DECIMAL(18,4) DEFAULT NULL,
        `currency` VARCHAR(8) NOT NULL,
        `bank_name` VARCHAR(120) DEFAULT NULL,
        `bank_code` VARCHAR(40) DEFAULT NULL,
        `account_number` VARCHAR(20) DEFAULT NULL,
        `account_name` VARCHAR(160) DEFAULT NULL,
        `chain` VARCHAR(20) DEFAULT NULL,
        `address` VARCHAR(128) DEFAULT NULL,
        `status` VARCHAR(20) NOT NULL DEFAULT \'PENDING\',
        `payout_ref` VARCHAR(255) DEFAULT NULL,
        `note` VARCHAR(255) DEFAULT NULL,
        `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        `processed_at` TIMESTAMP NULL DEFAULT NULL
    )');
    if (!$sqlite) {
        try {
            $pdo->exec('ALTER TABLE `merchant_withdrawals` ADD KEY `idx_merchant` (`merchant_id`)');
        } catch (PDOException $e) {
            // already there
        }
    }
    @file_put_contents($flag, gmdate('c'));
    $done = true;
}

/** Naira per $1 for earnings in dollars: what a customer pays for $1 of USDT (a little under the market). */
function merchantPayoutRate(): float
{
    return (float) (merchantVelcroRates()['USDT']['buy'] ?? 0);
}

/**
 * Earned (completed orders), held by a request awaiting payment, paid out, and what's left.
 *
 * @return array<string,mixed>
 */
function merchantEarnings(array $m): array
{
    ensureMerchantPayoutSchema();
    $earned = 0.0;
    foreach (merchantOrders((int) $m['id'], null) as $o) {
        $earned += $o['status'] === 'COMPLETED' ? (float) $o['earned'] : 0;
    }
    $sum = static fn (string $status): float => (float) (Database::selectOne(
        'SELECT COALESCE(SUM(`amount_ngn`), 0) AS s FROM `merchant_withdrawals` WHERE `merchant_id` = :m AND `status` = :s',
        ['m' => $m['id'], 's' => $status]
    )['s'] ?? 0);
    $pending = $sum('PENDING');
    $paid = $sum('APPROVED');
    $available = max(0, round($earned - $pending - $paid, 2));
    $rate = merchantPayoutRate();
    return [
        'earned_ngn' => round($earned, 2),
        'pending_ngn' => $pending,
        'paid_ngn' => $paid,
        'suspended' => $m['status'] === 'SUSPENDED',
        'available_ngn' => $available,
        'available_usd' => $rate > 0 ? round($available / $rate, 2) : null,
        'ngn_per_usd' => $rate > 0 ? $rate : null,
        'min_usd' => MERCHANT_MIN_WITHDRAWAL_USD,
        'min_ngn' => $rate > 0 ? ceil(MERCHANT_MIN_WITHDRAWAL_USD * $rate) : null,
    ];
}

/** Why the merchant can't withdraw right now, or null. */
function merchantWithdrawProblem(array $e): ?string
{
    return match (true) {
        $e['suspended'] => 'Withdrawals are paused while your store is suspended. Contact support.',
        $e['pending_ngn'] > 0 => 'You already have a withdrawal waiting to be paid.',
        $e['ngn_per_usd'] === null => 'Rates are unavailable right now. Try again in a minute.',
        $e['available_usd'] < MERCHANT_MIN_WITHDRAWAL_USD => 'The minimum withdrawal is $' . number_format(MERCHANT_MIN_WITHDRAWAL_USD, 2) . ' (about ₦' . number_format((float) $e['min_ngn']) . ').',
        default => null,
    };
}

function merchantWithdrawalView(array $w): array
{
    return [
        'id' => (int) $w['id'],
        'currency' => $w['currency'],
        'amount_ngn' => (float) $w['amount_ngn'],
        'amount_usd' => (float) $w['amount_usd'],
        'to' => $w['currency'] === 'NGN'
            ? trim($w['account_name'] . ' · ' . $w['bank_name'] . ' ••••' . substr((string) $w['account_number'], -4))
            : (REFERRAL_CHAINS[$w['chain']] ?? $w['chain']) . ' · ' . substr((string) $w['address'], 0, 6) . '…' . substr((string) $w['address'], -4),
        'status' => $w['status'],
        'payout_ref' => $w['payout_ref'],
        'note' => $w['note'],
        'created_at' => $w['created_at'],
        'processed_at' => $w['processed_at'],
    ];
}

function registerMerchantPayoutRoutes(Router $router): void
{
    $router->get('/api/merchant/earnings', function () {
        $email = requireMerchantAuth();
        $m = merchantFor($email);
        $e = merchantEarnings($m);
        $rows = Database::select('SELECT * FROM `merchant_withdrawals` WHERE `merchant_id` = :m ORDER BY `id` DESC LIMIT 50', ['m' => $m['id']]);
        jsonResponse(successResponse($e + [
            'can_withdraw' => merchantWithdrawProblem($e) === null,
            'reason' => merchantWithdrawProblem($e),
            'chains' => REFERRAL_CHAINS,
            'withdrawals' => array_map('merchantWithdrawalView', $rows),
        ]));
    });

    // A fresh emailed code for every withdrawal, on top of the signed-in session.
    $router->post('/api/merchant/withdraw/code', function () {
        $email = requireMerchantAuth();
        if (!rateLimitCheck('merch_wd_' . $email, 5, 3600)) {
            jsonResponse(errorResponse('Too many code requests. Try again in an hour.', 429), 429);
        }
        $e = merchantEarnings(merchantFor($email));
        if (($problem = merchantWithdrawProblem($e)) !== null) {
            jsonResponse(errorResponse($problem), 400);
        }
        try {
            sendReferralCode($email, referralOtpKey('merchwd', $email), 'Your Velcro Merchant withdrawal code', 'Use this code to withdraw ₦' . number_format($e['available_ngn'], 2) . ' of store earnings:');
        } catch (Throwable $ex) {
            jsonResponse(errorResponse(publicError($ex)), 500);
        }
        jsonResponse(successResponse(['sent' => true], 'Code sent to ' . $email));
    });

    // Withdraw the whole available balance, in naira to a checked bank account or USDC to a wallet.
    $router->post('/api/merchant/withdraw', function () {
        $email = requireMerchantAuth();
        $b = getJsonBody();
        $currency = strtoupper((string) body($b, 'currency', ''));
        if (!in_array($currency, ['NGN', 'USDC'], true)) {
            jsonResponse(errorResponse('Choose naira or USDC'), 400);
        }
        $m = merchantFor($email);
        $row = ['merchant_id' => $m['id'], 'currency' => $currency];
        if ($currency === 'USDC') {
            $chain = strtolower(trim((string) body($b, 'chain', '')));
            $address = trim((string) body($b, 'address', ''));
            if (!isset(REFERRAL_CHAINS[$chain])) {
                jsonResponse(errorResponse('Choose a supported network'), 400);
            }
            if (!isValidPayoutAddress($chain, $address)) {
                jsonResponse(errorResponse('That address is not valid for ' . REFERRAL_CHAINS[$chain]), 400);
            }
            $row += ['chain' => $chain, 'address' => $address];
        } else {
            $accountNumber = preg_replace('/\D/', '', (string) body($b, 'account_number', '')) ?? '';
            if (strlen($accountNumber) !== 10) {
                jsonResponse(errorResponse('Enter a 10-digit account number'), 400);
            }
            // HostFi pays naira, so its own lookup gives the name the money goes to.
            try {
                $bank = hostfiApi()->matchBank((string) body($b, 'bank_code', ''), (string) body($b, 'bank_name', ''));
                $name = $bank ? trim((string) (hostfiApi()->lookupAccount($bank['bankId'], $accountNumber)['accountName'] ?? '')) : '';
            } catch (Throwable $ex) {
                $name = '';
            }
            if (empty($bank) || $name === '') {
                jsonResponse(errorResponse('We couldn’t verify this bank account. Check the bank and number.'), 400);
            }
            $row += ['bank_name' => $bank['bankName'], 'bank_code' => $bank['bankId'], 'account_number' => $accountNumber, 'account_name' => $name];
        }
        $otp = verifyOTP(referralOtpKey('merchwd', $email), (string) body($b, 'otp', ''));
        if (!$otp['valid']) {
            jsonResponse(errorResponse($otp['reason']), 403);
        }
        $e = merchantEarnings($m);
        if (($problem = merchantWithdrawProblem($e)) !== null) {
            jsonResponse(errorResponse($problem), 400);
        }
        Database::insert('merchant_withdrawals', $row + ['amount_ngn' => $e['available_ngn'], 'amount_usd' => $e['available_usd'], 'rate' => $e['ngn_per_usd']]);
        auditLog('MERCHANT_WITHDRAW_REQUESTED', ['merchant_id' => $m['id'], 'currency' => $currency, 'amount_ngn' => $e['available_ngn']]);
        $brand = merchantBrand($m);
        $amount = $currency === 'NGN' ? '₦' . number_format($e['available_ngn'], 2) : '$' . number_format((float) $e['available_usd'], 2) . ' USDC';
        $to = $currency === 'NGN' ? "{$row['account_name']} · {$row['bank_name']} · {$row['account_number']}" : REFERRAL_CHAINS[$row['chain']] . ' · ' . $row['address'];
        runAfterResponse(static function () use ($brand, $m, $email, $amount, $to, $currency): void {
            @sendMail("Merchant withdrawal request — {$amount}", ...renderEmail([
                'eyebrow' => 'Admin',
                'title' => 'New merchant withdrawal request',
                'intro' => 'A merchant asked to withdraw their store earnings. Send the money, then mark it paid in the admin.',
                'amount' => ['Amount', $amount],
                'rows' => [['Store', ($brand['name'] ?: $m['business_name']) . " ({$m['slug']})"], ['Merchant', $email], ['Pay to', $to, $currency === 'USDC']],
                'cta' => ['Review in admin', EMAIL_SITE_URL . '/goat/'],
            ]));
            merchantMail($email, "Withdrawal requested: {$amount}", [
                'preheader' => "We've got your request to withdraw {$amount}.",
                'eyebrow' => 'Earnings',
                'title' => "We've got your withdrawal request",
                'intro' => "Your request to withdraw {$amount} of store earnings is in. We pay withdrawals within a working day and email you when it's sent.",
                'amount' => ['Withdrawal', $amount],
                'rows' => [['Pay to', $to]],
                'cta' => ['Open earnings', EMAIL_SITE_URL . '/merchant/#earnings'],
            ], 'withdraw_requested');
        }, 'Merchant withdrawal emails');
        jsonResponse(successResponse(['sent' => true], 'Withdrawal requested'));
    });

    // ─── Admin ───

    $router->get('/api/admin/merchant-withdrawals', function () {
        requireAdminAuth();
        ensureMerchantPayoutSchema();
        $rows = Database::select(
            'SELECT w.*, m.`email` AS `merchant_email`, m.`slug`, m.`business_name`, m.`brand`
             FROM `merchant_withdrawals` w JOIN `merchants` m ON m.`id` = w.`merchant_id`
             ORDER BY (w.`status` = \'PENDING\') DESC, w.`id` DESC LIMIT 200'
        );
        jsonResponse(['withdrawals' => array_map(static fn ($w) => merchantWithdrawalView($w) + [
            'store' => merchantBrand($w)['name'] ?: $w['business_name'],
            'slug' => $w['slug'],
            'merchant_email' => $w['merchant_email'],
            // The full payout details, for whoever sends the money.
            'bank_name' => $w['bank_name'], 'account_number' => $w['account_number'], 'account_name' => $w['account_name'],
            'chain' => $w['chain'], 'address' => $w['address'],
        ], $rows)]);
    });

    $router->post('/api/admin/merchant-withdrawals/(\d+)', function (string $id) {
        requireAdminAuth();
        ensureMerchantPayoutSchema();
        $b = getJsonBody();
        $action = (string) body($b, 'action', '');
        if (!in_array($action, ['approve', 'reject'], true)) {
            jsonResponse(['success' => false, 'error' => 'Action must be approve or reject'], 400);
        }
        // Only PENDING requests change, so a double click can't pay twice.
        $count = Database::execute(
            "UPDATE `merchant_withdrawals` SET `status` = :s, `payout_ref` = :r, `note` = :n, `processed_at` = CURRENT_TIMESTAMP WHERE `id` = :id AND `status` = 'PENDING'",
            [
                's' => $action === 'approve' ? 'APPROVED' : 'REJECTED',
                'r' => mb_substr(trim((string) body($b, 'payout_ref', '')), 0, 255) ?: null,
                'n' => mb_substr(trim((string) body($b, 'note', '')), 0, 255) ?: null,
                'id' => (int) $id,
            ]
        );
        if ($count === 0) {
            jsonResponse(['success' => false, 'error' => 'Request not found or already processed'], 409);
        }
        $w = Database::selectOne('SELECT w.*, m.`email` AS `merchant_email` FROM `merchant_withdrawals` w JOIN `merchants` m ON m.`id` = w.`merchant_id` WHERE w.`id` = :id', ['id' => (int) $id]);
        auditLog('MERCHANT_WITHDRAW_' . ($action === 'approve' ? 'APPROVED' : 'REJECTED'), ['id' => (int) $id]);
        $v = merchantWithdrawalView($w);
        $amount = $w['currency'] === 'NGN' ? '₦' . number_format((float) $w['amount_ngn'], 2) : '$' . number_format((float) $w['amount_usd'], 2) . ' USDC';
        $paid = $action === 'approve';
        $sent = merchantMail((string) $w['merchant_email'], $paid ? "Paid: your {$amount} withdrawal" : "Your {$amount} withdrawal wasn't sent", [
            'preheader' => $paid ? "We've sent {$amount} to you." : 'Your withdrawal was not sent. The amount is back in your earnings.',
            'eyebrow' => 'Earnings',
            'title' => $paid ? "Your {$amount} is on its way" : "We couldn't send your withdrawal",
            'intro' => $paid ? "We've sent {$amount} of store earnings to the account below." : 'We didn’t send this withdrawal, so the amount is back in your earnings. ' . ($w['note'] ? "Reason: {$w['note']}" : 'Reply to this email if you have questions.'),
            'amount' => [$paid ? 'Sent' : 'Returned to earnings', $amount],
            'rows' => array_values(array_filter([['To', $v['to']], $w['payout_ref'] ? ['Reference', (string) $w['payout_ref'], true] : null])),
            'cta' => ['Open earnings', EMAIL_SITE_URL . '/merchant/#earnings'],
        ], 'withdraw_' . $action);
        jsonResponse(['success' => true, 'email_sent' => $sent]);
    });
}
