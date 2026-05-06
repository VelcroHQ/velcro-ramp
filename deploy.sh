#!/bin/bash

# Configuration
SERVER_IP="187.124.13.111"
SERVER_USER="root"
SERVER_PATH="/root/velcro-ramp"

echo "🚀 Starting Deployment..."

# 1. Push local changes to GitHub
echo "📤 Pushing changes to GitHub..."
git add .
git commit -m "Deployment update: $(date)"
git push origin main

# 2. Update the VPS
echo "🌐 Updating VPS server..."
ssh -t ${SERVER_USER}@${SERVER_IP} "cd ${SERVER_PATH} && git fetch origin && git reset --hard origin/main && npm install && pm2 delete velcro-ramp && pm2 start server.js --name velcro-ramp && pm2 status"

echo "✅ Deployment Complete!"
