#!/bin/bash
# logs.sh - View Polymarket Trader container logs
#
# Shows logs from Docker containers with optional filtering by service.
#
# Usage: ./scripts/logs.sh [service] [lines]
#
# Arguments:
#   service  Service name to filter (default: all services)
#   lines    Number of lines to show (default: 100)
#
# Example:
#   ./scripts/logs.sh
#   ./scripts/logs.sh dashboard-api
#   ./scripts/logs.sh timescaledb 200

if [[ "$1" == "--help" || "$1" == "-h" ]]; then
  sed -n '2,/^[^#]/p' "$0" | grep '^#' | sed 's/^# \?//'
  exit 0
fi

SERVICE=${1:-}
LINES=${2:-100}

if [ -z "$SERVICE" ]; then
    echo "Showing logs for all services (last $LINES lines)..."
    docker-compose logs -f --tail=$LINES
else
    echo "Showing logs for $SERVICE (last $LINES lines)..."
    docker-compose logs -f --tail=$LINES $SERVICE
fi
