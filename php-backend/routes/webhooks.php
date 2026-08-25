<?php

declare(strict_types=1);

require_once __DIR__ . '/../paj_api.php';

function registerWebhookRoutes(Router $router): void
{
    $router->post('/webhook/switch', function () {
        rateLimitOrFail('webhook:switch:' . clientIp(), 120, 60);
        $payload = getJsonBody();
        $ip = clientIp();

        if (SWITCH_WEBHOOK_SECRET === '') {
            error_log('[Webhook] Switch webhook secret not configured');
            auditLog('WEBHOOK_REJECTED', ['ip' => $ip, 'reason' => 'secret_not_configured', 'provider' => 'switch']);
            jsonResponse(['success' => false, 'error' => 'Webhook secret not configured'], 500);
        }

        $sig = $_SERVER['HTTP_X_WEBHOOK_SIGNATURE'] ?? $_SERVER['HTTP_X_SWITCH_SIGNATURE'] ?? '';
        if (!verifyWebhookSignature(SWITCH_WEBHOOK_SECRET, $payload, $sig)) {
            error_log('[Webhook] Invalid signature rejected');
            auditLog('WEBHOOK_REJECTED', ['ip' => $ip, 'reason' => 'invalid_signature', 'provider' => 'switch']);
            jsonResponse(['success' => false, 'error' => 'Invalid signature'], 401);
        }

        error_log('[Webhook Received] ' . json_encode($payload));

        $reference = $payload['reference'] ?? ($payload['data']['reference'] ?? null);
        $status = $payload['status'] ?? ($payload['data']['status'] ?? null);

        if ($reference && $status) {
            $normalizedStatus = strtoupper((string) $status);
            $data = $payload['data'] ?? [];
            Database::safeExecute(
                'UPDATE `transactions` SET `status` = :status, `meta` = :meta, `hash` = :hash, `explorer_url` = :explorer_url WHERE `reference` = :reference',
                [
                    'status' => $normalizedStatus,
                    'meta' => jsonEncodeNullable($payload),
                    'hash' => $data['hash'] ?? null,
                    'explorer_url' => $data['explorer_url'] ?? null,
                    'reference' => $reference,
                ]
            );
            error_log("[Webhook] Updated status of {$reference} to {$status}");
        }

        jsonResponse(['success' => true, 'received' => true]);
    });

    $router->post('/webhook/paj', function () {
        rateLimitOrFail('webhook:paj:' . clientIp(), 120, 60);
        $payload = getJsonBody();
        $ip = clientIp();

        if (PAJ_WEBHOOK_SECRET === '') {
            error_log('[PAJ Webhook] PAJ webhook secret not configured');
            auditLog('WEBHOOK_REJECTED', ['ip' => $ip, 'reason' => 'secret_not_configured', 'provider' => 'paj']);
            jsonResponse(['received' => true, 'error' => 'Webhook secret not configured'], 500);
        }

        $sig = $_SERVER['HTTP_X_WEBHOOK_SIGNATURE'] ?? $_SERVER['HTTP_X_PAJ_SIGNATURE'] ?? '';
        if (!verifyWebhookSignature(PAJ_WEBHOOK_SECRET, $payload, $sig)) {
            error_log('[PAJ Webhook] Invalid signature rejected');
            auditLog('WEBHOOK_REJECTED', ['ip' => $ip, 'reason' => 'invalid_signature', 'provider' => 'paj']);
            jsonResponse(['success' => false, 'error' => 'Invalid signature'], 401);
        }

        error_log('[PAJ Webhook] ' . json_encode($payload));

        $txId = $payload['id'] ?? ($payload['data']['id'] ?? null) ?? ($payload['reference'] ?? null) ?? ($payload['orderId'] ?? null);
        $status = $payload['status'] ?? ($payload['data']['status'] ?? null) ?? ($payload['state'] ?? null);
        $hash = $payload['signature'] ?? $payload['hash'] ?? ($payload['data']['signature'] ?? null) ?? ($payload['data']['hash'] ?? null);
        $recipient = $payload['recipient'] ?? ($payload['data']['recipient'] ?? null);

        if ($txId && $status) {
            $update = [
                'status' => mapPajStatus($status),
                'meta' => jsonEncodeNullable($payload),
                'hash' => $hash,
                'wallet_address' => $recipient,
            ];
            $count = Database::safeExecute(
                'UPDATE `transactions` SET `status` = :status, `meta` = :meta, `hash` = :hash, `wallet_address` = :wallet_address WHERE `reference` = :id OR `switch_reference` = :id',
                [
                    'status' => $update['status'],
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
