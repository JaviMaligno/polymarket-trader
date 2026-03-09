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
account_consistency=$(query_one "
  SELECT row_to_json(t) FROM (
    SELECT
      a.current_capital::float AS capital,
      a.initial_capital::float AS initial,
      a.total_realized_pnl::float AS realized_pnl,
      a.total_fees_paid::float AS total_fees,
      (a.current_capital - (a.initial_capital + a.total_realized_pnl - a.total_fees_paid))::float AS unexplained_diff
    FROM paper_account a
    LIMIT 1
  ) t;
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

# 18. Error logs from containers
get_container_errors() {
  local pattern="$1"
  local container_name
  container_name=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -i "$pattern" | head -1 || echo "")
  if [ -z "$container_name" ]; then
    echo "[]"
    return
  fi
  local logs
  logs=$(docker logs --since 24h "$container_name" 2>&1 | grep -i -E "(error|fatal|exception|crash|ECONNREFUSED|ENOMEM)" | tail -20 || echo "")
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
  --argjson price_freshness "$price_freshness" \
  --argjson signal_freshness "$signal_freshness" \
  --argjson optimization_runs "$optimization_runs" \
  --argjson signal_weights "$signal_weights" \
  --argjson consecutive_losses "$consecutive_losses" \
  --argjson containers "$containers" \
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
    price_freshness: $price_freshness,
    signal_freshness: $signal_freshness,
    optimization_runs: $optimization_runs,
    signal_weights: $signal_weights,
    consecutive_losses: $consecutive_losses,
    containers: $containers,
    error_logs: $error_logs
  }'
