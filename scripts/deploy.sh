#!/bin/bash
set -e

# ============================================
# Polymarket Trader Deployment Script
# ============================================

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if .env exists
if [ ! -f .env ]; then
    log_warn ".env file not found. Copying from .env.example..."
    cp .env.example .env
    log_warn "Please edit .env with your configuration before continuing."
    exit 1
fi

# Parse arguments
ENVIRONMENT=${1:-production}

log_info "Deploying Polymarket Trader in ${ENVIRONMENT} mode..."

# Build and start services
if [ "$ENVIRONMENT" = "production" ]; then
    log_info "Building production images..."
    docker-compose -f docker-compose.yml -f docker-compose.prod.yml build --no-cache

    log_info "Starting production services..."
    docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d

elif [ "$ENVIRONMENT" = "development" ]; then
    log_info "Building development images..."
    docker-compose -f docker-compose.yml -f docker-compose.dev.yml build

    log_info "Starting development services..."
    docker-compose -f docker-compose.yml -f docker-compose.dev.yml up -d

else
    log_info "Building standard images..."
    docker-compose build

    log_info "Starting services..."
    docker-compose up -d
fi

# Wait for services to be healthy
log_info "Waiting for services to be ready..."
sleep 10

# Check service health
log_info "Checking service health..."

check_service() {
    local service=$1
    local status=$(docker-compose ps -q $service | xargs docker inspect --format='{{.State.Health.Status}}' 2>/dev/null || echo "unknown")

    if [ "$status" = "healthy" ]; then
        log_info "$service is healthy"
        return 0
    else
        log_warn "$service status: $status"
        return 1
    fi
}

check_service "timescaledb"
check_service "dashboard-api"
check_service "redis"

log_info "Deployment complete!"
log_info ""
log_info "Services:"
log_info "  - Dashboard Frontend: http://localhost:${FRONTEND_PORT:-80}"
log_info "  - Dashboard API: http://localhost:${API_PORT:-3001}"
log_info "  - Database: localhost:${DB_PORT:-5432}"
log_info ""
log_info "Useful commands:"
log_info "  - View logs: docker-compose logs -f"
log_info "  - Stop services: docker-compose down"
log_info "  - Restart: docker-compose restart"
