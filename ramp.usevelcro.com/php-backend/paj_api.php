<?php

declare(strict_types=1);

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';

/**
 * PAJ Ramp HTTP client.
 *
 * The original Node backend used the proprietary `paj_ramp` npm package. This
 * class replicates its surface by calling the PAJ HTTP API directly, using the
 * documented endpoints in `node_modules/paj_ramp/lib/API_REFERENCE.md`.
 *
 * Production base URL: https://api.paj.cash
 * Staging base URL:    https://api-staging.paj.cash
 */
class PajApiClient
{
    public const ASSETS = [
        ['id' => 'sol', 'symbol' => 'SOL', 'name' => 'Solana', 'mint' => 'So11111111111111111111111111111111111111112', 'chain' => 'SOLANA', 'logo' => '/logos/solana.png'],
        ['id' => 'jup', 'symbol' => 'JUP', 'name' => 'Jupiter', 'mint' => 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'chain' => 'SOLANA', 'logo' => '/logos/jup.png'],
        ['id' => 'bonk', 'symbol' => 'BONK', 'name' => 'Bonk', 'mint' => 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'chain' => 'SOLANA', 'logo' => 'https://assets.coingecko.com/coins/images/28600/small/bonk.jpg'],
        ['id' => 'wif', 'symbol' => 'WIF', 'name' => 'dogwifhat', 'mint' => 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', 'chain' => 'SOLANA', 'logo' => 'https://assets.coingecko.com/coins/images/33566/small/dogwifhat.jpg'],
        ['id' => 'pyth', 'symbol' => 'PYTH', 'name' => 'Pyth Network', 'mint' => 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', 'chain' => 'SOLANA', 'logo' => 'https://assets.coingecko.com/coins/images/31924/small/pyth.png'],
        ['id' => 'usdg', 'symbol' => 'USDG', 'name' => 'Global Dollar', 'mint' => '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', 'chain' => 'SOLANA', 'logo' => '/logos/usdg.png'],
        ['id' => 'usdt', 'symbol' => 'USDT', 'name' => 'Tether USD', 'mint' => 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'chain' => 'SOLANA', 'logo' => '/logos/usdt.png'],
        ['id' => 'usdc', 'symbol' => 'USDC', 'name' => 'USD Coin', 'mint' => 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'chain' => 'SOLANA', 'logo' => '/logos/usdc.png'],
    ];

    private string $baseUrl;
    private string $apiKey;

    public function __construct()
    {
        $this->baseUrl = rtrim(PAJ_BASE_URL, '/');
        $this->apiKey = PAJ_API_KEY;
    }

    public function isConfigured(): bool
    {
        return $this->apiKey !== '' && $this->baseUrl !== '' && $this->baseUrl !== 'https://api.paj.ramp';
    }

    private function getPajEmail(): string
    {
        $settings = loadSettings();
        return $settings['paj_email'] ?? PAJ_EMAIL;
    }

    /**
     * Make an HTTP request to the PAJ API.
     *
     * @param array<string,mixed> $body
     */
    private function request(string $method, string $endpoint, array $body = [], ?string $token = null, int $retries = 1): array
    {
        $url = $this->baseUrl . $endpoint;
        $headers = [
            'Content-Type: application/json',
            'Accept: application/json',
        ];
        if ($token !== null) {
            $headers[] = 'Authorization: Bearer ' . $token;
        }

        return httpRequest(strtoupper($method), $url, [
            'method' => strtoupper($method),
            'headers' => $headers,
            'body' => $body,
            'retries' => $retries,
            'timeout' => 30,
        ]);
    }

    /**
     * Make an unauthenticated request that only needs the business API key.
     *
     * @param array<string,mixed> $body
     */
    private function apiKeyRequest(string $method, string $endpoint, array $body = []): array
    {
        $url = $this->baseUrl . $endpoint;
        $headers = [
            'Content-Type: application/json',
            'Accept: application/json',
            'x-api-key: ' . $this->apiKey,
        ];

        return httpRequest(strtoupper($method), $url, [
            'method' => strtoupper($method),
            'headers' => $headers,
            'body' => $body,
            'retries' => 1,
            'timeout' => 30,
        ]);
    }

    // ─── Session Management ───

    public function initiateSession(): array
    {
        if (!$this->isConfigured()) {
            throw new Exception('PAJ API key / base URL not configured');
        }
        $result = $this->apiKeyRequest('POST', '/pub/initiate', [
            'email' => $this->getPajEmail(),
        ]);
        return [
            'success' => true,
            'email' => $this->getPajEmail(),
            'message' => 'OTP sent to email',
        ];
    }

    public function verifySession(string $otp): array
    {
        if (!$this->isConfigured()) {
            throw new Exception('PAJ API key / base URL not configured');
        }
        $result = $this->apiKeyRequest('POST', '/pub/verify', [
            'email' => $this->getPajEmail(),
            'otp' => $otp,
            'device' => [
                'uuid' => 'velcro-server-' . time(),
                'device' => 'Server',
                'os' => 'Linux',
                'browser' => 'PHP',
                'ip' => '127.0.0.1',
            ],
        ]);
        $session = [
            'token' => $result['token'] ?? '',
            'recipient' => $result['recipient'] ?? null,
            'isActive' => filter_var($result['isActive'] ?? true, FILTER_VALIDATE_BOOLEAN),
            'expiresAt' => $result['expiresAt'] ?? null,
            'createdAt' => gmdate('c'),
        ];
        $this->saveSession($session);
        return ['success' => true, 'session' => $session];
    }

    public function saveSession(array $session): void
    {
        try {
            Database::execute('DELETE FROM `' . PAJ_SESSION_TABLE . '`');
            Database::insert(PAJ_SESSION_TABLE, [
                'token' => $session['token'],
                'recipient' => $session['recipient'] ?? null,
                'is_active' => ($session['isActive'] ?? true) ? 1 : 0,
                'expires_at' => !empty($session['expiresAt']) ? date('Y-m-d H:i:s', strtotime($session['expiresAt'])) : null,
                'created_at' => !empty($session['createdAt']) ? date('Y-m-d H:i:s', strtotime($session['createdAt'])) : gmdate('Y-m-d H:i:s'),
            ]);
        } catch (Throwable $e) {
            error_log('Failed to save PAJ session to database: ' . $e->getMessage());
        }
    }

    public function loadSession(): ?array
    {
        try {
            $row = Database::selectOne('SELECT * FROM `' . PAJ_SESSION_TABLE . '` ORDER BY `id` DESC LIMIT 1');
            if ($row === null) {
                return null;
            }
            return [
                'token' => $row['token'],
                'recipient' => $row['recipient'],
                'isActive' => (bool) $row['is_active'],
                'expiresAt' => $row['expires_at'],
                'createdAt' => $row['created_at'],
            ];
        } catch (Throwable $e) {
            error_log('Failed to load PAJ session from database: ' . $e->getMessage());
            return null;
        }
    }

    public function isSessionValid(?array $session = null): bool
    {
        if ($session === null) {
            $session = $this->loadSession();
        }
        if ($session === null || empty($session['token'])) {
            return false;
        }
        if (!empty($session['expiresAt'])) {
            return strtotime($session['expiresAt']) > time();
        }
        return true;
    }

    public function getSessionToken(): string
    {
        $session = $this->loadSession();
        if (!$this->isSessionValid($session)) {
            throw new Exception('PAJ session expired. Please initiate and verify OTP via admin dashboard.');
        }
        return $session['token'];
    }

    public function getSessionStatus(): array
    {
        $session = $this->loadSession();
        return [
            'configured' => $this->isConfigured(),
            'valid' => $this->isSessionValid($session),
            'expiresAt' => $session['expiresAt'] ?? null,
        ];
    }

    // ─── Rates & Values ───

    public function getPajRate(): array
    {
        $result = $this->request('GET', '/pub/rate');
        // Match the shape returned by the original Node wrapper.
        return [
            'onramp' => $result['onRampRate'] ?? null,
            'offramp' => $result['offRampRate'] ?? null,
        ];
    }

    public function getRate(float $amount): array
    {
        return $this->request('GET', '/pub/rate/' . rawurlencode((string) $amount));
    }

    public function getTokenValue(float $fiatAmount, string $mint): array
    {
        $qs = http_build_query(['amount' => $fiatAmount, 'mint' => $mint, 'currency' => 'NGN']);
        return $this->request('GET', '/pub/rates/onramp-value?' . $qs, [], $this->getSessionToken());
    }

    public function getFiatValue(float $amount, string $mint): array
    {
        $qs = http_build_query(['amount' => $amount, 'mint' => $mint, 'currency' => 'NGN']);
        return $this->request('GET', '/pub/rates/offramp-value?' . $qs, [], $this->getSessionToken());
    }

    // ─── Banks & Accounts ───

    public function getBanks(): array
    {
        $cacheFile = __DIR__ . '/data/paj_banks_cache.json';

        // 1. Attempt live request if session is currently valid
        if ($this->isSessionValid()) {
            try {
                $banks = $this->request('GET', '/pub/bank', [], $this->getSessionToken());
                if (!empty($banks) && is_array($banks)) {
                    @file_put_contents($cacheFile, json_encode($banks, JSON_PRETTY_PRINT));
                    return $banks;
                }
            } catch (Throwable $e) {
                error_log('PAJ getBanks live fetch failed: ' . $e->getMessage());
            }
        }

        // 2. Return cached bank directory if available
        if (file_exists($cacheFile)) {
            $cached = json_decode((string) file_get_contents($cacheFile), true);
            if (is_array($cached) && !empty($cached)) {
                return $cached;
            }
        }

        // 3. Fallback to comprehensive Nigerian banking directory
        return $this->getFallbackBanks();
    }

    /**
     * Complete fallback directory of Nigerian banks with official NIP codes and PAJ IDs.
     *
     * @return array<int, array<string, string>>
     */
    public function getFallbackBanks(): array
    {
        return [
            ['id' => '058', 'code' => '058', 'name' => 'Guaranty Trust Bank (GTBank)', 'country' => 'NG'],
            ['id' => '044', 'code' => '044', 'name' => 'Access Bank', 'country' => 'NG'],
            ['id' => '057', 'code' => '057', 'name' => 'Zenith Bank', 'country' => 'NG'],
            ['id' => '011', 'code' => '011', 'name' => 'First Bank of Nigeria', 'country' => 'NG'],
            ['id' => '033', 'code' => '033', 'name' => 'United Bank for Africa (UBA)', 'country' => 'NG'],
            ['id' => '100004', 'code' => '100004', 'name' => 'Opay (PayCom)', 'country' => 'NG'],
            ['id' => '100033', 'code' => '100033', 'name' => 'PalmPay', 'country' => 'NG'],
            ['id' => '090267', 'code' => '090267', 'name' => 'Kuda Bank', 'country' => 'NG'],
            ['id' => '090405', 'code' => '090405', 'name' => 'Moniepoint MFB', 'country' => 'NG'],
            ['id' => '070', 'code' => '070', 'name' => 'Fidelity Bank', 'country' => 'NG'],
            ['id' => '214', 'code' => '214', 'name' => 'First City Monument Bank (FCMB)', 'country' => 'NG'],
            ['id' => '221', 'code' => '221', 'name' => 'Stanbic IBTC Bank', 'country' => 'NG'],
            ['id' => '232', 'code' => '232', 'name' => 'Sterling Bank', 'country' => 'NG'],
            ['id' => '032', 'code' => '032', 'name' => 'Union Bank of Nigeria', 'country' => 'NG'],
            ['id' => '215', 'code' => '215', 'name' => 'Unity Bank', 'country' => 'NG'],
            ['id' => '035', 'code' => '035', 'name' => 'Wema Bank', 'country' => 'NG'],
            ['id' => '076', 'code' => '076', 'name' => 'Polaris Bank', 'country' => 'NG'],
            ['id' => '050', 'code' => '050', 'name' => 'Ecobank Nigeria', 'country' => 'NG'],
            ['id' => '082', 'code' => '082', 'name' => 'Keystone Bank', 'country' => 'NG'],
            ['id' => '090110', 'code' => '090110', 'name' => 'VFD Microfinance Bank', 'country' => 'NG'],
            ['id' => '090701', 'code' => '090701', 'name' => 'Carbon', 'country' => 'NG'],
            ['id' => '090551', 'code' => '090551', 'name' => 'FairMoney MFB', 'country' => 'NG'],
            ['id' => '301', 'code' => '301', 'name' => 'Jaiz Bank', 'country' => 'NG'],
            ['id' => '302', 'code' => '302', 'name' => 'Taj Bank', 'country' => 'NG'],
            ['id' => '303', 'code' => '303', 'name' => 'Lotus Bank', 'country' => 'NG'],
            ['id' => '101', 'code' => '101', 'name' => 'Providus Bank', 'country' => 'NG'],
            ['id' => '102', 'code' => '102', 'name' => 'Titan Trust Bank', 'country' => 'NG'],
            ['id' => '105', 'code' => '105', 'name' => 'PremiumTrust Bank', 'country' => 'NG'],
            ['id' => '068', 'code' => '068', 'name' => 'Standard Chartered Bank', 'country' => 'NG'],
            ['id' => '023', 'code' => '023', 'name' => 'Citibank Nigeria', 'country' => 'NG'],
            ['id' => '104', 'code' => '104', 'name' => 'Parallex Bank', 'country' => 'NG'],
            ['id' => '106', 'code' => '106', 'name' => 'Signature Bank', 'country' => 'NG'],
            ['id' => '090175', 'code' => '090175', 'name' => 'Rubies MFB', 'country' => 'NG']
        ];
    }

    public function resolveBankAccount(string $bankId, string $accountNumber): array
    {
        $qs = http_build_query(['bankId' => $bankId, 'accountNumber' => $accountNumber]);
        return $this->request('GET', '/pub/bank-account/confirm?' . $qs, [], $this->getSessionToken());
    }

    // ─── Orders ───

    public function createOnrampOrder(float $fiatAmount, string $recipient, string $mint, ?float $businessUSDCFee = null, ?string $webhookUrl = null): array
    {
        $payload = [
            'fiatAmount' => $fiatAmount,
            'currency' => 'NGN',
            'recipient' => $recipient,
            'mint' => $mint,
            'chain' => 'SOLANA',
            'webhookURL' => $webhookUrl ?? (CALLBACK_URL !== '' ? CALLBACK_URL . '/webhook/paj' : null),
        ];
        if ($businessUSDCFee !== null && $businessUSDCFee > 0) {
            $payload['businessUSDCFee'] = $businessUSDCFee;
        }
        $payload = array_filter($payload, static fn ($v) => $v !== null && $v !== '');
        return $this->request('POST', '/pub/onramp', $payload, $this->getSessionToken());
    }

    public function createOfframpOrder(float $fiatAmount, string $mint, string $bank, string $accountNumber, ?float $businessUSDCFee = null, ?string $webhookUrl = null): array
    {
        $payload = [
            'bank' => $bank,
            'accountNumber' => $accountNumber,
            'currency' => 'NGN',
            'fiatAmount' => $fiatAmount,
            'mint' => $mint,
            'chain' => 'SOLANA',
            'webhookURL' => $webhookUrl ?? (CALLBACK_URL !== '' ? CALLBACK_URL . '/webhook/paj' : null),
        ];
        if ($businessUSDCFee !== null && $businessUSDCFee > 0) {
            $payload['businessUSDCFee'] = $businessUSDCFee;
        }
        $payload = array_filter($payload, static fn ($v) => $v !== null && $v !== '');
        return $this->request('POST', '/pub/offramp', $payload, $this->getSessionToken());
    }

    public function getTransactionStatus(string $txId): array
    {
        return $this->request('GET', '/pub/transactions/' . urlencode($txId), [], $this->getSessionToken());
    }

    public function getAssets(): array
    {
        return self::ASSETS;
    }
}

function pajApi(): PajApiClient
{
    static $client;
    if (!isset($client)) {
        $client = new PajApiClient();
    }
    return $client;
}
