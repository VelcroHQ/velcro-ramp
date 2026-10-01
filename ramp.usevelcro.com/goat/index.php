<?php

declare(strict_types=1);

/**
 * Velcro Ramp — Admin Panel Gateway & API Controller
 */

$uri = $_SERVER['REQUEST_URI'] ?? '';

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

