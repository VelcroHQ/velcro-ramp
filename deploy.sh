#!/bin/bash
# One-step deploy on the cPanel server. In cPanel → Terminal:
#   bash ~/repositories/velcro-ramp/deploy.sh
# Pulls main, copies the site into the document root, removes dev-only files, restarts PHP
# and stamps /deploy-version.txt. Also run by .cpanel.yml (with --no-pull) on "Deploy HEAD Commit".

set -u
DEPLOYPATH="${DEPLOYPATH:-$HOME/ramp.usevelcro.com}"
cd "$(dirname "$0")" || exit 1

if [ "${1:-}" != "--no-pull" ]; then
  echo "== Pulling latest code"
  git pull --ff-only || { echo "FAILED: git pull (nothing was deployed)"; exit 1; }
  exec bash "$0" --no-pull # rerun the freshly pulled version of this script
fi

echo "== Deploying $(git log --oneline -1)"
# cp can't keep times on folders PHP created (data, uploads) and says so; the files still copy.
/bin/cp -R ramp.usevelcro.com/. "$DEPLOYPATH/" 2>/dev/null || /bin/cp -R ramp.usevelcro.com/. "$DEPLOYPATH/" || true
if ! cmp -s ramp.usevelcro.com/php-backend/index.php "$DEPLOYPATH/php-backend/index.php"; then
  echo "FAILED: files did not copy to $DEPLOYPATH"
  exit 1
fi
echo "copied"

# Dev-only files, and files deleted from the code that an old deploy left behind.
rm -rf "$DEPLOYPATH/php-backend/tests" "$DEPLOYPATH/php-backend/.env.test" "$DEPLOYPATH/php-backend/.env.example" \
  "$DEPLOYPATH/php-backend/README.md" "$DEPLOYPATH/SETUP.txt" "$DEPLOYPATH/clear.php" "$DEPLOYPATH/config.php" \
  "$DEPLOYPATH/paj-session.php" "$DEPLOYPATH/goat/test-auth.php" "$DEPLOYPATH/php-backend/debug_logs.php"
echo "cleaned"

touch "$DEPLOYPATH/.htaccess"
pkill -u "$(whoami)" lsphp 2>/dev/null
echo "php restarted"

git rev-parse --short HEAD > "$DEPLOYPATH/deploy-version.txt"
echo "DONE: $(cat "$DEPLOYPATH/deploy-version.txt") is live"
