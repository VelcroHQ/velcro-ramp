<?php

declare(strict_types=1);

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/helpers.php';

class SwitchApiClient
{
    private string $baseUrl;
    private string $serviceKey;

    public function __construct()
    {
        $this->baseUrl = rtrim(SWITCH_BASE_URL, '/');
        $this->serviceKey = SWITCH_SERVICE_KEY;
    }

    /**
     * Make a request to the Switch API with retries.
     *
     * @param array<string,mixed> $options
     * @return array<string,mixed>
     */
    public function request(string $endpoint, array $options = [], int $retries = 2): array
    {
        $url = $this->baseUrl . $endpoint;
        $headers = [
            'Content-Type: application/json',
            'Accept: application/json',
            'x-service-key: ' . $this->serviceKey,
        ];
        if (isset($options['headers'])) {
            foreach ($options['headers'] as $k => $v) {
                if (is_int($k)) {
                    $headers[] = $v;
                } else {
                    $headers[] = "{$k}: {$v}";
                }
            }
            unset($options['headers']);
        }
        $options['headers'] = $headers;
        $options['retries'] = $retries;
        $options['timeout'] = $options['timeout'] ?? 30;

        return httpRequest($options['method'] ?? 'GET', $url, $options);
    }

    public function getAssets(): array
    {
        return $this->request('/asset');
    }

    public function getRates(array $query = []): array
    {
        $qs = http_build_query($query);
        return $this->request('/rates' . ($qs ? '?' . $qs : ''));
    }

    public function getInstitutions(array $query = []): array
    {
        $qs = http_build_query($query);
        return $this->request('/institution' . ($qs ? '?' . $qs : ''));
    }

    public function lookupBeneficiary(string $country, array $beneficiary): array
    {
        return $this->request('/institution/lookup', [
            'method' => 'POST',
            'body' => ['country' => $country, 'beneficiary' => $beneficiary],
        ]);
    }

    public function getRequirements(array $query): array
    {
        $qs = http_build_query($query);
        return $this->request('/requirement?' . $qs);
    }

    public function getRate(array $payload): array
    {
        $direction = $payload['direction'];
        $endpoint = $direction === 'ONRAMP' ? '/onramp/rate' : '/offramp/rate';
        $body = array_filter([
            'asset' => $payload['asset'] ?? null,
            'country' => $payload['country'],
            'currency' => $payload['currency'] ?? null,
            'channel' => $payload['channel'] ?? null,
            'developer_fee' => getPlatformFee(),
            'developer_recipient' => DEVELOPER_RECIPIENT,
        ], static fn ($v) => $v !== null && $v !== '');
        return $this->request($endpoint, ['method' => 'POST', 'body' => $body]);
    }

    public function initiateOrder(array $payload): array
    {
        $direction = $payload['direction'];
        $endpoint = $direction === 'ONRAMP' ? '/onramp/initiate' : '/offramp/initiate';
        $body = [
            'amount' => $payload['amount'],
            'country' => $payload['country'],
            'asset' => $payload['asset'],
            'currency' => $payload['currency'] ?? null,
            'channel' => $payload['channel'] ?? null,
            'beneficiary' => $payload['beneficiary'] ?? null,
            'exact_output' => $payload['exact_output'] ?? false,
            'reference' => $payload['reference'],
            'reason' => $payload['reason'] ?? 'PERSONAL_TRANSFER',
            'narration' => 'Velcro Settlement',
        ];
        if (DEVELOPER_RECIPIENT !== '') {
            $body['developer_fee'] = getPlatformFee();
            $body['developer_recipient'] = DEVELOPER_RECIPIENT;
        }
        if (!empty($payload['callback_url'])) {
            $body['callback_url'] = $payload['callback_url'];
        }
        if ($direction === 'OFFRAMP') {
            $body['static'] = false;
            $body['sender_name'] = 'Velcro Ramp';
        } elseif ($direction === 'ONRAMP' && !empty($payload['wallet_address'])) {
            $body['wallet_address'] = $payload['wallet_address'];
        }
        // Remove null/empty optional fields before sending
        $body = array_filter($body, static function ($v, $k) {
            if ($k === 'exact_output' || $k === 'static') {
                return true;
            }
            return $v !== null && $v !== '';
        }, ARRAY_FILTER_USE_BOTH);
        return $this->request($endpoint, ['method' => 'POST', 'body' => $body]);
    }

    public function getPaymentStatus(string $reference): array
    {
        return $this->request('/payment/status?reference=' . urlencode($reference));
    }

    public function confirmPayment(string $reference, ?string $hash = null): array
    {
        $body = ['reference' => $reference];
        if ($hash !== null) {
            $body['hash'] = $hash;
        }
        return $this->request('/payment/confirm', ['method' => 'POST', 'body' => $body]);
    }

    public function getHistory(array $query = []): array
    {
        $qs = http_build_query($query);
        return $this->request('/payment/history' . ($qs ? '?' . $qs : ''));
    }

    public function getDeveloperFees(): array
    {
        return $this->request('/developer/fees');
    }

    public function withdraw(string $asset, string $recipientAddress): array
    {
        return $this->request('/developer/withdraw', [
            'method' => 'POST',
            'body' => [
                'asset' => $asset,
                'beneficiary' => ['wallet_address' => $recipientAddress],
            ],
        ]);
    }
}

// Singleton accessor for shared-hosting simplicity
function switchApi(): SwitchApiClient
{
    static $client;
    if (!isset($client)) {
        $client = new SwitchApiClient();
    }
    return $client;
}
