Write-Host "Starting Deployment..." -ForegroundColor Cyan

# 1. Push local changes
Write-Host "Pushing changes to GitHub..." -ForegroundColor Yellow
git add .
git commit -m "Deployment update: $(Get-Date)"
git push origin main

# 2. Determine SSH Command
$SSH_KEY = "$HOME\.ssh\velcro_vps"
if (Test-Path $SSH_KEY) {
    Write-Host "🔐 Using identity file: $SSH_KEY" -ForegroundColor Cyan
    $SSH_CMD = "ssh -i $SSH_KEY"
} else {
    Write-Host "⚠️  Identity file $SSH_KEY not found. Falling back to default SSH..." -ForegroundColor DarkYellow
    $SSH_CMD = "ssh"
}

# 3. Update the VPS
Write-Host "Updating VPS server (usevelcro.xyz)..." -ForegroundColor Yellow
$RemoteCmd = "cd /root/velcro-ramp && (git fetch origin && git reset --hard origin/main) || (echo '❌ Git authentication failed on VPS.' && exit 1) && npm install && pm2 delete velcro-ramp 2>/dev/null || true && pm2 start server.js --name velcro-ramp && pm2 status"

Invoke-Expression "$SSH_CMD root@187.124.13.111 `"$RemoteCmd`""

if ($LASTEXITCODE -eq 0) {
    Write-Host "Done! Deployment Complete." -ForegroundColor Green
} else {
    Write-Host "Deployment failed." -ForegroundColor Red
}
