<?php

declare(strict_types=1);

/**
 * Velcro Ramp — PHP Backend Entry Point
 *
 * All API and webhook routes are dispatched from here. Static files
 * (index.html, style.css, etc.) are served directly by the web server.
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/router.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/poll_helpers.php';

// Ensure writable data directory exists
$dataDir = BASE_PATH . '/data';
if (!is_dir($dataDir)) {
    @mkdir($dataDir, 0755, true);
}

handleCors();

$method = $_SERVER['REQUEST_METHOD'];
$path = $_SERVER['REQUEST_URI'] ?? '/';

// Strip query string for routing
$path = parse_url($path, PHP_URL_PATH) ?: '/';

// Normalize /goat/api/... or /goat/webhook/... to /api/... or /webhook/...
if (str_starts_with($path, '/goat/api/')) {
    $path = substr($path, 5);
} elseif (str_starts_with($path, '/goat/webhook/')) {
    $path = substr($path, 5);
}

// For PHP built-in web server, return false to serve static files directly
if (php_sapi_name() === 'cli-server') {
    $file = $_SERVER['DOCUMENT_ROOT'] . $path;
    if ($path === '/' && file_exists($_SERVER['DOCUMENT_ROOT'] . '/index.html')) {
        return false;
    }
    if (file_exists($file) && !is_dir($file)) {
        return false;
    }
}

// Don't handle static assets here
if (preg_match('/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|html|txt|xml|json)$/i', $path)) {
    http_response_code(404);
    exit;
}

$router = new Router();

require_once __DIR__ . '/routes/public.php';
require_once __DIR__ . '/routes/admin.php';
require_once __DIR__ . '/routes/paj.php';
require_once __DIR__ . '/routes/webhooks.php';
require_once __DIR__ . '/routes/referrals.php';
require_once __DIR__ . '/routes/campaigns.php';

registerPublicRoutes($router);
registerAdminRoutes($router);
registerPajRoutes($router);
registerWebhookRoutes($router);
registerReferralRoutes($router);
registerCampaignRoutes($router);

// Receipts and campaign batches: sent after the response is flushed, at most every 20s.
register_shutdown_function(static function (): void {
    $tick = BASE_PATH . '/data/.receipts_tick';
    if (!mailConfigured() || (is_file($tick) && time() - filemtime($tick) < 20)) {
        return;
    }
    @touch($tick);
    if (function_exists('litespeed_finish_request')) {
        litespeed_finish_request();
    } elseif (function_exists('fastcgi_finish_request')) {
        fastcgi_finish_request();
    }
    try {
        sendPendingReceipts();
        sendCampaignBatch(20);
    } catch (Throwable $e) {
        error_log('Receipt sending failed: ' . $e->getMessage());
    }
});

$matched = $router->dispatch($method, $path);

if (!$matched) {
    jsonResponse(['success' => false, 'error' => 'Not found'], 404);
}
