<?php

declare(strict_types=1);

/*
 * HostFi buys (onramp): BTC, ETH and SOL when switched on in admin.
 *
 * 1. The user picks a coin, network and wallet. We open a naira bank account for that one order
 *    (HostFi DYNAMIC account, customId = order reference) and fix the wallet on the order.
 * 2. HostFi sends FIAT_DEPOSIT. Webhooks are unsigned, so we re-fetch the payment from HostFi and
 *    act only on HostFi's own record of it.
 * 3. Each payment runs its own pipeline, driven by HostFi's webhooks:
 *    RECEIVED → SWAPPING (→ SWAP_PENDING until the swap webhook) → SWAPPED → SENDING →
 *    SEND_PENDING → SENT (crypto payout webhook). Anything unexpected stops in REVIEW.
 * 4. Our fee stays in naira; the rest is swapped. The user gets the swap's coin minus HostFi's
 *    network fee, never more. A failed send waits for a "Retry" (customer or admin), which goes
 *    only to the wallet fixed on the order, once HostFi confirms the last attempt failed.
 *
 * Every step claims its row with a conditional UPDATE, so a repeated webhook, the poller and an
 * admin click can never run the same swap or send twice.
 */

const HOSTFI_BUY_TIMER_MINUTES = 60;
// HostFi keeps this much of each naira transfer it receives (₦5,000 sent → ₦4,950 credited).
// Used for estimates only; the real fee comes from HostFi's record of each payment.
const HOSTFI_COLLECTION_FEE_NGN = 50.0;
// HostFi holds swapped coin for a few minutes before it can be sent; past this, a person checks it.
const HOSTFI_SEND_WAIT_MINUTES = 120;

function ensureHostfiBuySchema(): void
{
    static $done = false;
    $flag = BASE_PATH . '/data/.hostfi_buy_schema_v1';
    if ($done || file_exists($flag)) {
        $done = true;
        ensureHostfiBuySchemaV2();
        return;
    }
    Database::pdo()->exec("CREATE TABLE IF NOT EXISTS `hostfi_buys` (
        `id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `payment_ref` VARCHAR(100) NOT NULL UNIQUE,
        `order_ref` VARCHAR(255) DEFAULT NULL,
        `ngn_amount` DECIMAL(24,2) NOT NULL,
        `paid_ngn` DECIMAL(24,2) DEFAULT NULL,
        `currency` VARCHAR(20) DEFAULT NULL,
        `network` VARCHAR(40) DEFAULT NULL,
        `wallet` VARCHAR(255) DEFAULT NULL,
        `status` VARCHAR(20) NOT NULL DEFAULT 'RECEIVED',
        `swap_ngn` DECIMAL(24,2) DEFAULT NULL,
        `coin_amount` DECIMAL(36,18) DEFAULT NULL,
        `fee_coin` DECIMAL(36,18) DEFAULT NULL,
        `send_amount` DECIMAL(36,18) DEFAULT NULL,
        `swap_ref` VARCHAR(100) DEFAULT NULL,
        `swap_pair_ref` VARCHAR(100) DEFAULT NULL,
        `send_ref` VARCHAR(100) DEFAULT NULL,
        `send_client_ref` VARCHAR(150) DEFAULT NULL,
        `send_attempts` INT NOT NULL DEFAULT 0,
        `tx_hash` VARCHAR(255) DEFAULT NULL,
        `note` VARCHAR(500) DEFAULT NULL,
        `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
        `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY `idx_order_ref` (`order_ref`),
        KEY `idx_status` (`status`),
        KEY `idx_send_client_ref` (`send_client_ref`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    @file_put_contents($flag, gmdate('c'));
    @file_put_contents(BASE_PATH . '/data/.hostfi_buy_schema_v2', gmdate('c')); // created with paid_ngn
    $done = true;
}

/** v2: `paid_ngn`, what the customer sent before HostFi's fee (`ngn_amount` is what arrived). */
function ensureHostfiBuySchemaV2(): void
{
    $flag = BASE_PATH . '/data/.hostfi_buy_schema_v2';
    if (file_exists($flag)) {
        return;
    }
    try {
        Database::pdo()->exec('ALTER TABLE `hostfi_buys` ADD COLUMN `paid_ngn` DECIMAL(24,2) DEFAULT NULL AFTER `ngn_amount`');
    } catch (Throwable $e) {
        // already there
    }
    @file_put_contents($flag, gmdate('c'));
}

/** What the customer sent: what reached us plus HostFi's fee on it (from HostFi's record). */
function hostfiPaidNgn(array $live): ?float
{
    $fee = $live['feeAmount'] ?? null;
    if (!is_array($fee) || strtoupper((string) ($fee['currency'] ?? 'NGN')) !== 'NGN' || !is_numeric($fee['value'] ?? null)) {
        return null;
    }
    return round((float) ($live['amount']['value'] ?? 0) + (float) $fee['value'], 2);
}

/** Customer-facing naira for a payment: what they sent, else what arrived. */
function hostfiBuyPaid(array $b): float
{
    return $b['paid_ngn'] !== null && $b['paid_ngn'] !== '' ? (float) $b['paid_ngn'] : (float) $b['ngn_amount'];
}

/** Payments recorded before paid_ngn existed: read HostFi's fee once from its record. */
function hostfiBuyBackfillPaid(array $rows): array
{
    foreach ($rows as &$r) {
        if (($r['paid_ngn'] ?? null) !== null || empty($r['payment_ref'])) {
            continue;
        }
        try {
            $paid = hostfiPaidNgn(hostfiApi()->collectionTransaction((string) $r['payment_ref'])) ?? (float) $r['ngn_amount'];
        } catch (Throwable $e) {
            continue; // try again next time
        }
        Database::execute('UPDATE `hostfi_buys` SET `paid_ngn` = :p WHERE `id` = :id', ['p' => $paid, 'id' => $r['id']]);
        $r['paid_ngn'] = $paid;
    }
    return $rows;
}

// ─── Rows ───

/** @return array<string,mixed>|null */
function hostfiBuy(int $id): ?array
{
    return Database::selectOne('SELECT * FROM `hostfi_buys` WHERE `id` = :id', ['id' => $id]);
}

/** Move a payment from one of $from to $to. Returns false if another worker got there first. */
function hostfiBuyClaim(int $id, array $from, string $to, array $set = []): bool
{
    $params = ['id' => $id, 'to' => $to];
    $in = [];
    foreach (array_values($from) as $i => $s) {
        $in[] = ":f{$i}";
        $params["f{$i}"] = $s;
    }
    $extra = '';
    foreach ($set as $col => $val) {
        $extra .= ", `{$col}` = :s_{$col}";
        $params["s_{$col}"] = $val;
    }
    $moved = Database::execute(
        "UPDATE `hostfi_buys` SET `status` = :to{$extra}, `updated_at` = NOW() WHERE `id` = :id AND `status` IN (" . implode(',', $in) . ')',
        $params
    ) === 1;
    if ($moved) {
        hostfiBuyNotify($id, $to);
    }
    return $moved;
}

function hostfiBuySetStatus(int $id, string $status, ?string $note = null): void
{
    Database::execute(
        'UPDATE `hostfi_buys` SET `status` = :s, `note` = COALESCE(:n, `note`), `updated_at` = NOW() WHERE `id` = :id',
        ['s' => $status, 'n' => $note, 'id' => $id]
    );
    hostfiBuyNotify($id, $status);
}

/** @return array{0: ?array, 1: array} the order and its meta.hostfi */
function hostfiBuyOrderFor(array $buy): array
{
    $order = $buy['order_ref'] ? Database::selectOne('SELECT * FROM `transactions` WHERE `reference` = :r', ['r' => $buy['order_ref']]) : null;
    $meta = $order ? (json_decode((string) ($order['meta'] ?? ''), true) ?: []) : [];
    return [$order, (array) ($meta['hostfi'] ?? [])];
}

/**
 * HostFi's network fee for sending $coin of $currency on $network, and that network's minimum.
 * HostFi rounds the fee UP to the coin's orderDecimals before checking the balance (SOL:
 * 0.00321063 → 0.003211), so sending "balance − listed fee" is refused for insufficient funds.
 */
function hostfiSendFee(string $currency, string $network, float $coin, bool $fresh = false): array
{
    foreach (hostfiApi()->cryptoSendNetworks($currency, $fresh) as $n) {
        if (strcasecmp($n['network'], $network) === 0) {
            $dp = (int) (hostfiApi()->walletAsset($currency)['currency']['orderDecimals'] ?? 8);
            $dp = max(0, min(8, $dp));
            $fee = $n['flat'] + $coin * $n['percent'] / 100;
            $fee = max($fee, (float) ($n['fee_min'] ?? 0)); // HostFi's fee floor and cap, when it sets them
            if ((float) ($n['fee_max'] ?? 0) > 0) {
                $fee = min($fee, (float) $n['fee_max']);
            }
            return ['fee' => ceil(round($fee * 10 ** $dp, 6)) / 10 ** $dp, 'min' => $n['min']];
        }
    }
    throw new RuntimeException("HostFi can't send {$currency} on {$network}");
}

// One smallest unit left over, so amount + fee never tips over the balance in HostFi's float maths.
const HOSTFI_SEND_MARGIN = 1e-8;

/** Coin amounts are floored to 8 decimals, so we never send more than the swap produced. */
function hostfiFloorCoin(float $v): float
{
    return floor(round($v * 1e8, 6)) / 1e8; // the round() absorbs float noise like 0.0965 → 9649999.9999
}

/** Wallet address format for a chain. */
function hostfiValidWallet(string $chain, string $address): bool
{
    return (bool) match ($chain) {
        'bitcoin' => preg_match('/^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/', $address),
        'ethereum', 'base', 'bsc', 'polygon', 'arbitrum', 'optimism' => preg_match('/^0x[a-fA-F0-9]{40}$/', $address),
        'solana' => preg_match('/^[1-9A-HJ-NP-Za-km-z]{32,44}$/', $address),
        default => false,
    };
}

// ─── Pipeline ───

/** Store a naira payment HostFi has confirmed. Idempotent on HostFi's reference. */
function hostfiRecordPayment(string $ref, ?array $order, float $ngn, ?float $paid = null): int
{
    ensureHostfiBuySchema();
    $meta = $order ? (json_decode((string) ($order['meta'] ?? ''), true) ?: []) : [];
    try {
        return (int) Database::insert('hostfi_buys', [
            'payment_ref' => $ref,
            'order_ref' => $order['reference'] ?? null,
            'ngn_amount' => $ngn,
            'paid_ngn' => $paid ?? $ngn,
            'currency' => $meta['hostfi']['symbol'] ?? null,
            'network' => $meta['hostfi']['network'] ?? null,
            'wallet' => $order['wallet_address'] ?? null,
            'status' => 'RECEIVED',
        ]);
    } catch (Throwable $e) {
        $row = Database::selectOne('SELECT `id` FROM `hostfi_buys` WHERE `payment_ref` = :r', ['r' => $ref]);
        if (!$row) {
            throw $e;
        }
        return (int) $row['id'];
    }
}

/** Why a payment can't be converted and sent automatically, or null if it can. */
function hostfiBuyProblem(array $buy, ?array $order, array $hf): ?string
{
    if (!$order) {
        return 'Payment to an account with no order';
    }
    if (strtoupper((string) $order['type']) !== 'ONRAMP' || empty($hf['symbol']) || empty($hf['network']) || empty($order['wallet_address'])) {
        return 'Order has no coin, network or wallet';
    }
    $sent = Database::selectOne(
        "SELECT `id` FROM `hostfi_buys` WHERE `order_ref` = :r AND `id` <> :id
            AND `status` IN ('SWAPPING','SWAP_PENDING','SWAPPED','SENDING','SEND_WAITING','SEND_PENDING','SEND_UNCERTAIN','SEND_FAILED','SENT')",
        ['r' => $order['reference'], 'id' => $buy['id']]
    );
    if ($sent) {
        return 'Second payment to an order that was already converted';
    }
    $max = (float) (loadSettings()['buy_max_limit'] ?? 1000000);
    if ((float) $buy['ngn_amount'] > $max) {
        return sprintf('Payment of ₦%s is over the ₦%s buy limit', number_format((float) $buy['ngn_amount'], 2), number_format($max));
    }
    try {
        $coin = (float) $buy['ngn_amount'] * (1 - hostfiFee() / 100) * hostfiRate('NGN', (string) $hf['symbol']);
        $send = hostfiSendFee((string) $hf['symbol'], (string) $hf['network'], $coin);
    } catch (Throwable $e) {
        return 'Could not price the payment: ' . substr($e->getMessage(), 0, 200);
    }
    if ($coin - $send['fee'] < max($send['min'], 1e-8)) {
        return 'Too small to send after the network fee';
    }
    return null;
}

function hostfiProcessPayment(int $id, bool $force = false): void
{
    $buy = hostfiBuy($id);
    if (!$buy) {
        return;
    }
    [$order, $hf] = hostfiBuyOrderFor($buy);

    if ($buy['status'] === 'RECEIVED' || ($force && $buy['status'] === 'REVIEW')) {
        $problem = $force ? null : hostfiBuyProblem($buy, $order, $hf);
        if ($problem !== null) {
            hostfiBuySetStatus($id, 'REVIEW', $problem);
            hostfiBuySyncOrder($buy['order_ref']);
            return;
        }
        if (!$order || empty($hf['symbol']) || empty($hf['network']) || empty($order['wallet_address'])) {
            hostfiBuySetStatus($id, 'REVIEW', 'No order or wallet for this payment');
            return;
        }
        if (!empty($buy['swap_ref'])) {
            // Already swapped once. Never convert the same payment twice.
            if ((float) $buy['send_amount'] > 0) {
                hostfiBuyClaim($id, [$buy['status']], 'SWAPPED');
            } else {
                hostfiBuySetStatus($id, 'REVIEW', 'Swap result unknown; check it in HostFi before resolving');
                return;
            }
        } else {
            $swapNgn = floor((float) $buy['ngn_amount'] * (1 - hostfiFee() / 100) * 100) / 100; // our fee stays in naira
            if (!hostfiBuyClaim($id, [$buy['status']], 'SWAPPING', ['swap_ngn' => $swapNgn, 'currency' => $hf['symbol'], 'network' => $hf['network'], 'wallet' => $order['wallet_address']])) {
                return;
            }
            hostfiBuySyncOrder($buy['order_ref']);
            try {
                $credit = hostfiApi()->swap('NGN', (string) $hf['symbol'], $swapNgn);
            } catch (Throwable $e) {
                // No idempotency key on swaps, so a failed or timed-out swap is checked by a person, not retried.
                hostfiBuySetStatus($id, 'REVIEW', 'Swap failed: ' . substr($e->getMessage(), 0, 300));
                hostfiBuySyncOrder($buy['order_ref']);
                return;
            }
            Database::execute(
                'UPDATE `hostfi_buys` SET `swap_ref` = :sr, `swap_pair_ref` = :sp, `updated_at` = NOW() WHERE `id` = :id',
                ['sr' => (string) ($credit['reference'] ?? ''), 'sp' => (string) ($credit['swapPairReference'] ?? ''), 'id' => $id]
            );
            $swapStatus = strtoupper((string) ($credit['status'] ?? ''));
            if ($swapStatus === 'SUCCESS') {
                hostfiBuySwapSucceeded($id, $credit);
            } elseif ($swapStatus === 'FAILED') {
                hostfiBuySetStatus($id, 'REVIEW', 'HostFi reported the swap as failed');
            } else {
                hostfiBuyClaim($id, ['SWAPPING'], 'SWAP_PENDING'); // the swap webhook takes it from here
            }
        }
    }

    $buy = hostfiBuy($id);
    if ($buy['status'] === 'SWAPPED') {
        hostfiBuySendAfterSwap($id);
    }
    hostfiBuySyncOrder($buy['order_ref']);
}

/** Send a freshly swapped payment once HostFi has released the coin (send amount + network fee). */
function hostfiBuySendAfterSwap(int $id): void
{
    $buy = hostfiBuy($id);
    try {
        $need = (float) $buy['send_amount'] + hostfiSendFee((string) $buy['currency'], (string) $buy['network'], (float) $buy['send_amount'])['fee'];
    } catch (Throwable $e) {
        $need = (float) $buy['send_amount'];
    }
    hostfiSendWhenFree((string) $buy['currency'], $need, static function () use ($id): void {
        $buy = hostfiBuy($id);
        if ($buy && $buy['status'] === 'SWAPPED') {
            hostfiBuySend($buy);
            hostfiBuySyncOrder($buy['order_ref']);
        }
    });
}

/** Record the coin a swap produced and what the user is sent: that coin minus HostFi's network fee, never more. */
function hostfiBuySwapSucceeded(int $id, array $credit): void
{
    $buy = hostfiBuy($id);
    $coin = (float) ($credit['amount']['value'] ?? 0);
    $currency = strtoupper((string) ($credit['amount']['currency'] ?? $buy['currency']));
    if ($coin <= 0 || $currency !== strtoupper((string) $buy['currency'])) {
        hostfiBuyClaim($id, ['SWAPPING', 'SWAP_PENDING'], 'REVIEW', ['note' => 'Swap returned no ' . $buy['currency']]);
        return;
    }
    try {
        $fee = hostfiSendFee((string) $buy['currency'], (string) $buy['network'], $coin);
    } catch (Throwable $e) {
        hostfiBuyClaim($id, ['SWAPPING', 'SWAP_PENDING'], 'REVIEW', ['coin_amount' => $coin, 'note' => 'No network fee: ' . substr($e->getMessage(), 0, 200)]);
        return;
    }
    $send = hostfiFloorCoin($coin - $fee['fee'] - HOSTFI_SEND_MARGIN);
    if ($send <= 0 || $send < $fee['min']) {
        hostfiBuyClaim($id, ['SWAPPING', 'SWAP_PENDING'], 'REVIEW', ['coin_amount' => $coin, 'note' => 'Too small to send after the network fee']);
        return;
    }
    hostfiBuyClaim($id, ['SWAPPING', 'SWAP_PENDING'], 'SWAPPED', ['coin_amount' => $coin, 'fee_coin' => $fee['fee'], 'send_amount' => $send]);
}

/** Ask HostFi how a pending swap ended. Used by the swap webhook and the admin "Check" button. */
function hostfiBuyCheckSwap(array $buy): void
{
    try {
        $live = hostfiApi()->assetTransaction((string) $buy['swap_ref']);
    } catch (Throwable $e) {
        return;
    }
    $status = strtoupper((string) ($live['status'] ?? ''));
    if ($status === 'SUCCESS' && strtoupper((string) ($live['type'] ?? '')) === 'CREDIT') {
        hostfiBuySwapSucceeded((int) $buy['id'], $live);
        $buy = hostfiBuy((int) $buy['id']);
        if ($buy['status'] === 'SWAPPED') {
            hostfiBuySendAfterSwap((int) $buy['id']);
        }
    } elseif ($status === 'FAILED') {
        hostfiBuyClaim((int) $buy['id'], ['SWAP_PENDING'], 'REVIEW', ['note' => 'HostFi reported the swap as failed']);
    }
    hostfiBuySyncOrder($buy['order_ref']);
}

/**
 * Send one attempt for a SWAPPED payment to the order's wallet. Each attempt has its own
 * clientReference (order-b{id}-attempt), so HostFi rejects a repeat of the same attempt.
 */
function hostfiBuySend(array $buy): void
{
    $id = (int) $buy['id'];
    $attempt = (int) $buy['send_attempts'] + 1;
    $clientRef = $buy['order_ref'] . '-b' . $id . '-' . $attempt;
    $set = ['send_attempts' => $attempt, 'send_client_ref' => $clientRef];
    // Amount plus HostFi's (rounded-up) fee must fit in what the swap produced; payments recorded
    // before the fee was rounded are trimmed here, never raised.
    try {
        $fee = hostfiSendFee((string) $buy['currency'], (string) $buy['network'], (float) $buy['coin_amount'], true)['fee'];
        $max = hostfiFloorCoin((float) $buy['coin_amount'] - $fee - HOSTFI_SEND_MARGIN);
        if ($max > 0 && $max < (float) $buy['send_amount']) {
            $buy['send_amount'] = $max;
            $set += ['send_amount' => $max, 'fee_coin' => $fee];
        }
    } catch (Throwable $e) {
        // keep the recorded amount; HostFi refuses it if it doesn't fit, and nothing is sent
    }
    if (!hostfiBuyClaim($id, ['SWAPPED'], 'SENDING', $set)) {
        return;
    }
    try {
        $res = hostfiApi()->payoutToWallet((string) $buy['currency'], (float) $buy['send_amount'], (string) $buy['wallet'], (string) $buy['network'], $clientRef);
    } catch (Throwable $e) {
        // A timeout can still have created the send. Look it up; if HostFi can't say, nothing is
        // re-sent until it can (see hostfiBuyCheckSend), so the user is never sent coins twice.
        try {
            $res = hostfiApi()->payout($clientRef);
        } catch (Throwable $lookup) {
            // A 4xx answer plus no record of the send means HostFi refused it outright: nothing went out.
            $refused = $e->getCode() >= 400 && $e->getCode() < 500 && $lookup->getCode() === 404;
            if ($refused && stripos($e->getMessage(), 'insufficient') !== false) {
                // HostFi holds swapped coin for a few minutes; hostfiBuyResumeWaiting sends once it's free.
                hostfiBuyClaim($id, ['SENDING'], 'SEND_WAITING', ['note' => "HostFi is still holding the {$buy['currency']} from the swap; it's sent automatically once released"]);
            } elseif ($refused) {
                hostfiBuyClaim($id, ['SENDING'], 'SEND_FAILED', ['note' => 'HostFi refused the send: ' . substr($e->getMessage(), 0, 200)]);
            } else {
                hostfiBuyClaim($id, ['SENDING'], 'SEND_UNCERTAIN', ['note' => 'Send request failed (' . substr($e->getMessage(), 0, 200) . '); waiting for HostFi to confirm before any retry']);
            }
            return;
        }
    }
    hostfiBuyClaim($id, ['SENDING'], 'SEND_PENDING', ['send_ref' => (string) ($res['reference'] ?? '')]);
    hostfiBuyApplySendStatus($id, $res);
}

/**
 * Send a SEND_WAITING payment once HostFi has released enough coin to cover it and the network
 * fee. After HOSTFI_SEND_WAIT_MINUTES it goes to REVIEW so someone looks at it.
 */
function hostfiBuyResumeWaiting(array $buy): void
{
    if ($buy['status'] !== 'SEND_WAITING') {
        return;
    }
    if (strtotime((string) $buy['updated_at']) < time() - HOSTFI_SEND_WAIT_MINUTES * 60) {
        hostfiBuyClaim((int) $buy['id'], ['SEND_WAITING'], 'REVIEW', ['note' => 'HostFi held the ' . $buy['currency'] . ' for over ' . HOSTFI_SEND_WAIT_MINUTES . ' minutes; retry the send once it is released']);
        hostfiBuySyncOrder($buy['order_ref']);
        return;
    }
    try {
        $wallet = hostfiApi()->walletAsset((string) $buy['currency']);
        $need = (float) $buy['send_amount'] + hostfiSendFee((string) $buy['currency'], (string) $buy['network'], (float) $buy['send_amount'])['fee'];
    } catch (Throwable $e) {
        return; // try again on the next check
    }
    // reservedBalance always equals the whole balance on HostFi, so it isn't a hold; liens and locks are.
    $free = (float) ($wallet['balance'] ?? 0) - (float) ($wallet['lienedBalance'] ?? 0) - (float) ($wallet['lockedBalance'] ?? 0);
    if ($free + 1e-9 < $need || !hostfiBuyClaim((int) $buy['id'], ['SEND_WAITING'], 'SWAPPED')) {
        return;
    }
    hostfiBuySend(hostfiBuy((int) $buy['id']));
    hostfiBuySyncOrder($buy['order_ref']);
}

/**
 * Move an order's sends along when its page is viewed: send payments HostFi was holding, and
 * re-read sends in flight (read-only) so the order completes as soon as the coin lands.
 */
function hostfiBuyResumeOrder(string $orderRef): void
{
    ensureHostfiBuySchema();
    $rows = Database::select("SELECT * FROM `hostfi_buys` WHERE `order_ref` = :r AND `status` IN ('SWAPPED','SEND_WAITING','SEND_PENDING')", ['r' => $orderRef]);
    foreach ($rows as $buy) {
        if ($buy['status'] === 'SWAPPED') {
            // Its send after the swap was interrupted; send it now.
            if (strtotime((string) $buy['updated_at']) < time() - 300) {
                hostfiBuySend($buy);
            }
        } elseif ($buy['status'] === 'SEND_WAITING') {
            hostfiBuyResumeWaiting($buy);
        } elseif (strtotime((string) $buy['updated_at']) < time() - 60) {
            hostfiBuyCheckSend($buy);
        }
    }
    if ($rows) {
        hostfiBuySyncOrder($orderRef);
    }
}

/** Re-read a send from HostFi (payout webhook, poller safety net, admin). Read-only. */
function hostfiBuyCheckSend(array $buy, bool $hookSaysSuccess = false): void
{
    if (!in_array($buy['status'], ['SEND_PENDING', 'SEND_UNCERTAIN'], true) || empty($buy['send_client_ref'])) {
        return;
    }
    try {
        $res = hostfiApi()->payout((string) $buy['send_client_ref']);
    } catch (Throwable $e) {
        if ($e->getCode() === 404 && $buy['status'] === 'SEND_UNCERTAIN' && strtotime((string) $buy['updated_at']) < time() - 600) {
            hostfiBuyClaim((int) $buy['id'], ['SEND_UNCERTAIN'], 'SEND_FAILED', ['note' => 'HostFi has no record of the send request; safe to retry']);
        }
        return;
    }
    hostfiBuyApplySendStatus((int) $buy['id'], hostfiTrustHookSuccess($res, $hookSaysSuccess));
}

/**
 * HostFi's API can say "in progress" for minutes after its own webhook reported the send as
 * successful (BTC: broadcast, waiting for a block). A success webhook that carried our secret
 * counts, as long as HostFi's record exists and isn't failed. It only marks the order done;
 * it never sends or re-sends anything.
 */
function hostfiTrustHookSuccess(array $live, bool $hookSaysSuccess): array
{
    $status = strtoupper((string) ($live['status'] ?? ''));
    if ($hookSaysSuccess && $status !== '' && !str_ends_with($status, '_FAILED') && empty($live['wasReversed'])) {
        $live['status'] = 'WITHDRAWAL_SUCCESS';
    }
    return $live;
}

function hostfiBuyApplySendStatus(int $id, array $payout): void
{
    $status = strtoupper((string) ($payout['status'] ?? ''));
    $hash = hostfiMeta($payout)['transactionId'] ?? null;
    $from = ['SEND_PENDING', 'SEND_UNCERTAIN'];
    if (!empty($payout['wasReversed']) || str_ends_with($status, '_FAILED')) {
        hostfiBuyClaim($id, $from, 'SEND_FAILED', ['note' => 'HostFi send ' . ($status ?: 'reversed')]);
    } elseif ($status === 'WITHDRAWAL_SUCCESS') {
        hostfiBuyClaim($id, $from, 'SENT', $hash ? ['tx_hash' => $hash] : []);
    } elseif ($status !== '') {
        hostfiBuyClaim($id, ['SEND_UNCERTAIN'], 'SEND_PENDING'); // HostFi has it and is still working on it
        $buy = hostfiBuy($id);
        // HostFi can show "in progress" long after the coin landed. The hash comes from HostFi's own
        // record, so a finalized, error-free transaction on chain is as good as its SUCCESS.
        if ($buy && $hash && hostfiChainFinalized(hostfiChain((string) $buy['network']), (string) $hash)) {
            hostfiBuyClaim($id, $from, 'SENT', ['tx_hash' => $hash, 'note' => 'Confirmed on chain while HostFi still showed ' . $status]);
        } elseif ($buy && $hash && empty($buy['tx_hash'])) {
            Database::execute('UPDATE `hostfi_buys` SET `tx_hash` = :h WHERE `id` = :id', ['h' => $hash, 'id' => $id]);
        }
    }
}

/**
 * Whether a transaction is settled on chain: Solana finalized, Bitcoin 1 confirmation, Ethereum
 * and Base mined successfully. Other chains wait for HostFi.
 */
function hostfiChainFinalized(string $chain, string $hash): bool
{
    if ($chain === 'bitcoin') {
        if (!preg_match('/^[0-9a-f]{64}$/i', $hash)) {
            return false;
        }
        foreach (['https://blockstream.info/api/tx/', 'https://mempool.space/api/tx/'] as $api) {
            try {
                $res = httpRequest('GET', $api . $hash . '/status', ['timeout' => 10]);
                return ($res['confirmed'] ?? false) === true;
            } catch (Throwable $e) {
                // try the next explorer
            }
        }
        return false;
    }
    $evm = ['ethereum' => 'https://ethereum-rpc.publicnode.com', 'base' => 'https://base-rpc.publicnode.com'][$chain] ?? null;
    if ($evm) {
        if (!preg_match('/^0x[0-9a-f]{64}$/i', $hash)) {
            return false;
        }
        try {
            $res = httpRequest('POST', $evm, [
                'headers' => ['Accept: application/json'],
                'body' => ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'eth_getTransactionReceipt', 'params' => [$hash]],
                'timeout' => 10,
            ]);
        } catch (Throwable $e) {
            return false;
        }
        return ($res['result']['status'] ?? '') === '0x1';
    }
    if ($chain !== 'solana' || !preg_match('/^[1-9A-HJ-NP-Za-km-z]{60,100}$/', $hash)) {
        return false;
    }
    try {
        $res = httpRequest('POST', 'https://api.mainnet-beta.solana.com', [
            'headers' => ['Accept: application/json'],
            'body' => ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'getSignatureStatuses', 'params' => [[$hash], ['searchTransactionHistory' => true]]],
            'timeout' => 10,
        ]);
    } catch (Throwable $e) {
        return false;
    }
    $s = $res['result']['value'][0] ?? null;
    return is_array($s) && ($s['confirmationStatus'] ?? '') === 'finalized' && ($s['err'] ?? null) === null;
}

/**
 * Retry a failed send. Only sends again once HostFi confirms the last attempt failed (or never
 * existed), and only to the wallet on the order, for the same amount.
 *
 * @return string what happened
 */
function hostfiBuyRetrySend(int $id): string
{
    $buy = hostfiBuy($id);
    $retryable = ['SEND_FAILED', 'SEND_UNCERTAIN', 'SEND_WAITING'];
    if (!$buy || !(in_array($buy['status'], $retryable, true) || ($buy['status'] === 'REVIEW' && (float) $buy['send_amount'] > 0))) {
        throw new RuntimeException('This payment has nothing to re-send');
    }
    if (!empty($buy['send_client_ref'])) {
        try {
            $last = hostfiApi()->payout((string) $buy['send_client_ref']);
        } catch (Throwable $e) {
            if ($e->getCode() !== 404) {
                throw new RuntimeException('Could not check the last send with HostFi, so nothing was sent. Try again shortly.');
            }
            hostfiRequireSettled((string) $buy['status'], (string) $buy['updated_at']);
            $last = null; // HostFi never received that attempt
        }
        $status = strtoupper((string) ($last['status'] ?? ''));
        if ($last && $status === 'WITHDRAWAL_SUCCESS' && empty($last['wasReversed'])) {
            hostfiBuySetStatus($id, 'SENT', 'HostFi shows the last send succeeded; nothing re-sent');
            hostfiBuySyncOrder($buy['order_ref']);
            return 'already_paid';
        }
        if ($last && !str_ends_with($status, '_FAILED') && empty($last['wasReversed'])) {
            hostfiBuySetStatus($id, 'SEND_PENDING', 'HostFi is still processing the last send; nothing re-sent');
            hostfiBuySyncOrder($buy['order_ref']);
            return 'still_pending';
        }
    }
    if (!hostfiBuyClaim($id, [$buy['status']], 'SWAPPED')) {
        throw new RuntimeException('The payment changed while retrying; refresh and check again');
    }
    hostfiBuySend(hostfiBuy($id));
    hostfiBuySyncOrder($buy['order_ref']);
    return 'sent';
}

/** Roll a HOSTFI buy order's status and amounts up from its payments. */
function hostfiBuySyncOrder(?string $orderRef): void
{
    if (!$orderRef) {
        return;
    }
    $order = Database::selectOne('SELECT * FROM `transactions` WHERE `reference` = :r', ['r' => $orderRef]);
    $rows = $order ? hostfiBuyBackfillPaid(Database::select('SELECT * FROM `hostfi_buys` WHERE `order_ref` = :r ORDER BY `id`', ['r' => $orderRef])) : [];
    if (!$rows) {
        return;
    }
    $statuses = array_column($rows, 'status');
    $any = static fn (array $want): bool => (bool) array_intersect($statuses, $want);
    $status = match (true) {
        $any(['SENT']) => 'COMPLETED',
        $any(['SWAPPING', 'SWAP_PENDING', 'SWAPPED', 'SENDING', 'SEND_WAITING', 'SEND_PENDING', 'SEND_UNCERTAIN', 'SEND_FAILED']) => 'PROCESSING',
        $any(['RECEIVED']) => 'CONFIRMED',
        !array_diff($statuses, ['RESOLVED']) => 'CANCELLED', // an admin closed every payment by hand
        default => 'REVIEW',
    };
    $counted = array_filter($rows, fn ($r) => !in_array($r['status'], ['REVIEW', 'RESOLVED'], true));
    $ngn = array_sum(array_map(fn ($r) => hostfiBuyPaid($r), $counted ?: $rows)); // what the customer sent
    $coin = array_sum(array_map(fn ($r) => (float) $r['send_amount'], $counted));
    $hash = null;
    foreach ($rows as $r) {
        $hash ??= $r['tx_hash'] ?: null;
    }
    Database::execute(
        'UPDATE `transactions` SET `status` = :s, `amount` = :a, `source_amount` = :a2, `destination_amount` = COALESCE(:c, `destination_amount`),
            `hash` = COALESCE(`hash`, :h), `updated_at` = NOW() WHERE `id` = :id',
        ['s' => $status, 'a' => $ngn, 'a2' => $ngn, 'c' => $coin > 0 ? $coin : null, 'h' => $hash, 'id' => $order['id']]
    );
    if ($status === 'COMPLETED' && $order['status'] !== 'COMPLETED') {
        $fresh = Database::selectOne('SELECT * FROM `transactions` WHERE `id` = :id', ['id' => $order['id']]);
        try {
            sendTransactionReceiptNow($fresh);
        } catch (Throwable $e) {
            error_log('[HostFi] Receipt failed for ' . $orderRef . ': ' . $e->getMessage()); // the poller resends unsent receipts
        }
    }
}

/** Poller safety net for missed webhooks. Read-only: re-reads sends stuck for 30+ minutes. */
function hostfiBuyReconcileOrder(string $orderRef): void
{
    hostfiBuyResumeOrder($orderRef);
    $rows = Database::select(
        "SELECT * FROM `hostfi_buys` WHERE `order_ref` = :r AND `status` IN ('SEND_PENDING','SEND_UNCERTAIN')",
        ['r' => $orderRef]
    );
    foreach ($rows as $buy) {
        if ($buy['status'] === 'SEND_PENDING' && strtotime((string) $buy['updated_at']) > time() - 1800) {
            continue;
        }
        hostfiBuyCheckSend($buy);
    }
    hostfiBuySyncOrder($orderRef);
}

/** Customer retries left: the first send is attempt 1, then up to HOSTFI_CUSTOMER_RETRY_LIMIT retries. */
function hostfiBuyRetriesLeft(array $buy): int
{
    return max(0, HOSTFI_CUSTOMER_RETRY_LIMIT + 1 - (int) $buy['send_attempts']);
}

/**
 * What the customer sees for each payment: received → converted → sent, in the same shape as
 * sell progress. No internal references.
 *
 * @return array<int,array<string,mixed>>
 */
function hostfiBuyProgress(string $orderRef): array
{
    ensureHostfiBuySchema();
    $rows = Database::safeSelect('SELECT * FROM `hostfi_buys` WHERE `order_ref` = :r ORDER BY `id`', ['r' => $orderRef], []);
    return array_map(static function (array $b): array {
        $s = $b['status'];
        $converted = (float) $b['coin_amount'] > 0 ? 'done' : (in_array($s, ['SWAPPING', 'SWAP_PENDING'], true) ? 'pending' : ($s === 'RECEIVED' ? 'waiting' : 'stopped'));
        $payout = match ($s) {
            'SENT' => 'done',
            'SENDING', 'SEND_WAITING', 'SEND_PENDING', 'SEND_UNCERTAIN' => 'pending',
            'SEND_FAILED' => 'failed',
            'REVIEW' => 'review',
            'RESOLVED' => 'resolved',
            default => 'waiting',
        };
        return [
            'kind' => 'buy',
            'amount' => hostfiBuyPaid($b),
            'currency' => 'NGN',
            'tx_hash' => $b['tx_hash'],
            'received_at' => $b['created_at'],
            'converted' => $converted,
            'payout' => $payout,
            'payout_amount' => $b['send_amount'] !== null ? (float) $b['send_amount'] : null,
            'payout_currency' => $b['currency'],
            'can_retry' => $s === 'SEND_FAILED' && hostfiBuyRetriesLeft($b) > 0,
        ];
    }, $rows);
}

/** Emails for states that need someone: the admin for anything stuck, the customer when their send failed. */
function hostfiBuyNotify(int $id, string $status): void
{
    $labels = ['REVIEW' => 'needs review', 'SEND_UNCERTAIN' => 'send unconfirmed', 'SEND_FAILED' => 'send failed'];
    if (!isset($labels[$status]) || !mailConfigured()) {
        return;
    }
    $buy = hostfiBuy($id);
    if (!$buy) {
        return;
    }
    [$order] = hostfiBuyOrderFor($buy);
    $coin = static fn ($v): string => $v !== null && (float) $v > 0 ? rtrim(rtrim(number_format((float) $v, 8, '.', ''), '0'), '.') . ' ' . $buy['currency'] : '-';
    $paid = '₦' . number_format(hostfiBuyPaid($buy), 2);
    try {
        sendMail("Velcro — HostFi buy {$labels[$status]} (" . ($buy['order_ref'] ?: 'no order') . ')', ...renderEmail([
            'eyebrow' => 'HostFi buy',
            'title' => 'A payment ' . $labels[$status],
            'intro' => (string) ($buy['note'] ?? '') !== '' ? (string) $buy['note'] : 'Check it in the admin HostFi section.',
            'rows' => [
                ['Order', (string) ($buy['order_ref'] ?: '-'), true],
                ['Paid', $paid],
                ['Swapped to', $coin($buy['coin_amount'])],
                ['To send', $coin($buy['send_amount'])],
                ['Wallet', (string) ($buy['wallet'] ?: '-'), true],
                ['Send attempts', (string) (int) $buy['send_attempts']],
                ['Customer', (string) ($order['email'] ?? '') ?: '-'],
            ],
            'cta' => ['Open admin', EMAIL_SITE_URL . '/goat/'],
        ]));

        $email = strtolower(trim((string) ($order['email'] ?? '')));
        if ($status === 'SEND_FAILED' && isValidEmail($email)) {
            $canRetry = hostfiBuyRetriesLeft($buy) > 0;
            $amount = $coin($buy['send_amount']);
            [$html, $text] = renderEmail([
                'preheader' => "Sending your {$amount} didn't go through. Your money is safe.",
                'eyebrow' => 'Send failed',
                'title' => "We couldn't send your crypto yet",
                'intro' => "We received your {$paid}, but sending {$amount} to your wallet failed. Your money is safe with us. "
                    . ($canRetry ? 'Open History on Velcro and tap "Retry" to send it again to the same wallet.' : 'Our team is looking into it and will contact you.'),
                'amount' => ['To your wallet', $amount],
                'rows' => [['Reference', (string) $buy['order_ref'], true]],
                'cta' => ['Open Velcro', EMAIL_SITE_URL],
                'outro' => 'For your safety, a retry can only go to the wallet on this order.',
            ]);
            sendEmailTo($email, "Action needed: sending your {$amount} failed", $html, $text);
        }
    } catch (Throwable $e) {
        error_log("[HostFi] Notify failed for buy {$id}: " . $e->getMessage());
    }
}

/**
 * FIAT_DEPOSIT webhook: re-fetch the payment from HostFi, find its order, and convert and send.
 * Returns false if HostFi doesn't confirm the payment.
 */
function hostfiHandleFiatDeposit(array $data): bool
{
    ensureHostfiBuySchema();
    $live = null;
    foreach (array_filter([$data['reference'] ?? null, $data['serviceReference'] ?? null]) as $ref) {
        try {
            $live = hostfiApi()->collectionTransaction((string) $ref);
            break;
        } catch (Throwable $e) {
            $live = null;
        }
    }
    $ok = $live
        && strtoupper((string) ($live['status'] ?? '')) === 'SUCCESS'
        && strtoupper((string) ($live['type'] ?? '')) === 'CREDIT'
        && strtoupper((string) ($live['amount']['currency'] ?? '')) === 'NGN'
        && empty($live['wasReversed']);
    if (!$ok) {
        auditLog('HOSTFI_WEBHOOK_UNVERIFIED', ['event' => 'FIAT_DEPOSIT', 'reference' => $data['reference'] ?? null]);
        return false;
    }
    // Find the order from HostFi's record only: our customId, else the account it was paid into.
    $meta = hostfiMeta($live);
    $field = static fn (string $k) => (string) ($live[$k] ?? $meta[$k] ?? '');
    $order = null;
    $customId = $field('customId');
    if ($customId !== '') {
        $order = Database::selectOne("SELECT * FROM `transactions` WHERE `reference` = :r AND `channel` = 'HOSTFI' AND `type` = 'ONRAMP'", ['r' => $customId]);
    }
    $acctRef = $field('recipientAccountReference');
    if (!$order && preg_match('/^[a-zA-Z0-9-]{8,64}$/', $acctRef)) {
        $order = Database::selectOne(
            "SELECT * FROM `transactions` WHERE `channel` = 'HOSTFI' AND `type` = 'ONRAMP' AND `meta` LIKE :m ORDER BY `id` DESC LIMIT 1",
            ['m' => '%"channel_ref":"' . $acctRef . '"%']
        );
    }
    $acct = $field('recipientAccountNumber');
    if (!$order && preg_match('/^\d{10}$/', $acct)) {
        $order = Database::selectOne(
            "SELECT * FROM `transactions` WHERE `channel` = 'HOSTFI' AND `type` = 'ONRAMP' AND `deposit_account_number` = :a ORDER BY `id` DESC LIMIT 1",
            ['a' => $acct]
        );
    }
    $id = hostfiRecordPayment((string) ($live['reference'] ?? $data['reference']), $order, (float) ($live['amount']['value'] ?? 0), hostfiPaidNgn($live));
    hostfiProcessPayment($id);
    return true;
}

// ─── Routes ───

function registerHostfiBuyRoutes(Router $router): void
{
    // Coins to buy through HostFi, with the networks HostFi can send them on and its fees.
    $router->get('/api/hostfi/buy-assets', function () {
        jsonResponse(successResponse(hostfiCachedList('buy', static function (): array {
            $out = [];
            foreach (hostfiEnabledAssets('buy') as $symbol) {
                try {
                    $networks = array_map(fn ($n) => ['code' => $n['network'], 'chain' => hostfiChain($n['network']), 'fee' => $n['flat'], 'fee_percent' => $n['percent'], 'min' => $n['min']], hostfiApi()->cryptoSendNetworks($symbol));
                    $networks = array_values(array_filter($networks, fn ($n) => in_array($n['chain'], ['bitcoin', 'ethereum', 'base', 'bsc', 'solana', 'polygon', 'arbitrum', 'optimism'], true)));
                    if (!$networks) {
                        continue;
                    }
                    $coinPerNgn = hostfiRate('NGN', $symbol);
                    $quote = hostfiQuote($symbol);
                    $out[] = [
                        'symbol' => $symbol,
                        'name' => (string) (hostfiApi()->walletAsset($symbol)['currency']['name'] ?? $symbol),
                        'networks' => $networks,
                        'coin_per_ngn' => $coinPerNgn * (1 - hostfiFee() / 100), // what the user gets per naira, before the network fee
                        'ngn_per_unit_gross' => $coinPerNgn > 0 ? 1 / $coinPerNgn : 0, // HostFi's own price, shown to users
                        'usd_per_unit' => $quote['usd_per_unit'],
                        'timer_minutes' => HOSTFI_BUY_TIMER_MINUTES,
                        'collection_fee_ngn' => HOSTFI_COLLECTION_FEE_NGN, // HostFi keeps this from each transfer
                    ];
                } catch (Throwable $e) {
                    error_log("[HostFi] buy {$symbol} unavailable: " . $e->getMessage()); // hide the coin rather than fail the list
                }
            }
            return $out;
        })));
    });

    $router->post('/api/hostfi/buy', function () {
        if (!rateLimitCheck('order_initiate_' . clientIp(), 15, 600)) {
            jsonResponse(errorResponse('Too many order attempts. Please wait a few minutes before trying again.'), 429);
        }
        ensureHostfiBuySchema();
        $b = getJsonBody();
        $symbol = strtoupper((string) body($b, 'asset', ''));
        $network = (string) body($b, 'network', '');
        $wallet = trim((string) body($b, 'wallet', ''));
        $amount = (float) body($b, 'amount', 0);
        $email = strtolower(trim((string) body($b, 'email', '')));

        if (!in_array($symbol, hostfiEnabledAssets('buy'), true)) {
            jsonResponse(errorResponse("{$symbol} buys are not available right now"), 400);
        }
        if ($email !== '' && !isValidEmail($email)) {
            jsonResponse(errorResponse('Invalid email address'), 400);
        }
        $chain = hostfiChain($network);
        if (!hostfiValidWallet($chain, $wallet)) {
            jsonResponse(errorResponse("That isn't a valid {$symbol} wallet address for this network"), 400);
        }
        $max = (float) (loadSettings()['buy_max_limit'] ?? 1000000);
        if ($amount <= 0 || $amount > $max) {
            jsonResponse(errorResponse('Amount must be more than ₦0 and at most ₦' . number_format($max)), 400);
        }
        try {
            $net = null;
            foreach (hostfiApi()->cryptoSendNetworks($symbol) as $n) {
                if ($n['network'] === $network) {
                    $net = $n;
                }
            }
            if (!$net) {
                jsonResponse(errorResponse("{$symbol} can't be sent on that network"), 400);
            }
            $coinPerNgn = hostfiRate('NGN', $symbol);
            $grossCoin = max(0, $amount - HOSTFI_COLLECTION_FEE_NGN) * (1 - hostfiFee() / 100) * $coinPerNgn;
            $estimate = hostfiFloorCoin($grossCoin - ($net['flat'] + $grossCoin * $net['percent'] / 100));
            if ($estimate < max($net['min'], 1e-8)) {
                $minNgn = ceil((($net['min'] + $net['flat']) / ($coinPerNgn * (1 - hostfiFee() / 100) * (1 - $net['percent'] / 100)) + HOSTFI_COLLECTION_FEE_NGN) / 100) * 100;
                jsonResponse(errorResponse('Minimum for ' . $symbol . ' on this network is ₦' . number_format($minNgn)), 400);
            }

            $reference = 'hfb_' . bin2hex(random_bytes(10));
            $acct = hostfiApi()->createNairaAccount($reference);
            if (empty($acct['accountNumber'])) {
                throw new RuntimeException('HostFi did not return an account');
            }
            $quote = hostfiQuote($symbol);
            Database::insert('transactions', [
                'reference' => $reference,
                'type' => 'ONRAMP',
                'status' => 'AWAITING_DEPOSIT',
                'country' => 'NG',
                'currency' => 'NGN',
                'asset' => $chain . ':' . strtolower($symbol),
                'channel' => 'HOSTFI',
                'amount' => $amount,
                'rate' => $coinPerNgn > 0 ? 1 / $coinPerNgn : null,
                'source_amount' => $amount,
                'source_currency' => 'NGN',
                'destination_amount' => $estimate,
                'destination_currency' => $symbol,
                'deposit_bank_name' => (string) ($acct['bankName'] ?? ''),
                'deposit_account_number' => (string) $acct['accountNumber'],
                'deposit_account_name' => (string) ($acct['accountName'] ?? ''),
                'wallet_address' => $wallet,
                'email' => $email !== '' ? $email : null,
                'meta' => jsonEncodeNullable(['hostfi' => [
                    'side' => 'buy',
                    'symbol' => $symbol,
                    'network' => $network,
                    'channel_id' => $acct['id'] ?? null,
                    'channel_ref' => $acct['reference'] ?? null,
                    'expires_at' => time() + HOSTFI_BUY_TIMER_MINUTES * 60,
                    'timer_minutes' => HOSTFI_BUY_TIMER_MINUTES,
                    // Quote at order time, so History can show "$1 = ₦X" plus our fee.
                    'quote' => ['ngn_per_usd' => $quote['usd_per_unit'] > 0 && $coinPerNgn > 0 ? (1 / $coinPerNgn) / $quote['usd_per_unit'] : null, 'fee_percent' => hostfiFee()],
                ]]),
            ] + referralFieldsFor(body($b, 'ref'), $email));

            if ($email !== '') {
                try {
                    sendOrderInitiatedEmailNow(Database::selectOne('SELECT * FROM `transactions` WHERE `reference` = :r', ['r' => $reference]) ?: []);
                } catch (Throwable $mailErr) {
                    error_log('[HostFi] Buy order email failed: ' . $mailErr->getMessage());
                }
            }

            jsonResponse(successResponse([
                'reference' => $reference,
                'bank_name' => (string) ($acct['bankName'] ?? ''),
                'account_number' => (string) $acct['accountNumber'],
                'account_name' => (string) ($acct['accountName'] ?? ''),
                'expires_in' => HOSTFI_BUY_TIMER_MINUTES * 60,
                'estimate' => $estimate,
                'network' => $network,
                'chain' => $chain,
            ]));
        } catch (Throwable $e) {
            error_log('[HostFi] buy failed: ' . $e->getMessage());
            jsonResponse(errorResponse('Could not create your payment account. Please try again.'), 502);
        }
    });

    $router->post('/api/admin/hostfi/buys/(\d+)/retry', function (string $id) {
        requireAdminAuth();
        ensureHostfiBuySchema();
        $buy = hostfiBuy((int) $id);
        if (!$buy || in_array($buy['status'], ['SENT', 'RESOLVED'], true)) {
            jsonResponse(['success' => false, 'error' => 'Nothing to retry for this payment'], 400);
        }
        auditLog('HOSTFI_BUY_RETRY', ['id' => (int) $id, 'from' => $buy['status']]);
        $outcome = 'processed';
        try {
            if (in_array($buy['status'], ['SEND_FAILED', 'SEND_UNCERTAIN', 'SEND_WAITING'], true) || ($buy['status'] === 'REVIEW' && (float) $buy['send_amount'] > 0)) {
                $outcome = hostfiBuyRetrySend((int) $id); // swap already done: only the send is retried
            } elseif ($buy['status'] === 'SWAP_PENDING') {
                hostfiBuyCheckSwap($buy);
            } elseif ($buy['status'] === 'SEND_PENDING') {
                hostfiBuyCheckSend($buy);
                hostfiBuySyncOrder($buy['order_ref']);
            } else {
                hostfiProcessPayment((int) $id, true); // "Approve & send" a payment held before its swap
            }
        } catch (Throwable $e) {
            jsonResponse(['success' => false, 'error' => $e->getMessage()], 400);
        }
        jsonResponse(['success' => true, 'outcome' => $outcome, 'buy' => hostfiBuy((int) $id)]);
    });

    $router->post('/api/admin/hostfi/buys/(\d+)/resolve', function (string $id) {
        requireAdminAuth();
        ensureHostfiBuySchema();
        $note = substr(trim((string) body(getJsonBody(), 'note', 'Resolved manually')), 0, 300);
        $buy = hostfiBuy((int) $id);
        if (!$buy || !in_array($buy['status'], ['REVIEW', 'SEND_FAILED', 'SEND_UNCERTAIN', 'SEND_WAITING', 'SWAP_PENDING'], true)) {
            jsonResponse(['success' => false, 'error' => 'Only payments that need attention can be resolved'], 400);
        }
        hostfiBuySetStatus((int) $id, 'RESOLVED', $note);
        hostfiBuySyncOrder($buy['order_ref']);
        auditLog('HOSTFI_BUY_RESOLVED', ['id' => (int) $id, 'note' => $note]);
        jsonResponse(['success' => true]);
    });
}
