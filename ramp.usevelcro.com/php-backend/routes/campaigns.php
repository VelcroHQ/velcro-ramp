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
        'image_url' => trim((string) body($body, 'image_url', '')),
        'body' => trim((string) body($body, 'body', '')),
        'cta_label' => trim((string) body($body, 'cta_label', '')),
        'cta_url' => trim((string) body($body, 'cta_url', '')),
    ];
    $error = null;
    if ($f['subject'] === '' || mb_strlen($f['subject']) > 150) {
        $error = 'Subject is required (max 150 characters)';
    } elseif ($f['title'] === '' || mb_strlen($f['title']) > 150) {
        $error = 'Headline is required (max 150 characters)';
    } elseif ($f['body'] === '' || mb_strlen($f['body']) > 15000) {
        $error = 'Message is required (max 15,000 characters)';
    } elseif (mb_strlen($f['preheader']) > 200) {
        $error = 'Preview text is too long (max 200 characters)';
    } elseif ($f['image_url'] !== '' && !preg_match('#^https?://[^\s<>"]+$#i', $f['image_url'])) {
        $error = 'Image link must start with http:// or https://';
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
    $allAudience = count(campaignAudience('all'));
    $txAudience = count(campaignAudience('transactions'));
    $uploadedAudience = count(campaignAudience('uploaded'));
    return [
        'audience' => $allAudience,
        'audience_transactions' => $txAudience,
        'audience_uploaded' => $uploadedAudience,
        'unsubscribed' => $unsubscribed,
        'campaigns' => $campaigns
    ];
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

    // Why isn't email sending? Reports how .env was read, without revealing secrets.
    $router->get('/api/admin/mail-status', function () {
        requireAdminAuth();
        $envFile = BASE_PATH . '/.env';
        $lines = is_readable($envFile) ? (file($envFile, FILE_IGNORE_NEW_LINES) ?: []) : [];
        $keyLines = [];
        foreach ($lines as $i => $line) {
            if (stripos($line, 'MAILHIVE') === false) {
                continue;
            }
            // Keep the line's shape (prefix, separator, quotes, odd characters) but hide the value.
            $shape = preg_replace_callback('/(=\s*["\']?)([^"\'\s]+)/', static fn ($m) => $m[1] . '[' . strlen($m[2]) . ' chars hidden]', $line, 1);
            $keyLines[] = [
                'line' => $i + 1,
                'shape' => preg_replace('/[^\x20-\x7E]/', '?', (string) $shape), // non-ASCII (BOM, smart quotes) shows as ?
                'has_invisible_chars' => (bool) preg_match('/[^\x20-\x7E\t]/', $line),
            ];
        }
        jsonResponse([
            'env_file' => $envFile,
            'env_exists' => is_file($envFile),
            'env_readable' => is_readable($envFile),
            'env_modified' => is_file($envFile) ? gmdate('Y-m-d H:i:s', (int) filemtime($envFile)) . ' UTC' : null,
            'mailhive_key_loaded' => MAILHIVE_API_KEY !== '',
            'mailhive_key_hint' => MAILHIVE_API_KEY !== '' ? substr(MAILHIVE_API_KEY, 0, 6) . '… (' . strlen(MAILHIVE_API_KEY) . ' chars)' : null,
            'mailhive_lines_in_env' => $keyLines,
            'set_by_server_environment' => getenv('MAILHIVE_API_KEY') !== false && !in_array('MAILHIVE_API_KEY', array_map(static fn ($l) => trim(explode('=', $l, 2)[0]), $lines), true),
            'smtp_configured' => SMTP_HOST !== '' && SMTP_USER !== '' && SMTP_PASS !== '',
            'php_mail_available' => function_exists('mail'),
            'mail_from' => MAIL_FROM,
            'admin_email' => ADMIN_EMAIL,
        ]);
    });

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
        $body = getJsonBody();
        $fields = campaignFieldsFrom($body);
        if (!mailConfigured()) {
            jsonResponse(['success' => false, 'error' => 'Email is not configured on the server'], 503);
        }
        $audienceSource = trim((string) ($body['audience_source'] ?? 'all'));
        $customEmails = $body['custom_emails'] ?? null;
        if (is_array($customEmails) && !empty($customEmails)) {
            $audience = array_values(array_filter(array_unique(array_map('strtolower', array_map('trim', $customEmails))), 'isValidEmail'));
        } else {
            $audience = campaignAudience($audienceSource);
        }
        if (!$audience) {
            jsonResponse(['success' => false, 'error' => 'No recipients found for this audience selection'], 400);
        }
        $id = (int) Database::insert('email_campaigns', $fields);
        foreach ($audience as $email) {
            Database::safeExecute('INSERT IGNORE INTO `email_campaign_recipients` (`campaign_id`, `email`) VALUES (:cid, :em)', [
                'cid' => $id,
                'em' => $email,
            ]);
        }
        auditLog('CAMPAIGN_STARTED', ['id' => $id, 'subject' => $fields['subject'], 'recipients' => count($audience), 'source' => $audienceSource]);
        jsonResponse(['success' => true, 'id' => $id, 'recipients' => count($audience)]);
    });

    $router->post('/api/admin/campaigns/upload-image', function () {
        requireAdminAuth();
        $uploadDir = realpath(__DIR__ . '/../../email-assets') . DIRECTORY_SEPARATOR . 'uploads';
        if (!is_dir($uploadDir)) {
            @mkdir($uploadDir, 0755, true);
        }

        $file = $_FILES['image'] ?? ($_FILES['file'] ?? null);
        if (!$file || empty($file['tmp_name'])) {
            jsonResponse(['success' => false, 'error' => 'No image file uploaded'], 400);
        }

        if (($file['error'] ?? UPLOAD_ERR_OK) !== UPLOAD_ERR_OK) {
            jsonResponse(['success' => false, 'error' => 'Upload failed with error code ' . ($file['error'] ?? 0)], 400);
        }

        if (($file['size'] ?? 0) > 5 * 1024 * 1024) {
            jsonResponse(['success' => false, 'error' => 'Image exceeds 5MB size limit'], 400);
        }

        $finfo = finfo_open(FILEINFO_MIME_TYPE);
        $mime = $finfo ? finfo_file($finfo, $file['tmp_name']) : '';
        if ($finfo) {
            finfo_close($finfo);
        }

        $allowed = [
            'image/jpeg' => 'jpg',
            'image/png' => 'png',
            'image/gif' => 'gif',
            'image/webp' => 'webp',
        ];

        if (!isset($allowed[$mime])) {
            jsonResponse(['success' => false, 'error' => 'Invalid image format. Allowed: PNG, JPG, WEBP, GIF'], 400);
        }

        $ext = $allowed[$mime];
        $filename = 'img_' . bin2hex(random_bytes(10)) . '.' . $ext;
        $destPath = $uploadDir . DIRECTORY_SEPARATOR . $filename;

        if (!move_uploaded_file($file['tmp_name'], $destPath)) {
            jsonResponse(['success' => false, 'error' => 'Failed to save uploaded image on server'], 500);
        }

        $publicUrl = EMAIL_SITE_URL . '/email-assets/uploads/' . $filename;
        jsonResponse([
            'success' => true,
            'url' => $publicUrl,
            'filename' => $filename,
        ]);
    });

    $router->post('/api/admin/campaigns/import-emails', function () {
        requireAdminAuth();
        ensureCampaignSchema();

        $rawContent = '';
        if (!empty($_FILES['file']['tmp_name'])) {
            $rawContent = (string) file_get_contents($_FILES['file']['tmp_name']);
        } else {
            $body = getJsonBody();
            $rawContent = (string) ($body['emails'] ?? ($body['content'] ?? ''));
        }

        if (trim($rawContent) === '') {
            jsonResponse(['success' => false, 'error' => 'No emails provided. Paste text or upload a CSV/TXT file.'], 400);
        }

        preg_match_all('/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/', $rawContent, $matches);
        $rawEmails = $matches[0] ?? [];
        $uniqueEmails = array_values(array_unique(array_filter(array_map('strtolower', array_map('trim', $rawEmails)), 'isValidEmail')));

        if (empty($uniqueEmails)) {
            jsonResponse(['success' => false, 'error' => 'No valid email addresses found in the uploaded text/file.'], 400);
        }

        $added = 0;
        $existing = 0;
        foreach ($uniqueEmails as $em) {
            $res = Database::safeExecute(
                'INSERT IGNORE INTO `email_subscribers` (`email`, `source`) VALUES (:email, :source)',
                ['email' => $em, 'source' => 'manual_upload']
            );
            if ($res > 0) {
                $added++;
            } else {
                $existing++;
            }
        }

        $totalSubscribers = (int) (Database::selectOne('SELECT COUNT(*) AS n FROM `email_subscribers`')['n'] ?? 0);
        auditLog('CAMPAIGN_EMAILS_IMPORTED', ['parsed' => count($uniqueEmails), 'added' => $added, 'existing' => $existing]);

        jsonResponse([
            'success' => true,
            'total_parsed' => count($uniqueEmails),
            'newly_added' => $added,
            'already_present' => $existing,
            'total_subscribers' => $totalSubscribers,
            'overview' => campaignOverview(),
        ]);
    });

    $router->get('/api/admin/campaigns/subscribers', function () {
        requireAdminAuth();
        ensureCampaignSchema();
        $rows = Database::safeSelect('SELECT `id`, `email`, `source`, `created_at` FROM `email_subscribers` ORDER BY `id` DESC LIMIT 500', [], []);
        $total = (int) (Database::selectOne('SELECT COUNT(*) AS n FROM `email_subscribers`')['n'] ?? 0);
        jsonResponse([
            'success' => true,
            'total' => $total,
            'subscribers' => $rows,
            'overview' => campaignOverview(),
        ]);
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
