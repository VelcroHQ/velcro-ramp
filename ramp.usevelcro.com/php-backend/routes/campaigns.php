<?php

declare(strict_types=1);

/**
 * Marketing campaigns (admin) and the public unsubscribe page.
 * The sending engine lives in emails.php so the cron job can use it too.
 */

/** Validated campaign fields from the request body. Ends the request on bad input. */
function campaignFieldsFrom(array $body): array
{
    $f = [
        'subject' => trim((string) body($body, 'subject', '')),
        'preheader' => trim((string) body($body, 'preheader', '')),
        'title' => trim((string) body($body, 'title', '')),
        'body' => trim((string) body($body, 'body', '')),
        'cta_label' => trim((string) body($body, 'cta_label', '')),
        'cta_url' => trim((string) body($body, 'cta_url', '')),
    ];
    $error = null;
    if ($f['subject'] === '' || mb_strlen($f['subject']) > 150) {
        $error = 'Subject is required (max 150 characters)';
    } elseif ($f['title'] === '' || mb_strlen($f['title']) > 150) {
        $error = 'Headline is required (max 150 characters)';
    } elseif ($f['body'] === '' || mb_strlen($f['body']) > 5000) {
        $error = 'Message is required (max 5,000 characters)';
    } elseif (mb_strlen($f['preheader']) > 200) {
        $error = 'Preview text is too long (max 200 characters)';
    } elseif (($f['cta_label'] === '') !== ($f['cta_url'] === '')) {
        $error = 'Button needs both a label and a link';
    } elseif ($f['cta_url'] !== '' && !preg_match('#^https?://[^\s<>"]+$#i', $f['cta_url'])) {
        $error = 'Button link must start with https://';
    } elseif (mb_strlen($f['cta_label']) > 60) {
        $error = 'Button label is too long (max 60 characters)';
    }
    if ($error !== null) {
        jsonResponse(['success' => false, 'error' => $error], 400);
    }
    return $f;
}

/** Campaign list with progress counts. */
function campaignOverview(): array
{
    ensureCampaignSchema();
    $campaigns = Database::select(
        "SELECT c.`id`, c.`subject`, c.`status`, c.`created_at`, c.`finished_at`,
                COUNT(r.`id`) AS total,
                SUM(r.`status` = 'SENT') AS sent,
                SUM(r.`status` = 'FAILED') AS failed,
                SUM(r.`status` = 'PENDING') AS pending
         FROM `email_campaigns` c LEFT JOIN `email_campaign_recipients` r ON r.`campaign_id` = c.`id`
         GROUP BY c.`id` ORDER BY c.`id` DESC LIMIT 50"
    );
    $unsubscribed = (int) (Database::selectOne('SELECT COUNT(*) AS n FROM `email_unsubscribes`')['n'] ?? 0);
    return ['audience' => count(campaignAudience()), 'unsubscribed' => $unsubscribed, 'campaigns' => $campaigns];
}

function unsubscribePage(string $title, string $message, string $form = ''): never
{
    http_response_code(200);
    header('Content-Type: text/html; charset=utf-8');
    $t = htmlspecialchars($title, ENT_QUOTES, 'UTF-8');
    $m = htmlspecialchars($message, ENT_QUOTES, 'UTF-8');
    echo "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"robots\" content=\"noindex\"><title>{$t} · Velcro</title></head>"
        . "<body style=\"margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f7;font-family:Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;padding:24px;box-sizing:border-box;\">"
        . "<div style=\"max-width:420px;width:100%;background:#fff;border:1px solid #e7e8ee;border-radius:20px;overflow:hidden;\">"
        . "<div style=\"height:6px;background:#A8CF45;\"></div><div style=\"padding:32px;\">"
        . "<img src=\"/velcro_logo.png\" width=\"104\" alt=\"Velcro\" style=\"display:block;margin-bottom:22px;\">"
        . "<h1 style=\"margin:0;font-size:22px;color:#0D0D59;\">{$t}</h1><p style=\"margin:10px 0 0;font-size:15px;line-height:1.6;color:#4b5563;\">{$m}</p>{$form}"
        . "<p style=\"margin:24px 0 0;font-size:13px;color:#9ca3af;\">Receipts and security codes for your orders will still be sent.</p>"
        . "</div></div></body></html>";
    exit;
}

function registerCampaignRoutes(Router $router): void
{
    // Public: confirm page on GET (mail scanners prefetch links), unsubscribe on POST.
    $unsubscribe = function () {
        $email = strtolower(trim((string) ($_GET['e'] ?? '')));
        $token = (string) ($_GET['t'] ?? '');
        if (!isValidEmail($email) || !hash_equals(unsubscribeToken($email), $token)) {
            unsubscribePage('Link not valid', 'This unsubscribe link is incomplete or has been changed. Use the link from your latest Velcro email.');
        }
        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            ensureCampaignSchema();
            try {
                Database::insert('email_unsubscribes', ['email' => $email]);
            } catch (PDOException $e) {
                // already unsubscribed
            }
            auditLog('EMAIL_UNSUBSCRIBED', ['email' => $email]);
            unsubscribePage("You're unsubscribed", "{$email} won't receive marketing emails from Velcro anymore.");
        }
        $action = htmlspecialchars('/api/unsubscribe?e=' . rawurlencode($email) . '&t=' . $token, ENT_QUOTES, 'UTF-8');
        unsubscribePage(
            'Unsubscribe from Velcro emails?',
            "{$email} will stop receiving news and offers from Velcro.",
            "<form method=\"post\" action=\"{$action}\" style=\"margin:24px 0 0;\"><button type=\"submit\" style=\"width:100%;height:48px;border:0;border-radius:12px;background:#A8CF45;color:#0D0D59;font-size:15px;font-weight:700;cursor:pointer;\">Unsubscribe</button></form>"
        );
    };
    $router->get('/api/unsubscribe', $unsubscribe);
    $router->post('/api/unsubscribe', $unsubscribe);

    // ─── Admin ───

    $router->get('/api/admin/campaigns', function () {
        requireAdminAuth();
        jsonResponse(campaignOverview());
    });

    $router->post('/api/admin/campaigns/preview', function () {
        requireAdminAuth();
        [$html] = renderCampaign(campaignFieldsFrom(getJsonBody()), 'preview@example.com');
        jsonResponse(['success' => true, 'html' => $html]);
    });

    $router->post('/api/admin/campaigns/test', function () {
        requireAdminAuth();
        $body = getJsonBody();
        $fields = campaignFieldsFrom($body);
        $to = strtolower(trim((string) body($body, 'to', '')));
        if (!isValidEmail($to)) {
            jsonResponse(['success' => false, 'error' => 'Enter a valid test email address'], 400);
        }
        if (!mailConfigured()) {
            jsonResponse(['success' => false, 'error' => 'Email is not configured on the server'], 503);
        }
        [$html, $text] = renderCampaign($fields, $to);
        $ok = sendEmailTo($to, '[Test] ' . $fields['subject'], $html, $text);
        jsonResponse($ok ? ['success' => true] : ['success' => false, 'error' => 'Sending failed. Check the server logs.'], $ok ? 200 : 502);
    });

    // Snapshot the audience now, then send in batches (request hook, cron, and the admin page's ticks).
    $router->post('/api/admin/campaigns', function () {
        requireAdminAuth();
        $fields = campaignFieldsFrom(getJsonBody());
        if (!mailConfigured()) {
            jsonResponse(['success' => false, 'error' => 'Email is not configured on the server'], 503);
        }
        $audience = campaignAudience();
        if (!$audience) {
            jsonResponse(['success' => false, 'error' => 'No one to send to yet'], 400);
        }
        $id = (int) Database::insert('email_campaigns', $fields);
        // ponytail: one INSERT per recipient; batch the inserts if the audience gets very large.
        foreach ($audience as $email) {
            Database::insert('email_campaign_recipients', ['campaign_id' => $id, 'email' => $email]);
        }
        auditLog('CAMPAIGN_STARTED', ['id' => $id, 'subject' => $fields['subject'], 'recipients' => count($audience)]);
        jsonResponse(['success' => true, 'id' => $id, 'recipients' => count($audience)]);
    });

    $router->post('/api/admin/campaigns/tick', function () {
        requireAdminAuth();
        $sent = sendCampaignBatch(15);
        jsonResponse(['success' => true, 'sent' => $sent] + campaignOverview());
    });

    $router->post('/api/admin/campaigns/(\d+)/cancel', function (string $id) {
        requireAdminAuth();
        ensureCampaignSchema();
        Database::execute("UPDATE `email_campaigns` SET `status` = 'CANCELLED', `finished_at` = NOW() WHERE `id` = :id AND `status` = 'SENDING'", ['id' => (int) $id]);
        Database::execute("UPDATE `email_campaign_recipients` SET `status` = 'CANCELLED' WHERE `campaign_id` = :id AND `status` = 'PENDING'", ['id' => (int) $id]);
        auditLog('CAMPAIGN_CANCELLED', ['id' => (int) $id]);
        jsonResponse(['success' => true]);
    });
}
