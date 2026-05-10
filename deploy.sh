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

# 2. Determine SSH Command
SSH_KEY="$HOME/.ssh/velcro_vps"
if [ -f "$SSH_KEY" ]; then
    echo "🔐 Using identity file: $SSH_KEY"
    SSH_CMD="ssh -i $SSH_KEY"
else
    echo "⚠️  Identity file $SSH_KEY not found. Falling back to default SSH..."
    SSH_CMD="ssh"
fi

# 3. Update the VPS
echo "🌐 Updating VPS server (usevelcro.xyz)..."
$SSH_CMD -t ${SERVER_USER}@${SERVER_IP} "cd ${SERVER_PATH} && (git fetch origin && git reset --hard origin/main) || (echo '❌ Git authentication failed on VPS.' && exit 1) && npm install && pm2 delete velcro-ramp 2>/dev/null || true && pm2 start server.js --name velcro-ramp && pm2 status"

if [ $? -eq 0 ]; then
    echo "✅ Deployment Complete!"
else
    echo "❌ Deployment failed."
fi
