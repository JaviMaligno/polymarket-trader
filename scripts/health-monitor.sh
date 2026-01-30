#!/bin/bash
# Health monitoring script for polymarket-trader on GCP VM
# Checks services and sends email alert if any are down
# Runs via cron every 5 minutes

ALERT_EMAIL="javiturco33@gmail.com"
LOG_FILE="/var/log/polymarket-health.log"
STATE_FILE="/tmp/polymarket-health-state"
COMPOSE_FILE="/opt/polymarket-trader/docker-compose.gcp.yml"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

send_alert() {
  local subject="$1"
  local body="$2"
  echo "$body" | mail -s "$subject" "$ALERT_EMAIL" 2>> "$LOG_FILE"
  log "Alert sent: $subject"
}

# Track which services are down
FAILURES=""
DETAILS=""

# Check TimescaleDB
if ! docker exec polymarket-timescaledb pg_isready -U polymarket -d polymarket_trading > /dev/null 2>&1; then
  FAILURES="$FAILURES timescaledb"
  DETAILS="$DETAILS\n- TimescaleDB: NOT RESPONDING"
else
  DETAILS="$DETAILS\n- TimescaleDB: OK"
fi

# Check Data Collector
DC_HEALTH=$(curl -sf http://localhost:10000/health 2>/dev/null)
if [ $? -ne 0 ]; then
  FAILURES="$FAILURES data-collector"
  DETAILS="$DETAILS\n- Data Collector: NOT RESPONDING"
else
  DETAILS="$DETAILS\n- Data Collector: OK"
fi

# Check Optimizer
OPT_HEALTH=$(curl -sf http://localhost:8000/health 2>/dev/null)
if [ $? -ne 0 ]; then
  FAILURES="$FAILURES optimizer"
  DETAILS="$DETAILS\n- Optimizer: NOT RESPONDING"
else
  DETAILS="$DETAILS\n- Optimizer: OK"
fi

# Get memory info
MEM_INFO=$(free -h | grep Mem | awk '{print "RAM: " $3 "/" $2 " used"}')
SWAP_INFO=$(free -h | grep Swap | awk '{print "Swap: " $3 "/" $2 " used"}')
DISK_INFO=$(df -h / | tail -1 | awk '{print "Disk: " $3 "/" $2 " (" $5 " used)"}')

if [ -n "$FAILURES" ]; then
  # Something is down
  PREV_STATE=$(cat "$STATE_FILE" 2>/dev/null)

  if [ "$PREV_STATE" != "FAILING:$FAILURES" ]; then
    # New failure or different failure - send alert
    BODY="ALERT: Service(s) down on polymarket-vm

Services:
$(echo -e "$DETAILS")

Resources:
$MEM_INFO
$SWAP_INFO
$DISK_INFO

Docker status:
$(docker compose -f $COMPOSE_FILE ps 2>/dev/null)

Attempting auto-restart...
$(docker compose -f $COMPOSE_FILE restart $FAILURES 2>&1)

Time: $(date)"

    send_alert "[POLYMARKET] Services DOWN: $FAILURES" "$BODY"
    echo "FAILING:$FAILURES" > "$STATE_FILE"
  fi

  log "UNHEALTHY: $FAILURES"

  # Try to restart failed services
  for service in $FAILURES; do
    log "Restarting $service..."
    docker compose -f "$COMPOSE_FILE" restart "$service" >> "$LOG_FILE" 2>&1
  done
else
  # All healthy
  PREV_STATE=$(cat "$STATE_FILE" 2>/dev/null)

  if [ -n "$PREV_STATE" ] && [ "$PREV_STATE" != "OK" ]; then
    # Was failing, now recovered - send recovery alert
    BODY="RECOVERED: All services are back online

Services:
$(echo -e "$DETAILS")

Resources:
$MEM_INFO
$SWAP_INFO
$DISK_INFO

Time: $(date)"

    send_alert "[POLYMARKET] Services RECOVERED" "$BODY"
  fi

  echo "OK" > "$STATE_FILE"
fi
