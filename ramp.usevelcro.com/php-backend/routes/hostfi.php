<?php

declare(strict_types=1);

require_once __DIR__ . '/../hostfi_api.php';
require_once __DIR__ . '/../emails.php';
require_once __DIR__ . '/referrals.php';

/*
 * HostFi sells (offramp): BTC and ETH, plus SOL/USDT/USDC when switched on in admin.
 *
 * 1. The user starts a sell. We create a fresh HostFi deposit address for that one order
 *    (customId = order reference) and store the user's bank account on the order.
 * 2. HostFi sends CRYPTO_DEPOSIT. Webhooks are unsigned, so the payload only names the
 *    deposit; we re-fetch it from HostFi and act only on what HostFi itself returns.
 * 3. Each deposit runs its own pipeline, driven by HostFi's webhooks:
 *    RECEIVED → SWAPPING (→ SWAP_PENDING until the swap webhook) → SWAPPED → PAYING →
 *    PAYOUT_PENDING → PAID (payout webhook). Anything unexpected stops in REVIEW.
 * 4. The payout is the swap's naira minus our fee and HostFi's ₦50 payout charge, never more. A failed
 *    payout waits for a "Retry payout" (customer or admin), which re-sends only once HostFi confirms
 *    the last attempt failed.
 * 5. Anything stuck (REVIEW, uncertain or failed payout) emails the admin; a failed payout also
 *    emails the customer so they can retry from History.
 *
 * Every step claims its row with a conditional UPDATE, so a repeated webhook, the poller
 * and an admin click can never run the same swap or payout twice.
 */

const HOSTFI_SYMBOLS = ['BTC', 'ETH', 'SOL', 'USDT', 'USDC'];
const HOSTFI_STABLES = ['USDT', 'USDC'];
// HostFi's charge per bank payout. Taken off the user's payout and the estimate, not shown as its own line.
const HOSTFI_PAYOUT_FEE_NGN = 50.0;

function ensureHostfiSchema(): void
{
    static $done = false;
    $flag = BASE_PATH . '/data/.hostfi_schema_v1';
    if ($done || file_exists($flag)) {
        $done = true;
        return;
    }
    Database::pdo()->exec("CREATE TABLE IF NOT EXISTS `hostfi_deposits` (
        `id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `deposit_ref` VARCHAR(100) NOT NULL UNIQUE,
        `order_ref` VARCHAR(255) DEFAULT NULL,
        `address` VARCHAR(255) DEFAULT NULL,
        `currency` VARCHAR(20) NOT NULL,
        `network` VARCHAR(40) DEFAULT NULL,
        `amount` DECIMAL(36,18) NOT NULL,
        `tx_hash` VARCHAR(255) DEFAULT NULL,
        `status` VARCHAR(20) NOT NULL DEFAULT 'RECEIVED',
        `ngn_amount` DECIMAL(24,2) DEFAULT NULL,
        `payout_amount` DECIMAL(24,2) DEFAULT NULL,
        `swap_ref` VARCHAR(100) DEFAULT NULL,
        `swap_pair_ref` VARCHAR(100) DEFAULT NULL,
        `payout_ref` VARCHAR(100) DEFAULT NULL,
        `payout_client_ref` VARCHAR(150) DEFAULT NULL,
        `payout_attempts` INT NOT NULL DEFAULT 0,
        `note` VARCHAR(500) DEFAULT NULL,
        `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
        `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY `idx_order_ref` (`order_ref`),
        KEY `idx_status` (`status`),
        KEY `idx_payout_client_ref` (`payout_client_ref`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    @file_put_contents($flag, gmdate('c'));
    $done = true;
}

// ─── Settings ───

/** Symbols currently sold through HostFi (switched on in admin and HostFi configured). */
function hostfiEnabledAssets(): array
{
    if (!hostfiApi()->isConfigured()) {
        return [];
    }
    $on = (array) (loadSettings()['hostfi_assets'] ?? []);
    return array_values(array_filter(HOSTFI_SYMBOLS, fn ($s) => !empty($on[$s])));
}

function hostfiFee(): float
{
    $fee = (float) (loadSettings()['hostfi_fee'] ?? DEVELOPER_FEE);
    return ($fee >= 0 && $fee <= 10) ? $fee : DEVELOPER_FEE;
}

function sellTimerMinutes(string $symbol): int
{
    $t = (array) (loadSettings()['sell_timer_minutes'] ?? []);
    return (int) ($t[strtoupper($symbol)] ?? $t['default'] ?? 60);
}

/** Our chain slug for a HostFi network code (used for logos, explorers and receipts). */
function hostfiChain(string $network): string
{
    $n = strtoupper($network);
    $map = [
        'BTC' => 'bitcoin', 'BITCOIN' => 'bitcoin',
        'ERC20' => 'ethereum', 'ETH' => 'ethereum', 'ETHEREUM' => 'ethereum',
        'TRC20' => 'tron', 'TRX' => 'tron', 'TRON' => 'tron',
        'BEP20' => 'bsc', 'BSC' => 'bsc', 'BNB' => 'bsc',
        'SOL' => 'solana', 'SPL' => 'solana', 'SOLANA' => 'solana',
        'POL' => 'polygon', 'POLYGON' => 'polygon', 'MATIC' => 'polygon', 'BASE' => 'base',
        'XLM' => 'stellar', 'STELLAR' => 'stellar',
        'ARBITRUM' => 'arbitrum', 'OPTIMISM' => 'optimism', 'AVAXC' => 'avalanche',
    ];
    return $map[$n] ?? strtolower(preg_replace('/[^a-z0-9]/i', '', $network) ?? '');
}

// ─── Quotes ───

/**
 * Naira per coin after Velcro's fee, and the coin's USD value. Cached for a minute.
 *
 * @return array{ngn_per_unit: float, usd_per_unit: float}
 */
function hostfiQuote(string $symbol): array
{
    $symbol = strtoupper($symbol);
    $file = BASE_PATH . '/data/.hostfi_quotes.json';
    $cache = is_file($file) ? (json_decode((string) @file_get_contents($file), true) ?: []) : [];
    $pair = static function (string $from, string $to) use (&$cache): float {
        $key = "{$from}/{$to}";
        if (isset($cache[$key]) && ($cache[$key]['at'] ?? 0) > time() - 60) {
            return (float) $cache[$key]['rate'];
        }
        $rate = hostfiApi()->rate($from, $to);
        $cache[$key] = ['rate' => $rate, 'at' => time()];
        return $rate;
    };
    $ngn = $pair($symbol, 'NGN');
    // Stablecoins count as exactly $1 (what users expect when typing a $ amount). Other coins use
    // HostFi's own dollar price; ETH has no USD pair there, so it goes via USDT.
    try {
        $usd = in_array($symbol, HOSTFI_STABLES, true) ? 1.0 : $pair($symbol, 'USD');
    } catch (Throwable $e) {
        $usdtNgn = $pair('USDT', 'NGN');
        $usd = $usdtNgn > 0 ? $ngn / $usdtNgn : 0.0;
    }
    @file_put_contents($file, json_encode($cache), LOCK_EX);
    return [
        'ngn_per_unit' => $ngn * (1 - hostfiFee() / 100), // what the user is paid per coin
        'ngn_per_unit_gross' => $ngn,                      // HostFi's own rate, shown to users
        'usd_per_unit' => $usd,
    ];
}

// ─── Deposit pipeline ───

/** @return array<string,mixed>|null */
function hostfiDeposit(int $id): ?array
{
    return Database::selectOne('SELECT * FROM `hostfi_deposits` WHERE `id` = :id', ['id' => $id]);
}

/** Move a deposit from one of $from to $to. Returns false if another worker got there first. */
function hostfiClaim(int $id, array $from, string $to, array $set = []): bool
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
        "UPDATE `hostfi_deposits` SET `status` = :to{$extra}, `updated_at` = NOW() WHERE `id` = :id AND `status` IN (" . implode(',', $in) . ')',
        $params
    ) === 1;
    if ($moved) {
        hostfiNotify($id, $to);
    }
    return $moved;
}

function hostfiSetStatus(int $id, string $status, ?string $note = null): void
{
    Database::execute(
        'UPDATE `hostfi_deposits` SET `status` = :s, `note` = COALESCE(:n, `note`), `updated_at` = NOW() WHERE `id` = :id',
        ['s' => $status, 'n' => $note, 'id' => $id]
    );
    hostfiNotify($id, $status);
}

/** Emails for states that need someone: the admin for anything stuck, the customer when their payout failed. */
function hostfiNotify(int $id, string $status): void
{
    $labels = ['REVIEW' => 'needs review', 'PAYOUT_UNCERTAIN' => 'payout unconfirmed', 'PAYOUT_FAILED' => 'payout failed'];
    if (!isset($labels[$status]) || !mailConfigured()) {
        return;
    }
    $dep = hostfiDeposit($id);
    if (!$dep) {
        return;
    }
    $order = $dep['order_ref'] ? Database::selectOne('SELECT * FROM `transactions` WHERE `reference` = :r', ['r' => $dep['order_ref']]) : null;
    $ngn = static fn ($v): string => $v !== null && (float) $v > 0 ? '₦' . number_format((float) $v, 2) : '-';
    $coin = rtrim(rtrim(number_format((float) $dep['amount'], 8, '.', ''), '0'), '.') . ' ' . $dep['currency'];
    try {
        sendMail("Velcro — HostFi deposit {$labels[$status]} (" . ($dep['order_ref'] ?: 'no order') . ')', ...renderEmail([
            'eyebrow' => 'HostFi',
            'title' => 'A deposit ' . $labels[$status],
            'intro' => (string) ($dep['note'] ?? '') !== '' ? (string) $dep['note'] : 'Check it in the admin HostFi section.',
            'rows' => [
                ['Order', (string) ($dep['order_ref'] ?: '-'), true],
                ['Deposit', $coin],
                ['Naira from swap', $ngn($dep['ngn_amount'])],
                ['Payout', $ngn($dep['payout_amount'])],
                ['Payout attempts', (string) (int) $dep['payout_attempts']],
                ['Customer', (string) ($order['email'] ?? '') ?: '-'],
            ],
            'cta' => ['Open admin', EMAIL_SITE_URL . '/goat/'],
        ]));

        $email = strtolower(trim((string) ($order['email'] ?? '')));
        if ($status === 'PAYOUT_FAILED' && isValidEmail($email)) {
            $canRetry = hostfiCustomerRetriesLeft($dep) > 0;
            $amount = $ngn($dep['payout_amount']);
            [$html, $text] = renderEmail([
                'preheader' => "Your {$amount} payout didn't go through. Your money is safe.",
                'eyebrow' => 'Payout failed',
                'title' => "Your payout didn't go through",
                'intro' => "We received your {$coin}, but the bank transfer of {$amount} failed. Your money is safe with us. "
                    . ($canRetry ? 'Open History on Velcro and tap "Retry payout" to send it again to the same account.' : 'Our team is looking into it and will contact you.'),
                'amount' => ['Payout', $amount],
                'rows' => [['Reference', (string) $dep['order_ref'], true]],
                'cta' => ['Open Velcro', EMAIL_SITE_URL],
                'outro' => 'For your safety, a retry can only go to the bank account on this order.',
            ]);
            sendEmailTo($email, "Action needed: your {$amount} payout failed", $html, $text);
        }
    } catch (Throwable $e) {
        error_log("[HostFi] Notify failed for deposit {$id}: " . $e->getMessage());
    }
}

/**
 * Store a deposit HostFi has confirmed. Idempotent on HostFi's reference.
 *
 * @param array{ref:string,address:?string,currency:string,network:?string,amount:float,tx_hash:?string} $d
 */
function hostfiRecordDeposit(array $d): int
{
    ensureHostfiSchema();
    $order = $d['address'] ? Database::selectOne(
        "SELECT `reference` FROM `transactions` WHERE `channel` = 'HOSTFI' AND `deposit_address` = :a ORDER BY `id` DESC LIMIT 1",
        ['a' => $d['address']]
    ) : null;
    try {
        return (int) Database::insert('hostfi_deposits', [
            'deposit_ref' => $d['ref'],
            'order_ref' => $order['reference'] ?? null,
            'address' => $d['address'],
            'currency' => strtoupper($d['currency']),
            'network' => $d['network'],
            'amount' => $d['amount'],
            'tx_hash' => $d['tx_hash'],
            'status' => 'RECEIVED',
        ]);
    } catch (PDOException $e) {
        $existing = Database::selectOne('SELECT `id` FROM `hostfi_deposits` WHERE `deposit_ref` = :r', ['r' => $d['ref']]);
        if ($existing) {
            return (int) $existing['id']; // webhook delivered twice
        }
        throw $e;
    }
}

/** @return array{0: ?array, 1: array} the deposit's order and its HostFi meta (bank, symbol…) */
function hostfiOrderFor(array $dep): array
{
    $order = $dep['order_ref'] ? Database::selectOne('SELECT * FROM `transactions` WHERE `reference` = :r', ['r' => $dep['order_ref']]) : null;
    $meta = $order ? (json_decode((string) ($order['meta'] ?? ''), true) ?: []) : [];
    return [$order, $meta['hostfi'] ?? []];
}

/**
 * A confirmed deposit: run the checks, then swap. Called from the deposit webhook, or by an
 * admin ($force = "Approve & pay", which skips the automatic checks for a deposit in REVIEW).
 * A swap that HostFi finishes later continues from the swap webhook (hostfiSwapWebhook).
 */
function hostfiProcessDeposit(int $id, bool $force = false): void
{
    $dep = hostfiDeposit($id);
    if (!$dep) {
        return;
    }
    [$order, $hf] = hostfiOrderFor($dep);

    if ($dep['status'] === 'RECEIVED' || ($force && $dep['status'] === 'REVIEW')) {
        $problem = $force ? null : hostfiAutoPayProblem($dep, $order, $hf);
        if ($problem !== null) {
            hostfiSetStatus($id, 'REVIEW', $problem);
            hostfiSyncOrder($dep['order_ref']);
            return;
        }
        if (!$order || empty($hf['bank'])) {
            hostfiSetStatus($id, 'REVIEW', 'No order or bank account for this deposit');
            return;
        }
        if (!empty($dep['swap_ref'])) {
            // Already swapped once (held in REVIEW later on). Never convert the same deposit twice.
            hostfiClaim($id, [$dep['status']], 'SWAPPED');
        } else {
            if (!hostfiClaim($id, [$dep['status']], 'SWAPPING')) {
                return;
            }
            hostfiSyncOrder($dep['order_ref']);
            try {
                $credit = hostfiApi()->swap($dep['currency'], 'NGN', (float) $dep['amount']);
            } catch (Throwable $e) {
                // No idempotency key on swaps, so a failed or timed-out swap is checked by a person, not retried.
                hostfiSetStatus($id, 'REVIEW', 'Swap failed: ' . substr($e->getMessage(), 0, 300));
                hostfiSyncOrder($dep['order_ref']);
                return;
            }
            Database::execute(
                'UPDATE `hostfi_deposits` SET `swap_ref` = :sr, `swap_pair_ref` = :sp, `updated_at` = NOW() WHERE `id` = :id',
                ['sr' => (string) ($credit['reference'] ?? ''), 'sp' => (string) ($credit['swapPairReference'] ?? ''), 'id' => $id]
            );
            $swapStatus = strtoupper((string) ($credit['status'] ?? ''));
            if ($swapStatus === 'SUCCESS') {
                hostfiSwapSucceeded($id, $credit);
            } elseif ($swapStatus === 'FAILED') {
                hostfiSetStatus($id, 'REVIEW', 'HostFi reported the swap as failed');
            } else {
                hostfiClaim($id, ['SWAPPING'], 'SWAP_PENDING'); // the swap webhook takes it from here
            }
        }
    }

    $dep = hostfiDeposit($id);
    if ($dep['status'] === 'SWAPPED') {
        hostfiSendPayout($dep, $hf);
    }
    hostfiSyncOrder($dep['order_ref']);
}

/** Record the naira a swap produced and what the user is owed: swap credit minus our fee and HostFi's ₦50, never more. */
function hostfiSwapSucceeded(int $id, array $credit): void
{
    $ngn = (float) ($credit['amount']['value'] ?? 0);
    if ($ngn <= 0) {
        hostfiSetStatus($id, 'REVIEW', 'Swap returned no naira amount');
        return;
    }
    $payout = floor($ngn * (1 - hostfiFee() / 100) * 100) / 100 - HOSTFI_PAYOUT_FEE_NGN;
    if ($payout <= 0) {
        hostfiClaim($id, ['SWAPPING', 'SWAP_PENDING'], 'REVIEW', ['ngn_amount' => $ngn, 'note' => 'Too small to cover the payout fee']);
        return;
    }
    hostfiClaim($id, ['SWAPPING', 'SWAP_PENDING'], 'SWAPPED', ['ngn_amount' => $ngn, 'payout_amount' => $payout]);
}

/** Swap webhook: re-fetch the credit leg from HostFi and, if it succeeded, pay out. */
function hostfiSwapWebhook(array $legs): void
{
    foreach ($legs as $leg) {
        if (strtoupper((string) ($leg['type'] ?? '')) !== 'CREDIT' || empty($leg['reference'])) {
            continue;
        }
        $dep = Database::selectOne(
            "SELECT * FROM `hostfi_deposits` WHERE `status` = 'SWAP_PENDING' AND (`swap_ref` = :r OR (`swap_pair_ref` <> '' AND `swap_pair_ref` = :p))",
            ['r' => (string) $leg['reference'], 'p' => (string) ($leg['swapPairReference'] ?? '')]
        );
        if ($dep) {
            hostfiCheckSwap($dep);
        }
    }
}

/** Ask HostFi how a pending swap ended. Used by the swap webhook and the admin "Check swap" button. */
function hostfiCheckSwap(array $dep): void
{
    try {
        $live = hostfiApi()->assetTransaction((string) $dep['swap_ref']);
    } catch (Throwable $e) {
        return;
    }
    $status = strtoupper((string) ($live['status'] ?? ''));
    if ($status === 'SUCCESS' && strtoupper((string) ($live['type'] ?? '')) === 'CREDIT') {
        hostfiSwapSucceeded((int) $dep['id'], $live);
        $dep = hostfiDeposit((int) $dep['id']);
        if ($dep['status'] === 'SWAPPED') {
            hostfiSendPayout($dep, hostfiOrderFor($dep)[1]);
        }
    } elseif ($status === 'FAILED') {
        hostfiClaim((int) $dep['id'], ['SWAP_PENDING'], 'REVIEW', ['note' => 'HostFi reported the swap as failed']);
    }
    hostfiSyncOrder($dep['order_ref']);
}

/** Why a deposit can't be paid automatically, or null if it can. */
function hostfiAutoPayProblem(array $dep, ?array $order, array $hf): ?string
{
    if (!$order) {
        return 'Deposit to an address with no order';
    }
    if (strtoupper((string) ($hf['symbol'] ?? '')) !== strtoupper((string) $dep['currency'])) {
        return "Sent {$dep['currency']} to a " . ($hf['symbol'] ?? '?') . ' order';
    }
    $paid = Database::selectOne(
        "SELECT `id` FROM `hostfi_deposits` WHERE `order_ref` = :r AND `id` <> :id
            AND `status` IN ('SWAPPING','SWAP_PENDING','SWAPPED','PAYING','PAYOUT_PENDING','PAYOUT_UNCERTAIN','PAYOUT_FAILED','PAID')",
        ['r' => $order['reference'], 'id' => $dep['id']]
    );
    if ($paid) {
        return 'Repeat deposit to an order that was already paid';
    }
    try {
        $usd = (float) $dep['amount'] * hostfiQuote((string) $dep['currency'])['usd_per_unit'];
    } catch (Throwable $e) {
        return 'Could not price the deposit: ' . substr($e->getMessage(), 0, 200);
    }
    $s = loadSettings();
    $min = (float) ($s['sell_min_limit'] ?? 1);
    $max = (float) ($s['sell_max_limit'] ?? 10000);
    if ($usd < $min || $usd > $max) {
        return sprintf('Deposit worth $%.2f is outside the $%s–$%s sell limits', $usd, number_format($min), number_format($max));
    }
    return null;
}

/**
 * Send one payout attempt for a SWAPPED deposit. Each attempt has its own clientReference
 * (order-deposit-attempt), so HostFi rejects a repeat of the same attempt as a duplicate.
 */
function hostfiSendPayout(array $dep, array $hf): void
{
    $id = (int) $dep['id'];
    $attempt = (int) $dep['payout_attempts'] + 1;
    $clientRef = $dep['order_ref'] . '-' . $id . '-' . $attempt;
    if (!hostfiClaim($id, ['SWAPPED'], 'PAYING', ['payout_attempts' => $attempt, 'payout_client_ref' => $clientRef])) {
        return;
    }
    try {
        $res = hostfiApi()->payoutToBank((float) $dep['payout_amount'], $hf['bank'], $clientRef, 'Velcro ' . $dep['order_ref']);
    } catch (Throwable $e) {
        // A timeout can still have created the payout. Look it up; if HostFi can't say, nothing is
        // re-sent until it can (see hostfiCheckPayout), so the user is never paid twice.
        try {
            $res = hostfiApi()->payout($clientRef);
        } catch (Throwable $lookup) {
            hostfiClaim($id, ['PAYING'], 'PAYOUT_UNCERTAIN', ['note' => 'Payout request failed (' . substr($e->getMessage(), 0, 200) . '); waiting for HostFi to confirm before any retry']);
            return;
        }
    }
    hostfiClaim($id, ['PAYING'], 'PAYOUT_PENDING', ['payout_ref' => (string) ($res['reference'] ?? '')]);
    hostfiApplyPayoutStatus($id, $res);
}

/**
 * Re-read a payout from HostFi (payout webhook, poller safety net, admin). Read-only: it only
 * records what HostFi says. An uncertain request HostFi still has no record of after 10 minutes
 * is treated as never created, which makes it safe for an admin to retry.
 */
function hostfiCheckPayout(array $dep): void
{
    if (!in_array($dep['status'], ['PAYOUT_PENDING', 'PAYOUT_UNCERTAIN'], true) || empty($dep['payout_client_ref'])) {
        return;
    }
    try {
        $res = hostfiApi()->payout((string) $dep['payout_client_ref']);
    } catch (Throwable $e) {
        if ($e->getCode() === 404 && $dep['status'] === 'PAYOUT_UNCERTAIN' && strtotime((string) $dep['updated_at']) < time() - 600) {
            hostfiClaim((int) $dep['id'], ['PAYOUT_UNCERTAIN'], 'PAYOUT_FAILED', ['note' => 'HostFi has no record of the payout request; safe to retry']);
        }
        return;
    }
    hostfiApplyPayoutStatus((int) $dep['id'], $res);
}

function hostfiApplyPayoutStatus(int $id, array $payout): void
{
    $status = strtoupper((string) ($payout['status'] ?? ''));
    $from = ['PAYOUT_PENDING', 'PAYOUT_UNCERTAIN'];
    if (!empty($payout['wasReversed']) || str_ends_with($status, '_FAILED')) {
        hostfiClaim($id, $from, 'PAYOUT_FAILED', ['note' => 'HostFi payout ' . ($status ?: 'reversed')]);
    } elseif ($status === 'WITHDRAWAL_SUCCESS') {
        hostfiClaim($id, $from, 'PAID');
    } elseif ($status !== '') {
        hostfiClaim($id, ['PAYOUT_UNCERTAIN'], 'PAYOUT_PENDING'); // HostFi has it and is still working on it
    }
}

/**
 * Admin "Retry payout". Only sends again once HostFi confirms the last attempt failed (or never
 * existed). If HostFi says it actually went through, the deposit is marked PAID instead.
 *
 * @return string what happened, for the admin
 */
function hostfiRetryPayout(int $id): string
{
    $dep = hostfiDeposit($id);
    $retryable = ['PAYOUT_FAILED', 'PAYOUT_UNCERTAIN'];
    if (!$dep || !(in_array($dep['status'], $retryable, true) || ($dep['status'] === 'REVIEW' && !empty($dep['ngn_amount'])))) {
        throw new RuntimeException('This deposit has no payout to retry');
    }
    if (!empty($dep['payout_client_ref'])) {
        try {
            $last = hostfiApi()->payout((string) $dep['payout_client_ref']);
        } catch (Throwable $e) {
            if ($e->getCode() !== 404) {
                throw new RuntimeException('Could not check the last payout with HostFi, so nothing was sent. Try again shortly.');
            }
            $last = null; // HostFi never received that attempt
        }
        $status = strtoupper((string) ($last['status'] ?? ''));
        if ($last && $status === 'WITHDRAWAL_SUCCESS' && empty($last['wasReversed'])) {
            hostfiSetStatus($id, 'PAID', 'HostFi shows the last payout succeeded; nothing re-sent');
            hostfiSyncOrder($dep['order_ref']);
            return 'already_paid';
        }
        if ($last && !str_ends_with($status, '_FAILED') && empty($last['wasReversed'])) {
            hostfiSetStatus($id, 'PAYOUT_PENDING', 'HostFi is still processing the last payout; nothing re-sent');
            hostfiSyncOrder($dep['order_ref']);
            return 'still_pending';
        }
    }
    if (!hostfiClaim($id, [$dep['status']], 'SWAPPED')) {
        throw new RuntimeException('The deposit changed while retrying; refresh and check again');
    }
    hostfiSendPayout(hostfiDeposit($id), hostfiOrderFor($dep)[1]);
    hostfiSyncOrder($dep['order_ref']);
    return 'sent';
}

/** Roll a HOSTFI order's status and amounts up from its deposits. */
function hostfiSyncOrder(?string $orderRef): void
{
    if (!$orderRef) {
        return;
    }
    $order = Database::selectOne('SELECT * FROM `transactions` WHERE `reference` = :r', ['r' => $orderRef]);
    if (!$order) {
        return;
    }
    $deps = Database::select('SELECT * FROM `hostfi_deposits` WHERE `order_ref` = :r ORDER BY `id`', ['r' => $orderRef]);
    if (!$deps) {
        return;
    }
    $statuses = array_column($deps, 'status');
    $any = static fn (array $want): bool => (bool) array_intersect($statuses, $want);
    $status = match (true) {
        $any(['PAID']) => 'COMPLETED',
        $any(['SWAPPING', 'SWAP_PENDING', 'SWAPPED', 'PAYING', 'PAYOUT_PENDING', 'PAYOUT_UNCERTAIN', 'PAYOUT_FAILED']) => 'PROCESSING',
        $any(['RECEIVED']) => 'CONFIRMED',
        !array_diff($statuses, ['RESOLVED']) => 'CANCELLED', // an admin closed every deposit by hand
        default => 'REVIEW',
    };
    $counted = array_filter($deps, fn ($d) => !in_array($d['status'], ['REVIEW', 'RESOLVED'], true));
    $crypto = array_sum(array_map(fn ($d) => (float) $d['amount'], $counted ?: $deps));
    $ngn = array_sum(array_map(fn ($d) => (float) $d['payout_amount'], $counted));
    $first = $deps[0];
    Database::execute(
        'UPDATE `transactions` SET `status` = :s, `amount` = :a, `source_amount` = :a2, `destination_amount` = COALESCE(:n, `destination_amount`),
            `hash` = COALESCE(`hash`, :h), `updated_at` = NOW() WHERE `id` = :id',
        ['s' => $status, 'a' => $crypto, 'a2' => $crypto, 'n' => $ngn > 0 ? $ngn : null, 'h' => $first['tx_hash'], 'id' => $order['id']]
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

/**
 * Poller safety net for missed webhooks. Read-only: re-reads payouts stuck for 30+ minutes
 * (and uncertain ones); it never swaps or sends money. Webhooks drive every money step.
 */
function hostfiReconcileOrder(string $orderRef): void
{
    ensureHostfiSchema();
    $deps = Database::select(
        "SELECT * FROM `hostfi_deposits` WHERE `order_ref` = :r AND `status` IN ('PAYOUT_PENDING','PAYOUT_UNCERTAIN')",
        ['r' => $orderRef]
    );
    foreach ($deps as $dep) {
        if ($dep['status'] === 'PAYOUT_PENDING' && strtotime((string) $dep['updated_at']) > time() - 1800) {
            continue;
        }
        hostfiCheckPayout($dep);
    }
    hostfiSyncOrder($orderRef);
}

const HOSTFI_CUSTOMER_RETRY_LIMIT = 3;

/**
 * What the customer sees for each deposit on an order: received → converted → paid, and whether
 * they may retry a failed payout. No bank details, no internal references.
 *
 * @return array<int,array<string,mixed>>
 */
/** The rate a HostFi order was quoted at, for display: HostFi's naira per $1 and our fee. */
function hostfiOrderRate(array $order): ?array
{
    $meta = is_array($order['meta'] ?? null) ? $order['meta'] : (json_decode((string) ($order['meta'] ?? ''), true) ?: []);
    $q = $meta['hostfi']['quote'] ?? null;
    return !empty($q['ngn_per_usd']) ? ['ngn_per_usd' => (float) $q['ngn_per_usd'], 'fee_percent' => (float) $q['fee_percent']] : null;
}

function hostfiProgress(string $orderRef): array
{
    ensureHostfiSchema();
    $deps = Database::safeSelect('SELECT * FROM `hostfi_deposits` WHERE `order_ref` = :r ORDER BY `id`', ['r' => $orderRef], []);
    return array_map(static function (array $d): array {
        $s = $d['status'];
        $converted = !empty($d['ngn_amount']) ? 'done' : (in_array($s, ['SWAPPING', 'SWAP_PENDING'], true) ? 'pending' : ($s === 'RECEIVED' ? 'waiting' : 'stopped'));
        $payout = match ($s) {
            'PAID' => 'done',
            'PAYING', 'PAYOUT_PENDING', 'PAYOUT_UNCERTAIN' => 'pending',
            'PAYOUT_FAILED' => 'failed',
            'REVIEW' => 'review',
            'RESOLVED' => 'resolved',
            default => 'waiting',
        };
        return [
            'amount' => (float) $d['amount'],
            'currency' => $d['currency'],
            'tx_hash' => $d['tx_hash'],
            'received_at' => $d['created_at'],
            'converted' => $converted,
            'payout' => $payout,
            'payout_amount' => $d['payout_amount'] !== null ? (float) $d['payout_amount'] : null,
            'can_retry' => $s === 'PAYOUT_FAILED' && hostfiCustomerRetriesLeft($d) > 0,
        ];
    }, $deps);
}

/** Customer retries left on a deposit: the first payout is attempt 1, then up to 3 retries. */
function hostfiCustomerRetriesLeft(array $dep): int
{
    return max(0, HOSTFI_CUSTOMER_RETRY_LIMIT + 1 - (int) $dep['payout_attempts']);
}

/** Metadata list [{name, value}] → map. */
function hostfiMeta(array $tx): array
{
    $out = [];
    foreach (($tx['metadata'] ?? []) as $m) {
        if (isset($m['name'])) {
            $out[(string) $m['name']] = (string) ($m['value'] ?? '');
        }
    }
    return $out;
}

// ─── Routes ───

function registerHostfiRoutes(Router $router): void
{
    $router->get('/api/hostfi/assets', function () {
        $out = [];
        foreach (hostfiEnabledAssets() as $symbol) {
            try {
                $asset = hostfiApi()->walletAsset($symbol);
                $networks = array_map(fn ($n) => ['code' => $n, 'chain' => hostfiChain($n)], HostfiApiClient::depositNetworks($asset));
                if (!$networks) {
                    continue;
                }
                $out[] = [
                    'symbol' => $symbol,
                    'name' => (string) ($asset['currency']['name'] ?? $symbol),
                    'networks' => $networks,
                    'timer_minutes' => sellTimerMinutes($symbol),
                    'payout_fee_ngn' => HOSTFI_PAYOUT_FEE_NGN,
                ] + hostfiQuote($symbol);
            } catch (Throwable $e) {
                error_log("[HostFi] {$symbol} unavailable: " . $e->getMessage()); // hide the coin rather than fail the list
            }
        }
        jsonResponse(successResponse($out));
    });

    // Customer "Retry payout" from History or the order screen. Safe to expose without login:
    // it can only re-send this deposit's own payout amount to the bank fixed on the order when it
    // was created, and only after HostFi confirms the last attempt failed (hostfiRetryPayout).
    $router->post('/api/hostfi/orders/([a-zA-Z0-9_]+)/retry', function (string $ref) {
        ensureHostfiSchema();
        if (!rateLimitCheck('hostfi_retry_ip_' . clientIp(), 10, 3600) || !rateLimitCheck('hostfi_retry_' . $ref, 1, 300)) {
            jsonResponse(errorResponse('Please wait a few minutes before retrying again.'), 429);
        }
        $order = Database::selectOne("SELECT `reference` FROM `transactions` WHERE `reference` = :r AND `channel` = 'HOSTFI'", ['r' => $ref]);
        if (!$order) {
            jsonResponse(errorResponse('Order not found'), 404);
        }
        $failed = Database::select("SELECT * FROM `hostfi_deposits` WHERE `order_ref` = :r AND `status` = 'PAYOUT_FAILED'", ['r' => $ref]);
        if (!$failed) {
            jsonResponse(errorResponse('There is no failed payout to retry on this order.'), 400);
        }
        $results = [];
        foreach ($failed as $dep) {
            if (hostfiCustomerRetriesLeft($dep) <= 0) {
                hostfiSetStatus((int) $dep['id'], 'REVIEW', 'Payout still failing after customer retries');
                $results[] = 'review';
                continue;
            }
            auditLog('HOSTFI_CUSTOMER_RETRY', ['order' => $ref, 'deposit' => (int) $dep['id'], 'attempt' => (int) $dep['payout_attempts'] + 1]);
            try {
                $results[] = hostfiRetryPayout((int) $dep['id']);
            } catch (Throwable $e) {
                $results[] = 'error';
            }
        }
        hostfiSyncOrder($ref);
        $message = in_array('sent', $results, true) ? 'Payout sent again. We\'ll update you here and by email.'
            : (in_array('already_paid', $results, true) ? 'Good news: your payout had already gone through.'
            : (in_array('review', $results, true) ? 'This payout needs our team. We\'ll contact you by email.'
            : 'We couldn\'t retry right now. Please try again in a few minutes.'));
        jsonResponse(successResponse(['progress' => hostfiProgress($ref), 'results' => $results], $message));
    });

    $router->post('/api/hostfi/resolve', function () {
        if (!hostfiApi()->isConfigured()) {
            jsonResponse(errorResponse('HostFi is not available'), 503);
        }
        if (!rateLimitCheck('hostfi_resolve_' . clientIp(), 30, 600)) {
            jsonResponse(errorResponse('Too many lookups. Please wait a few minutes.'), 429);
        }
        $b = getJsonBody();
        $accountNumber = preg_replace('/\D/', '', (string) body($b, 'accountNumber', '')) ?? '';
        if (strlen($accountNumber) < 10) {
            jsonResponse(errorResponse('Enter a valid account number'), 400);
        }
        try {
            $bank = hostfiApi()->matchBank((string) body($b, 'bankCode', ''), (string) body($b, 'bankName', ''));
            if (!$bank) {
                jsonResponse(errorResponse('This bank is not supported for this coin yet'), 400);
            }
            $acct = hostfiApi()->lookupAccount($bank['bankId'], $accountNumber);
            jsonResponse(successResponse(['accountName' => (string) ($acct['accountName'] ?? ''), 'bankName' => $bank['bankName']]));
        } catch (Throwable $e) {
            jsonResponse(errorResponse('Could not verify this account. Please check the details.'), 400);
        }
    });

    $router->post('/api/hostfi/sell', function () {
        if (!rateLimitCheck('order_initiate_' . clientIp(), 15, 600)) {
            jsonResponse(errorResponse('Too many order attempts. Please wait a few minutes before trying again.'), 429);
        }
        ensureHostfiSchema();
        $b = getJsonBody();
        $symbol = strtoupper((string) body($b, 'asset', ''));
        $network = (string) body($b, 'network', '');
        $amount = (float) body($b, 'amount', 0);
        $accountNumber = preg_replace('/\D/', '', (string) body($b, 'accountNumber', '')) ?? '';
        $email = strtolower(trim((string) body($b, 'email', '')));

        if (!in_array($symbol, hostfiEnabledAssets(), true)) {
            jsonResponse(errorResponse("{$symbol} sells are not available right now"), 400);
        }
        if ($amount <= 0 || strlen($accountNumber) < 10) {
            jsonResponse(errorResponse('amount and a valid accountNumber are required'), 400);
        }
        if ($email !== '' && !isValidEmail($email)) {
            jsonResponse(errorResponse('Invalid email address'), 400);
        }
        try {
            $asset = hostfiApi()->walletAsset($symbol);
            if (!in_array($network, HostfiApiClient::depositNetworks($asset), true)) {
                jsonResponse(errorResponse("{$symbol} can't be received on that network"), 400);
            }
            $quote = hostfiQuote($symbol);
            $usd = $amount * $quote['usd_per_unit'];
            $s = loadSettings();
            if ($usd < (float) ($s['sell_min_limit'] ?? 1) || $usd > (float) ($s['sell_max_limit'] ?? 10000)) {
                jsonResponse(errorResponse(sprintf('Sell amount must be between $%s and $%s', number_format((float) ($s['sell_min_limit'] ?? 1)), number_format((float) ($s['sell_max_limit'] ?? 10000)))), 400);
            }
            if ($amount * $quote['ngn_per_unit'] <= HOSTFI_PAYOUT_FEE_NGN) {
                jsonResponse(errorResponse('This amount is too small to sell'), 400);
            }
            $bank = hostfiApi()->matchBank((string) body($b, 'bankCode', ''), (string) body($b, 'bankName', ''));
            if (!$bank) {
                jsonResponse(errorResponse('This bank is not supported for this coin yet'), 400);
            }
            // HostFi's own lookup is the name the payout will be checked against.
            $acct = hostfiApi()->lookupAccount($bank['bankId'], $accountNumber);
            $accountName = trim((string) ($acct['accountName'] ?? ''));
            if ($accountName === '') {
                jsonResponse(errorResponse('Could not verify this bank account'), 400);
            }

            $reference = 'hf_' . bin2hex(random_bytes(10));
            $addr = hostfiApi()->createDepositAddress((string) $asset['id'], $reference, $network);
            if (empty($addr['address'])) {
                throw new RuntimeException('HostFi did not return an address');
            }
            $chain = hostfiChain($network);
            $minutes = sellTimerMinutes($symbol);
            $estimate = round($amount * $quote['ngn_per_unit'] - HOSTFI_PAYOUT_FEE_NGN, 2);
            Database::insert('transactions', [
                'reference' => $reference,
                'type' => 'OFFRAMP',
                'status' => 'AWAITING_DEPOSIT',
                'country' => 'NG',
                'currency' => 'NGN',
                'asset' => $chain . ':' . strtolower($symbol),
                'channel' => 'HOSTFI',
                'amount' => $amount,
                'rate' => $quote['ngn_per_unit'],
                'source_amount' => $amount,
                'source_currency' => $symbol,
                'destination_amount' => $estimate,
                'destination_currency' => 'NGN',
                'deposit_address' => (string) $addr['address'],
                'deposit_note' => !empty($addr['memo']) ? 'Memo: ' . $addr['memo'] : null,
                'beneficiary' => jsonEncodeNullable([
                    'holder_name' => $accountName,
                    'account_number' => $accountNumber,
                    'bank_code' => explode('::', $bank['bankId'])[1] ?? '',
                    'bank_name' => $bank['bankName'],
                ]),
                'email' => $email !== '' ? $email : null,
                'meta' => jsonEncodeNullable(['hostfi' => [
                    'symbol' => $symbol,
                    'network' => $network,
                    'address_id' => $addr['id'] ?? null,
                    'memo' => $addr['memo'] ?? null,
                    'expires_at' => time() + $minutes * 60,
                    'timer_minutes' => $minutes,
                    // Quote at order time, so History can show "$1 = ₦X" plus our fee.
                    'quote' => ['ngn_per_usd' => $quote['usd_per_unit'] > 0 ? $quote['ngn_per_unit_gross'] / $quote['usd_per_unit'] : null, 'fee_percent' => hostfiFee()],
                    'bank' => ['accountName' => $accountName, 'accountNumber' => $accountNumber, 'bankId' => $bank['bankId'], 'bankName' => $bank['bankName']],
                ]]),
            ] + referralFieldsFor(body($b, 'ref'), $email));

            if ($email !== '') {
                try {
                    sendOrderInitiatedEmailNow(Database::selectOne('SELECT * FROM `transactions` WHERE `reference` = :r', ['r' => $reference]) ?: []);
                } catch (Throwable $mailErr) {
                    error_log('[HostFi] Order email failed: ' . $mailErr->getMessage());
                }
            }

            jsonResponse(successResponse([
                'reference' => $reference,
                'address' => (string) $addr['address'],
                'memo' => $addr['memo'] ?? null,
                'network' => $network,
                'chain' => $chain,
                'expires_in' => $minutes * 60,
                'account_name' => $accountName,
                'bank_name' => $bank['bankName'],
                'estimate_ngn' => $estimate,
                'rate' => $quote['ngn_per_unit'],
            ]));
        } catch (Throwable $e) {
            error_log('[HostFi] sell failed: ' . $e->getMessage());
            jsonResponse(errorResponse('Could not create your deposit address. Please try again.'), 502);
        }
    });

    $router->post('/webhook/hostfi', function () {
        // HostFi echoes the secret we set on the subscription. Even with it, deposits and payouts
        // are re-fetched from HostFi below, so a leaked secret alone can't trigger a payout.
        $secret = HOSTFI_WEBHOOK_SECRET;
        $given = (string) ($_SERVER['HTTP_X_AUTH_SECRET'] ?? '');
        if ($secret !== '' && !hash_equals($secret, $given)) {
            auditLog('WEBHOOK_REJECTED', ['provider' => 'hostfi', 'reason' => $given === '' ? 'missing_secret' : 'bad_secret']);
            jsonResponse(['error' => 'Unauthorized'], 401);
        }
        $payload = json_decode(file_get_contents('php://input') ?: '', true) ?: [];
        $event = strtoupper((string) ($payload['event'] ?? ''));
        $data = is_array($payload['data'] ?? null) ? $payload['data'] : [];
        auditLog('HOSTFI_WEBHOOK', ['event' => $event, 'reference' => $data['reference'] ?? null]);
        if (!hostfiApi()->isConfigured()) {
            jsonResponse(['received' => true]);
        }
        ensureHostfiSchema();

        if ($event === 'CRYPTO_DEPOSIT') {
            // Unsigned webhook: only HostFi's own record of the deposit is trusted.
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
                && empty($live['wasReversed']);
            if (!$ok) {
                auditLog('HOSTFI_WEBHOOK_UNVERIFIED', ['reference' => $data['reference'] ?? null]);
                jsonResponse(['received' => true, 'verified' => false]);
            }
            $liveMeta = hostfiMeta($live);
            $hookMeta = hostfiMeta($data);
            $id = hostfiRecordDeposit([
                'ref' => (string) ($live['reference'] ?? $data['reference']),
                'address' => ($liveMeta['address'] ?? '') !== '' ? $liveMeta['address'] : ($hookMeta['address'] ?? null),
                'currency' => (string) ($live['amount']['currency'] ?? $data['amount']['currency'] ?? ''),
                'network' => $liveMeta['network'] ?? ($hookMeta['network'] ?? null),
                'amount' => (float) ($live['amount']['value'] ?? 0),
                'tx_hash' => $liveMeta['transactionId'] ?? ($hookMeta['transactionId'] ?? null),
            ]);
            hostfiProcessDeposit($id);
        } elseif (str_contains($event, 'SWAP') || isset($payload['transactions']) || isset($data['transactions'])) {
            // Asset Swap webhook: {transactions: [debit leg, credit leg]}. Re-fetched before use.
            hostfiSwapWebhook((array) ($payload['transactions'] ?? $data['transactions'] ?? []));
        } elseif (str_contains($event, 'WITHDRAWAL') || str_contains($event, 'PAYOUT')) {
            $clientRef = (string) ($data['clientReference'] ?? '');
            $dep = $clientRef !== '' ? Database::selectOne('SELECT * FROM `hostfi_deposits` WHERE `payout_client_ref` = :c', ['c' => $clientRef]) : null;
            if ($dep) {
                hostfiCheckPayout($dep); // re-fetched from HostFi, not taken from the payload
                hostfiSyncOrder($dep['order_ref']);
            }
        }
        jsonResponse(['received' => true]);
    });

    // ─── Admin ───

    $router->get('/api/admin/hostfi', function () {
        requireAdminAuth();
        $configured = hostfiApi()->isConfigured();
        $out = ['configured' => $configured, 'environment' => str_contains(HOSTFI_BASE_URL, '.dev.') ? 'sandbox' : 'live', 'balances' => [], 'deposits' => []];
        if ($configured) {
            try {
                ensureHostfiSchema();
                foreach (hostfiApi()->walletAssets() as $code => $a) {
                    $out['balances'][] = ['currency' => $code, 'balance' => (float) ($a['balance'] ?? 0)];
                }
            } catch (Throwable $e) {
                $out['error'] = publicError($e);
            }
            $out['deposits'] = Database::safeSelect(
                "SELECT d.*, t.email, t.status AS order_status FROM `hostfi_deposits` d LEFT JOIN `transactions` t ON t.reference = d.order_ref
                 ORDER BY CASE WHEN d.status IN ('REVIEW','PAYOUT_FAILED') THEN 0 ELSE 1 END, d.id DESC LIMIT 50",
                [],
                []
            );
        }
        jsonResponse($out);
    });

    $router->post('/api/admin/hostfi/deposits/(\d+)/retry', function (string $id) {
        requireAdminAuth();
        ensureHostfiSchema();
        $dep = hostfiDeposit((int) $id);
        if (!$dep || in_array($dep['status'], ['PAID', 'RESOLVED'], true)) {
            jsonResponse(['success' => false, 'error' => 'Nothing to retry for this deposit'], 400);
        }
        auditLog('HOSTFI_DEPOSIT_RETRY', ['id' => (int) $id, 'from' => $dep['status']]);
        $outcome = 'processed';
        try {
            if (in_array($dep['status'], ['PAYOUT_FAILED', 'PAYOUT_UNCERTAIN'], true) || ($dep['status'] === 'REVIEW' && !empty($dep['ngn_amount']))) {
                $outcome = hostfiRetryPayout((int) $id); // swap already done: only the payout is retried
            } elseif ($dep['status'] === 'SWAP_PENDING') {
                hostfiCheckSwap($dep);
            } elseif ($dep['status'] === 'PAYOUT_PENDING') {
                hostfiCheckPayout($dep);
                hostfiSyncOrder($dep['order_ref']);
            } else {
                hostfiProcessDeposit((int) $id, true); // "Approve & pay" a deposit held before its swap
            }
        } catch (Throwable $e) {
            jsonResponse(['success' => false, 'error' => $e->getMessage()], 400);
        }
        jsonResponse(['success' => true, 'outcome' => $outcome, 'deposit' => hostfiDeposit((int) $id)]);
    });

    $router->post('/api/admin/hostfi/deposits/(\d+)/resolve', function (string $id) {
        requireAdminAuth();
        ensureHostfiSchema();
        $note = substr(trim((string) body(getJsonBody(), 'note', 'Resolved manually')), 0, 300);
        $dep = hostfiDeposit((int) $id);
        if (!$dep || !in_array($dep['status'], ['REVIEW', 'PAYOUT_FAILED', 'PAYOUT_UNCERTAIN', 'SWAP_PENDING'], true)) {
            jsonResponse(['success' => false, 'error' => 'Only deposits that need attention can be resolved'], 400);
        }
        hostfiSetStatus((int) $id, 'RESOLVED', $note);
        hostfiSyncOrder($dep['order_ref']);
        auditLog('HOSTFI_DEPOSIT_RESOLVED', ['id' => (int) $id, 'note' => $note]);
        jsonResponse(['success' => true]);
    });
}
