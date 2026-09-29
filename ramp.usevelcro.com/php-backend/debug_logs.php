<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/helpers.php';

// Very simple password protection via query param
$pass = $_GET['key'] ?? '';
if ($pass !== 'velcro-debug-2026') {
    die('Unauthorized. Use ?key=velcro-debug-2026 to access.');
}

try {
    $logs = Database::safeSelect('SELECT * FROM `audit_logs` ORDER BY `created_at` DESC LIMIT 200', [], []);
} catch (Throwable $e) {
    die('Database error: ' . $e->getMessage());
}
?>
<!DOCTYPE html>
<html>
<head>
    <title>Velcro Debug Logs</title>
    <style>
        body { font-family: -apple-system, blinkmacsystemfont, "Segoe UI", Roboto, sans-serif; padding: 20px; background: #f8f9fa; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        h1 { margin: 0; font-size: 20px; }
        table { width: 100%; border-collapse: collapse; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border-radius: 8px; overflow: hidden; }
        th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #edf2f7; }
        th { background: #f1f5f9; font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 600; }
        tr:hover { background: #f8fafc; }
        .action { font-weight: 600; color: #0d0d59; }
        .details { font-family: monospace; font-size: 11px; white-space: pre-wrap; color: #475569; max-width: 400px; }
        .ip { color: #94a3b8; font-size: 12px; }
        .date { white-space: nowrap; font-size: 12px; color: #475569; }
        .badge { padding: 3px 6px; border-radius: 4px; font-size: 10px; background: #e2e8f0; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🚀 Velcro System Logs (Testing)</h1>
        <div>
            <button onclick="window.location.reload()" style="padding: 8px 15px; border-radius: 6px; border: 1px solid #cbd5e1; background: white; cursor: pointer;">Refresh</button>
        </div>
    </div>

    <table>
        <thead>
            <tr>
                <th>Action</th>
                <th>Details</th>
                <th>IP</th>
                <th>Date (UTC)</th>
            </tr>
        </thead>
        <tbody>
            <?php if (empty($logs)): ?>
                <tr><td colspan="4" style="text-align: center; padding: 40px; color: #94a3b8;">No logs found yet.</td></tr>
            <?php else: ?>
                <?php foreach ($logs as $log): ?>
                    <?php 
                        $details = json_decode($log['details'] ?? '{}', true);
                        $detailsStr = json_encode($details, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
                    ?>
                    <tr>
                        <td><span class="action"><?= htmlspecialchars((string)$log['action']) ?></span></td>
                        <td><div class="details"><?= htmlspecialchars($detailsStr) ?></div></td>
                        <td><span class="ip"><?= htmlspecialchars((string)$log['ip']) ?></span></td>
                        <td><span class="date"><?= htmlspecialchars((string)$log['created_at']) ?></span></td>
                    </tr>
                <?php endforeach; ?>
            <?php endif; ?>
        </tbody>
    </table>
</body>
</html>
