<?php

declare(strict_types=1);

/**
 * Purge expired OTP records.
 * Recommended cron: every 5 minutes.
 */

require_once __DIR__ . '/../helpers.php';

if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    exit('Forbidden');
}

try {
    cleanupExpiredOtps();
    echo "[" . gmdate('c') . "] Expired OTPs cleaned up.\n";
} catch (Throwable $e) {
    echo "[" . gmdate('c') . "] Error: " . $e->getMessage() . "\n";
}
