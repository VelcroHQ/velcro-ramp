<?php

declare(strict_types=1);

// Router for `php -S`, started by tests/security_test.php and tests/hostfi_test.php. Serves the real routes over a SQLite file.
if (PHP_SAPI !== 'cli-server') {
    http_response_code(404);
    exit;
}

define('BASE_PATH', (string) getenv('VELCRO_TEST_BASE'));

require_once __DIR__ . '/../../config.php';
require_once __DIR__ . '/../../helpers.php';
require_once __DIR__ . '/../../router.php';
require_once __DIR__ . '/../../db.php';
require_once __DIR__ . '/../../poll_helpers.php';
require_once __DIR__ . '/../../routes/public.php';
require_once __DIR__ . '/../../routes/admin.php';
require_once __DIR__ . '/../../routes/hostfi.php';
require_once __DIR__ . '/../../routes/referrals.php';
require_once __DIR__ . '/../../routes/merchant.php';

$pdo = new PDO('sqlite:' . BASE_PATH . '/test.db', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
$pdo->sqliteCreateFunction('NOW', fn () => gmdate('Y-m-d H:i:s'), 0); // MySQL built-in the routes use
(new ReflectionProperty(Database::class, 'pdo'))->setValue(null, $pdo);

$router = new Router();
registerPublicRoutes($router);
registerAdminRoutes($router);
registerHostfiRoutes($router);
registerMerchantRoutes($router);
if (!$router->dispatch($_SERVER['REQUEST_METHOD'], $_SERVER['REQUEST_URI'])) {
    jsonResponse(['error' => 'Not found'], 404);
}
