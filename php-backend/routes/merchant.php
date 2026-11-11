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
    ensureMerchantDomainSchema();
}

const MERCHANT_DOMAIN_PLANS = [
    'MONTHLY' => [
        'name' => 'Monthly Subscription',
        'amount_ngn' => 10000,
        'duration_days' => 30,
        'description' => '₦10,000 / month, billed monthly',
    ],
    'LIFETIME' => [
        'name' => 'Lifetime Access',
        'amount_ngn' => 200000,
        'duration_days' => null,
        'description' => '₦200,000 one-time fee, yours forever',
    ],
];

const MERCHANT_DOMAIN_BANK = [
    'account_number' => '3000911925',
    'account_name' => 'Novastaq Technologies Limited',
    'bank_name' => 'Kuda Bank',
];

/** Ensures dedicated domain upgrade columns and requests table exist. */
function ensureMerchantDomainSchema(): void
{
    static $done = false;
    if ($done) {
        return;
    }
    $flag = BASE_PATH . '/data/.merchant_domain_schema_v1';
    if (file_exists($flag)) {
        $done = true;
        return;
    }
    $pdo = Database::pdo();
    $isSqlite = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite';

    $cols = [
        'domain_status' => "VARCHAR(20) NOT NULL DEFAULT 'NONE'",
        'domain_plan' => "VARCHAR(20) DEFAULT NULL",
        'domain_requested_at' => "DATETIME DEFAULT NULL",
        'domain_activated_at' => "DATETIME DEFAULT NULL",
        'domain_expires_at' => "DATETIME DEFAULT NULL",
        'domain_payment_ref' => "VARCHAR(255) DEFAULT NULL",
        'domain_subdomain' => "VARCHAR(100) DEFAULT NULL",
        'domain_review_note' => "VARCHAR(255) DEFAULT NULL",
        'domain_paid_amount' => "INT UNSIGNED DEFAULT NULL",
    ];

    foreach ($cols as $name => $def) {
        try {
            $pdo->exec("ALTER TABLE `merchants` ADD COLUMN `{$name}` {$def}");
        } catch (\Throwable $e) {
            // Column already exists
        }
    }

    try {
        if ($isSqlite) {
            $pdo->exec("CREATE TABLE IF NOT EXISTS `merchant_domain_requests` (
                `id` INTEGER PRIMARY KEY AUTOINCREMENT,
                `merchant_id` INTEGER NOT NULL,
                `slug` TEXT NOT NULL,
                `plan` TEXT NOT NULL,
                `amount` INTEGER NOT NULL,
                `payment_method` TEXT DEFAULT 'BANK_TRANSFER',
                `payment_reference` TEXT DEFAULT NULL,
                `status` TEXT NOT NULL DEFAULT 'PENDING',
                `admin_note` TEXT DEFAULT NULL,
                `reviewed_at` TEXT DEFAULT NULL,
                `created_at` TEXT DEFAULT CURRENT_TIMESTAMP
            )");
        } else {
            $pdo->exec("CREATE TABLE IF NOT EXISTS `merchant_domain_requests` (
                `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                `merchant_id` INT UNSIGNED NOT NULL,
                `slug` VARCHAR(30) NOT NULL,
                `plan` VARCHAR(20) NOT NULL,
                `amount` INT UNSIGNED NOT NULL,
                `payment_method` VARCHAR(30) DEFAULT 'BANK_TRANSFER',
                `payment_reference` VARCHAR(255) DEFAULT NULL,
                `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
                `admin_note` VARCHAR(255) DEFAULT NULL,
                `reviewed_at` DATETIME DEFAULT NULL,
                `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
                KEY `idx_merchant` (`merchant_id`),
                KEY `idx_status` (`status`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
        }
    } catch (\Throwable $e) {
        // Table exists
    }
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

const MERCHANT_LAYOUTS = ['classic', 'card', 'minimal'];

/** Store name, colours, logo, welcome line and layout, with defaults filled in. */
function merchantBrand(array $m): array
{
    $b = json_decode((string) ($m['brand'] ?? ''), true) ?: [];
    return [
        'name' => (string) ($b['name'] ?? ($m['business_name'] ?? '')),
        'color' => preg_match('/^#[0-9a-f]{6}$/i', (string) ($b['color'] ?? '')) ? strtolower($b['color']) : MERCHANT_DEFAULT_COLOR,
        // Null means the store picks black or white text for the best contrast.
        'button_text' => preg_match('/^#[0-9a-f]{6}$/i', (string) ($b['button_text'] ?? '')) ? strtolower($b['button_text']) : null,
        'welcome' => (string) ($b['welcome'] ?? ''),
        'layout' => in_array($b['layout'] ?? '', MERCHANT_LAYOUTS, true) ? $b['layout'] : 'classic',
        'logo' => $b['logo'] ?? null,
        'support_url' => $b['support_url'] ?? null,
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
 * get per $1. Cached for a minute; never serves stale empty/null rates.
 *
 * @return array<string,array{provider:string,buy:?float,sell:?float,usd:?float}>
 */
function merchantVelcroRates(): array
{
    $file = BASE_PATH . '/data/.merchant_rates.json';
    $cached = is_file($file) ? json_decode((string) @file_get_contents($file), true) : null;
    $age = time() - (int) ($cached['at'] ?? 0);

    // If the cache contains nulls for buy or sell on any coin, treat cache as invalid
    $hasNulls = false;
    if (is_array($cached) && !empty($cached['rates'])) {
        foreach (array_keys(MERCHANT_COINS) as $sym) {
            $r = $cached['rates'][$sym] ?? null;
            if (!$r || empty($r['buy']) || empty($r['sell'])) {
                $hasNulls = true;
                break;
            }
        }
    } else {
        $hasNulls = true;
    }

    if (!$hasNulls && $age < 21600) {
        // Return cached rates immediately without blocking the visitor on remote API roundtrips.
        // If older than 60s, refresh in the background. Past 6 hours, wait for today's prices instead.
        $lock = $file . '.refreshing';
        if ($age >= 60 && (!is_file($lock) || filemtime($lock) < time() - 30) && @touch($lock)) {
            runAfterResponse(static function () use ($lock): void {
                try {
                    merchantFetchVelcroRates();
                } finally {
                    @unlink($lock);
                }
            }, 'Merchant rates refresh');
        }
        return $cached['rates'];
    }
    return merchantFetchVelcroRates();
}

/** How old, in seconds, the rates merchantVelcroRates() just returned are. */
function merchantRatesAge(): int
{
    $cached = json_decode((string) @file_get_contents(BASE_PATH . '/data/.merchant_rates.json'), true);
    return is_array($cached) ? max(0, time() - (int) ($cached['at'] ?? 0)) : 0;
}

/** Asks each provider for its rate now and saves the result for merchantVelcroRates(). */
function merchantFetchVelcroRates(): array
{
    $file = BASE_PATH . '/data/.merchant_rates.json';
    $out = [];

    // Get live baseline USD/NGN buy/sell rates from market (Switch / PAJ)
    $marketRates = function_exists('getLiveUsdNgnRates') ? getLiveUsdNgnRates() : ['buy' => 1400.0, 'sell' => 1370.0];
    $usdMarketBuy = $marketRates['buy'];
    $usdMarketSell = $marketRates['sell'];
    $switchStableBuy = null;
    $switchStableSell = null;

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
                // Fallback to market USD/NGN rates if HostFi quote is unavailable or zero
                if (!$buy && $usdMarketBuy > 0) {
                    $buy = $usdMarketBuy;
                }
                if (!$sell && $usdMarketSell > 0) {
                    $sell = $usdMarketSell;
                }
            } elseif ($provider === 'paj') {
                // PAJ's $ rates with Velcro's margin, then Velcro's fee (taken from what the customer receives).
                if (class_exists('PajApiClient') && function_exists('pajApi')) {
                    $r = pajApi()->getPajRate();
                    $margin = getPajRateMargin();
                    $fee = getPajFee() / 100;
                    $on = (float) ($r['onramp']['rate'] ?? 0);
                    $off = (float) ($r['offramp']['rate'] ?? 0);
                    $buy = $on > 0 ? ($on + $margin) / (1 - $fee) : null;
                    $sell = $off > 0 ? ($off - $margin) * (1 - $fee) : null;
                }
                if (!$buy && $usdMarketBuy > 0) {
                    $buy = $usdMarketBuy;
                }
                if (!$sell && $usdMarketSell > 0) {
                    $sell = $usdMarketSell;
                }
            } else {
                // Switch: USDT and USDC share identical USD stablecoin rates.
                if (in_array($sym, ['USDT', 'USDC'], true) && ($switchStableBuy !== null || $switchStableSell !== null)) {
                    $buy = $switchStableBuy;
                    $sell = $switchStableSell;
                } else {
                    $assets = json_decode((string) @file_get_contents(BASE_PATH . '/data/switch_assets_cache.json'), true) ?: [];
                    foreach (['ONRAMP' => 'onramp', 'OFFRAMP' => 'offramp'] as $dir => $key) {
                        $chains = (array) ($assets[$key][$sym]['chains'] ?? []);
                        $chain = array_values(array_intersect(['solana', 'base', 'tron', 'bsc', 'polygon', 'ethereum'], $chains))[0] ?? ($chains[0] ?? 'solana');
                        try {
                            $res = switchApi()->getRate(['direction' => $dir, 'country' => 'NG', 'currency' => 'NGN', 'channel' => 'BANK', 'asset' => $chain . ':' . strtolower($sym)]);
                            $rate = (float) ($res['data']['rate'] ?? 0);
                            if ($rate > 0) {
                                $dir === 'ONRAMP' ? $buy = $rate : $sell = $rate;
                            }
                        } catch (Throwable $re) {
                            // ignore individual direction failure
                        }
                    }
                    if (in_array($sym, ['USDT', 'USDC'], true)) {
                        $switchStableBuy = $buy;
                        $switchStableSell = $sell;
                    }
                }
                if (!$buy && $usdMarketBuy > 0) {
                    $buy = $usdMarketBuy;
                }
                if (!$sell && $usdMarketSell > 0) {
                    $sell = $usdMarketSell;
                }
            }
        } catch (Throwable $e) {
            error_log("[Merchant] {$sym} rate via {$provider} unavailable: " . $e->getMessage());
        }

        // Crypto token USD price
        $usd = null;
        if (in_array($sym, ['USDT', 'USDC'], true)) {
            $usd = 1.0;
        } else {
            try {
                $q = hostfiQuote($sym);
                $usd = $q['usd_per_unit'] > 0 ? $q['usd_per_unit'] : null;
            } catch (Throwable $e) {
                // fallback below
            }
            if (!$usd && function_exists('getCryptoUsdPrice')) {
                $usd = getCryptoUsdPrice($sym) ?: null;
            }
        }

        // Final safety fallbacks so no coin is ever null
        if ($buy === null && $usdMarketBuy) {
            $buy = $usdMarketBuy;
        }
        if ($sell === null && $usdMarketSell) {
            $sell = $usdMarketSell;
        }
        if ($usd === null) {
            $usd = in_array($sym, ['USDT', 'USDC'], true) ? 1.0 : (function_exists('getCryptoUsdPrice') ? (getCryptoUsdPrice($sym) ?: null) : null);
        }

        $out[$sym] = [
            'provider' => $provider,
            'buy' => $buy ? round((float) $buy, 2) : null,
            'sell' => $sell ? round((float) $sell, 2) : null,
            'usd' => $usd ? (float) $usd : null,
        ];
    }

    // A provider that didn't answer this time keeps its last good rates for up to an hour
    $old = json_decode((string) @file_get_contents($file), true);
    foreach ($out as $sym => $r) {
        $out[$sym]['at'] = time();
        $prev = is_array($old) ? ($old['rates'][$sym] ?? []) : [];
        $prevAt = (int) ($prev['at'] ?? $old['at'] ?? 0);
        if (time() - $prevAt >= 3600) {
            continue;
        }
        foreach (['buy', 'sell', 'usd'] as $k) {
            if ($r[$k] === null && isset($prev[$k])) {
                $out[$sym][$k] = $prev[$k];
                $out[$sym]['at'] = $prevAt;
            }
        }
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
    ensureMerchantDomainSchema();
    $brand = merchantBrand($m);

    $dStatus = $m['domain_status'] ?? 'NONE';
    $dExpires = $m['domain_expires_at'] ?? null;
    $dPlan = $m['domain_plan'] ?? null;
    $isActive = $dStatus === 'ACTIVE' && ($dExpires === null || strtotime($dExpires) > time());
    if ($dStatus === 'ACTIVE' && $dExpires !== null && strtotime($dExpires) <= time()) {
        $dStatus = 'EXPIRED';
        $isActive = false;
    }
    $subdomain = !empty($m['domain_subdomain']) ? (string) $m['domain_subdomain'] : ($m['slug'] ? $m['slug'] . '.usevelcro.com' : null);
    $dedicatedUrl = $subdomain ? 'https://' . $subdomain : null;
    $standardUrl = $m['slug'] ? EMAIL_SITE_URL . '/m/' . $m['slug'] : null;
    $storefrontUrl = $isActive && $dedicatedUrl ? $dedicatedUrl : $standardUrl;

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
        'storefront_url' => $storefrontUrl,
        'domain' => [
            'status' => $dStatus,
            'plan' => $dPlan,
            'is_active' => $isActive,
            'subdomain' => $subdomain,
            'dedicated_url' => $dedicatedUrl,
            'standard_url' => $standardUrl,
            'expires_at' => $dExpires,
            'requested_at' => $m['domain_requested_at'] ?? null,
            'activated_at' => $m['domain_activated_at'] ?? null,
            'payment_ref' => $m['domain_payment_ref'] ?? null,
            'paid_amount' => isset($m['domain_paid_amount']) ? (int) $m['domain_paid_amount'] : null,
            'review_note' => $m['domain_review_note'] ?? null,
            'pricing' => [
                'monthly' => 10000,
                'lifetime' => 200000,
                'bank' => MERCHANT_DOMAIN_BANK,
            ],
        ],
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
        'cta' => [$copy[2], 'https://merchant.usevelcro.com/'],
    ], 'status ' . $m['status']);
}

/** Dedicated domain status update (CONFIRMED, PASSED, REJECTED). */
function notifyMerchantDomainStatus(array $m, string $action): bool
{
    $name = (string) (merchantBrand($m)['name'] ?: $m['business_name']);
    $subdomain = (string) ($m['domain_subdomain'] ?: ($m['slug'] . '.usevelcro.com'));
    $url = 'https://' . $subdomain;
    if ($action === 'CONFIRMED' || $action === 'PASSED') {
        $planText = ($m['domain_plan'] === 'LIFETIME'
            ? 'Lifetime Access (Permanent VIP)'
            : ($m['domain_plan'] === 'PASSED'
                ? 'Complimentary VIP Pass'
                : 'Monthly Subscription (Active until ' . substr((string)($m['domain_expires_at'] ?? ''), 0, 10) . ')'));
        return merchantMail((string) $m['email'], "Your dedicated domain {$subdomain} is live!", [
            'preheader' => "Your dedicated domain {$subdomain} is now active.",
            'eyebrow' => 'Velcro Merchant Upgrade',
            'title' => 'Your dedicated domain is live!',
            'intro' => "Great news: your dedicated exchange address {$subdomain} is active. Your customers can now trade on your store directly without the /m/ path.",
            'rows' => [
                ['Store', $name],
                ['Dedicated URL', $url, true],
                ['Plan', $planText],
            ],
            'cta' => ['Open your store', $url],
        ], 'domain ' . $action);
    }
    if ($action === 'REJECTED') {
        return merchantMail((string) $m['email'], 'Update on your dedicated domain upgrade', [
            'preheader' => 'We could not verify your domain payment transfer.',
            'eyebrow' => 'Velcro Merchant Upgrade',
            'title' => 'Domain payment verification update',
            'intro' => "We could not verify your bank transfer for the dedicated domain upgrade." . ((string)($m['domain_review_note'] ?? '') !== '' ? " Reason: " . $m['domain_review_note'] : " Please verify that you transferred to Kuda Bank (3000911925 / Novastaq Technologies Limited) and resubmit with your transfer narration/sender name."),
            'rows' => [
                ['Store', $name],
                ['Status', 'Payment Not Verified'],
            ],
            'cta' => ['Open dashboard', 'https://merchant.usevelcro.com/'],
        ], 'domain rejected');
    }
    return false;
}

/** Welcome, once, when a merchant account is created. */
function sendMerchantWelcome(string $email): void
{
    runAfterResponse(static fn () => merchantMail($email, 'Welcome to Velcro Merchant', [
        'preheader' => 'Set up your store in a few minutes.',
        'eyebrow' => 'Velcro Merchant',
        'title' => 'Welcome to Velcro Merchant',
        'intro' => 'Your account is ready. Three steps to your first sale: personalize your store (name, address, logo and colours), set your markup on each coin, and verify your business so your store can go live.',
        'cta' => ['Open your dashboard', 'https://merchant.usevelcro.com/'],
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
            jsonResponse(successResponse(['sent' => true], 'Code sent to ' . $email . '. Please check your spam folder if not found in inbox.'));
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
        $businessName = mb_substr(trim((string) body($b, 'business_name', '')), 0, 120);
        if ($account) {
            Database::execute('UPDATE `merchant_accounts` SET `password_hash` = :h, `name` = COALESCE(:n, `name`) WHERE `id` = :id', [
                'h' => $hash,
                'n' => $name !== '' ? $name : null,
                'id' => $account['id'],
            ]);
        } else {
            Database::insert('merchant_accounts', [
                'email' => $email,
                'password_hash' => $hash,
                'name' => $name !== '' ? $name : null,
            ]);
        }

        // Initialize or update the merchant's store profile with business name, contact name, and suggested slug
        $m = merchantByEmail($email);
        $slug = null;
        if ($businessName !== '') {
            $baseSlug = strtolower(preg_replace('/[^a-z0-9]+/i', '-', trim($businessName)));
            $baseSlug = trim($baseSlug, '-');
            if (strlen($baseSlug) > 28) {
                $baseSlug = substr($baseSlug, 0, 28);
            }
            if (strlen($baseSlug) >= 3 && !in_array($baseSlug, MERCHANT_RESERVED_SLUGS, true)) {
                $slugCandidate = $baseSlug;
                $exists = Database::selectOne('SELECT `id` FROM `merchants` WHERE `slug` = :s AND `email` != :e', ['s' => $slugCandidate, 'e' => $email]);
                if ($exists) {
                    $slugCandidate = substr($baseSlug, 0, 22) . '-' . substr(bin2hex(random_bytes(3)), 0, 5);
                }
                $slug = $slugCandidate;
            }
        }

        if (!$m) {
            $brandJson = json_encode([
                'name' => $businessName,
                'color' => MERCHANT_DEFAULT_COLOR,
                'button_text' => null,
                'welcome' => '',
                'layout' => 'classic',
                'logo' => null,
                'support_url' => null,
            ]);
            try {
                Database::insert('merchants', [
                    'email' => $email,
                    'status' => 'DRAFT',
                    'business_name' => $businessName !== '' ? $businessName : null,
                    'contact_name' => $name !== '' ? $name : null,
                    'slug' => $slug,
                    'brand' => $brandJson,
                ]);
            } catch (Throwable $e) {
                try {
                    Database::insert('merchants', [
                        'email' => $email,
                        'status' => 'DRAFT',
                        'business_name' => $businessName !== '' ? $businessName : null,
                        'contact_name' => $name !== '' ? $name : null,
                        'brand' => $brandJson,
                    ]);
                } catch (Throwable $e2) {
                    // created by a parallel call
                }
            }
        } else {
            $updates = [];
            $params = ['id' => $m['id']];
            if ($businessName !== '' && empty($m['business_name'])) {
                $updates[] = '`business_name` = :bn';
                $params['bn'] = $businessName;
            }
            if ($name !== '' && empty($m['contact_name'])) {
                $updates[] = '`contact_name` = :cn';
                $params['cn'] = $name;
            }
            if ($slug !== null && empty($m['slug'])) {
                $updates[] = '`slug` = :sl';
                $params['sl'] = $slug;
            }
            if ($businessName !== '') {
                $brand = json_decode((string) ($m['brand'] ?? ''), true) ?: [];
                if (empty($brand['name'])) {
                    $brand['name'] = $businessName;
                    $updates[] = '`brand` = :b';
                    $params['b'] = json_encode($brand);
                }
            }
            if (!empty($updates)) {
                try {
                    Database::execute('UPDATE `merchants` SET ' . implode(', ', $updates) . ' WHERE `id` = :id', $params);
                } catch (Throwable $e) {
                    // ignore if slug collision
                }
            }
        }

        auditLog('MERCHANT_ACCOUNT_CREATED', ['email' => $email, 'method' => 'password', 'business_name' => $businessName, 'name' => $name]);
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
        jsonResponse(successResponse(['sent' => true], 'If that email has an account, a code is on its way. Please check your spam folder.'));
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
            'coins' => array_filter(MERCHANT_COINS, fn ($name, $sym) => isCoinGloballyEnabled($sym), ARRAY_FILTER_USE_BOTH),
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
        // Sent as null to go back to automatic black or white.
        $buttonText = strtolower(trim((string) (array_key_exists('button_text', $b) ? $b['button_text'] : $brand['button_text'])));
        $welcome = array_key_exists('welcome', $b) ? merchantField($b, 'welcome', 140) : $brand['welcome'];
        $layout = (string) body($b, 'layout', $brand['layout']);
        $locked = in_array($m['status'], ['APPROVED', 'SUSPENDED'], true) && $m['slug'];
        $problem = match (true) {
            mb_strlen($name) < 2 => 'Enter your exchange name',
            !preg_match('/^#[0-9a-f]{6}$/', $color) => 'Pick a valid colour',
            $buttonText !== '' && !preg_match('/^#[0-9a-f]{6}$/', $buttonText) => 'Pick a valid button text colour',
            !in_array($layout, MERCHANT_LAYOUTS, true) => 'Pick a layout',
            $locked && $slug !== (string) $m['slug'] => 'Your exchange link cannot be changed after approval',
            $locked && !empty($brand['name']) && $name !== (string) $brand['name'] => 'Your exchange name cannot be changed after approval',
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
                's' => $locked ? $m['slug'] : $slug,
                'b' => json_encode([
                    'name' => $locked ? $brand['name'] : $name,
                    'color' => $color,
                    'button_text' => $buttonText !== '' ? $buttonText : null,
                    'welcome' => $welcome,
                    'layout' => $layout,
                    'logo' => $logo,
                    'support_url' => $brand['support_url'],
                ]),
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

    // Where the store's customers get help: a WhatsApp phone number, WhatsApp link, Telegram or website link. Empty removes it.
    $router->post('/api/merchant/support', function () {
        $email = requireMerchantAuth();
        $raw = trim((string) body(getJsonBody(), 'support_url', ''));
        $url = $raw;
        if ($raw !== '') {
            $digits = preg_replace('/\D/', '', $raw);
            if (!str_starts_with($raw, 'http://') && !str_starts_with($raw, 'https://')) {
                if (str_starts_with($raw, 'wa.me/') || str_starts_with($raw, 't.me/')) {
                    $url = 'https://' . $raw;
                } elseif (strlen($digits) >= 7) {
                    if (strlen($digits) === 11 && str_starts_with($digits, '0')) {
                        $url = 'https://wa.me/234' . substr($digits, 1);
                    } elseif (str_starts_with($digits, '234') && strlen($digits) === 13) {
                        $url = 'https://wa.me/' . $digits;
                    } else {
                        $url = 'https://wa.me/' . $digits;
                    }
                }
            }
            if (!preg_match('#^https://[^\s<>"]{4,250}$#i', $url)) {
                jsonResponse(errorResponse('Enter a valid phone number (e.g. 07035428475) or a support link starting with https://, like https://wa.me/2347035428475'), 400);
            }
        }
        ensureMerchantSchema();
        $m = merchantFor($email);
        $brand = merchantBrand($m);
        $brand['support_url'] = $url !== '' ? $url : null;
        Database::execute('UPDATE `merchants` SET `brand` = :b WHERE `id` = :id', ['b' => json_encode($brand), 'id' => $m['id']]);
        jsonResponse(successResponse(merchantView(merchantByEmail($email)), $url !== '' ? 'Support saved' : 'Support removed'));
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
            $buyAvail = isCoinRouteEnabled('buy', $sym);
            $sellAvail = isCoinRouteEnabled('sell', $sym);
            if (!$buyAvail && !$sellAvail) {
                continue; // Admin disabled this coin completely across all providers
            }
            $c = $pricing[$sym] ?? ['buy_on' => false, 'sell_on' => false, 'buy' => 0.0, 'sell' => 0.0];
            $buyOn = !empty($c['buy_on']) && $buyAvail;
            $sellOn = !empty($c['sell_on']) && $sellAvail;
            if (!$buyOn && !$sellOn) {
                continue;
            }
            $velcro = $rates[$sym] ?? ['buy' => null, 'sell' => null];
            $usd = $velcro['usd'] ?? (in_array($sym, ['USDT', 'USDC'], true) ? 1.0 : (function_exists('getCryptoUsdPrice') ? (getCryptoUsdPrice($sym) ?: null) : null)); // for the coin estimate on the store page
            $coins[$sym] = [
                'symbol' => $sym,
                'name' => $name,
                'usd_price' => $usd,
                'provider' => MERCHANT_COIN_PROVIDERS[$sym] ?? null,
                'buy_on' => $buyOn,
                'sell_on' => $sellOn,
                // Naira per $1. The base rate and markup are only shown if the merchant chose 'breakdown'.
                'buy_rate' => $buyOn ? merchantCustomerRate($velcro['buy'], $c['buy'], 'buy') : null,
                'sell_rate' => $sellOn ? merchantCustomerRate($velcro['sell'], $c['sell'], 'sell') : null,
            ] + (merchantRateDisplay($m) === 'breakdown' ? [
                'velcro_buy_rate' => $buyOn ? $velcro['buy'] : null,
                'velcro_sell_rate' => $sellOn ? $velcro['sell'] : null,
                'buy_markup_percent' => $c['buy'],
                'sell_markup_percent' => $c['sell'],
            ] : []);
        }

        jsonResponse(successResponse([
            'rates_age' => merchantRatesAge(),
            'store' => [
                'name' => $brand['name'] ?: $m['business_name'] ?: 'Store',
                'slug' => $m['slug'],
                'color' => $brand['color'],
                'button_text' => $brand['button_text'],
                'welcome' => $brand['welcome'],
                'layout' => $brand['layout'],
                'logo' => $brand['logo'],
                'status' => $m['status'],
                'is_owner_preview' => $isOwner && $m['status'] !== 'APPROVED',
                'rate_display' => merchantRateDisplay($m),
                'support_url' => $brand['support_url'],
                'dedicated_domain' => ($m['domain_status'] ?? '') === 'ACTIVE' && (empty($m['domain_expires_at']) || strtotime($m['domain_expires_at']) > time()),
                'subdomain' => !empty($m['domain_subdomain']) ? (string) $m['domain_subdomain'] : ($m['slug'] ? $m['slug'] . '.usevelcro.com' : null),
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
                'cta' => ['Open your dashboard', 'https://merchant.usevelcro.com/'],
            ], 'verification received'), 'Merchant verification email');
        }
        jsonResponse(successResponse(merchantView($m), 'Verification submitted'));
    });

    // Dedicated domain upgrade request
    $router->post('/api/merchant/domain/upgrade', function () {
        $email = requireMerchantAuth();
        ensureMerchantSchema();
        ensureMerchantDomainSchema();
        $m = merchantByEmail($email);
        if (!$m) {
            jsonResponse(errorResponse('Merchant not found', 404), 404);
        }
        if (empty($m['slug'])) {
            jsonResponse(errorResponse('Choose your exchange address first in Settings'), 400);
        }
        $b = getJsonBody();
        $plan = strtoupper(trim((string) body($b, 'plan', 'MONTHLY')));
        if (!in_array($plan, ['MONTHLY', 'LIFETIME'], true)) {
            jsonResponse(errorResponse('Invalid plan chosen'), 400);
        }
        $ref = mb_substr(trim((string) body($b, 'payment_reference', '')), 0, 255);
        if ($ref === '') {
            jsonResponse(errorResponse('Please enter your sender name or bank transfer reference'), 400);
        }
        $amount = $plan === 'MONTHLY' ? 10000 : 200000;
        
        $requestedSlug = trim((string) body($b, 'slug', ''));
        if ($requestedSlug === '') {
            $requestedSlug = (string) ($m['slug'] ?? '');
        }
        $requestedSlug = strtolower(preg_replace('/[^a-z0-9-]/', '', $requestedSlug));
        if (strlen($requestedSlug) < 3 || strlen($requestedSlug) > 30) {
            jsonResponse(errorResponse('Subdomain slug must be between 3 and 30 characters'), 400);
        }
        $reserved = ['www', 'ramp', 'goat', 'merchant', 'api', 'admin', 'mail', 'cpanel', 'webmail', 'app', 'dashboard', 'support', 'help', 'status'];
        if (in_array($requestedSlug, $reserved, true)) {
            jsonResponse(errorResponse("The slug '{$requestedSlug}' is reserved and cannot be used"), 400);
        }
        $existing = Database::selectOne(
            "SELECT id FROM `merchants` WHERE `domain_subdomain` = :sub AND `id` != :id",
            ['sub' => $requestedSlug . '.usevelcro.com', 'id' => (int) $m['id']]
        );
        if ($existing) {
            jsonResponse(errorResponse("The subdomain '{$requestedSlug}.usevelcro.com' is already registered by another merchant"), 400);
        }
        $subdomain = $requestedSlug . '.usevelcro.com';
        $now = gmdate('Y-m-d H:i:s');

        Database::execute(
            'UPDATE `merchants` SET 
                `domain_status` = :st,
                `domain_plan` = :plan,
                `domain_requested_at` = :req_at,
                `domain_payment_ref` = :ref,
                `domain_paid_amount` = :amt,
                `domain_subdomain` = :sub,
                `domain_review_note` = NULL
             WHERE `id` = :id',
            [
                'st' => 'PENDING',
                'plan' => $plan,
                'req_at' => $now,
                'ref' => $ref,
                'amt' => $amount,
                'sub' => $subdomain,
                'id' => (int) $m['id'],
            ]
        );

        try {
            Database::execute(
                'INSERT INTO `merchant_domain_requests` 
                    (`merchant_id`, `slug`, `plan`, `amount`, `payment_method`, `payment_reference`, `status`, `created_at`)
                 VALUES (:mid, :slug, :plan, :amt, :method, :ref, :st, :now)',
                [
                    'mid' => (int) $m['id'],
                    'slug' => $m['slug'],
                    'plan' => $plan,
                    'amt' => $amount,
                    'method' => 'BANK_TRANSFER',
                    'ref' => $ref,
                    'st' => 'PENDING',
                    'now' => $now,
                ]
            );
        } catch (\Throwable $e) {}

        auditLog('MERCHANT_DOMAIN_UPGRADE_REQUEST', [
            'id' => (int) $m['id'],
            'slug' => $m['slug'],
            'plan' => $plan,
            'amount' => $amount,
            'payment_reference' => $ref,
        ]);

        $updated = Database::selectOne('SELECT * FROM `merchants` WHERE `id` = :id', ['id' => (int) $m['id']]);
        jsonResponse(successResponse(merchantView($updated), 'Domain upgrade request submitted. Awaiting verification.'));
    });

    // ─── Admin ───

    $router->get('/api/admin/merchants', function () {
        requireAdminAuth();
        ensureMerchantSchema();
        ensureMerchantDomainSchema();
        ensureStoreSchema();

        $domainPendingExpr = "0 AS `domain_pending_count`";
        try {
            Database::pdo()->query("SELECT 1 FROM `merchant_domain_requests` LIMIT 1");
            $domainPendingExpr = "(SELECT COUNT(*) FROM `merchant_domain_requests` r WHERE r.`merchant_id` = m.`id` AND r.`status` = 'PENDING') AS `domain_pending_count`";
        } catch (\Throwable $e) {}

        $ordersExpr = "0 AS `orders_count`, 0 AS `completed_volume`";
        try {
            Database::pdo()->query("SELECT 1 FROM `transactions` LIMIT 1");
            $ordersExpr = "(SELECT COUNT(*) FROM `transactions` t WHERE t.`merchant_id` = m.`id` AND t.`status` = 'COMPLETED') AS `orders_count`,
                           (SELECT COALESCE(SUM(t.`amount`), 0) FROM `transactions` t WHERE t.`merchant_id` = m.`id` AND t.`status` = 'COMPLETED') AS `completed_volume`";
        } catch (\Throwable $e) {}

        $rows = Database::select(
            "SELECT m.*, 
                    (SELECT COUNT(*) FROM `store_customers` c WHERE c.`merchant_id` = m.`id`) AS `customers`,
                    {$ordersExpr},
                    {$domainPendingExpr}
             FROM `merchants` m ORDER BY CASE m.`status` WHEN 'PENDING' THEN 0 WHEN 'DRAFT' THEN 2 ELSE 1 END, m.`id` DESC LIMIT 500"
        );
        $domainRequests = [];
        try {
            $domainRequests = Database::safeSelect(
                "SELECT r.*, m.business_name, m.email AS merchant_email, m.domain_status, m.domain_expires_at
                 FROM `merchant_domain_requests` r
                 JOIN `merchants` m ON m.id = r.merchant_id
                 ORDER BY CASE r.status WHEN 'PENDING' THEN 0 ELSE 1 END, r.id DESC LIMIT 100",
                [],
                []
            );
        } catch (\Throwable $e) {}

        jsonResponse([
            'merchants' => $rows,
            'domain_requests' => $domainRequests,
            'business_types' => MERCHANT_BUSINESS_TYPES,
            'volumes' => MERCHANT_VOLUMES,
            'domain_plans' => MERCHANT_DOMAIN_PLANS,
            'domain_bank' => MERCHANT_DOMAIN_BANK,
        ]);
    });

    $router->get('/api/admin/merchant-domains', function () {
        requireAdminAuth();
        ensureMerchantSchema();
        ensureMerchantDomainSchema();
        $requests = Database::safeSelect(
            "SELECT r.*, m.business_name, m.email AS merchant_email, m.domain_status, m.domain_expires_at
             FROM `merchant_domain_requests` r
             JOIN `merchants` m ON m.id = r.merchant_id
             ORDER BY CASE r.status WHEN 'PENDING' THEN 0 ELSE 1 END, r.id DESC LIMIT 200",
            [],
            []
        );
        $merchants = Database::safeSelect(
            "SELECT m.* FROM `merchants` m WHERE m.`domain_status` != 'NONE' OR m.`domain_requested_at` IS NOT NULL ORDER BY m.id DESC LIMIT 200",
            [],
            []
        );
        jsonResponse(['requests' => $requests, 'merchants' => $merchants, 'plans' => MERCHANT_DOMAIN_PLANS, 'bank' => MERCHANT_DOMAIN_BANK]);
    });

    $router->post('/api/admin/merchants/(\d+)/domain/confirm', function (string $id) {
        requireAdminAuth();
        ensureMerchantSchema();
        ensureMerchantDomainSchema();
        $m = Database::selectOne('SELECT * FROM `merchants` WHERE `id` = :id', ['id' => (int) $id]);
        if (!$m) {
            jsonResponse(['success' => false, 'error' => 'Merchant not found'], 404);
        }
        if (empty($m['slug'])) {
            jsonResponse(['success' => false, 'error' => 'Merchant has no slug set'], 400);
        }
        $b = getJsonBody();
        $plan = strtoupper(trim((string) body($b, 'plan', $m['domain_plan'] ?: 'MONTHLY')));
        if (!in_array($plan, ['MONTHLY', 'LIFETIME'], true)) {
            $plan = 'MONTHLY';
        }
        $note = mb_substr(trim((string) body($b, 'note', '')), 0, 255);
        $now = gmdate('Y-m-d H:i:s');
        $rawSub = trim((string) body($b, 'subdomain', ''));
        if ($rawSub === '') {
            $rawSub = trim((string) body($b, 'slug', ''));
        }
        if ($rawSub === '') {
            $rawSub = (string) ($m['domain_subdomain'] ?: ($m['slug'] ? $m['slug'] . '.usevelcro.com' : ''));
        }
        $cleanSub = strtolower(preg_replace('/[^a-z0-9.-]/i', '', $rawSub));
        if (!str_ends_with($cleanSub, '.usevelcro.com')) {
            $cleanSub = explode('.', $cleanSub)[0] . '.usevelcro.com';
        }
        $subdomain = $cleanSub;

        $expiresAt = null;
        if ($plan === 'MONTHLY') {
            $base = time();
            if (!empty($m['domain_expires_at']) && strtotime($m['domain_expires_at']) > time()) {
                $base = strtotime($m['domain_expires_at']);
            }
            $expiresAt = gmdate('Y-m-d H:i:s', $base + (30 * 86400));
        }

        Database::execute(
            'UPDATE `merchants` SET 
                `domain_status` = :st,
                `domain_plan` = :plan,
                `domain_activated_at` = :act,
                `domain_expires_at` = :exp,
                `domain_subdomain` = :sub,
                `domain_review_note` = :note
             WHERE `id` = :id',
            [
                'st' => 'ACTIVE',
                'plan' => $plan,
                'act' => $now,
                'exp' => $expiresAt,
                'sub' => $subdomain,
                'note' => $note !== '' ? $note : null,
                'id' => (int) $id,
            ]
        );

        try {
            Database::execute(
                "UPDATE `merchant_domain_requests` SET 
                    `status` = 'APPROVED',
                    `admin_note` = :note,
                    `reviewed_at` = :now
                 WHERE `merchant_id` = :mid AND `status` = 'PENDING'",
                ['note' => $note !== '' ? $note : 'Payment confirmed', 'now' => $now, 'mid' => (int) $id]
            );
        } catch (\Throwable $e) {}

        auditLog('MERCHANT_DOMAIN_CONFIRMED', [
            'id' => (int) $id,
            'slug' => $m['slug'],
            'plan' => $plan,
            'subdomain' => $subdomain,
            'expires_at' => $expiresAt,
            'note' => $note,
        ]);

        $updated = Database::selectOne('SELECT * FROM `merchants` WHERE `id` = :id', ['id' => (int) $id]);
        $emailSent = notifyMerchantDomainStatus($updated, 'CONFIRMED');
        jsonResponse(['success' => true, 'merchant' => $updated, 'email_sent' => $emailSent]);
    });

    $router->post('/api/admin/merchants/(\d+)/domain/pass', function (string $id) {
        requireAdminAuth();
        ensureMerchantSchema();
        ensureMerchantDomainSchema();
        $m = Database::selectOne('SELECT * FROM `merchants` WHERE `id` = :id', ['id' => (int) $id]);
        if (!$m) {
            jsonResponse(['success' => false, 'error' => 'Merchant not found'], 404);
        }
        if (empty($m['slug'])) {
            jsonResponse(['success' => false, 'error' => 'Merchant has no slug set. Have merchant pick a slug first.'], 400);
        }
        $b = getJsonBody();
        $plan = strtoupper(trim((string) body($b, 'plan', 'PASSED')));
        $days = (int) body($b, 'days', 0); // 0 = permanent/lifetime
        $expiresAt = $days > 0 ? gmdate('Y-m-d H:i:s', time() + ($days * 86400)) : null;
        $note = mb_substr(trim((string) body($b, 'note', 'Complimentary VIP Pass')), 0, 255);
        $rawSub = trim((string) body($b, 'subdomain', ''));
        if ($rawSub === '') {
            $rawSub = trim((string) body($b, 'slug', ''));
        }
        if ($rawSub === '') {
            $rawSub = (string) ($m['domain_subdomain'] ?: ($m['slug'] ? $m['slug'] . '.usevelcro.com' : ''));
        }
        $cleanSub = strtolower(preg_replace('/[^a-z0-9.-]/i', '', $rawSub));
        if (!str_ends_with($cleanSub, '.usevelcro.com')) {
            $cleanSub = explode('.', $cleanSub)[0] . '.usevelcro.com';
        }
        $subdomain = $cleanSub;
        $now = gmdate('Y-m-d H:i:s');

        Database::execute(
            'UPDATE `merchants` SET 
                `domain_status` = :st,
                `domain_plan` = :plan,
                `domain_activated_at` = :act,
                `domain_expires_at` = :exp,
                `domain_subdomain` = :sub,
                `domain_review_note` = :note
             WHERE `id` = :id',
            [
                'st' => 'ACTIVE',
                'plan' => $plan,
                'act' => $now,
                'exp' => $expiresAt,
                'sub' => $subdomain,
                'note' => $note,
                'id' => (int) $id,
            ]
        );

        try {
            Database::execute(
                "UPDATE `merchant_domain_requests` SET 
                    `status` = 'APPROVED',
                    `admin_note` = :note,
                    `reviewed_at` = :now
                 WHERE `merchant_id` = :mid AND `status` = 'PENDING'",
                ['note' => $note, 'now' => $now, 'mid' => (int) $id]
            );
        } catch (\Throwable $e) {}

        auditLog('MERCHANT_DOMAIN_PASSED', [
            'id' => (int) $id,
            'slug' => $m['slug'],
            'plan' => $plan,
            'subdomain' => $subdomain,
            'note' => $note,
        ]);

        $updated = Database::selectOne('SELECT * FROM `merchants` WHERE `id` = :id', ['id' => (int) $id]);
        $emailSent = notifyMerchantDomainStatus($updated, 'PASSED');
        jsonResponse(['success' => true, 'merchant' => $updated, 'email_sent' => $emailSent]);
    });

    $router->post('/api/admin/merchants/(\d+)/domain/reject', function (string $id) {
        requireAdminAuth();
        ensureMerchantSchema();
        ensureMerchantDomainSchema();
        $m = Database::selectOne('SELECT * FROM `merchants` WHERE `id` = :id', ['id' => (int) $id]);
        if (!$m) {
            jsonResponse(['success' => false, 'error' => 'Merchant not found'], 404);
        }
        $b = getJsonBody();
        $note = mb_substr(trim((string) body($b, 'note', 'Payment transfer could not be verified')), 0, 255);
        $now = gmdate('Y-m-d H:i:s');

        Database::execute(
            'UPDATE `merchants` SET 
                `domain_status` = :st,
                `domain_review_note` = :note
             WHERE `id` = :id',
            [
                'st' => 'REJECTED',
                'note' => $note,
                'id' => (int) $id,
            ]
        );

        try {
            Database::execute(
                "UPDATE `merchant_domain_requests` SET 
                    `status` = 'REJECTED',
                    `admin_note` = :note,
                    `reviewed_at` = :now
                 WHERE `merchant_id` = :mid AND `status` = 'PENDING'",
                ['note' => $note, 'now' => $now, 'mid' => (int) $id]
            );
        } catch (\Throwable $e) {}

        auditLog('MERCHANT_DOMAIN_REJECTED', [
            'id' => (int) $id,
            'slug' => $m['slug'],
            'note' => $note,
        ]);

        $updated = Database::selectOne('SELECT * FROM `merchants` WHERE `id` = :id', ['id' => (int) $id]);
        $emailSent = notifyMerchantDomainStatus($updated, 'REJECTED');
        jsonResponse(['success' => true, 'merchant' => $updated, 'email_sent' => $emailSent]);
    });

    $router->post('/api/admin/merchants/(\d+)/domain/revoke', function (string $id) {
        requireAdminAuth();
        ensureMerchantSchema();
        ensureMerchantDomainSchema();
        $m = Database::selectOne('SELECT * FROM `merchants` WHERE `id` = :id', ['id' => (int) $id]);
        if (!$m) {
            jsonResponse(['success' => false, 'error' => 'Merchant not found'], 404);
        }
        $b = getJsonBody();
        $note = mb_substr(trim((string) body($b, 'note', 'Domain revoked by admin')), 0, 255);

        Database::execute(
            'UPDATE `merchants` SET 
                `domain_status` = :st,
                `domain_review_note` = :note
             WHERE `id` = :id',
            [
                'st' => 'NONE',
                'note' => $note,
                'id' => (int) $id,
            ]
        );

        auditLog('MERCHANT_DOMAIN_REVOKED', [
            'id' => (int) $id,
            'slug' => $m['slug'],
            'note' => $note,
        ]);

        $updated = Database::selectOne('SELECT * FROM `merchants` WHERE `id` = :id', ['id' => (int) $id]);
        jsonResponse(['success' => true, 'merchant' => $updated]);
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
        if ($m['status'] === 'DRAFT' && empty($b['force'])) {
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

    // Admin endpoint: edit merchant trading name / business name
    $router->post('/api/admin/merchants/(\d+)/trading-name', function (string $id) {
        requireAdminAuth();
        ensureMerchantSchema();
        $b = getJsonBody();
        $businessName = mb_substr(trim((string) body($b, 'business_name', body($b, 'trading_name', ''))), 0, 120);
        if ($businessName === '') {
            jsonResponse(['success' => false, 'error' => 'Trading / business name cannot be empty'], 400);
        }
        $m = Database::selectOne('SELECT * FROM `merchants` WHERE `id` = :id', ['id' => (int) $id]);
        if (!$m) {
            jsonResponse(['success' => false, 'error' => 'Merchant not found'], 404);
        }

        $brand = json_decode((string) ($m['brand'] ?? ''), true) ?: [];
        $oldName = $m['business_name'] ?: ($brand['name'] ?? '');
        $brand['name'] = $businessName;

        Database::execute(
            'UPDATE `merchants` SET `business_name` = :bn, `brand` = :b WHERE `id` = :id',
            [
                'bn' => $businessName,
                'b' => json_encode($brand),
                'id' => (int) $id,
            ]
        );

        auditLog('MERCHANT_TRADING_NAME_UPDATED', [
            'id' => (int) $id,
            'email' => $m['email'],
            'old_name' => $oldName,
            'new_name' => $businessName,
        ]);

        $updated = Database::selectOne('SELECT * FROM `merchants` WHERE `id` = :id', ['id' => (int) $id]);
        jsonResponse(['success' => true, 'merchant' => $updated, 'business_name' => $businessName]);
    });

    // Admin endpoint: permanently delete a merchant account and all its store data
    $handleDeleteMerchant = function (string $id) {
        requireAdminAuth();
        ensureMerchantSchema();
        $m = Database::selectOne('SELECT * FROM `merchants` WHERE `id` = :id', ['id' => (int) $id]);
        if (!$m) {
            jsonResponse(['success' => false, 'error' => 'Merchant not found'], 404);
        }

        $mid = (int) $m['id'];
        $email = (string) $m['email'];
        $slug = (string) ($m['slug'] ?? '');

        // 1. Delete associated store customers
        Database::execute('DELETE FROM `store_customers` WHERE `merchant_id` = :id', ['id' => $mid]);

        // 2. Delete domain upgrade requests
        Database::execute('DELETE FROM `merchant_domain_requests` WHERE `merchant_id` = :id', ['id' => $mid]);

        // 3. Delete merchant withdrawals
        Database::execute('DELETE FROM `merchant_withdrawals` WHERE `merchant_id` = :id', ['id' => $mid]);

        // 4. Clean up any test store orders
        Database::execute('DELETE FROM `transactions` WHERE `merchant_id` = :id', ['id' => $mid]);

        // 5. Delete merchant store record
        Database::execute('DELETE FROM `merchants` WHERE `id` = :id', ['id' => $mid]);

        // 6. Delete merchant login account
        Database::execute('DELETE FROM `merchant_accounts` WHERE LOWER(`email`) = LOWER(:email)', ['email' => $email]);

        auditLog('ADMIN_MERCHANT_DELETED', [
            'id' => $mid,
            'email' => $email,
            'slug' => $slug,
        ]);

        jsonResponse([
            'success' => true,
            'message' => "Merchant '{$email}' and store data permanently deleted",
            'deleted_id' => $mid,
        ]);
    };

    $router->delete('/api/admin/merchants/(\d+)', $handleDeleteMerchant);
    $router->post('/api/admin/merchants/(\d+)/delete', $handleDeleteMerchant);
}
