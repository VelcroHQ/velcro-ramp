<?php

declare(strict_types=1);

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/switch_api.php';
require_once __DIR__ . '/paj_api.php';

function pollSingleTransaction(array $tx): void
{
    if (($tx['channel'] ?? '') === 'PAJ') {
        if (!pajApi()->isConfigured()) {
            return;
        }
        $id = !empty($tx['reference']) ? $tx['reference'] : ($tx['switch_reference'] ?? null);
        if (!$id) {
            return;
        }
        try {
            $result = pajApi()->getTransactionStatus((string)$id);
            $d = $result ?? [];
            $rawStatus = strtoupper((string) ($d['status'] ?? $tx['status']));
            $newStatus = mapPajStatus($rawStatus);
            if ($newStatus !== $tx['status']) {
                $update = [
                    'status' => $newStatus,
                    'meta' => jsonEncodeNullable($d),
                ];
                if (!empty($d['signature']) || !empty($d['hash'])) {
                    $update['hash'] = $d['signature'] ?? $d['hash'];
                }
                Database::safeExecute(
                    'UPDATE `transactions` SET `status` = :status, `meta` = :meta, `hash` = COALESCE(:hash, `hash`), `wallet_address` = COALESCE(:wallet_address, `wallet_address`), `updated_at` = NOW() WHERE `id` = :id',
                    [
                        'status' => $update['status'],
                        'meta' => $update['meta'],
                        'hash' => $update['hash'] ?? null,
                        'wallet_address' => $d['recipient'] ?? ($d['address'] ?? null),
                        'id' => $tx['id'],
                    ]
                );
                error_log("[Poller] PAJ {$tx['reference']} → {$newStatus}");
            }
        } catch (Throwable $e) {
            error_log("[Poller] Failed PAJ {$tx['reference']}: " . $e->getMessage());
        }
    } else {
        try {
            $refToQuery = !empty($tx['switch_reference']) ? (string)$tx['switch_reference'] : (string)$tx['reference'];
            $data = switchApi()->getPaymentStatus($refToQuery);
            $d = $data['data'] ?? [];
            if (empty($d['status']) && !empty($tx['reference']) && (string)$tx['reference'] !== $refToQuery) {
                $data = switchApi()->getPaymentStatus((string)$tx['reference']);
                $d = $data['data'] ?? [];
            }
            if (!empty($d['status'])) {
                $updated = updateSwitchTransactionFromData($refToQuery, $d);
                if ($updated) {
                    error_log("[Poller] Switch {$refToQuery} updated → status: " . ($updated['status'] ?? '') . ", amount: " . ($updated['amount'] ?? '') . ", dest_amount: " . ($updated['destination_amount'] ?? ''));
                }
            }
        } catch (Throwable $e) {
            error_log("[Poller] Failed Switch {$tx['reference']}: " . $e->getMessage());
        }
    }
}

function runBackgroundPoller(): void
{
    $since = gmdate('Y-m-d H:i:s', strtotime('-72 hours'));
    $placeholders = implode(',', array_fill(0, count(POLLABLE_STATUSES), '?'));
    $sql = "SELECT * FROM `transactions` WHERE `status` IN ({$placeholders}) AND `created_at` >= ? ORDER BY `created_at` DESC LIMIT 100";
    $params = [...POLLABLE_STATUSES, $since];

    try {
        $txs = Database::safeSelect($sql, $params, []);
        if (!empty($txs)) {
            error_log("[Poller] Checking " . count($txs) . " pending transaction(s)...");
            foreach ($txs as $tx) {
                pollSingleTransaction($tx);
                usleep(500000); // 0.5s delay between calls
            }
        }
    } catch (Throwable $e) {
        error_log('[Poller] Error: ' . $e->getMessage());
    }
}
