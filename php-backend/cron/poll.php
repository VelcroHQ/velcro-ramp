<?php

declare(strict_types=1);

/**
 * Cron-safe status poller.
 * Recommended cron: every 10 minutes.
 */

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../helpers.php';
require_once __DIR__ . '/../poll_helpers.php';

// Allow CLI access OR web access with valid admin key
$isCli = (php_sapi_name() === 'cli');
$key = (string) ($_GET['key'] ?? ($_SERVER['HTTP_AUTHORIZATION'] ?? ''));

if (!$isCli && !verifyAdminPassword($key)) {
    http_response_code(403);
    exit('Forbidden');
}

$lockFile = __DIR__ . '/../data/poll.lock';
$fp = fopen($lockFile, 'c');
if (!$fp || !flock($fp, LOCK_EX | LOCK_NB)) {
    echo "[" . gmdate('c') . "] Another poll is already running.\n";
    exit(0);
}

try {
    echo "[" . gmdate('c') . "] Starting poll...\n";
    runBackgroundPoller();
    $receipts = sendPendingReceipts(50);
    $campaigns = sendCampaignBatch(100);
    $reminders = sendAbandonedOrderReminders(20);
    echo "[" . gmdate('c') . "] Poll complete. Receipts sent: {$receipts}, reminders sent: {$reminders}, campaign emails sent: {$campaigns}\n";
} finally {
    flock($fp, LOCK_UN);
    fclose($fp);
}
