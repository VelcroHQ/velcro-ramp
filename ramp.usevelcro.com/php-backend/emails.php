<?php

declare(strict_types=1);

/**
 * Branded email layout + transaction receipts.
 * Tables and inline styles: the only markup Gmail, Outlook and Apple Mail all render the same way.
 */

const EMAIL_SITE_URL = 'https://ramp.usevelcro.com';

/**
 * Renders the branded email. Every value is plain text (escaped here).
 *
 * @param array{
 *   title: string, preheader?: string, eyebrow?: string, intro?: string, code?: string,
 *   amount?: array{0: string, 1: string}, rows?: array<int, array{0: string, 1: string, 2?: bool}>,
 *   cta?: array{0: string, 1: string}, outro?: string
 * } $o
 * @return array{0: string, 1: string} [html, text]
 */
function renderEmail(array $o): array
{
    $e = static fn (string $s): string => htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
    $font = "font-family:Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
    $mono = "font-family:'SFMono-Regular',Menlo,Consolas,monospace;";

    $body = '';
    if (!empty($o['eyebrow'])) {
        $body .= '<p style="margin:0 0 10px;font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#6f8f1f;">' . $e($o['eyebrow']) . '</p>';
    }
    $body .= '<h1 style="margin:0;font-size:24px;line-height:1.3;font-weight:800;color:#0D0D59;">' . $e($o['title']) . '</h1>';
    if (!empty($o['intro'])) {
        $body .= '<p style="margin:12px 0 0;font-size:15px;line-height:1.6;color:#4b5563;">' . $e($o['intro']) . '</p>';
    }
    foreach ($o['paragraphs'] ?? [] as $p) {
        $body .= '<p style="margin:14px 0 0;font-size:15px;line-height:1.7;color:#374151;">' . nl2br($e($p)) . '</p>';
    }
    if (!empty($o['amount'])) {
        $body .= '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;"><tr><td align="center" style="padding:22px 16px;border-radius:16px;background:#f6f9ec;">'
            . '<p style="margin:0;font-size:13px;color:#6b7280;">' . $e($o['amount'][0]) . '</p>'
            . '<p style="margin:6px 0 0;font-size:30px;line-height:1.2;font-weight:800;letter-spacing:-0.02em;color:#0D0D59;">' . $e($o['amount'][1]) . '</p>'
            . '</td></tr></table>';
    }
    if (!empty($o['code'])) {
        $body .= '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;"><tr><td align="center" style="padding:20px 12px;border-radius:14px;background:#f6f9ec;border:1px dashed #c9dd8f;' . $mono . 'font-size:34px;font-weight:800;letter-spacing:10px;color:#0D0D59;">'
            . $e($o['code']) . '</td></tr></table>';
    }
    if (!empty($o['rows'])) {
        $body .= '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;border-top:1px solid #eef0f4;">';
        foreach ($o['rows'] as $r) {
            $valueFont = !empty($r[2]) ? $mono . 'font-size:13px;word-break:break-all;' : 'font-size:14px;';
            $body .= '<tr><td style="padding:12px 0;border-bottom:1px solid #eef0f4;font-size:14px;color:#6b7280;white-space:nowrap;">' . $e($r[0]) . '</td>'
                . '<td align="right" style="padding:12px 0 12px 16px;border-bottom:1px solid #eef0f4;' . $valueFont . 'font-weight:600;color:#0D0D59;">' . $e($r[1]) . '</td></tr>';
        }
        $body .= '</table>';
    }
    if (!empty($o['cta'])) {
        $body .= '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:28px;"><tr><td bgcolor="#A8CF45" style="border-radius:12px;">'
            . '<a href="' . $e($o['cta'][1]) . '" style="display:inline-block;padding:14px 26px;' . $font . 'font-size:15px;font-weight:700;color:#0D0D59;text-decoration:none;">' . $e($o['cta'][0]) . ' &rarr;</a>'
            . '</td></tr></table>';
    }
    if (!empty($o['outro'])) {
        $body .= '<p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#9ca3af;">' . $e($o['outro']) . '</p>';
    }

    $html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        . '<meta name="color-scheme" content="light only"><title>' . $e($o['title']) . '</title>'
        . '<style>@media (max-width:600px){.card-pad{padding:28px 22px !important}}</style></head>'
        . '<body style="margin:0;padding:0;background:#f3f4f7;">'
        . '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' . $e($o['preheader'] ?? $o['title']) . '</div>'
        . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f7;"><tr><td align="center" style="padding:32px 16px;">'
        . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">'
        . '<tr><td style="padding:0 4px 18px;"><img src="' . EMAIL_SITE_URL . '/velcro_logo.png" width="112" alt="Velcro" style="display:block;border:0;height:auto;"></td></tr>'
        . '<tr><td style="background:#ffffff;border:1px solid #e7e8ee;border-radius:20px;overflow:hidden;">'
        . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="height:6px;line-height:6px;font-size:0;background:#A8CF45;">&nbsp;</td></tr>'
        . '<tr><td class="card-pad" style="padding:36px;' . $font . '">' . $body . '</td></tr></table>'
        . '</td></tr>'
        . '<tr><td align="center" style="padding:26px 8px 0;">' . emailSocialRow() . '</td></tr>'
        . '<tr><td align="center" style="padding:14px 8px 0;' . $font . 'font-size:12px;line-height:1.6;color:#9ca3af;">'
        . 'Velcro Ramp &middot; Move money &amp; spend globally<br><a href="' . EMAIL_SITE_URL . '" style="color:#6b7280;text-decoration:underline;">ramp.usevelcro.com</a>'
        . (!empty($o['unsubscribe']) ? '<br>Don\'t want these emails? <a href="' . $e($o['unsubscribe']) . '" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a>' : '')
        . '</td></tr></table></td></tr></table></body></html>';

    $text = [$o['title']];
    if (!empty($o['intro'])) {
        $text[] = $o['intro'];
    }
    foreach ($o['paragraphs'] ?? [] as $p) {
        $text[] = $p;
    }
    if (!empty($o['amount'])) {
        $text[] = $o['amount'][0] . ': ' . $o['amount'][1];
    }
    if (!empty($o['code'])) {
        $text[] = 'Code: ' . $o['code'];
    }
    foreach ($o['rows'] ?? [] as $r) {
        $text[] = $r[0] . ': ' . $r[1];
    }
    if (!empty($o['cta'])) {
        $text[] = $o['cta'][0] . ': ' . $o['cta'][1];
    }
    if (!empty($o['outro'])) {
        $text[] = $o['outro'];
    }
    $text[] = "--\nVelcro Ramp · Move money & spend globally\n" . EMAIL_SITE_URL . (!empty($o['unsubscribe']) ? "\nUnsubscribe: " . $o['unsubscribe'] : '');

    return [$html, implode("\n\n", $text)];
}

/** Social icons (PNGs in /email-assets; email apps don't render SVG). */
function emailSocialRow(): string
{
    $links = [
        'facebook' => 'https://www.facebook.com/share/189TAeNGS4/',
        'x' => 'https://x.com/usevelcro',
        'instagram' => 'https://www.instagram.com/usevelcro',
        'linkedin' => 'https://www.linkedin.com/company/velcrohq/',
    ];
    $cells = '';
    foreach ($links as $name => $url) {
        $cells .= '<td style="padding:0 6px;"><a href="' . $url . '" target="_blank"><img src="' . EMAIL_SITE_URL . '/email-assets/' . $name . '.png" width="32" height="32" alt="' . ucfirst($name) . '" style="display:block;border:0;"></a></td>';
    }
    return '<table role="presentation" cellpadding="0" cellspacing="0"><tr>' . $cells . '</tr></table>';
}

// ─── Transaction receipts ───

/** @return array{0: string, 1: string} [label, explorer tx url or ''] */
function receiptChain(array $t): array
{
    $asset = (string) $t['asset'];
    $chain = str_contains($asset, ':') ? strtolower(explode(':', $asset)[0]) : 'solana'; // PAJ assets are bare symbols on Solana
    $labels = ['solana' => 'Solana', 'tron' => 'TRON', 'ethereum' => 'Ethereum', 'bsc' => 'BNB Chain', 'base' => 'Base', 'polygon' => 'Polygon', 'arbitrum' => 'Arbitrum', 'optimism' => 'Optimism', 'avalanche' => 'Avalanche'];
    $explorers = ['solana' => 'https://solscan.io/tx/', 'ethereum' => 'https://etherscan.io/tx/', 'bsc' => 'https://bscscan.com/tx/', 'polygon' => 'https://polygonscan.com/tx/', 'arbitrum' => 'https://arbiscan.io/tx/', 'base' => 'https://basescan.org/tx/', 'tron' => 'https://tronscan.org/#/transaction/', 'optimism' => 'https://optimistic.etherscan.io/tx/', 'avalanche' => 'https://snowtrace.io/tx/'];
    $hash = (string) ($t['hash'] ?? '');
    $url = (string) ($t['explorer_url'] ?? '') ?: ($hash !== '' && isset($explorers[$chain]) ? $explorers[$chain] . $hash : '');
    return [$labels[$chain] ?? ucfirst($chain), $url];
}

/** @return array{0: string, 1: string, 2: string} [subject, html, text] */
function receiptEmail(array $t): array
{
    $asset = (string) $t['asset'];
    $symbol = strtoupper(str_contains($asset, ':') ? explode(':', $asset)[1] : $asset);
    $ngn = static fn ($v): string => '₦' . number_format((float) $v, 2);
    $crypto = static fn ($v): string => rtrim(rtrim(number_format((float) $v, 6, '.', ','), '0'), '.') . ' ' . $symbol;
    $short = static fn (string $s): string => strlen($s) > 18 ? substr($s, 0, 8) . '…' . substr($s, -6) : $s;
    $isPaj = strtoupper((string) ($t['channel'] ?? '')) === 'PAJ';
    [$chainLabel, $explorer] = receiptChain($t);
    $date = date('j M Y, g:i A', strtotime((string) ($t['updated_at'] ?? $t['created_at'] ?? 'now')) ?: time());
    $ref = (string) $t['reference'];

    if (strtoupper((string) $t['type']) === 'ONRAMP') {
        $received = (float) ($t['destination_amount'] ?? 0) > 0 ? $crypto($t['destination_amount']) : $symbol;
        $rows = [['You paid', $ngn($t['amount'])], ['Network', $chainLabel]];
        if (!empty($t['wallet_address'])) {
            $rows[] = ['Wallet', $short((string) $t['wallet_address']), true];
        }
        if (!empty($t['hash'])) {
            $rows[] = ['Transaction', $short((string) $t['hash']), true];
        }
        $rows[] = ['Reference', $short($ref), true];
        $rows[] = ['Date', $date];
        $subject = "Receipt: {$received} delivered";
        [$html, $text] = renderEmail([
            'preheader' => "Your {$received} has arrived in your wallet.",
            'eyebrow' => 'Receipt',
            'title' => 'Your crypto has arrived',
            'intro' => "We've sent {$received} to your wallet. Thanks for using Velcro.",
            'amount' => ['You received', $received],
            'rows' => $rows,
            'cta' => $explorer !== '' ? ['View on explorer', $explorer] : ['Open Velcro', EMAIL_SITE_URL],
            'outro' => 'Keep this email as your receipt. Questions? Tap the help button on ramp.usevelcro.com.',
        ]);
        return [$subject, $html, $text];
    }

    // Sell: PAJ stores the naira amount in `amount`; Switch stores crypto in `amount` and the naira payout in destination_amount.
    $paid = $isPaj ? $t['amount'] : ($t['destination_amount'] ?? null);
    $received = $paid !== null && (float) $paid > 0 ? $ngn($paid) : 'Naira';
    $ben = is_array($t['beneficiary'] ?? null) ? $t['beneficiary'] : (json_decode((string) ($t['beneficiary'] ?? ''), true) ?: []);
    $banks = ['100004' => 'OPay', '000014' => 'Access Bank', '000013' => 'GTBank', '000015' => 'Zenith Bank', '000016' => 'First Bank', '000004' => 'UBA', '000007' => 'Fidelity Bank', '000017' => 'Wema Bank', '090286' => 'Safehaven MFB', '100033' => 'PalmPay', '100026' => 'Kuda Bank'];
    $bank = (string) ($ben['bank_name'] ?? $ben['bankName'] ?? $ben['institution'] ?? ($banks[$ben['bank_code'] ?? ''] ?? ''));
    $account = (string) ($ben['account_number'] ?? $ben['accountNumber'] ?? '');
    $rows = [];
    if (!$isPaj && (float) $t['amount'] > 0) {
        $rows[] = ['You sold', $crypto($t['amount'])];
    }
    if ($bank !== '') {
        $rows[] = ['Bank', $bank];
    }
    if ($account !== '') {
        $holder = (string) ($ben['holder_name'] ?? '');
        $rows[] = ['Account', '•••• ' . substr($account, -4) . ($holder !== '' && $holder !== 'Customer' ? ' · ' . $holder : '')];
    }
    $rows[] = ['Reference', $short($ref), true];
    $rows[] = ['Date', $date];
    $subject = "Receipt: {$received} sent to your bank";
    [$html, $text] = renderEmail([
        'preheader' => "Your {$received} payout is complete.",
        'eyebrow' => 'Receipt',
        'title' => 'Your payout is complete',
        'intro' => "We've sent {$received} to your bank account" . ($bank !== '' ? " at {$bank}" : '') . '. It usually lands within minutes.',
        'amount' => ['You received', $received],
        'rows' => $rows,
        'cta' => ['Open Velcro', EMAIL_SITE_URL],
        'outro' => "Keep this email as your receipt. If the money hasn't arrived within an hour, contact us from the help button on ramp.usevelcro.com with your reference.",
    ]);
    return [$subject, $html, $text];
}

/** Adds receipt tracking. Orders already completed at migration time are marked sent so nobody gets old receipts. */
function ensureReceiptSchema(): void
{
    static $done = false;
    $flag = BASE_PATH . '/data/.receipt_schema_v1';
    if ($done || file_exists($flag)) {
        $done = true;
        return;
    }
    try {
        Database::pdo()->exec('ALTER TABLE `transactions` ADD COLUMN `receipt_sent_at` DATETIME DEFAULT NULL');
        Database::pdo()->exec("UPDATE `transactions` SET `receipt_sent_at` = NOW(), `updated_at` = `updated_at` WHERE `status` = 'COMPLETED'");
    } catch (PDOException $e) {
        if ((int) ($e->errorInfo[1] ?? 0) !== 1060) { // 1060: column already exists
            throw $e;
        }
    }
    @file_put_contents($flag, gmdate('c'));
    $done = true;
}

/**
 * Emails a receipt for each newly completed order that has an email.
 * Each row is claimed with a conditional UPDATE first, so concurrent requests never double-send.
 * ponytail: a failed send is not retried (avoids looping on bounced addresses); add a retry counter if that matters.
 */
function sendPendingReceipts(int $limit = 5): int
{
    if (!mailConfigured()) {
        return 0;
    }
    ensureReceiptSchema();
    $rows = Database::select(
        "SELECT * FROM `transactions` WHERE `status` = 'COMPLETED' AND `receipt_sent_at` IS NULL AND `email` IS NOT NULL AND `email` <> '' ORDER BY `id` LIMIT " . max(1, $limit)
    );
    $sent = 0;
    foreach ($rows as $t) {
        $claimed = Database::execute(
            'UPDATE `transactions` SET `receipt_sent_at` = NOW(), `updated_at` = `updated_at` WHERE `id` = :id AND `receipt_sent_at` IS NULL',
            ['id' => $t['id']]
        );
        if ($claimed !== 1) {
            continue;
        }
        [$subject, $html, $text] = receiptEmail($t);
        if (sendEmailTo((string) $t['email'], $subject, $html, $text)) {
            $sent++;
        } else {
            error_log("Receipt email failed for tx {$t['reference']}");
        }
    }
    return $sent;
}

// ─── Signing key (referral tokens, unsubscribe links) ───

function appKey(): string
{
    static $key = null;
    if ($key !== null) {
        return $key;
    }
    $file = BASE_PATH . '/data/.app_key';
    if (!is_file($file)) {
        $fp = @fopen($file, 'x'); // 'x' fails if another request created it first
        if ($fp) {
            fwrite($fp, bin2hex(random_bytes(32)));
            fclose($fp);
        }
    }
    $key = trim((string) @file_get_contents($file));
    if (strlen($key) < 32) {
        throw new RuntimeException('Signing key unavailable');
    }
    return $key;
}

function unsubscribeToken(string $email): string
{
    return substr(hash_hmac('sha256', 'unsub|' . strtolower(trim($email)), appKey()), 0, 32);
}

function unsubscribeUrl(string $email): string
{
    $email = strtolower(trim($email));
    return EMAIL_SITE_URL . '/api/unsubscribe?e=' . rawurlencode($email) . '&t=' . unsubscribeToken($email);
}

// ─── Marketing campaigns ───

function ensureCampaignSchema(): void
{
    static $done = false;
    $flag = BASE_PATH . '/data/.campaign_schema_v1';
    if ($done || file_exists($flag)) {
        $done = true;
        return;
    }
    $pdo = Database::pdo();
    $pdo->exec("CREATE TABLE IF NOT EXISTS `email_campaigns` (
        `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `subject` VARCHAR(150) NOT NULL,
        `preheader` VARCHAR(200) DEFAULT NULL,
        `title` VARCHAR(150) NOT NULL,
        `body` TEXT NOT NULL,
        `cta_label` VARCHAR(60) DEFAULT NULL,
        `cta_url` VARCHAR(500) DEFAULT NULL,
        `status` VARCHAR(20) NOT NULL DEFAULT 'SENDING',
        `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
        `finished_at` DATETIME DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $pdo->exec("CREATE TABLE IF NOT EXISTS `email_campaign_recipients` (
        `id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `campaign_id` INT UNSIGNED NOT NULL,
        `email` VARCHAR(255) NOT NULL,
        `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        `sent_at` DATETIME DEFAULT NULL,
        UNIQUE KEY `uniq_campaign_email` (`campaign_id`, `email`),
        KEY `idx_status` (`status`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $pdo->exec("CREATE TABLE IF NOT EXISTS `email_unsubscribes` (
        `email` VARCHAR(255) NOT NULL PRIMARY KEY,
        `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    @file_put_contents($flag, gmdate('c'));
    $done = true;
}

/**
 * Everyone who gave us an email (orders + referrers), minus unsubscribes.
 * ponytail: loads the whole list into memory; page it if the audience reaches hundreds of thousands.
 *
 * @return array<int,string>
 */
function campaignAudience(): array
{
    ensureCampaignSchema();
    $emails = [];
    foreach (Database::select("SELECT DISTINCT LOWER(TRIM(`email`)) AS e FROM `transactions` WHERE `email` IS NOT NULL AND `email` <> ''") as $r) {
        $emails[$r['e']] = true;
    }
    try {
        foreach (Database::select('SELECT `email` AS e FROM `referrers`') as $r) {
            $emails[strtolower($r['e'])] = true;
        }
    } catch (Throwable $e) {
        // referral tables not created yet
    }
    foreach (Database::select('SELECT `email` AS e FROM `email_unsubscribes`') as $r) {
        unset($emails[strtolower($r['e'])]);
    }
    return array_values(array_filter(array_keys($emails), 'isValidEmail'));
}

/**
 * @param array<string,mixed> $c campaign fields (subject, preheader, title, body, cta_label, cta_url)
 * @return array{0: string, 1: string} [html, text]
 */
function renderCampaign(array $c, string $email): array
{
    $paragraphs = array_values(array_filter(array_map('trim', preg_split('/\R\s*\R/', trim((string) $c['body'])) ?: [])));
    return renderEmail([
        'preheader' => (string) ($c['preheader'] ?? '') ?: (string) $c['title'],
        'title' => (string) $c['title'],
        'paragraphs' => $paragraphs,
        'cta' => !empty($c['cta_label']) && !empty($c['cta_url']) ? [(string) $c['cta_label'], (string) $c['cta_url']] : null,
        'unsubscribe' => unsubscribeUrl($email),
    ]);
}

/**
 * Sends the next batch of pending campaign emails. Each recipient is claimed with a conditional
 * UPDATE first, so overlapping runs (request hook, cron, admin page) never send twice.
 */
function sendCampaignBatch(int $limit = 20): int
{
    if (!mailConfigured()) {
        return 0;
    }
    ensureCampaignSchema();
    $rows = Database::select(
        "SELECT r.`id` AS rid, r.`email`, c.`subject`, c.`preheader`, c.`title`, c.`body`, c.`cta_label`, c.`cta_url`
         FROM `email_campaign_recipients` r JOIN `email_campaigns` c ON c.`id` = r.`campaign_id`
         WHERE r.`status` = 'PENDING' AND c.`status` = 'SENDING' ORDER BY r.`id` LIMIT " . max(1, $limit)
    );
    $sent = 0;
    foreach ($rows as $r) {
        if (Database::execute("UPDATE `email_campaign_recipients` SET `status` = 'SENT', `sent_at` = NOW() WHERE `id` = :id AND `status` = 'PENDING'", ['id' => $r['rid']]) !== 1) {
            continue;
        }
        if (Database::selectOne('SELECT 1 AS x FROM `email_unsubscribes` WHERE `email` = :e', ['e' => $r['email']])) {
            Database::execute("UPDATE `email_campaign_recipients` SET `status` = 'SKIPPED' WHERE `id` = :id", ['id' => $r['rid']]);
            continue; // unsubscribed after the campaign started
        }
        [$html, $text] = renderCampaign($r, $r['email']);
        if (sendEmailTo($r['email'], (string) $r['subject'], $html, $text)) {
            $sent++;
        } else {
            Database::execute("UPDATE `email_campaign_recipients` SET `status` = 'FAILED' WHERE `id` = :id", ['id' => $r['rid']]);
        }
    }
    Database::execute(
        "UPDATE `email_campaigns` SET `status` = 'SENT', `finished_at` = NOW()
         WHERE `status` = 'SENDING' AND NOT EXISTS (SELECT 1 FROM `email_campaign_recipients` r WHERE r.`campaign_id` = `email_campaigns`.`id` AND r.`status` = 'PENDING')"
    );
    return $sent;
}
