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

        // The payload is unauthenticated when no signature is sent, so it only tells us
        // which reference to re-check. Only live data from Switch is written; if that
        // lookup fails, the poller picks the transaction up later.
        if ($reference) {
            try {
                $liveStatusData = switchApi()->getPaymentStatus((string)$reference);
                if (!empty($liveStatusData['data']['status'])) {
                    $updatedTx = updateSwitchTransactionFromData((string)$reference, $liveStatusData['data']);
                    if ($updatedTx) {
                        error_log("[Switch Webhook] Updated transaction {$reference} (status: " . ($updatedTx['status'] ?? '') . ", amount: " . ($updatedTx['amount'] ?? '') . ", dest_amount: " . ($updatedTx['destination_amount'] ?? '') . ")");
                    }
                }
            } catch (Throwable $e) {
                error_log("Failed to fetch live status in Switch webhook for {$reference}: " . $e->getMessage());
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

        if ($txId) {
            // The payload is unauthenticated when no signature is sent, so only live data
            // from PAJ is written. If that lookup fails, the poller picks the transaction up later.
            $status = null;
            try {
                if (pajApi()->isConfigured()) {
                    $liveData = pajApi()->getTransactionStatus((string)$txId);
                    if (!empty($liveData['status'])) {
                        $status = $liveData['status'];
                        $hash = $liveData['signature'] ?? ($liveData['hash'] ?? null);
                        $recipient = $liveData['recipient'] ?? ($liveData['address'] ?? null);
                        $payload = $liveData;
                    }
                }
            } catch (Throwable $e) {
                error_log("Failed to fetch live status in PAJ webhook for {$txId}: " . $e->getMessage());
            }

            if ($status) {
                $mappedStatus = mapPajStatus((string)$status);
                $count = Database::safeExecute(
                    'UPDATE `transactions` SET `status` = :status, `meta` = :meta, `hash` = COALESCE(:hash, `hash`), `wallet_address` = COALESCE(:wallet_address, `wallet_address`), `updated_at` = NOW() WHERE `reference` = :id1 OR `switch_reference` = :id2',
                    [
                        'status' => $mappedStatus,
                        'meta' => jsonEncodeNullable($payload),
                        'hash' => $hash,
                        'wallet_address' => $recipient,
                        'id1' => (string)$txId,
                        'id2' => (string)$txId,
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
