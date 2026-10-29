<?php

declare(strict_types=1);

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/helpers.php';

/**
 * HostFi (HostCap) B2B API client — https://hostfi.readme.io
 *
 * Auth: POST /auth/token {clientId, clientSecret} returns a JWT valid ~1 hour, sent as `x-auth-token`.
 * Errors come back as {code, message}. Calls that move money (swap, payout) are never retried
 * automatically; payouts carry a clientReference so a repeat is rejected as DUPLICATE_TRANSACTION.
 */
class HostfiApiClient
{
    private string $baseUrl;
    private string $clientId;
    private string $clientSecret;
    private ?string $token = null;
    /** @var array<string,array<string,mixed>>|null */
    private ?array $assetsByCurrency = null;

    public function __construct()
    {
        $this->baseUrl = rtrim(HOSTFI_BASE_URL, '/');
        $this->clientId = HOSTFI_CLIENT_ID;
        $this->clientSecret = HOSTFI_CLIENT_SECRET;
    }

    public function isConfigured(): bool
    {
        return $this->clientId !== '' && $this->clientSecret !== '' && $this->baseUrl !== '';
    }

    // ─── Transport ───

    private function tokenFile(): string
    {
        return BASE_PATH . '/data/.hostfi_token.json';
    }

    private function accessToken(bool $refresh = false): string
    {
        if (!$refresh && $this->token !== null) {
            return $this->token;
        }
        $file = $this->tokenFile();
        if (!$refresh && is_file($file)) {
            $cached = json_decode((string) @file_get_contents($file), true);
            // Refresh a minute early so a token never expires mid-request.
            if (is_array($cached) && ($cached['expires'] ?? 0) > time() + 60 && !empty($cached['token'])) {
                return $this->token = (string) $cached['token'];
            }
        }
        if (!$this->isConfigured()) {
            throw new RuntimeException('HostFi is not configured');
        }
        $res = httpRequest('POST', $this->baseUrl . '/auth/token', [
            'headers' => ['Accept: application/json'],
            'body' => ['clientId' => $this->clientId, 'clientSecret' => $this->clientSecret],
            'timeout' => 20,
        ]);
        $res = $res['data'] ?? $res;
        $token = (string) ($res['token'] ?? '');
        if ($token === '') {
            throw new RuntimeException('HostFi did not return an access token');
        }
        $ttl = (int) ($res['expiresIn'] ?? 3600);
        @file_put_contents($file, json_encode(['token' => $token, 'expires' => time() + $ttl]), LOCK_EX);
        return $this->token = $token;
    }

    /**
     * @param array<string,mixed>|null $body
     * @return array<string,mixed>
     */
    private function request(string $method, string $path, ?array $body = null, bool $retryable = true): array
    {
        $send = fn (string $token) => httpRequest($method, $this->baseUrl . $path, [
            'headers' => ['Accept: application/json', 'x-auth-token: ' . $token],
            'body' => $body,
            'retries' => $retryable ? 1 : 0,
            'timeout' => 30,
        ]);
        try {
            $res = $send($this->accessToken());
        } catch (Exception $e) {
            if ($e->getCode() !== 401) {
                throw $e;
            }
            // Token revoked or expired early: fetch a new one once.
            $res = $send($this->accessToken(true));
        }
        // Responses are documented unwrapped; tolerate a {data: ...} envelope too.
        return isset($res['data']) && is_array($res['data']) ? $res['data'] : $res;
    }

    // ─── Wallets & currencies ───

    /** @return array<string,array<string,mixed>> wallet assets keyed by currency code */
    public function walletAssets(): array
    {
        if ($this->assetsByCurrency !== null) {
            return $this->assetsByCurrency;
        }
        $res = $this->request('GET', '/v1/assets');
        $out = [];
        foreach (($res['assets'] ?? $res) as $asset) {
            if (!is_array($asset)) {
                continue;
            }
            $code = strtoupper((string) ($asset['currency']['code'] ?? $asset['currency'] ?? ''));
            if ($code !== '' && !isset($out[$code])) {
                $out[$code] = $asset;
            }
        }
        return $this->assetsByCurrency = $out;
    }

    /** @return array<string,mixed> */
    public function walletAsset(string $currency): array
    {
        $asset = $this->walletAssets()[strtoupper($currency)] ?? null;
        if (!$asset || empty($asset['id'])) {
            throw new RuntimeException("No HostFi {$currency} wallet on this account");
        }
        return $asset;
    }

    /**
     * Networks a wallet asset can receive deposits on.
     *
     * @param array<string,mixed> $asset
     * @return string[]
     */
    public static function depositNetworks(array $asset): array
    {
        $cur = is_array($asset['currency'] ?? null) ? $asset['currency'] : [];
        // The currency's own network (ERC20 for ETH/USDT, BTC, SOL) is the main one; `networks`
        // lists only the extra chains. On the live API ETH is ERC20 + [BEP20, BASE].
        $networks = [];
        $mainActivities = $cur['activities'] ?? null;
        if (!empty($cur['network']) && (!is_array($mainActivities) || in_array('DEPOSIT', $mainActivities, true))) {
            $networks[] = (string) $cur['network'];
        }
        foreach (($cur['networks'] ?? []) as $n) {
            $activities = $n['activities'] ?? null;
            if (is_array($activities) && !in_array('DEPOSIT', $activities, true)) {
                continue;
            }
            if (!empty($n['network'])) {
                $networks[] = (string) $n['network'];
            }
        }
        return array_values(array_unique($networks));
    }

    // ─── Rates ───

    /** Naira paid by HostFi for one unit of $currency, before Velcro's fee. */
    public function ngnPerUnit(string $currency): float
    {
        return $this->rate($currency, 'NGN');
    }

    /** Units of $to for one unit of $from. Throws if HostFi has no such pair (e.g. ETH→USD). */
    public function rate(string $from, string $to): float
    {
        $from = strtoupper($from);
        $res = $this->request('GET', '/v1/conversions?fromCurrency=' . rawurlencode($from) . '&toCurrency=' . rawurlencode(strtoupper($to)));
        // With both currencies given HostFi returns one object (not the documented `rates` list),
        // and `rate` is units of toCurrency per one fromCurrency, as a string. Verified on the live API.
        $row = isset($res['rate']) ? $res : (($res['rates'] ?? [])[0] ?? null);
        $rate = (float) ($row['rate'] ?? 0);
        if ($rate <= 0 || strtoupper((string) ($row['fromCurrency'] ?? $from)) !== $from) {
            throw new RuntimeException("No HostFi rate for {$from}/{$to}");
        }
        return $rate;
    }

    // ─── Collections ───

    /** @return array<string,mixed> address object: id, address, network, memo, ... */
    public function createDepositAddress(string $assetId, string $customId, string $network): array
    {
        return $this->request('POST', '/v1/collections/crypto/addresses', [
            'assetId' => $assetId,
            'customId' => $customId,
            'network' => $network,
            'countryCode' => 'NG',
        ], false);
    }

    /** @return array<string,mixed> */
    public function collectionTransaction(string $id): array
    {
        return $this->request('GET', '/v1/collections/transactions/' . rawurlencode($id));
    }

    // ─── Swap ───

    /**
     * Convert $amount of $from into $to between our own wallets.
     *
     * @return array<string,mixed> the credit leg (amount received in $to)
     */
    public function swap(string $from, string $to, float $amount): array
    {
        $source = $this->walletAsset($from);
        $target = $this->walletAsset($to);
        $res = $this->request('POST', '/v1/assets/swap', [
            'source' => ['currency' => strtoupper($from), 'assetId' => $source['id']],
            'target' => ['currency' => strtoupper($to), 'assetId' => $target['id']],
            'amount' => ['value' => $amount, 'currency' => strtoupper($from)],
        ], false);
        foreach (($res['transactions'] ?? []) as $leg) {
            if (strtoupper((string) ($leg['type'] ?? '')) === 'CREDIT') {
                return $leg;
            }
        }
        throw new RuntimeException('HostFi swap returned no credit leg');
    }

    /** @return array<string,mixed> one wallet transaction (e.g. a swap's credit leg), from HostFi */
    public function assetTransaction(string $reference): array
    {
        return $this->request('GET', '/v1/assets/transactions/' . rawurlencode($reference));
    }

    // ─── Payouts ───

    /** @return array<int,array{bankId:string,bankName:string}> */
    public function banks(string $country = 'NG'): array
    {
        $file = BASE_PATH . '/data/.hostfi_banks_' . strtolower($country) . '.json';
        if (is_file($file) && filemtime($file) > time() - 86400) {
            $cached = json_decode((string) @file_get_contents($file), true);
            if (is_array($cached) && $cached) {
                return $cached;
            }
        }
        $res = $this->request('GET', '/v1/payout/banks/' . rawurlencode(strtoupper($country)) . '/list');
        $banks = array_values(array_filter($res['banks'] ?? [], fn ($b) => !empty($b['bankId'])));
        if ($banks) {
            @file_put_contents($file, json_encode($banks), LOCK_EX);
        }
        return $banks;
    }

    /**
     * HostFi bank for a bank the user picked from our list. HostFi ids look like "NG::100004";
     * match on the code after "::" first, then on the normalised name.
     *
     * @return array{bankId:string,bankName:string}|null
     */
    public function matchBank(string $code, string $name): ?array
    {
        $banks = $this->banks('NG');
        $code = trim($code);
        foreach ($banks as $b) {
            if ($code !== '' && (explode('::', (string) $b['bankId'])[1] ?? '') === $code) {
                return $b;
            }
        }
        $norm = static fn (string $s): string => preg_replace('/\b(bank|plc|limited|ltd|nigeria|mfb|microfinance|psb|international)\b|[^a-z0-9]/', '', strtolower($s)) ?? '';
        $want = $norm($name);
        if ($want === '') {
            return null;
        }
        foreach ($banks as $b) {
            if ($norm((string) $b['bankName']) === $want) {
                return $b;
            }
        }
        return null;
    }

    /** @return array<string,mixed> bankId, bankName, accountName, accountNumber */
    public function lookupAccount(string $bankId, string $accountNumber): array
    {
        return $this->request('POST', '/v1/payout/accounts/lookup', ['bankId' => $bankId, 'accountNumber' => $accountNumber]);
    }

    /**
     * Send naira to a bank account. Never retried here: the caller re-checks by clientReference.
     *
     * @param array{accountName:string,accountNumber:string,bankId:string,bankName:string} $bank
     * @return array<string,mixed> WithdrawalTransaction
     */
    public function payoutToBank(float $amountNgn, array $bank, string $clientReference, string $memo): array
    {
        $ngn = $this->walletAsset('NGN');
        return $this->request('POST', '/v1/payout/transactions', [
            'assetId' => $ngn['id'],
            'methodId' => 'BANK_TRANSFER',
            'amount' => $amountNgn,
            'currency' => 'NGN',
            'clientReference' => $clientReference,
            'memo' => $memo,
            'recipient' => [
                'type' => 'BANK',
                'method' => 'BANK_TRANSFER',
                'currency' => 'NGN',
                'accountName' => $bank['accountName'],
                'accountNumber' => $bank['accountNumber'],
                'bankId' => $bank['bankId'],
                'bankName' => $bank['bankName'],
            ],
        ], false);
    }

    /** @return array<string,mixed> WithdrawalTransaction, looked up by HostFi reference or our clientReference */
    public function payout(string $reference): array
    {
        return $this->request('GET', '/v1/payout/transactions/' . rawurlencode($reference));
    }
}

function hostfiApi(): HostfiApiClient
{
    static $client = null;
    return $client ??= new HostfiApiClient();
}
