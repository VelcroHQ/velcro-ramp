<?php

declare(strict_types=1);

/**
 * Velcro Ramp — Admin Panel Gateway
 *
 * Serves index.html directly when accessing /goat or /goat/
 */

header('Content-Type: text/html; charset=UTF-8');
if (file_exists(__DIR__ . '/index.html')) {
    readfile(__DIR__ . '/index.html');
    exit;
}

echo '<!DOCTYPE html><html><body><h1>Admin Dashboard</h1><p>index.html not found.</p></body></html>';
