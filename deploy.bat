@echo off
echo 🚀 Starting Deployment...
echo 📤 Pushing changes to GitHub...
git add .
git commit -m "Fixing GH/KE Mobile Money and Detailed Logging"
git push origin main

echo 🌐 Updating VPS server (usevelcro.xyz)...
ssh root@usevelcro.xyz "cd /root/velcro-ramp && git fetch origin && git reset --hard origin/main && npm install && pm2 delete velcro-ramp && pm2 start server.js --name velcro-ramp && pm2 status"

echo ✅ Done! Deployment Complete.
pause
