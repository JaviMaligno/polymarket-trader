#!/bin/bash

# ============================================
# View Polymarket Trader Logs
# ============================================

SERVICE=${1:-}
LINES=${2:-100}

if [ -z "$SERVICE" ]; then
    echo "Showing logs for all services (last $LINES lines)..."
    docker-compose logs -f --tail=$LINES
else
    echo "Showing logs for $SERVICE (last $LINES lines)..."
    docker-compose logs -f --tail=$LINES $SERVICE
fi
