<?php

declare(strict_types=1);

/**
 * Velcro Ramp — Apache front controller
 *
 * This file exists so Apache deployments can keep the document root inside
 * public/ while still loading the backend router from php-backend/index.php.
 *
 * The PHP built-in server command can also use this file as the router:
 *   php -S localhost:3000 -t public public/index.php
 */

require __DIR__ . '/../php-backend/index.php';
