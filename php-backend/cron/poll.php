<?php

declare(strict_types=1);

/**
 * Cron-safe status poller.
 * Recommended cron: every 10 minutes.
 */

require_once __DIR__ . '/../poll_helpers.php';

// Prevent web access
if (php_sapi_name() !== 'cli') {
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
    echo "[" . gmdate('c') . "] Poll complete.\n";
} finally {
    flock($fp, LOCK_UN);
    fclose($fp);
}
