<?php

declare(strict_types=1);

// Start PHP Session for authentication state persistence
if (session_status() === PHP_SESSION_NONE) {
    session_start();
}

// 1. Locate and include the backend framework files
$backendDir = '';
$paths = [
    __DIR__ . '/php-backend',           // local folder
    __DIR__ . '/../php-backend',        // public/ -> php-backend
    __DIR__ . '/../ramp/php-backend',   // goat/ -> ramp/php-backend
    __DIR__ . '/../../ramp/php-backend',// nested directories
];

foreach ($paths as $path) {
    if (is_dir($path) && file_exists($path . '/config.php')) {
        $backendDir = $path;
        break;
    }
}

if (!$backendDir) {
    die("Error: Could not locate php-backend directory. Please check your setup.");
}

require_once $backendDir . '/config.php';
require_once $backendDir . '/helpers.php';
require_once $backendDir . '/db.php';
require_once $backendDir . '/paj_api.php';

// 2. Authentication Logic
$isAuthenticated = false;
$authError = '';

// Check if trying to login
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action']) && $_POST['action'] === 'login') {
    $password = trim($_POST['password'] ?? '');
    $passHash = hash('sha256', $password);
    
    if (defined('ADMIN_PASSWORD_HASH') && ADMIN_PASSWORD_HASH !== '' && $passHash === ADMIN_PASSWORD_HASH) {
        $_SESSION['paj_auth'] = true;
    } else {
        $authError = 'Invalid admin password.';
    }
}

// Check logout
if (isset($_GET['action']) && $_GET['action'] === 'logout') {
    unset($_SESSION['paj_auth']);
    header('Location: paj-session.php');
    exit;
}

// Set authentication status
if (isset($_SESSION['paj_auth']) && $_SESSION['paj_auth'] === true) {
    $isAuthenticated = true;
}

// 3. Handle Actions (only if authenticated)
$actionSuccess = '';
$actionError = '';

if ($isAuthenticated && $_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action'])) {
    $action = $_POST['action'];
    
    try {
        if ($action === 'update_email') {
            $email = strtolower(trim($_POST['email'] ?? ''));
            if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
                throw new Exception('Please enter a valid email address.');
            }
            $settings = loadSettings();
            $settings['paj_email'] = $email;
            if (saveSettings($settings)) {
                $actionSuccess = "Registered email updated to: <b>" . htmlspecialchars($email) . "</b>";
            } else {
                throw new Exception('Failed to save settings.');
            }
        }
        
        elseif ($action === 'initiate') {
            $paj = new PajApiClient();
            $result = $paj->initiateSession();
            $actionSuccess = "OTP initiated successfully! Check the email address: <b>" . htmlspecialchars($result['email'] ?? '') . "</b>";
        }
        
        elseif ($action === 'verify') {
            $otp = trim($_POST['otp'] ?? '');
            $otp = preg_replace('/[^0-9]/', '', $otp);
            if (strlen($otp) !== 4) {
                throw new Exception('Please enter a valid 4-digit OTP.');
            }
            $paj = new PajApiClient();
            $result = $paj->verifySession($otp);
            if (isset($result['success']) && $result['success']) {
                $actionSuccess = "Session verified and activated successfully!";
            } else {
                throw new Exception($result['error'] ?? 'Verification failed.');
            }
        }
    } catch (Throwable $e) {
        $actionError = $e->getMessage();
    }
}

// 4. Load Data for Display
$pajStatus = null;
$sessionDetails = null;
$registeredEmail = '';

if ($isAuthenticated) {
    try {
        $paj = new PajApiClient();
        $pajStatus = $paj->getSessionStatus();
        $sessionDetails = $paj->loadSession();
        $registeredEmail = loadSettings()['paj_email'] ?? PAJ_EMAIL;
    } catch (Throwable $e) {
        $actionError = "Data Load Error: " . $e->getMessage();
    }
}

?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Velcro Convert — PAJ Session Setup</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: #020617;
            --card-bg: #0f172a;
            --text-main: #f1f5f9;
            --text-secondary: #94a3b8;
            --primary: #a8cf45;
            --primary-hover: #bce64c;
            --primary-bg: #0d0d59;
            --border: #1e293b;
            --success: #10b981;
            --success-bg: #064e3b;
            --error: #ef4444;
            --error-bg: #450a0a;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            font-family: 'Inter', sans-serif;
            -webkit-font-smoothing: antialiased;
        }

        body {
            background-color: var(--bg-color);
            color: var(--text-main);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }

        .container {
            width: 100%;
            max-width: 520px;
            margin: 0 auto;
        }

        .card {
            background-color: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 24px;
            padding: 32px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
            position: relative;
        }

        .card-glow::before {
            content: '';
            position: absolute;
            inset: -1px;
            border-radius: 25px;
            background: linear-gradient(135deg, rgba(168, 207, 69, 0.15), rgba(13, 13, 89, 0.05), rgba(168, 207, 69, 0.1));
            z-index: -1;
            filter: blur(15px);
            opacity: 0.8;
            pointer-events: none;
        }

        .header {
            text-align: center;
            margin-bottom: 28px;
        }

        .logo-wrap {
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
        }

        .logo-text {
            font-size: 20px;
            font-weight: 800;
            color: var(--text-main);
            letter-spacing: -0.5px;
        }

        .logo-badge {
            background-color: var(--primary);
            color: var(--primary-bg);
            font-size: 10px;
            font-weight: 800;
            padding: 4px 8px;
            border-radius: 6px;
            text-transform: uppercase;
        }

        .subtitle {
            font-size: 13px;
            color: var(--text-secondary);
        }

        .banner {
            padding: 14px 16px;
            border-radius: 12px;
            font-size: 13px;
            line-height: 1.5;
            margin-bottom: 20px;
            display: flex;
            align-items: flex-start;
            gap: 10px;
        }

        .banner-success {
            background-color: var(--success-bg);
            color: #d1fae5;
            border: 1px solid #065f46;
        }

        .banner-error {
            background-color: var(--error-bg);
            color: #fee2e2;
            border: 1px solid #7f1d1d;
        }

        .banner-status {
            background-color: #1e293b;
            color: var(--text-main);
            border: 1px solid var(--border);
            text-align: center;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 6px;
            padding: 16px;
        }

        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            border-radius: 100px;
            font-size: 12px;
            font-weight: 700;
            text-transform: uppercase;
        }

        .status-active {
            background-color: var(--success-bg);
            color: #34d399;
            border: 1px solid #065f46;
        }

        .status-inactive {
            background-color: var(--error-bg);
            color: #f87171;
            border: 1px solid #7f1d1d;
        }

        .form-group {
            margin-bottom: 20px;
            text-align: left;
        }

        .label {
            font-size: 11px;
            font-weight: 700;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.05em;
            display: block;
            margin-bottom: 8px;
        }

        .input-wrap {
            display: flex;
            gap: 8px;
        }

        .input {
            width: 100%;
            background: rgba(15, 23, 42, 0.4);
            border: 1.5px solid var(--border);
            border-radius: 12px;
            padding: 12px 16px;
            font-size: 14px;
            color: var(--text-main);
            outline: none;
            transition: all 0.2s ease;
        }

        .input:focus {
            border-color: var(--primary);
            box-shadow: 0 0 0 3px rgba(168, 207, 69, 0.1);
        }

        .input-otp {
            text-align: center;
            font-size: 24px;
            font-weight: 700;
            letter-spacing: 8px;
            font-family: monospace;
            padding: 8px;
        }

        .btn {
            background-color: var(--primary);
            color: var(--primary-bg);
            border: none;
            padding: 12px 20px;
            font-size: 14px;
            font-weight: 700;
            border-radius: 12px;
            cursor: pointer;
            transition: all 0.2s ease;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            white-space: nowrap;
        }

        .btn:hover {
            background-color: var(--primary-hover);
            box-shadow: 0 0 15px rgba(168, 207, 69, 0.3);
            transform: translateY(-1px);
        }

        .btn:active {
            transform: translateY(1px);
        }

        .btn-secondary {
            background-color: transparent;
            border: 1.5px solid var(--border);
            color: var(--text-main);
        }

        .btn-secondary:hover {
            background-color: rgba(255, 255, 255, 0.05);
            box-shadow: none;
        }

        .btn-full {
            width: 100%;
            padding: 14px;
            font-size: 15px;
        }

        .divider {
            height: 1px;
            background-color: var(--border);
            margin: 24px 0;
        }

        .logout-link {
            display: inline-block;
            margin-top: 16px;
            font-size: 12px;
            color: var(--error);
            text-decoration: none;
            font-weight: 600;
        }

        .logout-link:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>

<div class="container">
    <div class="card card-glow">
        <div class="header">
            <div class="logo-wrap">
                <span class="logo-text">Velcro Convert</span>
                <span class="logo-badge">PAJ API</span>
            </div>
            <p class="subtitle">Secure session setup & token activation manager</p>
        </div>

        <?php if (!$isAuthenticated): ?>
            <!-- Login Form -->
            <form method="POST">
                <input type="hidden" name="action" value="login">
                
                <?php if ($authError): ?>
                    <div class="banner banner-error">
                        <span>⚠️ <?php echo htmlspecialchars($authError); ?></span>
                    </div>
                <?php endif; ?>

                <div class="form-group">
                    <label class="label" for="password">Admin Password</label>
                    <input type="password" id="password" name="password" required placeholder="Enter platform admin password" class="input">
                </div>
                <button type="submit" class="btn btn-full">Authenticate</button>
            </form>

        <?php else: ?>
            <!-- Authenticated Workspace -->
            
            <?php if ($actionSuccess): ?>
                <div class="banner banner-success">
                    <span>✅ <?php echo $actionSuccess; ?></span>
                </div>
            <?php endif; ?>

            <?php if ($actionError): ?>
                <div class="banner banner-error">
                    <span>⚠️ <?php echo htmlspecialchars($actionError); ?></span>
                </div>
            <?php endif; ?>

            <!-- Status Banner -->
            <div class="banner banner-status">
                <?php if ($pajStatus && $pajStatus['valid']): ?>
                    <div class="status-badge status-active">Session Active</div>
                    <div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px;">
                        Expires: <?php echo date('Y-m-d H:i:s', strtotime($sessionDetails['expiresAt'] ?? 'now')); ?>
                    </div>
                <?php else: ?>
                    <div class="status-badge status-inactive">No Active Session</div>
                    <div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px;">
                        You must request and verify a 4-digit OTP to authorize transactions.
                    </div>
                <?php endif; ?>
            </div>

            <!-- Form 1: Registered Email -->
            <form method="POST" class="form-group">
                <input type="hidden" name="action" value="update_email">
                <label class="label">Registered PAJ Email</label>
                <div class="input-wrap">
                    <input type="email" name="email" required value="<?php echo htmlspecialchars($registeredEmail); ?>" class="input">
                    <button type="submit" class="btn">Update</button>
                </div>
            </form>

            <div class="divider"></div>

            <!-- Form 2: Initiate Session -->
            <form method="POST" class="form-group">
                <input type="hidden" name="action" value="initiate">
                <label class="label">Initiate Session (Request OTP)</label>
                <p style="font-size: 11px; color: var(--text-secondary); margin-bottom: 8px;">
                    This triggers a login request to PAJ. They will email a 4-digit verification code.
                </p>
                <button type="submit" class="btn btn-full">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                    Send 4-Digit OTP
                </button>
            </form>

            <div class="divider"></div>

            <!-- Form 3: Verify OTP -->
            <form method="POST" class="form-group">
                <input type="hidden" name="action" value="verify">
                <label class="label" for="otp">Enter 4-Digit OTP</label>
                <div class="input-wrap" style="flex-direction: column; gap: 12px;">
                    <input type="text" id="otp" name="otp" required placeholder="0000" maxlength="4" inputmode="numeric" pattern="[0-9]*" class="input input-otp">
                    <button type="submit" class="btn btn-full" style="background-color: var(--success); color: #fff;">Verify and Lock Session</button>
                </div>
            </form>

            <div style="text-align: center;">
                <a href="?action=logout" class="logout-link">Logout Admin Session</a>
            </div>

        <?php endif; ?>
    </div>
</div>

</body>
</html>
