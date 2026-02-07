#!/bin/bash
# stop.sh - Stop Polymarket Trader services
#
# Stops all running Docker containers for the trading system.
#
# Usage: ./scripts/stop.sh [environment]
#
# Arguments:
#   environment  Target environment: production|development (default: default)
#
# Example:
#   ./scripts/stop.sh
#   ./scripts/stop.sh production

if [[ "$1" == "--help" || "$1" == "-h" ]]; then
  sed -n '2,/^[^#]/p' "$0" | grep '^#' | sed 's/^# \?//'
  exit 0
fi

set -e

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
