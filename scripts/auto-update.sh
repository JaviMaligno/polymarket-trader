#!/bin/bash
# auto-update.sh - Auto-update Polymarket Trader on GCP VM
#
# Checks for new commits on main branch and redeploys if changes found.
# Designed to run via cron for continuous deployment.
#
# Usage: ./scripts/auto-update.sh
#
# Environment:
#   REPO_DIR      Repository directory (default: /opt/polymarket-trader)
#   LOG_FILE      Log file path (default: /var/log/polymarket-autoupdate.log)
#   COMPOSE_FILE  Docker compose file (default: docker-compose.gcp.yml)
#
# Cron Example:
#   */10 * * * * /opt/polymarket-trader/scripts/auto-update.sh

if [[ "$1" == "--help" || "$1" == "-h" ]]; then
  sed -n '2,/^[^#]/p' "$0" | grep '^#' | sed 's/^# \?//'
  exit 0
fi

REPO_DIR="${REPO_DIR:-/opt/polymarket-trader}"
LOG_FILE="/var/log/polymarket-autoupdate.log"
COMPOSE_FILE="docker-compose.gcp.yml"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

cd "$REPO_DIR" || { log "ERROR: Cannot cd to $REPO_DIR"; exit 1; }

# Fetch latest changes
git fetch origin main --quiet 2>> "$LOG_FILE"

# Check if there are new commits
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  # No changes, nothing to do
  exit 0
fi

log "New commits detected: $LOCAL -> $REMOTE"
log "Pulling changes..."

git pull origin main --quiet 2>> "$LOG_FILE"

if [ $? -ne 0 ]; then
  log "ERROR: git pull failed"
  exit 1
fi

log "Rebuilding and restarting services..."
docker compose -f "$COMPOSE_FILE" up -d --build 2>> "$LOG_FILE"

if [ $? -eq 0 ]; then
  log "SUCCESS: Services updated and restarted"
else
  log "ERROR: docker compose up failed"
  exit 1
fi
