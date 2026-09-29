<?php

declare(strict_types=1);

/**
 * Cron-safe auto-withdrawal.
 * Recommended cron: 0 0 * * * /usr/bin/php /path/to/php-backend/cron/auto_withdraw.php >> /path/to/php-backend/data/withdraw.log 2>&1
 */

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../helpers.php';
require_once __DIR__ . '/../switch_api.php';
require_once __DIR__ . '/../routes/admin.php';

if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    exit('Forbidden');
}

if (!AUTO_WITHDRAWAL_ENABLED) {
    echo "[" . gmdate('c') . "] Auto-withdrawal disabled.\n";
    exit(0);
}

$lockFile = __DIR__ . '/../data/withdraw.lock';
$fp = fopen($lockFile, 'c');
if (!$fp || !flock($fp, LOCK_EX | LOCK_NB)) {
    echo "[" . gmdate('c') . "] Another withdrawal is already running.\n";
    exit(0);
}

try {
    echo "[" . gmdate('c') . "] Running scheduled fee withdrawal...\n";

    $balance = 0.0;
    $currency = 'USD';
    try {
        $feesData = switchApi()->getDeveloperFees();
        $balance = (float) ($feesData['data']['amount'] ?? 0);
        $currency = $feesData['data']['currency'] ?? 'USD';
    } catch (Throwable $e) {
        echo "[" . gmdate('c') . "] Failed to fetch developer fees: " . $e->getMessage() . "\n";
    }

    echo "[" . gmdate('c') . "] Current developer fee balance: {$balance} {$currency}\n";

    if ($balance < AUTO_WITHDRAWAL_MIN_BALANCE) {
        echo "[" . gmdate('c') . "] Balance {$balance} below minimum " . AUTO_WITHDRAWAL_MIN_BALANCE . ". Skipping.\n";
        exit(0);
    }

    $result = executeWithdrawal(DEVELOPER_WITHDRAW_ASSET, 'cron', 'cron');
    if ($result['success']) {
        echo "[" . gmdate('c') . "] Withdrawal succeeded: " . json_encode($result['data'] ?? []) . "\n";
    } else {
        echo "[" . gmdate('c') . "] Withdrawal failed: " . ($result['error'] ?? 'Unknown') . "\n";
    }
} catch (Throwable $e) {
    auditLog('WITHDRAW_ERROR', ['ip' => 'cron', 'recipient' => DEVELOPER_RECIPIENT, 'error' => $e->getMessage(), 'source' => 'cron']);
    echo "[" . gmdate('c') . "] Unexpected error: " . $e->getMessage() . "\n";
} finally {
    flock($fp, LOCK_UN);
    fclose($fp);
}
