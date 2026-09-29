<?php

declare(strict_types=1);

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/switch_api.php';
require_once __DIR__ . '/paj_api.php';

function pollSingleTransaction(array $tx): void
{
    if ($tx['channel'] === 'PAJ') {
        if (!pajApi()->isConfigured()) {
            return;
        }
        $id = $tx['reference'] ?: $tx['switch_reference'];
        if (!$id) {
            return;
        }
        try {
            $result = pajApi()->getTransactionStatus($id);
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
                    'UPDATE `transactions` SET `status` = :status, `meta` = :meta, `hash` = :hash WHERE `reference` = :reference',
                    ['status' => $update['status'], 'meta' => $update['meta'], 'hash' => $update['hash'] ?? null, 'reference' => $tx['reference']]
                );
                error_log("[Poller] PAJ {$tx['reference']} → {$newStatus}");
            }
        } catch (Throwable $e) {
            error_log("[Poller] Failed PAJ {$tx['reference']}: " . $e->getMessage());
        }
    } else {
        try {
            $data = switchApi()->getPaymentStatus($tx['reference']);
            $d = $data['data'] ?? [];
            if (!empty($d['status'])) {
                $newStatus = strtoupper((string) $d['status']);
                if ($newStatus !== $tx['status']) {
                    $meta = $d['meta'] ?? [];
                    Database::safeExecute(
                        'UPDATE `transactions` SET `status` = :status, `hash` = :hash, `explorer_url` = :explorer_url WHERE `reference` = :reference',
                        [
                            'status' => $newStatus,
                            'hash' => $d['hash'] ?? ($d['tx_hash'] ?? $tx['hash'] ?? null),
                            'explorer_url' => $meta['explorer_url'] ?? ($d['explorer_url'] ?? $tx['explorer_url'] ?? null),
                            'reference' => $tx['reference'],
                        ]
                    );
                    error_log("[Poller] Switch {$tx['reference']} → {$newStatus}");
                }
            }
        } catch (Throwable $e) {
            error_log("[Poller] Failed Switch {$tx['reference']}: " . $e->getMessage());
        }
    }
}

function runBackgroundPoller(): void
{
    $since = gmdate('Y-m-d H:i:s', strtotime('-24 hours'));
    $placeholders = implode(',', array_fill(0, count(POLLABLE_STATUSES), '?'));
    $sql = "SELECT * FROM `transactions` WHERE `status` IN ({$placeholders}) AND `created_at` >= ? ORDER BY `created_at` DESC LIMIT 50";
    $params = [...POLLABLE_STATUSES, $since];

    try {
        $txs = Database::safeSelect($sql, $params, []);
        if (!empty($txs)) {
            error_log("[Poller] Checking " . count($txs) . " pending transaction(s)...");
            foreach ($txs as $tx) {
                pollSingleTransaction($tx);
                usleep(1500000); // 1.5s delay between calls
            }
        }
    } catch (Throwable $e) {
        error_log('[Poller] Error: ' . $e->getMessage());
    }
}
