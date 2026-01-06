#!/bin/bash
set -e

# ============================================
# Backup Polymarket Trader Database
# ============================================

BACKUP_DIR=${BACKUP_DIR:-./backups}
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/polymarket_backup_$TIMESTAMP.sql.gz"

# Create backup directory if it doesn't exist
mkdir -p $BACKUP_DIR

echo "Creating backup..."

# Backup database
docker-compose exec -T timescaledb pg_dump -U polymarket polymarket_trading | gzip > $BACKUP_FILE

echo "Backup created: $BACKUP_FILE"

# Keep only last 7 days of backups
echo "Cleaning old backups..."
find $BACKUP_DIR -name "polymarket_backup_*.sql.gz" -mtime +7 -delete

echo "Backup complete!"
