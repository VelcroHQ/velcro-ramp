<?php

declare(strict_types=1);

require_once __DIR__ . '/../paj_api.php';
require_once __DIR__ . '/../switch_api.php';

function registerWebhookRoutes(Router $router): void
{
    $router->post('/webhook/switch', function () {
        $rawBody = file_get_contents('php://input') ?: '';
        $payload = json_decode($rawBody, true) ?: [];
        $ip = clientIp();

        $switchKey = trim(SWITCH_SERVICE_KEY !== '' ? SWITCH_SERVICE_KEY : SWITCH_WEBHOOK_SECRET);
        $isPlaceholder = ($switchKey === '' || str_starts_with($switchKey, 'your_'));
        $sig = $_SERVER['HTTP_X_SWITCH_SIGNATURE'] ?? $_SERVER['HTTP_X_WEBHOOK_SIGNATURE'] ?? $_SERVER['HTTP_X_SIGNATURE'] ?? '';

        if (!$isPlaceholder && $sig !== '') {
            if (!verifySwitchWebhook($rawBody, $sig, $switchKey)) {
                error_log('[Switch Webhook] Invalid Switch signature rejected');
                auditLog('WEBHOOK_REJECTED', ['ip' => $ip, 'reason' => 'invalid_signature', 'provider' => 'switch']);
                jsonResponse(['success' => false, 'error' => 'Invalid signature'], 401);
            }
        }

        error_log('[Switch Webhook Received] ' . json_encode($payload));

        $reference = $payload['reference']
            ?? ($payload['data']['reference']
            ?? ($payload['id']
            ?? ($payload['data']['id'] ?? null)));

        $status = $payload['status']
            ?? ($payload['data']['status']
            ?? ($payload['state']
            ?? ($payload['data']['state']
            ?? ($payload['event'] ?? null))));

        if ($reference) {
            $data = $payload['data'] ?? [];
            $meta = $data['meta'] ?? ($payload['meta'] ?? []);
            $hash = $meta['hash'] ?? ($data['hash'] ?? ($payload['hash'] ?? null));
            $explorerUrl = $meta['explorer_url'] ?? ($data['explorer_url'] ?? ($payload['explorer_url'] ?? null));

            // Query live Switch status to ensure authoritative state
            try {
                $liveStatusData = switchApi()->getPaymentStatus((string)$reference);
                if (!empty($liveStatusData['data']['status'])) {
                    $d = $liveStatusData['data'];
                    $status = $d['status'];
                    $m = $d['meta'] ?? [];
                    $hash = $m['hash'] ?? ($d['hash'] ?? $hash);
                    $explorerUrl = $m['explorer_url'] ?? ($d['explorer_url'] ?? $explorerUrl);
                    $payload = array_merge($payload, $liveStatusData);
                }
            } catch (Throwable $e) {
                error_log("Failed to fetch live status in Switch webhook for {$reference}: " . $e->getMessage());
            }

            if ($status) {
                $normalizedStatus = strtoupper((string)$status);
                Database::safeExecute(
                    'UPDATE `transactions` SET `status` = :status, `meta` = :meta, `hash` = COALESCE(:hash, `hash`), `explorer_url` = COALESCE(:explorer_url, `explorer_url`), `updated_at` = NOW() WHERE `reference` = :reference OR `switch_reference` = :reference',
                    [
                        'status' => $normalizedStatus,
                        'meta' => jsonEncodeNullable($payload),
                        'hash' => $hash,
                        'explorer_url' => $explorerUrl,
                        'reference' => (string)$reference,
                    ]
                );
                error_log("[Switch Webhook] Updated status of {$reference} to {$normalizedStatus}");
            }
        }

        jsonResponse(['success' => true, 'received' => true]);
    });

    $router->post('/webhook/paj', function () {
        $rawBody = file_get_contents('php://input') ?: '';
        $payload = json_decode($rawBody, true) ?: getJsonBody();
        $ip = clientIp();

        $pajSecret = trim(PAJ_WEBHOOK_SECRET);
        $isPlaceholder = ($pajSecret === '' || str_starts_with($pajSecret, 'your_'));
        $sig = $_SERVER['HTTP_X_WEBHOOK_SIGNATURE'] ?? $_SERVER['HTTP_X_PAJ_SIGNATURE'] ?? $_SERVER['HTTP_X_SIGNATURE'] ?? $_SERVER['HTTP_SIGNATURE'] ?? '';

        if (!$isPlaceholder && $sig !== '') {
            $validHmac = hash_equals(hash_hmac('sha256', $rawBody, $pajSecret), $sig);
            $validHash = verifyWebhookSignature($pajSecret, $payload, $sig);
            if (!$validHmac && !$validHash) {
                error_log('[PAJ Webhook] Invalid signature rejected');
                auditLog('WEBHOOK_REJECTED', ['ip' => $ip, 'reason' => 'invalid_signature', 'provider' => 'paj']);
                jsonResponse(['success' => false, 'error' => 'Invalid signature'], 401);
            }
        }

        error_log('[PAJ Webhook Received] ' . json_encode($payload));

        $txId = $payload['id']
            ?? ($payload['data']['id']
            ?? ($payload['reference']
            ?? ($payload['data']['reference']
            ?? ($payload['orderId']
            ?? ($payload['data']['orderId']
            ?? ($payload['transactionId']
            ?? ($payload['data']['transactionId'] ?? null)))))));

        $status = $payload['status']
            ?? ($payload['data']['status']
            ?? ($payload['state']
            ?? ($payload['data']['state']
            ?? ($payload['event'] ?? null))));

        $hash = $payload['signature']
            ?? ($payload['hash']
            ?? ($payload['txHash']
            ?? ($payload['tx_hash']
            ?? ($payload['data']['signature']
            ?? ($payload['data']['hash'] ?? null)))));

        $recipient = $payload['recipient']
            ?? ($payload['wallet_address']
            ?? ($payload['data']['recipient']
            ?? ($payload['data']['wallet_address'] ?? null)));

        if ($txId) {
            // Live query PAJ directly to ensure 100% authoritative final state
            try {
                if (pajApi()->isConfigured()) {
                    $liveData = pajApi()->getTransactionStatus((string)$txId);
                    if (!empty($liveData['status'])) {
                        $status = $liveData['status'];
                        $hash = $liveData['signature'] ?? ($liveData['hash'] ?? $hash);
                        $recipient = $liveData['recipient'] ?? ($liveData['address'] ?? $recipient);
                        $payload = array_merge($payload, $liveData);
                    }
                }
            } catch (Throwable $e) {
                error_log("Failed to fetch live status in PAJ webhook for {$txId}: " . $e->getMessage());
            }

            if ($status) {
                $mappedStatus = mapPajStatus((string)$status);
                $count = Database::safeExecute(
                    'UPDATE `transactions` SET `status` = :status, `meta` = :meta, `hash` = COALESCE(:hash, `hash`), `wallet_address` = COALESCE(:wallet_address, `wallet_address`), `updated_at` = NOW() WHERE `reference` = :id OR `switch_reference` = :id',
                    [
                        'status' => $mappedStatus,
                        'meta' => jsonEncodeNullable($payload),
                        'hash' => $hash,
                        'wallet_address' => $recipient,
                        'id' => (string)$txId,
                    ]
                );
                if ($count > 0) {
                    error_log("✅ PAJ webhook updated tx {$txId} → {$mappedStatus}");
                } else {
                    error_log("⚠️ PAJ webhook: no tx updated for {$txId} (mapped status: {$mappedStatus})");
                }
            }
        } else {
            error_log('⚠️ PAJ webhook: missing transaction id or reference');
        }

        jsonResponse(['success' => true, 'received' => true]);
    });
}
