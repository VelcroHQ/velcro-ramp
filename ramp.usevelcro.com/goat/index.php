<?php

declare(strict_types=1);

/**
 * Velcro Ramp — Front controller for admin panel & API gateway
 */

$uri = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH) ?? '';

// If request is for an API endpoint (/api/...) or webhook (/webhook/...)
if (str_contains($uri, '/api/') || str_contains($uri, '/webhook/')) {
    require_once __DIR__ . '/../php-backend/index.php';
    exit;
}

// Otherwise serve the Admin Dashboard HTML directly
if (file_exists(__DIR__ . '/index.html')) {
    header('Content-Type: text/html; charset=UTF-8');
    readfile(__DIR__ . '/index.html');
    exit;
}

require_once __DIR__ . '/../php-backend/index.php';
