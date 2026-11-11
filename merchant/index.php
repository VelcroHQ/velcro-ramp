<?php

declare(strict_types=1);

/**
 * Velcro Ramp — Merchant Portal Gateway & API Controller
 */

$uri = $_SERVER['REQUEST_URI'] ?? '';
$host = strtolower($_SERVER['HTTP_HOST'] ?? '');

// If request is for an API endpoint (/api/...) or webhook (/webhook/...)
if (str_contains($uri, '/api/') || str_contains($uri, '/webhook/')) {
    require_once __DIR__ . '/../php-backend/index.php';
    exit;
}

// Clean pretty URLs for legal pages (/terms, /privacy)
$cleanPath = rtrim((string) parse_url($uri, PHP_URL_PATH), '/');
if ($cleanPath === '/terms') {
    header('Content-Type: text/html; charset=UTF-8');
    if (file_exists(__DIR__ . '/terms.html')) {
        readfile(__DIR__ . '/terms.html');
        exit;
    }
}
if ($cleanPath === '/privacy') {
    header('Content-Type: text/html; charset=UTF-8');
    if (file_exists(__DIR__ . '/privacy.html')) {
        readfile(__DIR__ . '/privacy.html');
        exit;
    }
}

// If this is a merchant storefront subdomain (e.g. megamind.usevelcro.com, not merchant.usevelcro.com)
if ($host !== '' && !str_starts_with($host, 'merchant.') && !str_starts_with($host, 'ramp.') && !str_starts_with($host, 'goat.')) {
    header('Content-Type: text/html; charset=UTF-8');
    if (file_exists(__DIR__ . '/store/index.html')) {
        readfile(__DIR__ . '/store/index.html');
        exit;
    }
    if (file_exists(__DIR__ . '/../store/index.html')) {
        readfile(__DIR__ . '/../store/index.html');
        exit;
    }
}

// Serve index.html directly for dashboard requests
header('Content-Type: text/html; charset=UTF-8');
if (file_exists(__DIR__ . '/index.html')) {
    readfile(__DIR__ . '/index.html');
    exit;
}

echo '<!DOCTYPE html><html><body><h1>Merchant Dashboard</h1><p>index.html not found.</p></body></html>';

