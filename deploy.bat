@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

echo Starting Deployment...

:: 1. Push changes to GitHub
echo Pushing changes to GitHub...
git add .
git commit -m "Deployment update: %date% %time%"
git push origin main

:: 2. Determine SSH Command
set SSH_KEY=%USERPROFILE%\.ssh\velcro_vps
if exist "!SSH_KEY!" (
    echo Using identity file: !SSH_KEY!
    set SSH_CMD=ssh -i "!SSH_KEY!"
) else (
    echo Identity file not found. Falling back to default SSH...
    set SSH_CMD=ssh
)

:: 3. Update VPS
echo Connecting to VPS (187.124.13.111)...
!SSH_CMD! root@187.124.13.111 "cd /root/velcro-ramp && (git fetch origin && git reset --hard origin/main) || (echo Git authentication failed on VPS. Please configure your GitHub token. && exit 1) && npm install && pm2 delete velcro-ramp 2>/dev/null || true && pm2 start server.js --name velcro-ramp && pm2 status"

if %ERRORLEVEL% equ 0 (
    echo Deployment Complete!
) else (
    echo Deployment failed.
)
pause
