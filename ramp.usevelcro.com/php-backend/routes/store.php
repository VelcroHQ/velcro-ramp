<?php

declare(strict_types=1);

/**
 * Customers of merchant stores (ramp.usevelcro.com/m/{slug}). Accounts are per store: someone who
 * signs up at Northline is Northline's customer, and the same email at another store is a separate
 * account. Sign-in mirrors merchants (email + password with an emailed code, or Google), and every
 * email goes out from Velcro in the store's name and colours, "Powered by Velcro".
 */

function ensureStoreSchema(): void
{
    static $done = false;
    $flag = BASE_PATH . '/data/.store_schema_v1';
    if ($done || file_exists($flag)) {
        $done = true;
        ensureStoreOrderColumns();
        return;
    }
    ensureMerchantSchema();
    Database::pdo()->exec("CREATE TABLE IF NOT EXISTS `store_customers` (
        `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `merchant_id` INT UNSIGNED NOT NULL,
        `email` VARCHAR(255) NOT NULL,
        `password_hash` VARCHAR(255) DEFAULT NULL,
        `google_sub` VARCHAR(64) DEFAULT NULL,
        `name` VARCHAR(120) DEFAULT NULL,
        `token_version` INT NOT NULL DEFAULT 1,
        `last_login_at` DATETIME DEFAULT NULL,
        `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY `uniq_store_email` (`merchant_id`, `email`),
        UNIQUE KEY `uniq_store_google` (`merchant_id`, `google_sub`),
        KEY `idx_merchant` (`merchant_id`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    @file_put_contents($flag, gmdate('c'));
    $done = true;
    ensureStoreOrderColumns();
}

/** v2: store orders carry their store, customer, the merchant's markup and Velcro's fee at order time. */
/** Undoes the 2026-11-04 auto-link: main-site orders tagged to a store, and customers made from them. */
function repairStoreLinks(): void
{
    $flag = BASE_PATH . '/data/.store_repair_v1';
    if (file_exists($flag)) {
        return;
    }
    try {
        $orders = Database::execute('UPDATE `transactions` SET `merchant_id` = NULL WHERE `merchant_id` IS NOT NULL AND `velcro_fee_percent` IS NULL');
        $customers = Database::execute(
            'DELETE FROM `store_customers` WHERE `password_hash` IS NULL AND `google_sub` IS NULL
               AND `id` NOT IN (SELECT `store_customer_id` FROM `transactions` WHERE `store_customer_id` IS NOT NULL)'
        );
        auditLog('STORE_LINKS_REPAIRED', ['orders_untagged' => $orders, 'customers_removed' => $customers]);
        @file_put_contents($flag, gmdate('c'));
    } catch (Throwable $e) {
        error_log('[Store] link repair failed: ' . $e->getMessage());
    }
}

function ensureStoreOrderColumns(): void
{
    $flag = BASE_PATH . '/data/.store_schema_v2';
    if (file_exists($flag)) {
        return;
    }
    foreach ([
        'ADD COLUMN `merchant_id` INT UNSIGNED DEFAULT NULL',
        'ADD COLUMN `store_customer_id` INT UNSIGNED DEFAULT NULL',
        'ADD COLUMN `merchant_markup_percent` DECIMAL(6,3) DEFAULT NULL',
        'ADD COLUMN `velcro_fee_percent` DECIMAL(6,3) DEFAULT NULL',
        'ADD KEY `idx_merchant_id` (`merchant_id`)',
    ] as $alter) {
        try {
            Database::pdo()->exec("ALTER TABLE `transactions` {$alter}");
        } catch (PDOException $e) {
            // 1060 duplicate column / 1061 duplicate key: already there
            if (!in_array((int) ($e->errorInfo[1] ?? 0), [1060, 1061], true)) {
                throw $e;
            }
        }
    }
    @file_put_contents($flag, gmdate('c'));
}

/**
 * For an order placed on a store (request has `store` = slug): the store, the signed-in customer,
 * and the merchant's markup for this coin and side. Null for a normal Velcro order. Ends the request
 * if the store, the customer, the coin or the provider doesn't check out.
 *
 * @return array{merchant:array,customer:array,markup:float}|null
 */
function storeOrderContext(string $side, string $symbol, string $provider): ?array
{
    $body = getJsonBody();
    $slug = strtolower(trim((string) body($body, 'store', '')));
    if ($slug === '') {
        return null;
    }
    $m = storeBySlug($slug);
    if ($m['status'] !== 'APPROVED') {
        // The owner can test a store that's still waiting for approval, but never a suspended or rejected one.
        $owner = merchantTokenEmail((string) ($_SERVER['HTTP_X_MERCHANT_TOKEN'] ?? ''));
        if (!in_array($m['status'], ['DRAFT', 'PENDING'], true) || strtolower((string) $owner) !== strtolower((string) $m['email'])) {
            jsonResponse(errorResponse('This store is not taking orders yet.'), 403);
        }
    }
    // Only a signed-in customer of this store can order; an email in the request is never trusted.
    $customer = storeTokenCustomer($m);
    if (!$customer) {
        jsonResponse(errorResponse('Sign in to continue', 401), 401);
    }
    $symbol = strtoupper($symbol);
    $p = merchantPricing($m)[$symbol] ?? null;
    if (!$p || empty($p[$side . '_on']) || (MERCHANT_COIN_PROVIDERS[$symbol] ?? '') !== $provider) {
        jsonResponse(errorResponse("This store isn't " . ($side === 'buy' ? 'selling' : 'buying') . " {$symbol} right now."), 400);
    }
    return ['merchant' => $m, 'customer' => $customer, 'markup' => (float) ($p[$side] ?? 0)];
}

/** Columns that tag a store order. */
function storeOrderFields(?array $ctx, float $velcroFee): array
{
    if (!$ctx) {
        return [];
    }
    ensureStoreOrderColumns();
    return [
        'merchant_id' => (int) $ctx['merchant']['id'],
        'store_customer_id' => !empty($ctx['customer']['id']) ? (int) $ctx['customer']['id'] : null,
        'merchant_markup_percent' => (float) ($ctx['markup'] ?? 0),
        'velcro_fee_percent' => $velcroFee,
    ];
}

/**
 * The store at /m/{slug}: approved stores for everyone; a store that isn't approved yet only for
 * its own merchant (preview). Ends the request with 404 otherwise.
 */
function storeBySlug(string $slug): array
{
    ensureStoreSchema();
    $m = Database::selectOne('SELECT * FROM `merchants` WHERE `slug` = :s', ['s' => strtolower(trim($slug))]);
    $owner = $m ? merchantTokenEmail((string) ($_SERVER['HTTP_X_MERCHANT_TOKEN'] ?? '')) : null;
    if (!$m || ($m['status'] !== 'APPROVED' && strtolower((string) $owner) !== strtolower((string) $m['email']))) {
        jsonResponse(errorResponse('Store not found', 404), 404);
    }
    return $m;
}

/** Name, colour and logo for the store's emails and pages. */
function storeBranding(array $m): array
{
    $b = merchantBrand($m);
    return ['name' => $b['name'] ?: ($m['business_name'] ?: 'Store'), 'color' => $b['color'], 'logo' => $b['logo']];
}

/** Sends an email from Velcro in the store's branding ("Northline Exchange via Velcro"). */
function storeMail(array $m, string $to, string $subject, array $email, string $kind): bool
{
    if (!mailConfigured()) {
        return false;
    }
    $brand = storeBranding($m);
    try {
        [$html, $text] = renderEmail($email + ['store' => $brand]);
        $sent = (bool) @sendEmailTo($to, $subject, $html, $text, $brand['name'] . ' via Velcro');
    } catch (Throwable $e) {
        error_log("[Store] {$kind} email to {$to} failed: " . $e->getMessage());
        $sent = false;
    }
    if (!$sent) {
        auditLog('STORE_EMAIL_FAILED', ['merchant_id' => $m['id'], 'to' => $to, 'kind' => $kind]);
    }
    return $sent;
}

/** A 6-digit code in the store's branding. Ends the request if it can't be sent. */
function storeSendCode(array $m, string $email, string $purpose, string $subject, string $line): void
{
    if (!mailConfigured()) {
        jsonResponse(errorResponse('Email codes are temporarily unavailable.', 503), 503);
    }
    $otp = generateOTP();
    storeOTP(storeOtpKey($m, $purpose, $email), $otp);
    $sent = storeMail($m, $email, $subject, [
        'preheader' => "Your code is {$otp}",
        'eyebrow' => 'Verification',
        'title' => $subject,
        'intro' => $line,
        'code' => $otp,
        'outro' => "This code expires in 5 minutes. If you didn't request it, you can ignore this email.",
    ], $purpose);
    if (!$sent) {
        jsonResponse(errorResponse('Could not send the code. Try again shortly.', 502), 502);
    }
}

function storeOtpKey(array $m, string $purpose, string $email): string
{
    return referralOtpKey($purpose . (int) $m['id'], $email);
}

function storeCustomer(array $m, string $email): ?array
{
    return Database::selectOne('SELECT * FROM `store_customers` WHERE `merchant_id` = :m AND `email` = :e', ['m' => $m['id'], 'e' => strtolower(trim($email))]);
}

function issueStoreToken(array $customer): string
{
    Database::execute('UPDATE `store_customers` SET `last_login_at` = :t WHERE `id` = :id', ['t' => gmdate('Y-m-d H:i:s'), 'id' => $customer['id']]);
    $payload = 'store|' . (int) $customer['merchant_id'] . '|' . $customer['email'] . '|' . (time() + 30 * 86400) . '|' . (int) $customer['token_version'];
    return rtrim(strtr(base64_encode($payload), '+/', '-_'), '=') . '.' . hash_hmac('sha256', $payload, appKey());
}

/** The signed-in customer of this store (X-Store-Token), or null. A token from another store never counts. */
function storeTokenCustomer(array $m): ?array
{
    [$b64, $sig] = array_pad(explode('.', (string) ($_SERVER['HTTP_X_STORE_TOKEN'] ?? ''), 2), 2, '');
    $payload = base64_decode(strtr($b64, '-_', '+/'), true);
    if ($payload === false || !hash_equals(hash_hmac('sha256', $payload, appKey()), $sig)) {
        return null;
    }
    [$scope, $mid, $email, $exp, $ver] = array_pad(explode('|', $payload, 5), 5, '');
    if ($scope !== 'store' || (int) $mid !== (int) $m['id'] || (int) $exp <= time()) {
        return null;
    }
    $c = storeCustomer($m, $email);
    return $c && (int) $c['token_version'] === (int) $ver ? $c : null;
}

function storeSignedIn(array $customer, string $message): never
{
    jsonResponse(successResponse(['token' => issueStoreToken($customer), 'email' => $customer['email'], 'name' => $customer['name']], $message));
}

function resolvePayoutBankInfo(array $ben, array $meta): array
{
    static $banks = [
        '100004' => 'OPay',
        '000014' => 'Access Bank',
        '044'    => 'Access Bank',
        '000013' => 'Guaranty Trust Bank (GTBank)',
        '058'    => 'Guaranty Trust Bank (GTBank)',
        '000015' => 'Zenith Bank',
        '057'    => 'Zenith Bank',
        '000016' => 'First Bank of Nigeria',
        '011'    => 'First Bank of Nigeria',
        '000004' => 'United Bank for Africa (UBA)',
        '033'    => 'United Bank for Africa (UBA)',
        '000007' => 'Fidelity Bank',
        '070'    => 'Fidelity Bank',
        '000018' => 'Union Bank',
        '032'    => 'Union Bank',
        '000017' => 'Wema Bank (ALAT)',
        '035'    => 'Wema Bank (ALAT)',
        '000001' => 'Sterling Bank',
        '232'    => 'Sterling Bank',
        '000010' => 'Ecobank Nigeria',
        '050'    => 'Ecobank Nigeria',
        '090267' => 'Kuda Bank',
        '100026' => 'Kuda Bank',
        '000008' => 'Kuda Bank',
        '000012' => 'Stanbic IBTC Bank',
        '221'    => 'Stanbic IBTC Bank',
        '000003' => 'First City Monument Bank (FCMB)',
        '214'    => 'First City Monument Bank (FCMB)',
        '100033' => 'PalmPay',
        '090405' => 'Moniepoint MFB',
        '090393' => 'Moniepoint MFB',
        '000011' => 'Unity Bank',
        '215'    => 'Unity Bank',
        '076'    => 'Polaris Bank',
        '000023' => 'Providus Bank',
        '101'    => 'Providus Bank',
        '000026' => 'TAJ Bank',
        '302'    => 'TAJ Bank',
        '000027' => 'Globus Bank',
        '000029' => 'Lotus Bank',
        '303'    => 'Lotus Bank',
        '000031' => 'PremiumTrust Bank',
        '105'    => 'PremiumTrust Bank',
        '000006' => 'Jaiz Bank',
        '301'    => 'Jaiz Bank',
        '000021' => 'Standard Chartered Bank',
        '068'    => 'Standard Chartered Bank',
        '090110' => 'VFD Microfinance Bank',
        '090701' => 'Carbon',
        '090551' => 'FairMoney MFB',
        '023'    => 'Citibank Nigeria',
        '102'    => 'Titan Trust Bank',
        '090286' => 'Safehaven MFB',
    ];

    $bankName = $ben['bank_name']
        ?? $ben['bankName']
        ?? $ben['institution']
        ?? ($meta['hostfi']['bank']['bankName'] ?? null)
        ?? ($meta['bank']['bankName'] ?? null)
        ?? null;

    $bankCode = (string) ($ben['bank_code']
        ?? $ben['bankCode']
        ?? $ben['bank']
        ?? $ben['bankId']
        ?? ($meta['hostfi']['bank']['bankId'] ?? '')
        ?? '');
    if (str_contains($bankCode, '::')) {
        $bankCode = explode('::', $bankCode)[1] ?? $bankCode;
    }

    if (empty($bankName) || strtolower(trim((string)$bankName)) === 'bank') {
        if ($bankCode !== '' && isset($banks[$bankCode])) {
            $bankName = $banks[$bankCode];
        } elseif ($bankCode !== '' && isset($banks[ltrim($bankCode, '0')])) {
            $bankName = $banks[ltrim($bankCode, '0')];
        } elseif ($bankCode !== '' && isset($banks[str_pad($bankCode, 6, '0', STR_PAD_LEFT)])) {
            $bankName = $banks[str_pad($bankCode, 6, '0', STR_PAD_LEFT)];
        }
    }

    $accountNumber = $ben['account_number']
        ?? $ben['accountNumber']
        ?? ($meta['hostfi']['bank']['accountNumber'] ?? null)
        ?? ($meta['bank']['accountNumber'] ?? null)
        ?? null;

    $holderName = $ben['holder_name']
        ?? $ben['holderName']
        ?? $ben['account_name']
        ?? $ben['accountName']
        ?? ($meta['hostfi']['bank']['accountName'] ?? null)
        ?? ($meta['bank']['accountName'] ?? null)
        ?? null;

    return [
        'bank_name' => $bankName ?: null,
        'account_number' => $accountNumber ?: null,
        'holder_name' => $holderName ?: null,
    ];
}

/**
 * A store's orders (newest 500, or all with $limit null) for its dashboard: coin, naira value, and the markup earned.
 * Naira value is what the customer paid on a buy, and the payout before fees on a sell. Only
 * completed orders earn; open ones show what they would.
 */
function merchantOrders(int $merchantId, ?int $limit = 500): array
{
    ensureStoreOrderColumns();
    repairStoreLinks();
    // Only orders placed on this store (tagged when they were created). A customer's orders on the
    // main site or on another store never show here.
    $rows = Database::select(
        'SELECT t.`reference`, t.`type`, t.`status`, t.`channel`, t.`asset`, t.`amount`, t.`destination_amount`, t.`destination_currency`,
                t.`source_currency`, t.`merchant_markup_percent`, t.`velcro_fee_percent`, t.`rate`, t.`hash`, t.`created_at`, t.`store_customer_id`,
                t.`wallet_address`, t.`deposit_bank_name`, t.`deposit_account_number`, t.`deposit_account_name`, t.`deposit_address`, t.`deposit_note`,
                t.`beneficiary`, t.`meta`,
                c.`email` AS `customer_email`, c.`name` AS `customer_name`
         FROM `transactions` t
         LEFT JOIN `store_customers` c ON c.`id` = t.`store_customer_id` AND c.`merchant_id` = t.`merchant_id`
         WHERE t.`merchant_id` = :m AND t.`velcro_fee_percent` IS NOT NULL
         ORDER BY t.`id` DESC' . ($limit ? ' LIMIT ' . (int) $limit : ''),
        ['m' => $merchantId]
    );
    return array_map(static function (array $t): array {
        $buy = strtoupper((string) $t['type']) === 'ONRAMP';
        $markup = (float) ($t['merchant_markup_percent'] ?? 0);
        $fees = ($markup + (float) ($t['velcro_fee_percent'] ?? 0)) / 100;
        $coin = strtoupper((string) ($buy ? $t['destination_currency'] : $t['source_currency']) ?: (explode(':', (string) $t['asset'])[1] ?? $t['asset']));
        if ($buy) {
            $naira = (float) $t['amount'];
        } elseif (strtoupper((string) $t['channel']) === 'PAJ') {
            $naira = (float) $t['amount']; // PAJ sells are ordered in naira
        } else {
            $paid = strtoupper((string) $t['destination_currency']) === 'NGN' ? (float) $t['destination_amount'] : 0.0;
            if ($paid > 0 && $fees < 1) {
                $naira = $paid / (1 - $fees);
            } elseif (!empty($t['rate']) && (float)$t['rate'] > 0 && (float)$t['amount'] > 0) {
                $naira = (float)$t['amount'] * (float)$t['rate'];
            } else {
                $naira = (float) $t['amount'];
            }
        }
        $ben = json_decode((string) ($t['beneficiary'] ?? ''), true) ?: [];
        $meta = json_decode((string) ($t['meta'] ?? ''), true) ?: [];
        $chain = str_contains((string) $t['asset'], ':') ? explode(':', (string) $t['asset'])[0] : '';
        $network = (string) ($meta['network'] ?? $meta['chain'] ?? $chain);
        $rawChannel = strtoupper((string) ($t['channel'] ?? ''));
        $provider = $rawChannel === 'HOSTFI' ? 'hostfi' : ($rawChannel === 'PAJ' || str_starts_with((string)$t['reference'], 'paj_') ? 'paj' : 'switch');
        $hostfiProgress = [];
        if ($provider === 'hostfi' && function_exists('hostfiProgress')) {
            try { $hostfiProgress = hostfiProgress((string) $t['reference']); } catch (\Throwable) {}
        }
        $payout = resolvePayoutBankInfo($ben, $meta);
        return [
            'reference' => $t['reference'],
            'side' => $buy ? 'buy' : 'sell',
            'status' => strtoupper((string) $t['status']),
            'coin' => $coin,
            'coin_amount' => $buy ? ($t['destination_amount'] !== null ? (float) $t['destination_amount'] : null) : (float) $t['amount'],
            'naira' => round($naira, 2),
            'rate' => !empty($t['rate']) && (float)$t['rate'] > 0 ? (float)$t['rate'] : null,
            'markup_percent' => $markup,
            'earned' => round($naira * $markup / 100, 2),
            'customer_email' => $t['customer_email'],
            'customer_name' => $t['customer_name'],
            'customer_id' => (int) $t['store_customer_id'],
            'wallet_address' => $t['wallet_address'] ?: ($ben['wallet_address'] ?? null),
            'network' => $network ?: null,
            'channel' => $rawChannel ?: null,
            'provider' => $provider,
            'hash' => $t['hash'] ?: null,
            'deposit_bank_name' => $t['deposit_bank_name'] ?: null,
            'deposit_account_number' => $t['deposit_account_number'] ?: null,
            'deposit_account_name' => $t['deposit_account_name'] ?: null,
            'deposit_address' => $t['deposit_address'] ?: null,
            'deposit_note' => $t['deposit_note'] ?: ($meta['memo'] ?? null),
            'payout_bank_name' => $payout['bank_name'],
            'payout_account_number' => $payout['account_number'],
            'payout_account_name' => $payout['holder_name'],
            'hostfi_progress' => $hostfiProgress,
            'created_at' => $t['created_at'],
        ];
    }, $rows);
}

/**
 * An order as its customer sees it, with when its account or address lapses and how much coin a
 * sale sends. The rest of `meta` (provider ids, fees) stays on the server.
 */
function storeCustomerOrderView(array $o): array
{
    $meta = json_decode((string) ($o['meta'] ?? ''), true) ?: [];
    $ben = json_decode((string) ($o['beneficiary'] ?? ''), true) ?: [];
    unset($o['meta'], $o['beneficiary']);
    $created = strtotime((string) $o['created_at']) ?: 0;
    $o['expires_at'] = (int) ($meta['hostfi']['expires_at'] ?? 0) ?: ($created ? $created + 3600 : 0);
    $o['send_amount'] = null;
    $chain = str_contains((string) $o['asset'], ':') ? explode(':', (string) $o['asset'])[0] : '';
    $o['network'] = (string) ($meta['network'] ?? $meta['chain'] ?? $chain);
    if (strtoupper((string) $o['type']) === 'OFFRAMP') {
        // PAJ sells are ordered in naira, so their coin amount is in PAJ's own order.
        $o['send_amount'] = (float) (strtoupper((string) $o['channel']) === 'PAJ' ? ($meta['amount'] ?? 0) : $o['amount']);
        $payout = resolvePayoutBankInfo($ben, $meta);
        $o['payout_bank_name'] = $payout['bank_name'];
        $o['payout_account_number'] = $payout['account_number'];
        $o['payout_account_name'] = $payout['holder_name'];
    }
    return $o;
}

function storeCustomerView(array $c): array
{
    return ['id' => (int) ($c['id'] ?? 0), 'email' => $c['email'], 'name' => $c['name'], 'since' => $c['created_at']];
}

function sendStoreWelcome(array $m, string $email): void
{
    $brand = storeBranding($m);
    runAfterResponse(static fn () => storeMail($m, $email, 'Welcome to ' . $brand['name'], [
        'preheader' => 'Buy and sell crypto with naira.',
        'eyebrow' => $brand['name'],
        'title' => 'Welcome to ' . $brand['name'],
        'intro' => 'Your account is ready. Buy BTC, ETH, SOL, USDT or USDC by bank transfer, or sell and get paid straight to your bank. Every order is tracked live and you get a receipt by email.',
        'cta' => ['Open ' . $brand['name'], 'https://' . $m['slug'] . '.usevelcro.com'],
        'outro' => "If you didn't create this account, reply to this email and we'll close it.",
    ], 'welcome'), 'Store welcome email');
}

function registerStoreRoutes(Router $router): void
{
    $slug = '([a-z0-9-]{3,30})';

    $router->post("/api/store/{$slug}/auth/signup/code", function (string $slug) {
        $m = storeBySlug($slug);
        $email = referralEmailFrom(body(getJsonBody(), 'email'));
        if (!rateLimitCheck('store_code_' . $m['id'] . $email, 5, 3600) || !rateLimitCheck('store_code_ip_' . clientIp(), 20, 3600)) {
            jsonResponse(errorResponse('Too many code requests. Try again in an hour.', 429), 429);
        }
        $c = storeCustomer($m, $email);
        if ($c && $c['password_hash']) {
            jsonResponse(errorResponse('You already have an account. Sign in instead.'), 409);
        }
        $name = storeBranding($m)['name'];
        storeSendCode($m, $email, 'stsu', "Confirm your {$name} email", "Use this code to finish creating your {$name} account:");
        jsonResponse(successResponse(['sent' => true], 'Code sent to ' . $email));
    });

    $router->post("/api/store/{$slug}/auth/signup", function (string $slug) {
        $m = storeBySlug($slug);
        $b = getJsonBody();
        $email = referralEmailFrom(body($b, 'email'));
        $password = (string) body($b, 'password', '');
        if (($problem = merchantPasswordProblem($password)) !== null) {
            jsonResponse(errorResponse($problem), 400);
        }
        $check = verifyOTP(storeOtpKey($m, 'stsu', $email), (string) body($b, 'otp', ''));
        if (!$check['valid']) {
            jsonResponse(errorResponse($check['reason']), 403);
        }
        $c = storeCustomer($m, $email);
        if ($c && $c['password_hash']) {
            jsonResponse(errorResponse('You already have an account. Sign in instead.'), 409);
        }
        $hash = password_hash($password, PASSWORD_DEFAULT);
        $name = mb_substr(trim((string) body($b, 'name', '')), 0, 120);
        if ($c) {
            Database::execute('UPDATE `store_customers` SET `password_hash` = :h WHERE `id` = :id', ['h' => $hash, 'id' => $c['id']]);
        } else {
            Database::insert('store_customers', ['merchant_id' => $m['id'], 'email' => $email, 'password_hash' => $hash, 'name' => $name !== '' ? $name : null]);
            sendStoreWelcome($m, $email);
        }
        auditLog('STORE_CUSTOMER_CREATED', ['merchant_id' => $m['id'], 'email' => $email, 'method' => 'password']);
        storeSignedIn(storeCustomer($m, $email), 'Account created');
    });

    $router->post("/api/store/{$slug}/auth/login", function (string $slug) {
        $m = storeBySlug($slug);
        $b = getJsonBody();
        $email = referralEmailFrom(body($b, 'email'));
        if (!rateLimitCheck('store_login_' . $m['id'] . $email, 10, 900) || !rateLimitCheck('store_login_ip_' . clientIp(), 30, 900)) {
            jsonResponse(errorResponse('Too many sign-in attempts. Try again in 15 minutes.', 429), 429);
        }
        $c = storeCustomer($m, $email);
        if (!$c || !$c['password_hash'] || !password_verify((string) body($b, 'password', ''), $c['password_hash'])) {
            if ($c && !$c['password_hash'] && $c['google_sub']) {
                jsonResponse(errorResponse('This account uses Google. Continue with Google, or set a password with "Forgot password".', 401), 401);
            }
            jsonResponse(errorResponse('Wrong email or password', 401), 401);
        }
        storeSignedIn($c, 'Signed in');
    });

    // Same answer whether or not the account exists.
    $router->post("/api/store/{$slug}/auth/reset/code", function (string $slug) {
        $m = storeBySlug($slug);
        $email = referralEmailFrom(body(getJsonBody(), 'email'));
        if (!rateLimitCheck('store_reset_' . $m['id'] . $email, 5, 3600) || !rateLimitCheck('store_reset_ip_' . clientIp(), 20, 3600)) {
            jsonResponse(errorResponse('Too many code requests. Try again in an hour.', 429), 429);
        }
        if (storeCustomer($m, $email)) {
            storeSendCode($m, $email, 'strs', 'Reset your password', 'Use this code to set a new password:');
        }
        jsonResponse(successResponse(['sent' => true], 'If that email has an account, a code is on its way'));
    });

    $router->post("/api/store/{$slug}/auth/reset", function (string $slug) {
        $m = storeBySlug($slug);
        $b = getJsonBody();
        $email = referralEmailFrom(body($b, 'email'));
        $password = (string) body($b, 'password', '');
        if (($problem = merchantPasswordProblem($password)) !== null) {
            jsonResponse(errorResponse($problem), 400);
        }
        $check = verifyOTP(storeOtpKey($m, 'strs', $email), (string) body($b, 'otp', ''));
        $c = storeCustomer($m, $email);
        if (!$check['valid'] || !$c) {
            jsonResponse(errorResponse($check['valid'] ? 'Invalid code' : $check['reason']), 403);
        }
        Database::execute('UPDATE `store_customers` SET `password_hash` = :h, `token_version` = `token_version` + 1 WHERE `id` = :id', ['h' => password_hash($password, PASSWORD_DEFAULT), 'id' => $c['id']]);
        auditLog('STORE_CUSTOMER_PASSWORD_RESET', ['merchant_id' => $m['id'], 'email' => $email]);
        $brand = storeBranding($m);
        runAfterResponse(static fn () => storeMail($m, $email, 'Your password was changed', [
            'eyebrow' => 'Security',
            'title' => 'Your password was changed',
            'intro' => "The password for your {$brand['name']} account was just changed, and every other session was signed out.",
            'outro' => "If this wasn't you, reset your password now and reply to this email.",
        ], 'password changed'), 'Store password email');
        storeSignedIn(storeCustomer($m, $email), 'Password updated');
    });

    $router->post("/api/store/{$slug}/auth/google", function (string $slug) {
        $m = storeBySlug($slug);
        if (!rateLimitCheck('store_google_ip_' . clientIp(), 30, 900)) {
            jsonResponse(errorResponse('Too many sign-in attempts. Try again shortly.', 429), 429);
        }
        $google = verifyGoogleCredential((string) body(getJsonBody(), 'credential', ''));
        if (!$google) {
            jsonResponse(errorResponse('Google sign-in failed. Try again.', 401), 401);
        }
        $c = Database::selectOne('SELECT * FROM `store_customers` WHERE `merchant_id` = :m AND `google_sub` = :s', ['m' => $m['id'], 's' => $google['sub']])
            ?? storeCustomer($m, $google['email']);
        if (!$c) {
            Database::insert('store_customers', ['merchant_id' => $m['id'], 'email' => $google['email'], 'google_sub' => $google['sub'], 'name' => $google['name'] ?: null]);
            auditLog('STORE_CUSTOMER_CREATED', ['merchant_id' => $m['id'], 'email' => $google['email'], 'method' => 'google']);
            sendStoreWelcome($m, $google['email']);
        } elseif (!$c['google_sub']) {
            Database::execute('UPDATE `store_customers` SET `google_sub` = :s WHERE `id` = :id', ['s' => $google['sub'], 'id' => $c['id']]);
        }
        storeSignedIn(storeCustomer($m, $google['email']), 'Signed in');
    });

    $router->get("/api/store/{$slug}/me", function (string $slug) {
        $m = storeBySlug($slug);
        $c = storeTokenCustomer($m);
        if (!$c) {
            jsonResponse(errorResponse('Sign in to continue', 401), 401);
        }
        ensureStoreOrderColumns();
        // The customer's orders on this store, newest first (status, amounts, and what to pay or send).
        $orders = Database::select(
            'SELECT `reference`, `type`, `status`, `channel`, `asset`, `amount`, `destination_amount`, `destination_currency`, `source_currency`, `deposit_bank_name`,
                    `deposit_account_number`, `deposit_account_name`, `deposit_address`, `deposit_note`, `wallet_address`, `hash`, `meta`, `beneficiary`, `rate`, `created_at`
             FROM `transactions`
             WHERE (`merchant_id` = :m AND `store_customer_id` = :c)
                OR (`merchant_id` = :m2 AND LOWER(`email`) = LOWER(:email))
             ORDER BY `id` DESC LIMIT 50',
            ['m' => $m['id'], 'c' => $c['id'], 'm2' => $m['id'], 'email' => $c['email']]
        );
        jsonResponse(successResponse(['customer' => storeCustomerView($c), 'orders' => array_map('storeCustomerOrderView', $orders)]));
    });

    // ─── The merchant's and admin's view of a store's customers ───

    $router->get('/api/merchant/customers', function () {
        $email = requireMerchantAuth();
        ensureStoreSchema();
        $m = merchantFor($email);
        $merchantId = (int) $m['id'];

        $rows = Database::select('SELECT * FROM `store_customers` WHERE `merchant_id` = :m ORDER BY `id` DESC LIMIT 500', ['m' => $merchantId]);
        // Orders and completed volume per customer, from the same rows as the Orders tab.
        $stats = [];
        foreach (merchantOrders($merchantId) as $o) {
            $s = &$stats[(int) $o['customer_id']];
            $s['orders'] = ($s['orders'] ?? 0) + 1;
            $s['volume_ngn'] = ($s['volume_ngn'] ?? 0) + ($o['status'] === 'COMPLETED' ? (float) $o['naira'] : 0);
            $s['last_order_at'] = max($s['last_order_at'] ?? '', (string) $o['created_at']);
            unset($s);
        }
        jsonResponse(successResponse([
            'customers' => array_map(static fn ($c) => storeCustomerView($c) + ($stats[(int) $c['id']] ?? []) + ['orders' => 0, 'volume_ngn' => 0, 'last_order_at' => null], $rows),
            'total' => count($rows),
        ]));
    });

    // Every order on the store, newest first, with what the merchant's markup earned on it.
    $router->get('/api/merchant/orders', function () {
        $email = requireMerchantAuth();
        ensureStoreSchema();
        $m = merchantFor($email);
        $orders = merchantOrders((int) $m['id']);
        $month = gmdate('Y-m');
        $summary = ['orders_month' => 0, 'volume_month_ngn' => 0.0, 'earned_month_ngn' => 0.0, 'earned_total_ngn' => 0.0];
        foreach ($orders as $o) {
            $thisMonth = str_starts_with((string) $o['created_at'], $month);
            $summary['orders_month'] += $thisMonth ? 1 : 0;
            if ($o['status'] === 'COMPLETED') {
                $summary['volume_month_ngn'] += $thisMonth ? (float) $o['naira'] : 0;
                $summary['earned_month_ngn'] += $thisMonth ? (float) $o['earned'] : 0;
                $summary['earned_total_ngn'] += (float) $o['earned'];
            }
        }
        jsonResponse(successResponse(['orders' => array_map(static fn ($o) => array_diff_key($o, ['customer_id' => 1]), $orders), 'summary' => $summary]));
    });

    $router->get('/api/admin/merchants/(\d+)/customers', function (string $id) {
        requireAdminAuth();
        ensureStoreSchema();
        $rows = Database::select(
            'SELECT `id`, `email`, `name`, `google_sub` IS NOT NULL AS `google`, `last_login_at`, `created_at` FROM `store_customers` WHERE `merchant_id` = :m ORDER BY `id` DESC LIMIT 1000',
            ['m' => (int) $id]
        );
        jsonResponse(['customers' => $rows]);
    });
}
