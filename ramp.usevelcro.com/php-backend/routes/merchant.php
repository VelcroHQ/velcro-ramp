<?php

declare(strict_types=1);

/**
 * Velcro Merchant: a branded storefront (ramp.usevelcro.com/m/{slug}, later {slug}.usevelcro.com)
 * that runs on Velcro's rails with the merchant's name, logo, colour and markup. Signing up gives a
 * DRAFT store straight away; branding and prices can be set any time, and the store goes live once
 * Velcro approves the merchant's business verification (KYB). Merchants never hold customer funds
 * and verify their own customers.
 */

const MERCHANT_STATUSES = ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'];
const MERCHANT_COINS = ['BTC' => 'Bitcoin', 'ETH' => 'Ethereum', 'SOL' => 'Solana', 'USDT' => 'Tether', 'USDC' => 'USD Coin'];
const MERCHANT_DEFAULT_MARKUP = 1.0; // % on top of Velcro's price, each side
const MERCHANT_MAX_MARKUP = 5.0;
const MERCHANT_DEFAULT_COLOR = '#a8cf45';
const MERCHANT_LOGO_MAX_BYTES = 400 * 1024;
// Which provider prices and fills each coin on merchant stores.
const MERCHANT_COIN_PROVIDERS = ['BTC' => 'hostfi', 'ETH' => 'hostfi', 'SOL' => 'paj', 'USDT' => 'switch', 'USDC' => 'switch'];
// How a store shows its rate: the final rate only, or Velcro's rate plus the merchant's markup.
const MERCHANT_RATE_DISPLAYS = ['final', 'breakdown'];
const MERCHANT_BUSINESS_TYPES = ['individual' => 'Individual / sole trader', 'registered' => 'Registered business'];
const MERCHANT_VOLUMES = ['under_1m' => 'Under ₦1M', '1m_10m' => '₦1M – ₦10M', '10m_50m' => '₦10M – ₦50M', 'over_50m' => 'Over ₦50M'];

// Storefront names that would clash with our own addresses or pose as Velcro, banks or exchanges.
const MERCHANT_RESERVED_SLUGS = [
    'www', 'api', 'app', 'admin', 'goat', 'ramp', 'mail', 'email', 'smtp', 'ftp', 'cpanel', 'webmail', 'merchant',
    'merchants', 'm', 'store', 'shop', 'support', 'help', 'docs', 'status', 'blog', 'dev', 'test', 'staging',
    'web', 'whatsapp', 'login', 'signup', 'account', 'dashboard', 'pay', 'checkout', 'static', 'assets', 'cdn',
];
const MERCHANT_BLOCKED_WORDS = [
    'velcro', 'official', 'binance', 'bybit', 'okx', 'kucoin', 'coinbase', 'luno', 'quidax', 'yellowcard', 'busha',
    'roqqu', 'paxful', 'opay', 'palmpay', 'kuda', 'moniepoint', 'paystack', 'flutterwave', 'hostfi', 'gtbank', 'zenith',
    'firstbank', 'accessbank', 'ubabank', 'cbn', 'efcc', 'verify', 'secure', 'wallet', 'airdrop', 'giveaway',
];

/** Creates the merchants table on first use, so deploys need no manual SQL. */
function ensureMerchantSchema(): void
{
    static $done = false;
    $flag = BASE_PATH . '/data/.merchant_schema_v1';
    if ($done || file_exists($flag)) {
        $done = true;
        return;
    }
    Database::pdo()->exec("CREATE TABLE IF NOT EXISTS `merchants` (
        `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `email` VARCHAR(255) NOT NULL UNIQUE,
        `slug` VARCHAR(30) DEFAULT NULL UNIQUE,
        `status` VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
        `business_name` VARCHAR(120) DEFAULT NULL,
        `business_type` VARCHAR(20) DEFAULT NULL,
        `registration_number` VARCHAR(40) DEFAULT NULL,
        `contact_name` VARCHAR(120) DEFAULT NULL,
        `phone` VARCHAR(30) DEFAULT NULL,
        `website` VARCHAR(255) DEFAULT NULL,
        `monthly_volume` VARCHAR(20) DEFAULT NULL,
        `description` VARCHAR(1000) DEFAULT NULL,
        `brand` TEXT DEFAULT NULL,
        `pricing` TEXT DEFAULT NULL,
        `terms_accepted_at` DATETIME DEFAULT NULL,
        `terms_ip` VARCHAR(64) DEFAULT NULL,
        `review_note` VARCHAR(500) DEFAULT NULL,
        `reviewed_at` DATETIME DEFAULT NULL,
        `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
        `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY `idx_status` (`status`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    // Sign-in, separate from the store: an account exists before it applies for a store.
    Database::pdo()->exec("CREATE TABLE IF NOT EXISTS `merchant_accounts` (
        `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `email` VARCHAR(255) NOT NULL UNIQUE,
        `password_hash` VARCHAR(255) DEFAULT NULL,
        `google_sub` VARCHAR(64) DEFAULT NULL UNIQUE,
        `name` VARCHAR(120) DEFAULT NULL,
        `token_version` INT NOT NULL DEFAULT 1,
        `last_login_at` DATETIME DEFAULT NULL,
        `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    @file_put_contents($flag, gmdate('c'));
    $done = true;
}

function merchantByEmail(string $email): ?array
{
    return Database::selectOne('SELECT * FROM `merchants` WHERE `email` = :e', ['e' => strtolower(trim($email))]);
}

/** Why a storefront name can't be used, or null if it's fine. Doesn't check whether it's taken. */
function merchantSlugProblem(string $slug): ?string
{
    if (!preg_match('/^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/', $slug) || str_contains($slug, '--')) {
        return 'Use 3–30 lowercase letters, numbers or single hyphens, starting and ending with a letter or number';
    }
    if (in_array($slug, MERCHANT_RESERVED_SLUGS, true)) {
        return 'That name is reserved';
    }
    $plain = str_replace('-', '', $slug);
    foreach (MERCHANT_BLOCKED_WORDS as $word) {
        if (str_contains($plain, $word)) {
            return 'That name can’t be used. Pick one that’s clearly your own brand';
        }
    }
    return null;
}

/** The merchant's store, created as a DRAFT the first time it's needed. */
function merchantFor(string $email): array
{
    $email = strtolower(trim($email));
    $m = merchantByEmail($email);
    if (!$m) {
        try {
            Database::insert('merchants', ['email' => $email, 'status' => 'DRAFT']);
        } catch (PDOException $e) {
            // created by a parallel request
        }
        $m = merchantByEmail($email);
    }
    return $m;
}

/** Store name, colour and logo, with defaults filled in. */
function merchantBrand(array $m): array
{
    $b = json_decode((string) ($m['brand'] ?? ''), true) ?: [];
    return [
        'name' => (string) ($b['name'] ?? ($m['business_name'] ?? '')),
        'color' => preg_match('/^#[0-9a-f]{6}$/i', (string) ($b['color'] ?? '')) ? strtolower($b['color']) : MERCHANT_DEFAULT_COLOR,
        'logo' => $b['logo'] ?? null,
    ];
}

/** Markup % and on/off switch per coin and side, with defaults filled in. */
function merchantPricing(array $m): array
{
    $saved = json_decode((string) ($m['pricing'] ?? ''), true) ?: [];
    $out = [];
    foreach (array_keys(MERCHANT_COINS) as $sym) {
        $c = (array) ($saved[$sym] ?? []);
        $out[$sym] = [
            'buy' => isset($c['buy']) ? (float) $c['buy'] : MERCHANT_DEFAULT_MARKUP,
            'sell' => isset($c['sell']) ? (float) $c['sell'] : MERCHANT_DEFAULT_MARKUP,
            'buy_on' => (bool) ($c['buy_on'] ?? true),
            'sell_on' => (bool) ($c['sell_on'] ?? true),
        ];
    }
    return $out;
}

/** How the store shows rates to customers ('final' or 'breakdown'). */
function merchantRateDisplay(array $m): string
{
    $saved = json_decode((string) ($m['pricing'] ?? ''), true) ?: [];
    return in_array($saved['_display'] ?? '', MERCHANT_RATE_DISPLAYS, true) ? $saved['_display'] : 'final';
}

/**
 * Velcro's own customer rate per coin as naira per $1, Velcro's fee included, from the provider
 * that fills that coin on merchant stores. 'buy' is what a customer pays per $1, 'sell' what they
 * get per $1. Null where the provider can't quote right now. Cached for a minute.
 *
 * @return array<string,array{provider:string,buy:?float,sell:?float}>
 */
function merchantVelcroRates(): array
{
    $file = BASE_PATH . '/data/.merchant_rates.json';
    $cached = is_file($file) ? json_decode((string) @file_get_contents($file), true) : null;
    if (is_array($cached) && ($cached['at'] ?? 0) > time() - 60 && !empty($cached['rates'])) {
        return $cached['rates'];
    }
    $out = [];
    foreach (MERCHANT_COIN_PROVIDERS as $sym => $provider) {
        $buy = $sell = null;
        try {
            if ($provider === 'hostfi') {
                // Same maths as a HostFi order: buys swap paid × (1 − fee), sells pay out swapped × (1 − fee).
                $q = hostfiQuote($sym);
                $fee = hostfiFee() / 100;
                if ($q['ngn_per_unit'] > 0 && $q['usd_per_unit'] > 0) {
                    $perUsd = $q['ngn_per_unit'] / $q['usd_per_unit'];
                    [$buy, $sell] = [$perUsd / (1 - $fee), $perUsd * (1 - $fee)];
                }
            } elseif ($provider === 'paj') {
                // PAJ's $ rates with Velcro's margin, then Velcro's fee (taken from what the customer receives).
                $r = pajApi()->getPajRate();
                $margin = getPajRateMargin();
                $fee = getPajFee() / 100;
                $on = (float) ($r['onramp']['rate'] ?? 0);
                $off = (float) ($r['offramp']['rate'] ?? 0);
                $buy = $on > 0 ? ($on + $margin) / (1 - $fee) : null;
                $sell = $off > 0 ? ($off - $margin) * (1 - $fee) : null;
            } else {
                // Switch quotes per direction already include Velcro's developer fee.
                $assets = json_decode((string) @file_get_contents(BASE_PATH . '/data/switch_assets_cache.json'), true) ?: [];
                foreach (['ONRAMP' => 'onramp', 'OFFRAMP' => 'offramp'] as $dir => $key) {
                    $chains = (array) ($assets[$key][$sym]['chains'] ?? []);
                    $chain = array_values(array_intersect(['solana', 'base', 'tron', 'bsc', 'polygon', 'ethereum'], $chains))[0] ?? ($chains[0] ?? 'solana');
                    $res = switchApi()->getRate(['direction' => $dir, 'country' => 'NG', 'currency' => 'NGN', 'channel' => 'BANK', 'asset' => $chain . ':' . strtolower($sym)]);
                    $rate = (float) ($res['data']['rate'] ?? 0);
                    if ($rate > 0) {
                        $dir === 'ONRAMP' ? $buy = $rate : $sell = $rate;
                    }
                }
            }
        } catch (Throwable $e) {
            error_log("[Merchant] {$sym} rate via {$provider} unavailable: " . $e->getMessage());
        }
        $out[$sym] = ['provider' => $provider, 'buy' => $buy ? round($buy, 2) : null, 'sell' => $sell ? round($sell, 2) : null];
    }
    if (array_filter(array_column($out, 'buy')) || array_filter(array_column($out, 'sell'))) {
        @file_put_contents($file, json_encode(['at' => time(), 'rates' => $out]), LOCK_EX);
    }
    return $out;
}

/** A customer's rate per $1 at a store: Velcro's rate with the merchant's markup on top. */
function merchantCustomerRate(?float $velcro, float $markup, string $side): ?float
{
    if (!$velcro) {
        return null;
    }
    return round($side === 'buy' ? $velcro * (1 + $markup / 100) : $velcro * (1 - $markup / 100), 2);
}

/** The merchant's own dashboard view: no internal review details beyond the note. */
function merchantView(array $m): array
{
    $brand = merchantBrand($m);
    return [
        'email' => $m['email'],
        'slug' => $m['slug'],
        'status' => $m['status'],
        'business_name' => $m['business_name'],
        'business_type' => $m['business_type'],
        'registration_number' => $m['registration_number'],
        'contact_name' => $m['contact_name'],
        'phone' => $m['phone'],
        'website' => $m['website'],
        'monthly_volume' => $m['monthly_volume'],
        'description' => $m['description'],
        'review_note' => in_array($m['status'], ['REJECTED', 'SUSPENDED'], true) ? $m['review_note'] : null,
        'brand' => $brand,
        'pricing' => merchantPricing($m),
        'rate_display' => merchantRateDisplay($m),
        'storefront_url' => $m['slug'] ? EMAIL_SITE_URL . '/m/' . $m['slug'] : null,
        // What's left before the store can go live, for the dashboard checklist.
        'checklist' => [
            'branded' => $m['slug'] !== null && $brand['name'] !== '',
            'priced' => ($m['pricing'] ?? null) !== null,
            'verified' => $m['status'] === 'APPROVED',
        ],
        'created_at' => $m['created_at'],
    ];
}

/** Where uploaded logos live and their public URL prefix (document root /merchant/logos/). */
function merchantLogoDir(): array
{
    $dir = (string) env('MERCHANT_LOGO_DIR', dirname(BASE_PATH) . '/merchant/logos');
    return [$dir, '/merchant/logos/'];
}

/**
 * Saves a logo sent as a data URL (PNG, JPEG or WebP, checked by decoding it, never SVG) and
 * returns its public URL. Throws with a message for the merchant if it isn't acceptable.
 */
function merchantSaveLogo(int $id, string $dataUrl): string
{
    if (!preg_match('#^data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$#', $dataUrl, $mm)) {
        throw new InvalidArgumentException('Upload a PNG, JPG or WebP image');
    }
    $bytes = base64_decode($mm[2], true);
    if ($bytes === false || strlen($bytes) > MERCHANT_LOGO_MAX_BYTES) {
        throw new InvalidArgumentException('Logos can be up to 400 KB');
    }
    $info = @getimagesizefromstring($bytes);
    $types = [IMAGETYPE_PNG => 'png', IMAGETYPE_JPEG => 'jpg', IMAGETYPE_WEBP => 'webp'];
    if (!$info || !isset($types[$info[2]]) || $info[0] < 32 || $info[1] < 32 || $info[0] > 2000 || $info[1] > 2000) {
        throw new InvalidArgumentException('That image couldn’t be read. Use a square PNG or JPG, at least 32×32');
    }
    [$dir, $url] = merchantLogoDir();
    if (!is_dir($dir) && !@mkdir($dir, 0755, true)) {
        throw new RuntimeException('Logo storage is unavailable');
    }
    $name = $id . '-' . bin2hex(random_bytes(6)) . '.' . $types[$info[2]];
    if (@file_put_contents($dir . '/' . $name, $bytes) === false) {
        throw new RuntimeException('Logo storage is unavailable');
    }
    return $url . $name;
}

/** Removes a logo this store uploaded (only files in the logo folder, by name). */
function merchantDeleteLogo(?string $url): void
{
    [$dir, $prefix] = merchantLogoDir();
    if ($url && str_starts_with($url, $prefix) && preg_match('/^\d+-[0-9a-f]{12}\.(png|jpg|webp)$/', substr($url, strlen($prefix)))) {
        $file = $dir . '/' . substr($url, strlen($prefix));
        // A file just written can be briefly locked (e.g. by a virus scanner on Windows): retry.
        for ($i = 0; $i < 5 && is_file($file) && !@unlink($file); $i++) {
            usleep(100000);
        }
    }
}

// ─── Sign-in ───
// Email + password (the email proven with a code at sign-up), or Google. A signed token carries
// the account's token_version, so a password reset signs out every other session.

const MERCHANT_MIN_PASSWORD = 8;

function merchantAccount(string $email): ?array
{
    return Database::selectOne('SELECT * FROM `merchant_accounts` WHERE `email` = :e', ['e' => strtolower(trim($email))]);
}

function issueMerchantToken(array $account): string
{
    Database::execute('UPDATE `merchant_accounts` SET `last_login_at` = :t WHERE `id` = :id', ['t' => gmdate('Y-m-d H:i:s'), 'id' => $account['id']]);
    $payload = 'merchant|' . $account['email'] . '|' . (time() + 30 * 86400) . '|' . (int) $account['token_version'];
    return rtrim(strtr(base64_encode($payload), '+/', '-_'), '=') . '.' . hash_hmac('sha256', $payload, appKey());
}

/** The account a token belongs to, or null if it's forged, expired or signed out by a reset. */
function merchantTokenAccount(string $token): ?array
{
    [$b64, $sig] = array_pad(explode('.', $token, 2), 2, '');
    $payload = base64_decode(strtr($b64, '-_', '+/'), true);
    if ($payload === false || !hash_equals(hash_hmac('sha256', $payload, appKey()), $sig)) {
        return null;
    }
    [$scope, $email, $exp, $ver] = array_pad(explode('|', $payload, 4), 4, '');
    if ($scope !== 'merchant' || (int) $exp <= time()) {
        return null;
    }
    ensureMerchantSchema();
    $account = merchantAccount($email);
    return $account && (int) $account['token_version'] === (int) $ver ? $account : null;
}

function merchantTokenEmail(string $token): ?string
{
    return merchantTokenAccount($token)['email'] ?? null;
}

/** The signed-in merchant's email (X-Merchant-Token). Ends the request with 401 otherwise. */
function requireMerchantAuth(): string
{
    $email = merchantTokenEmail((string) ($_SERVER['HTTP_X_MERCHANT_TOKEN'] ?? ''));
    if ($email === null) {
        jsonResponse(errorResponse('Sign in to continue', 401), 401);
    }
    return $email;
}

function merchantPasswordProblem(string $password): ?string
{
    if (strlen($password) < MERCHANT_MIN_PASSWORD || strlen($password) > 128) {
        return 'Use at least ' . MERCHANT_MIN_PASSWORD . ' characters for your password';
    }
    if (!preg_match('/[A-Za-z]/', $password) || !preg_match('/[0-9]/', $password)) {
        return 'Use letters and numbers in your password';
    }
    return null;
}

/** Signed-in response: the token plus who it's for. */
function merchantSignedIn(array $account, string $message): never
{
    jsonResponse(successResponse(['token' => issueMerchantToken($account), 'email' => $account['email']], $message));
}

/**
 * Google's verdict on a Sign in with Google credential (an ID token), checked by Google itself
 * against our client ID. Null if it's not valid for us.
 *
 * @return array{sub:string,email:string,name:string}|null
 */
function verifyGoogleCredential(string $credential): ?array
{
    if (GOOGLE_CLIENT_ID === '' || !preg_match('/^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/', $credential)) {
        return null;
    }
    try {
        $info = httpRequest('GET', 'https://oauth2.googleapis.com/tokeninfo?id_token=' . rawurlencode($credential), ['timeout' => 10]);
    } catch (Throwable $e) {
        return null;
    }
    $ok = ($info['aud'] ?? '') === GOOGLE_CLIENT_ID
        && in_array($info['iss'] ?? '', ['accounts.google.com', 'https://accounts.google.com'], true)
        && (int) ($info['exp'] ?? 0) > time()
        && in_array($info['email_verified'] ?? false, [true, 'true'], true)
        && isValidEmail((string) ($info['email'] ?? ''))
        && (string) ($info['sub'] ?? '') !== '';
    return $ok ? ['sub' => (string) $info['sub'], 'email' => strtolower((string) $info['email']), 'name' => (string) ($info['name'] ?? '')] : null;
}

/** Plain-text field from the body, trimmed and capped. */
function merchantField(array $b, string $key, int $max): string
{
    return mb_substr(trim(preg_replace('/\s+/u', ' ', (string) body($b, $key, '')) ?? ''), 0, $max);
}

/** Sends one merchant email; failures are logged and audited, never thrown. */
function merchantMail(string $to, string $subject, array $email, string $kind): bool
{
    if (!mailConfigured()) {
        return false;
    }
    try {
        [$html, $text] = renderEmail($email);
        $sent = (bool) @sendEmailTo($to, $subject, $html, $text);
    } catch (Throwable $e) {
        error_log("[Merchant] {$kind} email to {$to} failed: " . $e->getMessage());
        $sent = false;
    }
    if (!$sent) {
        auditLog('MERCHANT_EMAIL_FAILED', ['to' => $to, 'kind' => $kind]);
    }
    return $sent;
}

/** Approved / rejected / suspended. Returns whether the email went out. */
function notifyMerchantStatus(array $m): bool
{
    $name = (string) (merchantBrand($m)['name'] ?: $m['business_name']);
    $url = EMAIL_SITE_URL . '/m/' . $m['slug'];
    $copy = [
        'APPROVED' => ['Your Velcro Merchant store is approved', "Good news: {$name} is verified. Your store link is ready to share, and your customers will be able to trade on it as soon as it opens.", 'Open your dashboard'],
        'REJECTED' => ['We need a few changes to your Velcro Merchant store', "We couldn't verify {$name} yet. Update your business details in Settings and resubmit, and we'll take another look.", 'Fix my details'],
        'SUSPENDED' => ['Your Velcro Merchant store is suspended', "{$name} has been suspended and your store is offline. Reply to this email or contact support if you think this is a mistake.", 'View details'],
    ][$m['status']] ?? null;
    if (!$copy) {
        return false;
    }
    return merchantMail((string) $m['email'], $copy[0], [
        'preheader' => $copy[1],
        'eyebrow' => 'Velcro Merchant',
        'title' => $copy[0],
        'intro' => $copy[1] . ((string) $m['review_note'] !== '' && $m['status'] !== 'APPROVED' ? ' Reason: ' . $m['review_note'] : ''),
        'rows' => [['Store', $name], ['Store address', $url, true]],
        'cta' => [$copy[2], EMAIL_SITE_URL . '/merchant/'],
    ], 'status ' . $m['status']);
}

/** Welcome, once, when a merchant account is created. */
function sendMerchantWelcome(string $email): void
{
    runAfterResponse(static fn () => merchantMail($email, 'Welcome to Velcro Merchant', [
        'preheader' => 'Set up your store in a few minutes.',
        'eyebrow' => 'Velcro Merchant',
        'title' => 'Welcome to Velcro Merchant',
        'intro' => 'Your account is ready. Three steps to your first sale: personalize your store (name, address, logo and colours), set your markup on each coin, and verify your business so your store can go live.',
        'cta' => ['Open your dashboard', EMAIL_SITE_URL . '/merchant/'],
        'outro' => "If you didn't create this account, reply to this email and we'll close it.",
    ], 'welcome'), 'Merchant welcome email');
}

function registerMerchantRoutes(Router $router): void
{
    $router->get('/api/merchant/config', function () {
        jsonResponse(successResponse(['google_client_id' => GOOGLE_CLIENT_ID !== '' ? GOOGLE_CLIENT_ID : null]));
    });

    // Sign-up step 1: prove the email with a code.
    $router->post('/api/merchant/auth/signup/code', function () {
        $email = referralEmailFrom(body(getJsonBody(), 'email'));
        if (!rateLimitCheck('merch_code_' . $email, 5, 3600) || !rateLimitCheck('merch_code_ip_' . clientIp(), 20, 3600)) {
            jsonResponse(errorResponse('Too many code requests. Try again in an hour.', 429), 429);
        }
        ensureMerchantSchema();
        $account = merchantAccount($email);
        if ($account && $account['password_hash']) {
            jsonResponse(errorResponse('You already have an account. Sign in instead.'), 409);
        }
        try {
            sendReferralCode($email, referralOtpKey('merchsignup', $email), 'Confirm your Velcro Merchant email', 'Use this code to finish creating your Velcro Merchant account:');
            jsonResponse(successResponse(['sent' => true], 'Code sent to ' . $email));
        } catch (Throwable $e) {
            jsonResponse(errorResponse(publicError($e)), 500);
        }
    });

    // Sign-up step 2: code + password. A Google-only account can add a password the same way.
    $router->post('/api/merchant/auth/signup', function () {
        $b = getJsonBody();
        $email = referralEmailFrom(body($b, 'email'));
        $password = (string) body($b, 'password', '');
        if (($problem = merchantPasswordProblem($password)) !== null) {
            jsonResponse(errorResponse($problem), 400);
        }
        ensureMerchantSchema();
        $check = verifyOTP(referralOtpKey('merchsignup', $email), (string) body($b, 'otp', ''));
        if (!$check['valid']) {
            jsonResponse(errorResponse($check['reason']), 403);
        }
        $account = merchantAccount($email);
        if ($account && $account['password_hash']) {
            jsonResponse(errorResponse('You already have an account. Sign in instead.'), 409);
        }
        $hash = password_hash($password, PASSWORD_DEFAULT);
        $name = mb_substr(trim((string) body($b, 'name', '')), 0, 120);
        if ($account) {
            Database::execute('UPDATE `merchant_accounts` SET `password_hash` = :h WHERE `id` = :id', ['h' => $hash, 'id' => $account['id']]);
        } else {
            Database::insert('merchant_accounts', ['email' => $email, 'password_hash' => $hash, 'name' => $name !== '' ? $name : null]);
        }
        auditLog('MERCHANT_ACCOUNT_CREATED', ['email' => $email, 'method' => 'password']);
        if (!$account) {
            sendMerchantWelcome($email);
        }
        merchantSignedIn(merchantAccount($email), 'Account created');
    });

    $router->post('/api/merchant/auth/login', function () {
        $b = getJsonBody();
        $email = referralEmailFrom(body($b, 'email'));
        // Per account and per IP, so neither one password nor many accounts can be guessed at speed.
        if (!rateLimitCheck('merch_login_' . $email, 10, 900) || !rateLimitCheck('merch_login_ip_' . clientIp(), 30, 900)) {
            jsonResponse(errorResponse('Too many sign-in attempts. Try again in 15 minutes.', 429), 429);
        }
        ensureMerchantSchema();
        $account = merchantAccount($email);
        $ok = $account && $account['password_hash'] && password_verify((string) body($b, 'password', ''), $account['password_hash']);
        if (!$ok) {
            if ($account && !$account['password_hash'] && $account['google_sub']) {
                jsonResponse(errorResponse('This account uses Google. Continue with Google, or set a password with "Forgot password".', 401), 401);
            }
            jsonResponse(errorResponse('Wrong email or password', 401), 401);
        }
        if (password_needs_rehash($account['password_hash'], PASSWORD_DEFAULT)) {
            Database::execute('UPDATE `merchant_accounts` SET `password_hash` = :h WHERE `id` = :id', ['h' => password_hash((string) body($b, 'password', ''), PASSWORD_DEFAULT), 'id' => $account['id']]);
        }
        merchantSignedIn($account, 'Signed in');
    });

    // Same answer whether or not the account exists, so this can't be used to find merchants' emails.
    $router->post('/api/merchant/auth/reset/code', function () {
        $email = referralEmailFrom(body(getJsonBody(), 'email'));
        if (!rateLimitCheck('merch_reset_' . $email, 5, 3600) || !rateLimitCheck('merch_reset_ip_' . clientIp(), 20, 3600)) {
            jsonResponse(errorResponse('Too many code requests. Try again in an hour.', 429), 429);
        }
        ensureMerchantSchema();
        if (merchantAccount($email)) {
            try {
                sendReferralCode($email, referralOtpKey('merchreset', $email), 'Reset your Velcro Merchant password', 'Use this code to set a new password:');
            } catch (Throwable $e) {
                jsonResponse(errorResponse(publicError($e)), 500);
            }
        }
        jsonResponse(successResponse(['sent' => true], 'If that email has an account, a code is on its way'));
    });

    $router->post('/api/merchant/auth/reset', function () {
        $b = getJsonBody();
        $email = referralEmailFrom(body($b, 'email'));
        $password = (string) body($b, 'password', '');
        if (($problem = merchantPasswordProblem($password)) !== null) {
            jsonResponse(errorResponse($problem), 400);
        }
        ensureMerchantSchema();
        $check = verifyOTP(referralOtpKey('merchreset', $email), (string) body($b, 'otp', ''));
        $account = merchantAccount($email);
        if (!$check['valid'] || !$account) {
            jsonResponse(errorResponse($check['valid'] ? 'Invalid code' : $check['reason']), 403);
        }
        // token_version + 1 signs out every other session.
        Database::execute(
            'UPDATE `merchant_accounts` SET `password_hash` = :h, `token_version` = `token_version` + 1 WHERE `id` = :id',
            ['h' => password_hash($password, PASSWORD_DEFAULT), 'id' => $account['id']]
        );
        auditLog('MERCHANT_PASSWORD_RESET', ['email' => $email]);
        runAfterResponse(static fn () => merchantMail($email, 'Your Velcro Merchant password was changed', [
            'eyebrow' => 'Security',
            'title' => 'Your password was changed',
            'intro' => 'The password for your Velcro Merchant account was just changed, and every other session was signed out.',
            'outro' => "If this wasn't you, reset your password now and reply to this email so we can help.",
            'cta' => ['Open Velcro Merchant', EMAIL_SITE_URL . '/merchant/'],
        ], 'password changed'), 'Merchant password email');
        merchantSignedIn(merchantAccount($email), 'Password updated');
    });

    $router->post('/api/merchant/auth/google', function () {
        if (!rateLimitCheck('merch_google_ip_' . clientIp(), 30, 900)) {
            jsonResponse(errorResponse('Too many sign-in attempts. Try again shortly.', 429), 429);
        }
        $google = verifyGoogleCredential((string) body(getJsonBody(), 'credential', ''));
        if (!$google) {
            jsonResponse(errorResponse('Google sign-in failed. Try again.', 401), 401);
        }
        ensureMerchantSchema();
        $account = Database::selectOne('SELECT * FROM `merchant_accounts` WHERE `google_sub` = :s', ['s' => $google['sub']])
            ?? merchantAccount($google['email']);
        if (!$account) {
            Database::insert('merchant_accounts', ['email' => $google['email'], 'google_sub' => $google['sub'], 'name' => $google['name'] ?: null]);
            auditLog('MERCHANT_ACCOUNT_CREATED', ['email' => $google['email'], 'method' => 'google']);
            sendMerchantWelcome($google['email']);
        } elseif (!$account['google_sub']) {
            // Google has verified this address, so linking it to the existing account is safe.
            Database::execute('UPDATE `merchant_accounts` SET `google_sub` = :s WHERE `id` = :id', ['s' => $google['sub'], 'id' => $account['id']]);
        }
        $account = Database::selectOne('SELECT * FROM `merchant_accounts` WHERE `google_sub` = :s', ['s' => $google['sub']]);
        merchantSignedIn($account, 'Signed in');
    });

    $router->get('/api/merchant/me', function () {
        $email = requireMerchantAuth();
        ensureMerchantSchema();
        $account = merchantAccount($email);
        jsonResponse(successResponse([
            'email' => $email,
            'name' => $account['name'] ?? null,
            'merchant' => merchantView(merchantFor($email)),
            'coins' => MERCHANT_COINS,
            'max_markup' => MERCHANT_MAX_MARKUP,
            'business_types' => MERCHANT_BUSINESS_TYPES,
            'volumes' => MERCHANT_VOLUMES,
        ]));
    });

    // Velcro's own naira price per coin (before any markup), for the pricing screen.
    // Velcro's rate per $1 for each coin (our fee included), for the pricing screen.
    $router->get('/api/merchant/prices', function () {
        requireMerchantAuth();
        jsonResponse(successResponse(['rates' => merchantVelcroRates()]));
    });

    // Store name, address, colour and logo. The address is fixed once the store is approved.
    $router->post('/api/merchant/brand', function () {
        $email = requireMerchantAuth();
        $b = getJsonBody();
        if (!rateLimitCheck('merch_brand_' . $email, 30, 3600)) {
            jsonResponse(errorResponse('Too many updates. Try again later.', 429), 429);
        }
        ensureMerchantSchema();
        $m = merchantFor($email);
        $brand = merchantBrand($m);
        $name = merchantField($b, 'name', 60);
        $slug = strtolower(trim((string) body($b, 'slug', '')));
        $color = strtolower(trim((string) body($b, 'color', $brand['color'])));
        $locked = in_array($m['status'], ['APPROVED', 'SUSPENDED'], true) && $m['slug'];
        $problem = match (true) {
            mb_strlen($name) < 2 => 'Enter your store name',
            !preg_match('/^#[0-9a-f]{6}$/', $color) => 'Pick a valid colour',
            $locked && $slug !== $m['slug'] => 'Your store address can’t change after approval',
            default => merchantSlugProblem($slug),
        };
        if ($problem !== null) {
            jsonResponse(errorResponse($problem), 400);
        }
        $logo = $brand['logo'];
        try {
            if (body($b, 'remove_logo')) {
                $logo = null;
            } elseif (($data = (string) body($b, 'logo', '')) !== '') {
                $logo = merchantSaveLogo((int) $m['id'], $data);
            }
        } catch (InvalidArgumentException $e) {
            jsonResponse(errorResponse($e->getMessage()), 400);
        }
        try {
            Database::execute('UPDATE `merchants` SET `slug` = :s, `brand` = :b WHERE `id` = :id', [
                's' => $slug,
                'b' => json_encode(['name' => $name, 'color' => $color, 'logo' => $logo]),
                'id' => $m['id'],
            ]);
        } catch (PDOException $e) {
            if ($logo !== $brand['logo']) {
                merchantDeleteLogo($logo);
            }
            jsonResponse(errorResponse('That store address is taken. Pick another.'), 409);
        }
        if ($logo !== $brand['logo']) {
            merchantDeleteLogo($brand['logo']);
        }
        jsonResponse(successResponse(merchantView(merchantByEmail($email)), 'Store updated'));
    });

    // Markup % per coin and side (0–MERCHANT_MAX_MARKUP), and which ones are switched on.
    $router->post('/api/merchant/pricing', function () {
        $email = requireMerchantAuth();
        $b = getJsonBody();
        $coins = (array) body($b, 'coins', []);
        $display = (string) body($b, 'display', '');
        if ($display !== '' && !in_array($display, MERCHANT_RATE_DISPLAYS, true)) {
            jsonResponse(errorResponse('Unknown rate display'), 400);
        }
        ensureMerchantSchema();
        $m = merchantFor($email);
        $pricing = merchantPricing($m);
        foreach ($coins as $sym => $c) {
            if (!isset($pricing[$sym]) || !is_array($c)) {
                jsonResponse(errorResponse('Unknown coin ' . $sym), 400);
            }
            foreach (['buy', 'sell'] as $side) {
                if (array_key_exists($side, $c)) {
                    $v = $c[$side];
                    if (!is_numeric($v) || $v < 0 || $v > MERCHANT_MAX_MARKUP) {
                        jsonResponse(errorResponse('Markup must be between 0% and ' . MERCHANT_MAX_MARKUP . '%'), 400);
                    }
                    $pricing[$sym][$side] = round((float) $v, 2);
                }
                if (array_key_exists($side . '_on', $c)) {
                    $pricing[$sym][$side . '_on'] = (bool) $c[$side . '_on'];
                }
            }
        }
        $pricing['_display'] = $display !== '' ? $display : merchantRateDisplay($m);
        Database::execute('UPDATE `merchants` SET `pricing` = :p WHERE `id` = :id', ['p' => json_encode($pricing), 'id' => $m['id']]);
        jsonResponse(successResponse(merchantView(merchantByEmail($email)), 'Prices saved'));
    });

    $router->get('/api/merchant/slug-check', function () {
        $slug = strtolower(trim((string) query('slug', '')));
        if (!rateLimitCheck('merch_slug_ip_' . clientIp(), 120, 600)) {
            jsonResponse(errorResponse('Too many checks. Slow down a little.', 429), 429);
        }
        ensureMerchantSchema();
        $problem = merchantSlugProblem($slug);
        if ($problem === null) {
            $owner = Database::selectOne('SELECT `email` FROM `merchants` WHERE `slug` = :s', ['s' => $slug]);
            $mine = merchantTokenEmail((string) ($_SERVER['HTTP_X_MERCHANT_TOKEN'] ?? ''));
            if ($owner && $owner['email'] !== $mine) {
                $problem = 'That name is taken';
            }
        }
        jsonResponse(successResponse(['slug' => $slug, 'available' => $problem === null, 'reason' => $problem]));
    });

    // Public storefront data for customer orders (/m/{slug})
    $router->get('/api/merchant/storefront/([a-z0-9-]+)', function (string $slug) {
        ensureMerchantSchema();
        $slug = strtolower(trim($slug));
        $m = Database::selectOne('SELECT * FROM `merchants` WHERE `slug` = :s', ['s' => $slug]);
        if (!$m) {
            jsonResponse(errorResponse('Store not found', 404), 404);
        }
        $brand = merchantBrand($m);
        $pricing = merchantPricing($m);

        $authEmail = merchantTokenEmail((string) ($_SERVER['HTTP_X_MERCHANT_TOKEN'] ?? ''));
        $isOwner = $authEmail && strtolower($authEmail) === strtolower($m['email']);

        if ($m['status'] !== 'APPROVED' && !$isOwner) {
            jsonResponse(errorResponse('This store is not live yet.', 404), 404);
        }

        $coins = [];
        $rates = merchantVelcroRates();
        foreach (MERCHANT_COINS as $sym => $name) {
            $c = $pricing[$sym];
            if (!$c['buy_on'] && !$c['sell_on']) {
                continue;
            }
            $velcro = $rates[$sym] ?? ['buy' => null, 'sell' => null];
            $usd = null;
            if (in_array($sym, ['USDT', 'USDC'], true)) {
                $usd = 1.0;
            } else {
                try {
                    $usd = hostfiQuote($sym)['usd_per_unit'] ?: null; // for the coin estimate on the store page
                } catch (Throwable $e) {
                    $usd = null;
                }
            }
            $coins[$sym] = [
                'symbol' => $sym,
                'name' => $name,
                'usd_price' => $usd,
                'buy_on' => $c['buy_on'],
                'sell_on' => $c['sell_on'],
                // Naira per $1. The base rate and markup are only shown if the merchant chose 'breakdown'.
                'buy_rate' => $c['buy_on'] ? merchantCustomerRate($velcro['buy'], $c['buy'], 'buy') : null,
                'sell_rate' => $c['sell_on'] ? merchantCustomerRate($velcro['sell'], $c['sell'], 'sell') : null,
            ] + (merchantRateDisplay($m) === 'breakdown' ? [
                'velcro_buy_rate' => $c['buy_on'] ? $velcro['buy'] : null,
                'velcro_sell_rate' => $c['sell_on'] ? $velcro['sell'] : null,
                'buy_markup_percent' => $c['buy'],
                'sell_markup_percent' => $c['sell'],
            ] : []);
        }

        jsonResponse(successResponse([
            'store' => [
                'name' => $brand['name'] ?: $m['business_name'] ?: 'Store',
                'slug' => $m['slug'],
                'color' => $brand['color'],
                'logo' => $brand['logo'],
                'status' => $m['status'],
                'is_owner_preview' => $isOwner && $m['status'] !== 'APPROVED',
                'rate_display' => merchantRateDisplay($m),
            ],
            'google_client_id' => GOOGLE_CLIENT_ID !== '' ? GOOGLE_CLIENT_ID : null,
            'coins' => $coins,
        ]));
    });

    // Business verification (KYB). Submitting a DRAFT or REJECTED store, or editing a PENDING one,
    // sends it to Velcro for review.
    $router->post('/api/merchant/verification', function () {
        $email = requireMerchantAuth();
        $b = getJsonBody();
        if (!rateLimitCheck('merch_apply_' . $email, 10, 3600)) {
            jsonResponse(errorResponse('Too many updates. Try again later.', 429), 429);
        }
        ensureMerchantSchema();
        $existing = merchantFor($email);
        if (!in_array($existing['status'], ['DRAFT', 'PENDING', 'REJECTED'], true)) {
            jsonResponse(errorResponse('Your business is already verified.'), 400);
        }
        $slug = strtolower(trim((string) body($b, 'slug', (string) $existing['slug'])));
        $type = (string) body($b, 'business_type', '');
        $volume = (string) body($b, 'monthly_volume', '');
        $fields = [
            'business_name' => merchantField($b, 'business_name', 120),
            'contact_name' => merchantField($b, 'contact_name', 120),
            'phone' => merchantField($b, 'phone', 30),
            'registration_number' => merchantField($b, 'registration_number', 40),
            'website' => merchantField($b, 'website', 255),
            'description' => merchantField($b, 'description', 1000),
        ];
        $problem = match (true) {
            mb_strlen($fields['business_name']) < 2 => 'Enter your business or brand name',
            mb_strlen($fields['contact_name']) < 2 => 'Enter your full name',
            !preg_match('/^\+?[0-9 ()-]{7,20}$/', $fields['phone']) => 'Enter a valid phone number',
            !isset(MERCHANT_BUSINESS_TYPES[$type]) => 'Choose a business type',
            $type === 'registered' && mb_strlen($fields['registration_number']) < 4 => 'Enter your CAC / registration number',
            $volume !== '' && !isset(MERCHANT_VOLUMES[$volume]) => 'Choose an expected monthly volume',
            $fields['website'] !== '' && !preg_match('~^(https?://)?[^\s/$.?#][^\s]*\.[^\s]{2,}$~i', $fields['website']) => 'Enter a valid website or social link',
            !body($b, 'agree_terms') => 'Please accept the merchant terms',
            default => merchantSlugProblem($slug),
        };
        if ($problem !== null) {
            jsonResponse(errorResponse($problem), 400);
        }
        $row = $fields + [
            'slug' => $slug,
            'business_type' => $type,
            'monthly_volume' => $volume !== '' ? $volume : null,
            'status' => 'PENDING',
            'terms_accepted_at' => gmdate('Y-m-d H:i:s'),
            'terms_ip' => clientIp(),
        ];
        if (!merchantBrand($existing)['name']) {
            // No store name yet: start with the business name.
            $row['brand'] = json_encode(['name' => mb_substr($fields['business_name'], 0, 60)] + merchantBrand($existing));
        }
        try {
            $set = implode(', ', array_map(fn ($k) => "`{$k}` = :{$k}", array_keys($row)));
            Database::execute("UPDATE `merchants` SET {$set} WHERE `id` = :id", $row + ['id' => $existing['id']]);
        } catch (PDOException $e) {
            // The slug is UNIQUE: someone took it between the check and now.
            jsonResponse(errorResponse('That store name is taken. Pick another.'), 409);
        }
        $m = merchantByEmail($email);
        $resubmit = $existing['status'] !== 'DRAFT';
        auditLog($resubmit ? 'MERCHANT_VERIFICATION_UPDATED' : 'MERCHANT_VERIFICATION_SUBMITTED', ['email' => $email, 'slug' => $slug]);
        if (mailConfigured()) {
            runAfterResponse(static fn () => @sendMail('Velcro Merchant application — ' . $m['business_name'], ...renderEmail([
                    'eyebrow' => 'Velcro Merchant',
                    'title' => $resubmit ? 'A merchant updated their verification' : 'New merchant verification',
                    'intro' => 'Review it in the admin Merchants section.',
                    'rows' => [
                        ['Business', (string) $m['business_name']],
                        ['Type', MERCHANT_BUSINESS_TYPES[$m['business_type']] ?? $m['business_type']],
                        ['Store name', (string) $m['slug'], true],
                        ['Contact', $m['contact_name'] . ' · ' . $m['phone']],
                        ['Email', (string) $m['email']],
                    ],
                    'cta' => ['Review in admin', EMAIL_SITE_URL . '/goat/'],
                ])), 'Merchant admin alert');
            runAfterResponse(static fn () => merchantMail($email, $resubmit ? 'We’ve received your updated details' : 'We’ve received your business details', [
                'eyebrow' => 'Velcro Merchant',
                'title' => $resubmit ? 'Thanks, we’ll take another look' : 'Thanks, we’re reviewing your business',
                'intro' => 'We usually review new stores within one working day. We’ll email you as soon as you’re approved, or tell you exactly what we need.',
                'rows' => [['Business', (string) $m['business_name']], ['Store address', EMAIL_SITE_URL . '/m/' . $m['slug'], true]],
                'cta' => ['Open your dashboard', EMAIL_SITE_URL . '/merchant/'],
            ], 'verification received'), 'Merchant verification email');
        }
        jsonResponse(successResponse(merchantView($m), 'Verification submitted'));
    });

    // ─── Admin ───

    $router->get('/api/admin/merchants', function () {
        requireAdminAuth();
        ensureMerchantSchema();
        ensureStoreSchema();
        $rows = Database::select(
            "SELECT m.*, (SELECT COUNT(*) FROM `store_customers` c WHERE c.`merchant_id` = m.`id`) AS `customers`
             FROM `merchants` m ORDER BY CASE m.`status` WHEN 'PENDING' THEN 0 WHEN 'DRAFT' THEN 2 ELSE 1 END, m.`id` DESC LIMIT 500"
        );
        jsonResponse(['merchants' => $rows, 'business_types' => MERCHANT_BUSINESS_TYPES, 'volumes' => MERCHANT_VOLUMES]);
    });

    $router->post('/api/admin/merchants/(\d+)/status', function (string $id) {
        requireAdminAuth();
        ensureMerchantSchema();
        $b = getJsonBody();
        $status = strtoupper((string) body($b, 'status', ''));
        $note = mb_substr(trim((string) body($b, 'note', '')), 0, 500);
        if (!in_array($status, ['APPROVED', 'REJECTED', 'SUSPENDED'], true)) {
            jsonResponse(['success' => false, 'error' => 'Unknown status'], 400);
        }
        if ($status !== 'APPROVED' && $note === '') {
            jsonResponse(['success' => false, 'error' => 'Add a reason the merchant will see'], 400);
        }
        $m = Database::selectOne('SELECT * FROM `merchants` WHERE `id` = :id', ['id' => (int) $id]);
        if (!$m) {
            jsonResponse(['success' => false, 'error' => 'Merchant not found'], 404);
        }
        if ($m['status'] === 'DRAFT') {
            jsonResponse(['success' => false, 'error' => 'This merchant hasn’t submitted verification yet'], 400);
        }
        Database::execute(
            'UPDATE `merchants` SET `status` = :s, `review_note` = :n, `reviewed_at` = :t WHERE `id` = :id',
            ['s' => $status, 'n' => $note !== '' ? $note : null, 't' => gmdate('Y-m-d H:i:s'), 'id' => (int) $id]
        );
        auditLog('MERCHANT_' . $status, ['id' => (int) $id, 'slug' => $m['slug'], 'note' => $note]);
        $m = Database::selectOne('SELECT * FROM `merchants` WHERE `id` = :id', ['id' => (int) $id]);
        jsonResponse(['success' => true, 'merchant' => $m, 'email_sent' => notifyMerchantStatus($m)]);
    });
}
