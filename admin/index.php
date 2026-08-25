<?php

declare(strict_types=1);

/**
 * Velcro Ramp — Subdomain front controller for admin panel
 *
 * This file allows the admin panel hosted on a subdomain (e.g. goat.usevelcro.xyz)
 * to route api and webhook requests directly to the shared backend in the parent directory.
 */

require_once __DIR__ . '/../php-backend/index.php';
