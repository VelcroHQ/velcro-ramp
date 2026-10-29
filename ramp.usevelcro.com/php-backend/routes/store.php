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
    $slug = strtolower(trim((string) body(getJsonBody(), 'store', '')));
    if ($slug === '') {
        return null;
    }
    $m = storeBySlug($slug);
    if ($m['status'] !== 'APPROVED') {
        jsonResponse(errorResponse('This store is not taking orders yet.'), 403);
    }
    $customer = storeTokenCustomer($m);
    if (!$customer) {
        jsonResponse(errorResponse('Sign in to continue', 401), 401);
    }
    $symbol = strtoupper($symbol);
    $p = merchantPricing($m)[$symbol] ?? null;
    if (!$p || empty($p[$side . '_on']) || (MERCHANT_COIN_PROVIDERS[$symbol] ?? '') !== $provider) {
        jsonResponse(errorResponse("This store isn't " . ($side === 'buy' ? 'selling' : 'buying') . " {$symbol} right now."), 400);
    }
    return ['merchant' => $m, 'customer' => $customer, 'markup' => (float) $p[$side]];
}

/** Columns that tag a store order. */
function storeOrderFields(?array $ctx, float $velcroFee): array
{
    return $ctx ? [
        'merchant_id' => (int) $ctx['merchant']['id'],
        'store_customer_id' => (int) $ctx['customer']['id'],
        'merchant_markup_percent' => $ctx['markup'],
        'velcro_fee_percent' => $velcroFee,
    ] : [];
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

function storeCustomerView(array $c): array
{
    return ['email' => $c['email'], 'name' => $c['name'], 'since' => $c['created_at']];
}

function sendStoreWelcome(array $m, string $email): void
{
    $brand = storeBranding($m);
    runAfterResponse(static fn () => storeMail($m, $email, 'Welcome to ' . $brand['name'], [
        'preheader' => 'Buy and sell crypto with naira.',
        'eyebrow' => $brand['name'],
        'title' => 'Welcome to ' . $brand['name'],
        'intro' => 'Your account is ready. Buy BTC, ETH, SOL, USDT or USDC by bank transfer, or sell and get paid straight to your bank. Every order is tracked live and you get a receipt by email.',
        'cta' => ['Open ' . $brand['name'], EMAIL_SITE_URL . '/m/' . $m['slug']],
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
        // The customer's orders on this store, newest first (status, amounts, and what to pay or send).
        $orders = Database::select(
            'SELECT `reference`, `type`, `status`, `asset`, `amount`, `destination_amount`, `destination_currency`, `source_currency`, `deposit_bank_name`,
                    `deposit_account_number`, `deposit_account_name`, `deposit_address`, `wallet_address`, `hash`, `created_at`
             FROM `transactions` WHERE `merchant_id` = :m AND `store_customer_id` = :c ORDER BY `id` DESC LIMIT 50',
            ['m' => $m['id'], 'c' => $c['id']]
        );
        jsonResponse(successResponse(['customer' => storeCustomerView($c), 'orders' => $orders]));
    });

    // ─── The merchant's and admin's view of a store's customers ───

    $router->get('/api/merchant/customers', function () {
        $email = requireMerchantAuth();
        ensureStoreSchema();
        $m = merchantFor($email);
        $rows = Database::select('SELECT * FROM `store_customers` WHERE `merchant_id` = :m ORDER BY `id` DESC LIMIT 500', ['m' => $m['id']]);
        jsonResponse(successResponse(['customers' => array_map('storeCustomerView', $rows), 'total' => count($rows)]));
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
