<?php

declare(strict_types=1);

/**
 * Velcro Ramp — Admin Panel Gateway & API Controller
 */

$uri = $_SERVER['REQUEST_URI'] ?? '';
$host = strtolower($_SERVER['HTTP_HOST'] ?? '');

// If accessed via ramp.usevelcro.com/goat, redirect permanently to goat.usevelcro.com
if ($host === 'ramp.usevelcro.com') {
    $path = preg_replace('#^/goat(/|$)#i', '/', (string) parse_url($uri, PHP_URL_PATH));
    $query = isset($_SERVER['QUERY_STRING']) && $_SERVER['QUERY_STRING'] !== '' ? '?' . $_SERVER['QUERY_STRING'] : '';
    header('Location: https://goat.usevelcro.com' . $path . $query, true, 301);
    exit;
}

// If request is for an API endpoint (/api/...) or webhook (/webhook/...)
if (str_contains($uri, '/api/') || str_contains($uri, '/webhook/')) {
    require_once __DIR__ . '/../php-backend/index.php';
    exit;
}

// Serve index.html directly for dashboard requests
header('Content-Type: text/html; charset=UTF-8');
if (file_exists(__DIR__ . '/index.html')) {
    readfile(__DIR__ . '/index.html');
    exit;
}

echo '<!DOCTYPE html><html><body><h1>Admin Dashboard</h1><p>index.html not found.</p></body></html>';

