#!/bin/bash
# One-shot update script for Velcro Ramp
# Run this from your local machine after pushing to GitHub

SERVER_IP="187.124.13.111"
SERVER_USER="root"
SERVER_PATH="/root/velcro-ramp"

echo "🚀 Deploying updates to usevelcro.xyz..."

ssh -t ${SERVER_USER}@${SERVER_IP} "
  set -e
  echo '⬇️  Pulling latest code...'
  cd ${SERVER_PATH}
  git fetch origin main
  git reset --hard origin/main
  
  echo '⬇️  Installing dependencies...'
  npm install
  
  echo '🔄 Restarting server...'
  pm2 delete velcro-ramp 2>/dev/null || true
  pm2 start server.js --name velcro-ramp
  pm2 save
  
  echo '✅ Done! Server is running:'
  pm2 status velcro-ramp
  echo ''
  echo '⏳ Waiting 3 seconds for server to start...'
  sleep 3
  echo '📡 Health check:'
  curl -s http://localhost:3000/api/health | head -c 200
  echo ''
"

echo ''
echo '🌐 Clear browser cache:'
echo '   https://usevelcro.xyz/?nocache=1'
