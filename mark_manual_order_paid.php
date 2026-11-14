<?php
declare(strict_types=1);

require_once __DIR__ . '/php-backend/config.php';
require_once __DIR__ . '/php-backend/db.php';
require_once __DIR__ . '/php-backend/helpers.php';
require_once __DIR__ . '/php-backend/emails.php';
require_once __DIR__ . '/php-backend/routes/hostfi.php';
require_once __DIR__ . '/php-backend/routes/merchant_payouts.php';

// Auth check
$key = (string) ($_GET['key'] ?? '');
if ($key !== 'velcro_admin_manual_fix_2026') {
    http_response_code(403);
    echo json_encode(['error' => 'Forbidden']);
    exit;
}

$ref = 'hf_d2366a551e9d76e8a622';
$order = Database::selectOne('SELECT * FROM `transactions` WHERE `reference` = :r', ['r' => $ref]);
if (!$order) {
    echo json_encode(['error' => 'Order not found']);
    exit;
}

$deps = Database::select('SELECT * FROM `hostfi_deposits` WHERE `order_ref` = :r', ['r' => $ref]);
if (!$deps) {
    echo json_encode(['error' => 'No deposits found']);
    exit;
}

// Calculate gross and payout amounts
// 0.0076253 BTC @ 90,626,654.87 = ~₦691,055.43
// Total fee: 1.3% (0.8% merchant + 0.5% velcro) = ~₦8,983.72
// Payout = ₦682,021.71
$payoutNgn = 682021.71;
$grossNgn = 691055.43;

foreach ($deps as $d) {
    Database::execute(
        "UPDATE `hostfi_deposits` SET `status` = 'PAID', `ngn_amount` = :g, `payout_amount` = :p, `note` = 'Paid manually via HostFi dashboard by admin', `updated_at` = NOW() WHERE `id` = :id",
        ['g' => $grossNgn, 'p' => $payoutNgn, 'id' => $d['id']]
    );
}

// Sync the order status and trigger receipt & merchant earnings
hostfiSyncOrder($ref);

// Fetch updated order & merchant balance
$updatedOrder = Database::selectOne('SELECT * FROM `transactions` WHERE `reference` = :r', ['r' => $ref]);
$merchant = Database::selectOne('SELECT * FROM `merchants` WHERE `id` = :id', ['id' => $order['merchant_id']]);
$earnings = $merchant ? merchantEarnings($merchant) : null;

echo json_encode([
    'success' => true,
    'order' => [
        'reference' => $updatedOrder['reference'],
        'status' => $updatedOrder['status'],
        'amount' => $updatedOrder['amount'],
        'destination_amount' => $updatedOrder['destination_amount'],
        'destination_currency' => $updatedOrder['destination_currency'],
    ],
    'merchant' => [
        'name' => $merchant['business_name'] ?? $merchant['slug'],
        'slug' => $merchant['slug'],
        'earnings' => $earnings,
    ],
], JSON_PRETTY_PRINT);

@unlink(__FILE__);

