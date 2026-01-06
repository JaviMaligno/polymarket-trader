#!/bin/bash
set -e

# ============================================
# Stop Polymarket Trader Services
# ============================================

echo "Stopping Polymarket Trader services..."

# Parse arguments
ENVIRONMENT=${1:-default}

if [ "$ENVIRONMENT" = "production" ]; then
    docker-compose -f docker-compose.yml -f docker-compose.prod.yml down
elif [ "$ENVIRONMENT" = "development" ]; then
    docker-compose -f docker-compose.yml -f docker-compose.dev.yml down
else
    docker-compose down
fi

echo "Services stopped."
