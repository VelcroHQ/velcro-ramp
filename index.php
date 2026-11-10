<?php

declare(strict_types=1);

/**
 * Velcro Ramp — production front controller
 *
 * This file should sit at the document root (e.g. public_html/index.php).
 * It loads the backend router from the php-backend/ subdirectory.
 */

// Clears PHP's code cache after a deploy: /index.php?flush=<OPCACHE_FLUSH_KEY from .env>.
// Without the key (or with no key set) the request is handled like any other and gets a 404.
if (isset($_GET['flush'])) {
    require_once __DIR__ . '/php-backend/config.php';
    $flushKey = (string) env('OPCACHE_FLUSH_KEY', '');
    if ($flushKey !== '' && hash_equals($flushKey, (string) $_GET['flush']) && function_exists('opcache_reset')) {
        @opcache_reset();
        header('Content-Type: application/json');
        echo json_encode(['success' => true, 'opcache_reset' => true, 'timestamp' => time()]);
        exit;
    }
}

// ── Agent-Readiness: Content Negotiation for Markdown (Accept: text/markdown or ?format=markdown) ──
$acceptHeader = $_SERVER['HTTP_ACCEPT'] ?? '';
$isMarkdownRequest = (isset($_GET['format']) && $_GET['format'] === 'markdown')
    || stripos($acceptHeader, 'text/markdown') !== false
    || stripos($acceptHeader, 'text/x-markdown') !== false;

if ($isMarkdownRequest && (!isset($_SERVER['REQUEST_URI']) || preg_match('#^/(index(\.(php|html))?)?(\?.*)?$#i', $_SERVER['REQUEST_URI']))) {
    header('Content-Type: text/markdown; charset=utf-8');
    header('Vary: Accept');
    header('Content-Signal: search=yes, ai-train=no');
    header('Link: <https://ramp.usevelcro.com/llms.txt>; rel="describedby"; type="text/plain", <https://ramp.usevelcro.com/?format=markdown>; rel="alternate"; type="text/markdown"');
    if (file_exists(__DIR__ . '/index.md')) {
        readfile(__DIR__ . '/index.md');
    } else {
        readfile(__DIR__ . '/llms.txt');
    }
    exit;
}

require __DIR__ . '/php-backend/index.php';
