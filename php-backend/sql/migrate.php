<?php

declare(strict_types=1);

/**
 * MongoDB → MySQL migration helper.
 *
 * Usage:
 *   1. Export your MongoDB transactions collection:
 *      mongoexport --db=velcro_ramp --collection=transactions --out=transactions.json
 *   2. Place transactions.json next to this script.
 *   3. Run: php migrate.php
 */

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../db.php';

if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    exit('Forbidden');
}

$sourceFile = __DIR__ . '/transactions.json';
if (!file_exists($sourceFile)) {
    echo "Error: transactions.json not found. Place it next to migrate.php.\n";
    exit(1);
}

$handle = fopen($sourceFile, 'r');
if (!$handle) {
    echo "Error: Could not open transactions.json\n";
    exit(1);
}

$inserted = 0;
$skipped = 0;
$errors = 0;
$errorMessages = [];

while (($line = fgets($handle)) !== false) {
    $line = trim($line);
    if ($line === '') {
        continue;
    }
    $doc = json_decode($line, true);
    if (!is_array($doc)) {
        $skipped++;
        continue;
    }

    // Map MongoDB _id / timestamps if present
    $reference = $doc['reference'] ?? ($doc['_id'] ?? null);
    if (!$reference) {
        $skipped++;
        continue;
    }

    // Normalize beneficiary / meta
    $beneficiary = $doc['beneficiary'] ?? null;
    if (is_string($beneficiary)) {
        $beneficiary = json_decode($beneficiary, true);
    }
    $meta = $doc['meta'] ?? null;
    if (is_string($meta)) {
        $meta = json_decode($meta, true);
    }

    $createdAt = null;
    if (!empty($doc['created_at'])) {
        $ts = is_array($doc['created_at']) && isset($doc['created_at']['$date'])
            ? $doc['created_at']['$date']
            : $doc['created_at'];
        $createdAt = date('Y-m-d H:i:s', is_numeric($ts) ? (int) ($ts / 1000) : strtotime($ts));
    }

    $data = [
        'reference' => $reference,
        'switch_reference' => $doc['switch_reference'] ?? null,
        'type' => $doc['type'] ?? 'OFFRAMP',
        'status' => strtoupper($doc['status'] ?? 'AWAITING_DEPOSIT'),
        'country' => $doc['country'] ?? 'NG',
        'currency' => $doc['currency'] ?? 'NGN',
        'asset' => $doc['asset'] ?? 'USDT',
        'channel' => $doc['channel'] ?? 'BANK',
        'amount' => $doc['amount'] ?? 0,
        'rate' => $doc['rate'] ?? null,
        'fee_total' => $doc['fee_total'] ?? null,
        'fee_platform' => $doc['fee_platform'] ?? null,
        'fee_developer' => $doc['fee_developer'] ?? null,
        'source_amount' => $doc['source_amount'] ?? null,
        'source_currency' => $doc['source_currency'] ?? null,
        'destination_amount' => $doc['destination_amount'] ?? null,
        'destination_currency' => $doc['destination_currency'] ?? null,
        'deposit_address' => $doc['deposit_address'] ?? null,
        'deposit_bank_name' => $doc['deposit_bank_name'] ?? null,
        'deposit_account_number' => $doc['deposit_account_number'] ?? null,
        'deposit_account_name' => $doc['deposit_account_name'] ?? null,
        'deposit_note' => $doc['deposit_note'] ?? null,
        'beneficiary' => jsonEncodeNullable($beneficiary),
        'wallet_address' => $doc['wallet_address'] ?? null,
        'hash' => $doc['hash'] ?? null,
        'explorer_url' => $doc['explorer_url'] ?? null,
        'callback_url' => $doc['callback_url'] ?? null,
        'meta' => jsonEncodeNullable($meta),
        'email' => !empty($doc['email']) ? strtolower(trim($doc['email'])) : null,
    ];
    if ($createdAt) {
        $data['created_at'] = $createdAt;
    }

    try {
        Database::insert('transactions', $data);
        $inserted++;
    } catch (Throwable $e) {
        // Duplicate reference? Try update instead.
        if (str_contains($e->getMessage(), 'Duplicate')) {
            unset($data['reference']);
            Database::update('transactions', $data, ['reference' => $reference]);
            $inserted++;
        } else {
            $msg = $e->getMessage();
            if (count($errorMessages) < 5) {
                $errorMessages[] = "[{$reference}] {$msg}";
            }
            error_log('Migration error for ' . $reference . ': ' . $msg);
            $errors++;
        }
    }
}

fclose($handle);

echo "Migration complete:\n";
echo "  Inserted/updated: {$inserted}\n";
echo "  Skipped: {$skipped}\n";
echo "  Errors: {$errors}\n";
if (!empty($errorMessages)) {
    echo "\nFirst errors:\n";
    foreach ($errorMessages as $m) {
        echo "  - {$m}\n";
    }
}
