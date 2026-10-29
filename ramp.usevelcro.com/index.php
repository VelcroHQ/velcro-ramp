<?php

declare(strict_types=1);

/**
 * Velcro Ramp — production front controller
 *
 * This file should sit at the document root (e.g. public_html/index.php).
 * It loads the backend router from the php-backend/ subdirectory.
 */

if (isset($_GET['flush']) && function_exists('opcache_reset')) {
    @opcache_reset();
    header('Content-Type: application/json');
    echo json_encode(['success' => true, 'opcache_reset' => true, 'timestamp' => time()]);
    exit;
}

require __DIR__ . '/php-backend/index.php';
