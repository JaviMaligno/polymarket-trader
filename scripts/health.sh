#!/bin/bash

# ============================================
# Health Check for Polymarket Trader
# ============================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "Checking Polymarket Trader health..."
echo ""

# Check Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}[FAIL]${NC} Docker is not installed"
    exit 1
fi
echo -e "${GREEN}[OK]${NC} Docker is installed"

# Check Docker Compose
if ! command -v docker-compose &> /dev/null; then
    echo -e "${RED}[FAIL]${NC} Docker Compose is not installed"
    exit 1
fi
echo -e "${GREEN}[OK]${NC} Docker Compose is installed"

# Check containers
echo ""
echo "Container Status:"
docker-compose ps

echo ""
echo "Health Checks:"

# Function to check container health
check_container() {
    local name=$1
    local container_id=$(docker-compose ps -q $name 2>/dev/null)

    if [ -z "$container_id" ]; then
        echo -e "${RED}[DOWN]${NC} $name - container not running"
        return 1
    fi

    local health=$(docker inspect --format='{{.State.Health.Status}}' $container_id 2>/dev/null || echo "no-healthcheck")

    if [ "$health" = "healthy" ]; then
        echo -e "${GREEN}[HEALTHY]${NC} $name"
        return 0
    elif [ "$health" = "no-healthcheck" ]; then
        local running=$(docker inspect --format='{{.State.Running}}' $container_id 2>/dev/null)
        if [ "$running" = "true" ]; then
            echo -e "${YELLOW}[RUNNING]${NC} $name (no healthcheck)"
            return 0
        else
            echo -e "${RED}[STOPPED]${NC} $name"
            return 1
        fi
    else
        echo -e "${YELLOW}[$health]${NC} $name"
        return 1
    fi
}

check_container "timescaledb"
check_container "dashboard-api"
check_container "dashboard-frontend"
check_container "redis"

echo ""

# Check API endpoint
API_PORT=${API_PORT:-3001}
if curl -s -o /dev/null -w "%{http_code}" http://localhost:$API_PORT/health | grep -q "200"; then
    echo -e "${GREEN}[OK]${NC} API is responding at http://localhost:$API_PORT"
else
    echo -e "${RED}[FAIL]${NC} API is not responding at http://localhost:$API_PORT"
fi

# Check Frontend
FRONTEND_PORT=${FRONTEND_PORT:-80}
if curl -s -o /dev/null -w "%{http_code}" http://localhost:$FRONTEND_PORT/health | grep -q "200"; then
    echo -e "${GREEN}[OK]${NC} Frontend is responding at http://localhost:$FRONTEND_PORT"
else
    echo -e "${YELLOW}[WARN]${NC} Frontend health check failed (may still be accessible)"
fi

echo ""
echo "Health check complete!"
