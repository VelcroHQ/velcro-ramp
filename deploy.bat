@echo off
echo 🚀 Starting Deployment...
echo 📤 Pushing changes to GitHub...
git add .
git commit -m "Deployment update: %date% %time%"
git push origin main

echo 🔐 Connecting to VPS via SSH key...
ssh -i %USERPROFILE%\.ssh\velcro_vps root@187.124.13.111 "cd /root/velcro-ramp && git fetch origin && git reset --hard origin/main && npm install && pm2 delete velcro-ramp && pm2 start server.js --name velcro-ramp && pm2 status"

echo ✅ Done! Deployment Complete.
pause
