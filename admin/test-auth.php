<?php
declare(strict_types=1);

// Enable error displaying for diagnostics
ini_set('display_errors', '1');
error_reporting(E_ALL);

header('Content-Type: text/plain; charset=utf-8');

echo "--- Velcro Subdomain Auth Diagnostics ---\n\n";

// 1. Check if php-backend config can be loaded
$configPath = __DIR__ . '/../php-backend/config.php';
if (!file_exists($configPath)) {
    echo "[ERROR] Backend config file not found at: {$configPath}\n";
    exit;
}

require_once $configPath;
require_once __DIR__ . '/../php-backend/helpers.php';

echo "1. Server Environment:\n";
echo "   Server Software: " . ($_SERVER['SERVER_SOFTWARE'] ?? 'Unknown') . "\n";
echo "   PHP Version: " . PHP_VERSION . "\n\n";

echo "2. Configured Admin Password (from .env):\n";
$envPath = __DIR__ . '/../php-backend/.env';
if (file_exists($envPath)) {
    $envLines = file($envPath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    $foundPass = false;
    foreach ($envLines as $line) {
        $trimmed = trim($line);
        if (str_starts_with($trimmed, 'ADMIN_PASSWORD=')) {
            $passVal = substr($trimmed, 15);
            echo "   Raw password value in .env: \"{$passVal}\"\n";
            $foundPass = true;
            break;
        }
    }
    if (!$foundPass) {
        echo "   [WARNING] ADMIN_PASSWORD key not found in .env\n";
    }
} else {
    echo "   [ERROR] .env file not found at: {$envPath}\n";
}

if (defined('ADMIN_PASSWORD_HASH')) {
    if (ADMIN_PASSWORD_HASH === '') {
        echo "   [WARNING] ADMIN_PASSWORD_HASH is empty! Config is not loaded or password is blank.\n";
    } else {
        echo "   Resolved Hash (SHA-256): " . ADMIN_PASSWORD_HASH . "\n";
    }
} else {
    echo "   [ERROR] ADMIN_PASSWORD_HASH is not defined.\n";
}
echo "\n";

echo "3. Incoming Authorization Headers:\n";
$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
echo "   \$_SERVER['HTTP_AUTHORIZATION']: " . ($auth !== '' ? "[PRESENT, value: \"{$auth}\"]" : "[MISSING]") . "\n";

$redirectAuth = $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
echo "   \$_SERVER['REDIRECT_HTTP_AUTHORIZATION']: " . ($redirectAuth !== '' ? "[PRESENT, value: \"{$redirectAuth}\"]" : "[MISSING]") . "\n";

$xAuth = $_SERVER['HTTP_X_AUTHORIZATION'] ?? '';
echo "   \$_SERVER['HTTP_X_AUTHORIZATION']: " . ($xAuth !== '' ? "[PRESENT, value: \"{$xAuth}\"]" : "[MISSING]") . "\n";

if (function_exists('apache_request_headers')) {
    $headers = apache_request_headers();
    echo "   Apache Authorization header: " . (isset($headers['Authorization']) ? "[PRESENT, value: \"" . $headers['Authorization'] . "\"]" : "[MISSING]") . "\n";
} else {
    echo "   apache_request_headers() not available.\n";
}
echo "\n";

echo "4. Raw headers received by server:\n";
foreach ($_SERVER as $key => $val) {
    if (str_contains(strtolower($key), 'auth') || str_contains(strtolower($key), 'http_')) {
        echo "   {$key}: {$val}\n";
    }
}
echo "\n";

echo "5. Test Authentication:\n";
$testPassword = $_GET['pass'] ?? '';
if ($testPassword === '') {
    echo "   No test password provided. Access this page with ?pass=YourPassword to verify if your password matches the server config.\n";
} else {
    $inputClean = preg_replace('/^Bearer\s+/i', '', trim($testPassword));
    $inputHash = hash('sha256', $inputClean);
    echo "   Input password to test: \"{$testPassword}\"\n";
    echo "   Input password hash: " . $inputHash . "\n";
    if (defined('ADMIN_PASSWORD_HASH') && ADMIN_PASSWORD_HASH !== '') {
        if ($inputHash === ADMIN_PASSWORD_HASH) {
            echo "   [SUCCESS] Your password matches the configured ADMIN_PASSWORD hash!\n";
        } else {
            echo "   [FAIL] Your password does NOT match the configured ADMIN_PASSWORD hash.\n";
        }
    }
}
