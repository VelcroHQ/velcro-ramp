<?php

declare(strict_types=1);

require_once __DIR__ . '/../paj_api.php';

function registerWebhookRoutes(Router $router): void
{
    $router->post('/webhook/switch', function () {
        $rawBody = file_get_contents('php://input') ?: '';
        $payload = json_decode($rawBody, true) ?: [];
        $ip = clientIp();

        $switchKey = SWITCH_SERVICE_KEY !== '' ? SWITCH_SERVICE_KEY : SWITCH_WEBHOOK_SECRET;
        if ($switchKey !== '') {
            $sig = $_SERVER['HTTP_X_SWITCH_SIGNATURE'] ?? $_SERVER['HTTP_X_WEBHOOK_SIGNATURE'] ?? '';
            if (!verifySwitchWebhook($rawBody, $sig, $switchKey)) {
                error_log('[Webhook] Invalid Switch signature rejected');
                auditLog('WEBHOOK_REJECTED', ['ip' => $ip, 'reason' => 'invalid_signature', 'provider' => 'switch']);
                jsonResponse(['success' => false, 'error' => 'Invalid signature'], 401);
            }
        }

        error_log('[Webhook Received] ' . json_encode($payload));

        $reference = $payload['reference'] ?? ($payload['data']['reference'] ?? null);
        $status = $payload['status'] ?? ($payload['data']['status'] ?? null);

        if ($reference && $status) {
            $normalizedStatus = strtoupper((string) $status);
            $data = $payload['data'] ?? [];
            $meta = $data['meta'] ?? ($payload['meta'] ?? []);
            $hash = $meta['hash'] ?? ($data['hash'] ?? ($payload['hash'] ?? null));
            $explorerUrl = $meta['explorer_url'] ?? ($data['explorer_url'] ?? ($payload['explorer_url'] ?? null));

            Database::safeExecute(
                "UPDATE `transactions` SET `status` = :status, `meta` = :meta, `hash` = COALESCE(:hash, `hash`), `explorer_url` = COALESCE(:explorer_url, `explorer_url`) WHERE (`reference` = :reference OR `switch_reference` = :reference) AND (`status` NOT IN ('COMPLETED', 'FAILED', 'CANCELLED') OR :status_check = 'COMPLETED')",
                [
                    'status' => $normalizedStatus,
                    'status_check' => $normalizedStatus,
                    'meta' => jsonEncodeNullable($payload),
                    'hash' => $hash,
                    'explorer_url' => $explorerUrl,
                    'reference' => $reference,
                ]
            );
            error_log("[Webhook] Updated status of {$reference} to {$status}");
        }

        jsonResponse(['success' => true, 'received' => true]);
    });

    $router->post('/webhook/paj', function () {
        $payload = getJsonBody();
        $ip = clientIp();

        if (PAJ_WEBHOOK_SECRET !== '') {
            $sig = $_SERVER['HTTP_X_WEBHOOK_SIGNATURE'] ?? $_SERVER['HTTP_X_PAJ_SIGNATURE'] ?? '';
            if (!verifyWebhookSignature(PAJ_WEBHOOK_SECRET, $payload, $sig)) {
                error_log('[PAJ Webhook] Invalid signature rejected');
                auditLog('WEBHOOK_REJECTED', ['ip' => $ip, 'reason' => 'invalid_signature', 'provider' => 'paj']);
                jsonResponse(['success' => false, 'error' => 'Invalid signature'], 401);
            }
        }

        error_log('[PAJ Webhook] ' . json_encode($payload));

        $txId = $payload['id'] ?? ($payload['data']['id'] ?? null) ?? ($payload['reference'] ?? null) ?? ($payload['orderId'] ?? null);
        $status = $payload['status'] ?? ($payload['data']['status'] ?? null) ?? ($payload['state'] ?? null);
        $hash = $payload['signature'] ?? $payload['hash'] ?? ($payload['data']['signature'] ?? null) ?? ($payload['data']['hash'] ?? null);
        $recipient = $payload['recipient'] ?? ($payload['data']['recipient'] ?? null);

        if ($txId && $status) {
            $mappedStatus = mapPajStatus($status);
            $update = [
                'status' => $mappedStatus,
                'meta' => jsonEncodeNullable($payload),
                'hash' => $hash,
                'wallet_address' => $recipient,
            ];
            $count = Database::safeExecute(
                "UPDATE `transactions` SET `status` = :status, `meta` = :meta, `hash` = :hash, `wallet_address` = :wallet_address WHERE (`reference` = :id OR `switch_reference` = :id) AND (`status` NOT IN ('COMPLETED', 'FAILED', 'CANCELLED') OR :status_check = 'COMPLETED')",
                [
                    'status' => $update['status'],
                    'status_check' => $update['status'],
                    'meta' => $update['meta'],
                    'hash' => $update['hash'],
                    'wallet_address' => $update['wallet_address'],
                    'id' => $txId,
                ]
            );
            if ($count > 0) {
                error_log("✅ PAJ webhook updated tx {$txId} → {$status}");
            } else {
                error_log("⚠️ PAJ webhook: no tx found for {$txId}");
            }
        } else {
            error_log('⚠️ PAJ webhook: missing id or status');
        }

        jsonResponse(['received' => true]);
    });
}
