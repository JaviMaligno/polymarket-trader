#!/usr/bin/env bash
# daily-review.sh — Gathers trading data from the GCP VM and outputs JSON to stdout.
# Designed to run ON the VM via: bash /opt/polymarket-trader/scripts/daily-review.sh
# All diagnostic/error output goes to stderr; only valid JSON goes to stdout.
#
# Dependencies: docker, jq (both available on the GCP VM)

set -euo pipefail

# ── early checks ─────────────────────────────────────────────────────────────

if ! command -v docker &>/dev/null; then
  echo '{"error":"docker not found"}' >&2
  exit 1
fi

if ! docker exec polymarket-timescaledb pg_isready -U polymarket -d polymarket_trading &>/dev/null; then
  echo '{"error":"database not reachable"}' >&2
  exit 1
fi

PSQL="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -t -A"

# ── helpers ──────────────────────────────────────────────────────────────────

# query_json: execute SQL that returns a JSON array via json_agg.
# Returns [] when the result is empty or null.
query_json() {
  local sql="$1"
  local result
  result=$($PSQL -c "$sql" 2>&2 || echo "")
  if [ -z "$result" ] || [ "$result" = "" ] || [ "$result" = "null" ]; then
    echo "[]"
  else
    echo "$result"
  fi
}

# query_one: execute SQL that returns a single JSON object via row_to_json.
# Returns null when the result is empty.
query_one() {
  local sql="$1"
  local result
  result=$($PSQL -c "$sql" 2>&2 || echo "")
  if [ -z "$result" ] || [ "$result" = "" ] || [ "$result" = "null" ]; then
    echo "null"
  else
    echo "$result"
  fi
}

# ── data gathering ───────────────────────────────────────────────────────────

# 1. Account
account=$(query_one "
  SELECT row_to_json(t) FROM (
    SELECT
      current_capital::float,
      initial_capital::float,
      available_capital::float,
      total_realized_pnl::float,
      total_unrealized_pnl::float,
      total_fees_paid::float,
      max_drawdown::float,
      peak_equity::float,
      total_trades::float,
      winning_trades::float,
      losing_trades::float,
      updated_at
    FROM paper_account
    LIMIT 1
  ) t;
")

# 2. Trades in last 24h
trades_24h=$(query_json "
  SELECT COALESCE(json_agg(t), '[]'::json) FROM (
    SELECT
      time,
      side,
      executed_size::float,
      executed_price::float,
      value_usd::float,
      fee::float,
      signal_type,
      fill_type,
      market_id
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
    ORDER BY time DESC
  ) t;
")

# 3. Trades summary (24h aggregates)
trades_summary=$(query_one "
  SELECT row_to_json(t) FROM (
    SELECT
      COUNT(*)::float AS total_trades,
      COALESCE(SUM(value_usd), 0)::float AS total_value,
      COALESCE(SUM(fee), 0)::float AS total_fees
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
  ) t;
")

# 4. Signal distribution (24h trades grouped by signal_type)
signal_distribution=$(query_json "
  SELECT COALESCE(json_agg(t), '[]'::json) FROM (
    SELECT
      COALESCE(signal_type, 'unknown') AS signal_type,
      COUNT(*)::float AS trade_count,
      COALESCE(SUM(value_usd), 0)::float AS total_value
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
    GROUP BY signal_type
    ORDER BY trade_count DESC
  ) t;
")

# 5. Hourly trades (24h grouped by hour)
hourly_trades=$(query_json "
  SELECT COALESCE(json_agg(t), '[]'::json) FROM (
    SELECT
      date_trunc('hour', time) AS hour,
      COUNT(*)::float AS trade_count,
      COALESCE(SUM(value_usd), 0)::float AS total_value
    FROM paper_trades
    WHERE time > NOW() - INTERVAL '24 hours'
    GROUP BY date_trunc('hour', time)
    ORDER BY hour DESC
  ) t;
")

# 6. Open positions (size > 0, closed_at IS NULL)
open_positions=$(query_json "
  SELECT COALESCE(json_agg(t), '[]'::json) FROM (
    SELECT
      market_id,
      token_id,
      side,
      size::float,
      avg_entry_price::float,
      current_price::float,
      unrealized_pnl::float,
      unrealized_pnl_pct::float,
      realized_pnl::float,
      opened_at,
      updated_at,
      signal_type
    FROM paper_positions
    WHERE size > 0 AND closed_at IS NULL
    ORDER BY unrealized_pnl ASC
  ) t;
")

# 7. Worst positions (top 10 worst open positions with market question)
worst_positions=$(query_json "
  SELECT COALESCE(json_agg(t), '[]'::json) FROM (
    SELECT
      p.market_id,
      m.question,
      p.side,
      p.size::float,
      p.avg_entry_price::float,
      p.current_price::float,
      p.unrealized_pnl::float,
      p.unrealized_pnl_pct::float,
      p.opened_at
    FROM paper_positions p
    LEFT JOIN markets m ON m.id = p.market_id
    WHERE p.size > 0 AND p.closed_at IS NULL
    ORDER BY p.unrealized_pnl ASC
    LIMIT 10
  ) t;
")

# 8. Recently closed positions (last 24h)
recently_closed=$(query_json "
  SELECT COALESCE(json_agg(t), '[]'::json) FROM (
    SELECT
      p.market_id,
      m.question,
      p.side,
      p.avg_entry_price::float,
      p.realized_pnl::float,
      p.opened_at,
      p.closed_at
    FROM paper_positions p
    LEFT JOIN markets m ON m.id = p.market_id
    WHERE p.closed_at > NOW() - INTERVAL '24 hours'
    ORDER BY p.closed_at DESC
  ) t;
")

# 9. Zombie positions (size=0, closed_at IS NULL)
zombie_positions=$(query_one "
  SELECT row_to_json(t) FROM (
    SELECT COUNT(*)::float AS count
    FROM paper_positions
    WHERE size = 0 AND closed_at IS NULL
  ) t;
")

# 10. Orphaned buys (buy trades without corresponding position)
orphaned_buys=$(query_one "
  SELECT row_to_json(t) FROM (
    SELECT
      COUNT(*)::float AS count,
      COALESCE(SUM(tr.value_usd), 0)::float AS total_value
    FROM paper_trades tr
    LEFT JOIN paper_positions p ON tr.market_id = p.market_id AND tr.token_id = p.token_id
    WHERE tr.side = 'buy' AND p.market_id IS NULL
  ) t;
")

# 11. Account consistency check
# Formula: current_capital + open_positions_cost = initial_capital + realized_pnl - fees
# (capital is reduced when positions are opened; we must add position costs back to balance)
account_consistency=$(query_one "
  SELECT row_to_json(t) FROM (
    SELECT
      a.current_capital::float AS capital,
      a.initial_capital::float AS initial,
      a.total_realized_pnl::float AS realized_pnl,
      a.total_fees_paid::float AS total_fees,
      COALESCE(pos.open_cost, 0)::float AS open_positions_cost,
      (a.current_capital + COALESCE(pos.open_cost, 0) - (a.initial_capital + a.total_realized_pnl - a.total_fees_paid))::float AS unexplained_diff
    FROM paper_account a
    LEFT JOIN (
      SELECT SUM(size * avg_entry_price) AS open_cost
      FROM paper_positions
      WHERE closed_at IS NULL
    ) pos ON true
    LIMIT 1
  ) t;
")

# 11b. Generalized invariant checks (PASS/FAIL)
invariant_checks=$(query_one "
  SELECT row_to_json(t) FROM (
    SELECT
      -- Cash flow crosscheck: account PnL vs actual trade flows
      ABS(a.total_realized_pnl - COALESCE(flows.net_cash_plus_fees, 0)) < 1.0 AS pnl_matches_cashflows,
      a.total_realized_pnl::float AS account_pnl,
      COALESCE(flows.net_cash_plus_fees, 0)::float AS cashflow_pnl,
      ABS(a.total_realized_pnl - COALESCE(flows.net_cash_plus_fees, 0))::float AS pnl_gap,
      -- Available capital vs locked
      ABS(a.available_capital - (a.current_capital - COALESCE(pos.open_cost, 0))) < 1.0 AS capital_lock_correct,
      a.available_capital::float AS available,
      a.current_capital::float AS current,
      COALESCE(pos.open_cost, 0)::float AS open_cost,
      -- Fee tracking
      ABS(a.total_fees_paid - COALESCE(fees.actual_fees, 0)) < 1.0 AS fees_match,
      a.total_fees_paid::float AS account_fees,
      COALESCE(fees.actual_fees, 0)::float AS trade_fees
    FROM paper_account a
    LEFT JOIN (
      SELECT SUM(CASE WHEN side = 'sell' THEN amount ELSE -amount END) + SUM(fee) AS net_cash_plus_fees
      FROM paper_trades
    ) flows ON true
    LEFT JOIN (
      SELECT SUM(size * avg_entry_price) AS open_cost
      FROM paper_positions WHERE closed_at IS NULL
    ) pos ON true
    LEFT JOIN (
      SELECT SUM(fee) AS actual_fees FROM paper_trades
    ) fees ON true
    LIMIT 1
  ) t
")

# 12. Price freshness
price_freshness=$(query_one "
  SELECT row_to_json(t) FROM (
    SELECT
      MAX(time) AS latest_price,
      COUNT(DISTINCT market_id)::float AS markets_with_data_1h,
      COUNT(*)::float AS record_count_1h
    FROM price_history
    WHERE time > NOW() - INTERVAL '1 hour'
  ) t;
")

# 13. Signal freshness (using signal_predictions table)
signal_freshness=$(query_one "
  SELECT row_to_json(t) FROM (
    SELECT
      MAX(time) AS latest_signal,
      COUNT(*)::float AS count_last_hour
    FROM signal_predictions
    WHERE time > NOW() - INTERVAL '1 hour'
  ) t;
")

# 14. Optimization runs (last 3)
optimization_runs=$(query_json "
  SELECT COALESCE(json_agg(t), '[]'::json) FROM (
    SELECT
      id,
      name,
      status,
      best_score::float,
      iterations_completed::float,
      created_at,
      completed_at,
      duration_seconds::float
    FROM optimization_runs
    ORDER BY created_at DESC
    LIMIT 3
  ) t;
")

# 15. Signal weights
signal_weights=$(query_json "
  SELECT COALESCE(json_agg(t), '[]'::json) FROM (
    SELECT
      signal_type,
      weight::float,
      is_enabled,
      min_confidence::float,
      updated_at
    FROM signal_weights
    ORDER BY signal_type
  ) t;
")

# 16. Consecutive losses (from recently closed positions with negative PnL)
consecutive_losses=$(query_one "
  SELECT row_to_json(t) FROM (
    WITH recent AS (
      SELECT
        realized_pnl,
        closed_at,
        CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END AS is_loss,
        ROW_NUMBER() OVER (ORDER BY closed_at DESC) AS rn
      FROM paper_positions
      WHERE closed_at IS NOT NULL
      ORDER BY closed_at DESC
      LIMIT 50
    ),
    groups AS (
      SELECT
        is_loss,
        rn,
        rn - ROW_NUMBER() OVER (PARTITION BY is_loss ORDER BY rn) AS grp
      FROM recent
    ),
    streaks AS (
      SELECT
        is_loss,
        COUNT(*) AS streak_len
      FROM groups
      WHERE is_loss = 1
      GROUP BY is_loss, grp
    )
    SELECT COALESCE(MAX(streak_len), 0)::float AS max_consecutive_losses
    FROM streaks
  ) t;
")

# 17. Docker container status
containers="[]"
if command -v docker &>/dev/null; then
  raw_containers=$(docker ps --format '{"name":"{{.Names}}","status":"{{.Status}}","image":"{{.Image}}","ports":"{{.Ports}}"}' 2>/dev/null || echo "")
  if [ -n "$raw_containers" ]; then
    # Convert newline-separated JSON objects into a JSON array
    containers=$(echo "$raw_containers" | jq -s '.' 2>/dev/null || echo "[]")
  fi
fi

# 18. Resource usage (CPU%, MEM usage/limit per container)
resource_usage="[]"
if command -v docker &>/dev/null; then
  raw_stats=$(docker stats --no-stream --format '{"name":"{{.Name}}","cpu_pct":"{{.CPUPerc}}","mem_usage":"{{.MemUsage}}","mem_pct":"{{.MemPerc}}","net_io":"{{.NetIO}}","pids":"{{.PIDs}}"}' 2>/dev/null || echo "")
  if [ -n "$raw_stats" ]; then
    resource_usage=$(echo "$raw_stats" | jq -s '.' 2>/dev/null || echo "[]")
  fi
fi

# 18b. CPU/Memory alerts (parsed from resource_usage)
cpu_alerts="[]"
if [ "$resource_usage" != "[]" ]; then
  cpu_alerts=$(echo "$resource_usage" | jq '[
    .[] |
    {
      name: .name,
      cpu: (.cpu_pct | gsub("%"; "") | tonumber),
      mem_pct: (.mem_pct | gsub("%"; "") | tonumber)
    } |
    if .cpu > 90 then {level: "critical", name: .name, message: "\(.name) CPU at \(.cpu)% (>90%)"}
    elif .cpu > 70 then {level: "warning", name: .name, message: "\(.name) CPU at \(.cpu)% (>70%)"}
    else empty end
  ] + [
    .[] |
    {
      name: .name,
      mem_pct: (.mem_pct | gsub("%"; "") | tonumber)
    } |
    if .mem_pct > 85 then {level: "warning", name: .name, message: "\(.name) memory at \(.mem_pct)% (>85%)"}
    else empty end
  ]' 2>/dev/null || echo "[]")
fi

# 18c. Container restart counts and OOM events
container_health="{}"
if command -v docker &>/dev/null; then
  restart_json="[]"
  for cid in $(docker ps -q 2>/dev/null); do
    cinfo=$(docker inspect --format='{"name":"{{.Name}}","restart_count":{{.RestartCount}},"started_at":"{{.State.StartedAt}}"}' "$cid" 2>/dev/null || echo "")
    if [ -n "$cinfo" ]; then
      restart_json=$(echo "$restart_json" | jq --argjson item "$cinfo" '. + [$item]' 2>/dev/null || echo "$restart_json")
    fi
  done

  oom_events=$(dmesg 2>/dev/null | grep -ci 'oom\|killed process' || echo "0")

  container_health=$(jq -n \
    --argjson restarts "$restart_json" \
    --argjson oom_count "$oom_events" \
    '{"restarts": $restarts, "oom_kills_in_dmesg": $oom_count}' 2>/dev/null || echo '{"restarts":[],"oom_kills_in_dmesg":0}')
fi

# 18d. Database security (auth failure count from TimescaleDB logs)
db_security="{}"
if command -v docker &>/dev/null; then
  fatal_count=$(docker logs polymarket-timescaledb --since 24h 2>&1 | grep -c "FATAL" 2>/dev/null || echo "0")
  db_security=$(jq -n --argjson fatal_count "$fatal_count" '{"fatal_auth_failures_24h": $fatal_count}' 2>/dev/null || echo '{"fatal_auth_failures_24h":0}')
fi

# 18e. Disk usage
disk_usage="{}"
disk_pct=$(df / --output=pcent 2>/dev/null | tail -1 | tr -d ' %' || echo "0")
docker_size=$(du -sm /var/lib/docker/ 2>/dev/null | cut -f1 || echo "0")
disk_usage=$(jq -n --argjson pct "$disk_pct" --argjson docker_mb "$docker_size" \
  '{"root_usage_pct": $pct, "docker_size_mb": $docker_mb}' 2>/dev/null || echo '{"root_usage_pct":0,"docker_size_mb":0}')

# 19. Error logs from containers
get_container_errors() {
  local pattern="$1"
  local container_name
  container_name=$(docker ps --format '{{.Names}}' 2>/dev/null | { grep -i "$pattern" || true; } | head -1)
  if [ -z "$container_name" ]; then
    echo "[]"
    return
  fi
  local logs
  logs=$(docker logs --since 24h "$container_name" 2>&1 | { grep -i -E "(error|fatal|exception|crash|ECONNREFUSED|ENOMEM)" || true; } | tail -20)
  if [ -z "$logs" ]; then
    echo "[]"
    return
  fi
  # Convert each line to a JSON string, then wrap in array
  echo "$logs" | jq -R -s 'split("\n") | map(select(length > 0))' 2>/dev/null || echo "[]"
}

dashboard_errors=$(get_container_errors "dashboard")
collector_errors=$(get_container_errors "data-collector")

error_logs=$(jq -n \
  --argjson dashboard "$dashboard_errors" \
  --argjson collector "$collector_errors" \
  '{"dashboard_api": $dashboard, "data_collector": $collector}' 2>/dev/null || echo '{"dashboard_api":[],"data_collector":[]}')

# ── assemble final JSON ─────────────────────────────────────────────────────

jq -n \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson account "$account" \
  --argjson trades_24h "$trades_24h" \
  --argjson trades_summary "$trades_summary" \
  --argjson signal_distribution "$signal_distribution" \
  --argjson hourly_trades "$hourly_trades" \
  --argjson open_positions "$open_positions" \
  --argjson worst_positions "$worst_positions" \
  --argjson recently_closed "$recently_closed" \
  --argjson zombie_positions "$zombie_positions" \
  --argjson orphaned_buys "$orphaned_buys" \
  --argjson account_consistency "$account_consistency" \
  --argjson invariant_checks "$invariant_checks" \
  --argjson price_freshness "$price_freshness" \
  --argjson signal_freshness "$signal_freshness" \
  --argjson optimization_runs "$optimization_runs" \
  --argjson signal_weights "$signal_weights" \
  --argjson consecutive_losses "$consecutive_losses" \
  --argjson containers "$containers" \
  --argjson resource_usage "$resource_usage" \
  --argjson cpu_alerts "$cpu_alerts" \
  --argjson container_health "$container_health" \
  --argjson db_security "$db_security" \
  --argjson disk_usage "$disk_usage" \
  --argjson error_logs "$error_logs" \
  '{
    generated_at: $ts,
    account: $account,
    trades_24h: $trades_24h,
    trades_summary: $trades_summary,
    signal_distribution: $signal_distribution,
    hourly_trades: $hourly_trades,
    open_positions: $open_positions,
    worst_positions: $worst_positions,
    recently_closed: $recently_closed,
    zombie_positions: $zombie_positions,
    orphaned_buys: $orphaned_buys,
    account_consistency: $account_consistency,
    invariant_checks: $invariant_checks,
    price_freshness: $price_freshness,
    signal_freshness: $signal_freshness,
    optimization_runs: $optimization_runs,
    signal_weights: $signal_weights,
    consecutive_losses: $consecutive_losses,
    containers: $containers,
    resource_usage: $resource_usage,
    cpu_alerts: $cpu_alerts,
    container_health: $container_health,
    db_security: $db_security,
    disk_usage: $disk_usage,
    error_logs: $error_logs
  }'
