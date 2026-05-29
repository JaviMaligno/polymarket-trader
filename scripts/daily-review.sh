#!/usr/bin/env bash
# daily-review.sh — Gathers trading data from the GCP VM and outputs JSON to stdout.
# Designed to run ON the VM via: bash /opt/polymarket-trader/scripts/daily-review.sh
# All diagnostic/error output goes to stderr; only valid JSON goes to stdout.
#
# Dependencies: docker, jq (both available on the GCP VM)

set -euo pipefail

# If the script exits non-zero (set -e or explicit exit 1), emit a minimal
# fallback JSON to stdout so the workflow's jq validation always passes and
# Claude can create a GitHub issue documenting the infra failure.
trap '_rc=$?; [[ $_rc -ne 0 ]] && printf "{\"gather_failed\":true,\"exit_code\":%d,\"generated_at\":\"%s\"}\n" "$_rc" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"' EXIT

# ── early checks ─────────────────────────────────────────────────────────────

if ! command -v docker &>/dev/null; then
  echo "docker not found" >&2
  exit 1
fi

if ! docker exec polymarket-timescaledb pg_isready -U polymarket -d polymarket_trading &>/dev/null; then
  echo "database not reachable" >&2
  exit 1
fi

PSQL="docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading -t -A"
HISTORY_FILE="/home/Usuario/polymarket-trader/review-history.json"

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
      p.signal_type,
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

# 10. Orphaned buys (buy trades without corresponding position, scoped to post-reset)
# Pre-reset buy trades have no surviving position rows (positions deleted during reset),
# so the unscoped query would inflate the count with historical noise. Filtering to
# trades after last_reset_at catches the only actionable case: a buy executed in the
# current epoch that never created a position record.
orphaned_buys=$(query_one "
  SELECT row_to_json(t) FROM (
    SELECT
      COUNT(*)::float AS count,
      COALESCE(SUM(tr.value_usd), 0)::float AS total_value
    FROM paper_trades tr
    LEFT JOIN paper_positions p ON tr.market_id = p.market_id AND tr.token_id = p.token_id
    WHERE tr.side = 'buy'
      AND p.market_id IS NULL
      AND tr.time > (SELECT last_reset_at FROM paper_account)
  ) t;
")

# 11. Generalized invariant checks (PASS/FAIL)
#
# NOTE: a prior `account_consistency` check (an `unexplained_diff` formula:
# current_capital + open_cost - (initial + realized_pnl - total_fees_paid)) was
# removed here. It used an inconsistent fee convention: `realized_pnl` is stored
# net of the EXIT fee only (PositionClosingService computes netPnl = grossPnl -
# exit_fee), while `total_fees_paid` accumulates BOTH entry and exit fees. The
# formula therefore double-subtracted the exit fee and reported a spurious
# positive `unexplained_diff == +SUM(exit_fee)` (~half of total_fees_paid) that
# grew with trade volume but represented no real capital loss. The
# `capital_matches_cashflows` check below reconstructs net cash leg-by-leg from
# paper_trades and is convention-independent — it fully supersedes that check.
# Uses last_reset_at from paper_account as the epoch so that pre-reset trades
# (e.g. from the 2026-03-30 No-token corruption incident) are excluded from the
# cashflow and fee cross-checks, preventing false-positive CRITICAL alerts.
invariant_checks=$(query_one "
  WITH reset_epoch AS (
    SELECT COALESCE(
      (SELECT last_reset_at FROM paper_account LIMIT 1),
      '2026-03-30T17:30:00Z'::timestamptz
    ) AS ts
  )
  SELECT row_to_json(t) FROM (
    SELECT
      -- Cash flow crosscheck: net cash from trades should equal capital change
      -- Buy: capital -= (value_usd + fee). Sell: capital += (value_usd - fee).
      ABS((a.current_capital - a.initial_capital) - COALESCE(flows.net_cash_flow, 0)) < 1.0 AS capital_matches_cashflows,
      (a.current_capital - a.initial_capital)::float AS capital_change,
      COALESCE(flows.net_cash_flow, 0)::float AS net_cash_flow,
      ABS((a.current_capital - a.initial_capital) - COALESCE(flows.net_cash_flow, 0))::float AS cashflow_gap,
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
      SELECT SUM(CASE WHEN side = 'sell' THEN value_usd - fee ELSE -(value_usd + fee) END) AS net_cash_flow
      FROM paper_trades
      WHERE time >= (SELECT ts FROM reset_epoch)
    ) flows ON true
    LEFT JOIN (
      SELECT SUM(size * avg_entry_price) AS open_cost
      FROM paper_positions WHERE closed_at IS NULL
    ) pos ON true
    LEFT JOIN (
      SELECT SUM(fee) AS actual_fees FROM paper_trades
      WHERE time >= (SELECT ts FROM reset_epoch)
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

# Phase 5 Pilar 4-A (2026-05-15): health-of-edge metrics.
# Surface the gap between "cohorts we trade" and "cohorts where measurement
# says we have positive cost-aware edge". When the gap > 0, we're burning
# capital in cohorts the data says are anti-edge. Daily-review prompt should
# treat a non-empty edge_gap as CRITICAL.

# 15a. Cohorts with positive cost-aware edge (latest measurement per cell, t_net > 0)
edge_cohorts_positive=$(query_json "
  SELECT COALESCE(json_agg(t), '[]'::json) FROM (
    WITH latest AS (
      SELECT DISTINCT ON (signal_id, market_type, direction)
        signal_id, market_type, direction, t_net, n, rt_cost_pct, measured_at
      FROM generator_edge
      ORDER BY signal_id, market_type, direction, measured_at DESC
    )
    SELECT
      signal_id, market_type, direction,
      ROUND(t_net::numeric, 2)::float AS t_net,
      n::float AS n,
      ROUND(rt_cost_pct::numeric, 3)::float AS rt_cost_pct,
      measured_at
    FROM latest
    WHERE t_net > 0
    ORDER BY t_net DESC
    LIMIT 30
  ) t
")

# 15b. Cohorts traded in last 7 days (type, side, count, pnl)
edge_cohorts_traded=$(query_json "
  SELECT COALESCE(json_agg(t), '[]'::json) FROM (
    SELECT
      m.market_type,
      p.side AS direction,
      COUNT(*)::float AS n_trades,
      ROUND(COALESCE(SUM(p.realized_pnl), 0)::numeric, 2)::float AS total_pnl,
      COUNT(*) FILTER (WHERE p.realized_pnl > 0)::float AS wins
    FROM paper_positions p
    JOIN markets m ON m.id = p.market_id
    WHERE p.opened_at >= NOW() - INTERVAL '7 days'
      AND p.realized_pnl IS NOT NULL
    GROUP BY 1, 2
    ORDER BY 3 DESC
  ) t
")

# 15c. Edge gap — (type, direction) traded but NO signal has positive edge.
# When this returns rows, we are burning capital on cohorts that have been
# measured as anti-edge net. CRITICAL signal for the daily-review.
edge_gap=$(query_json "
  SELECT COALESCE(json_agg(t), '[]'::json) FROM (
    WITH latest_positive AS (
      SELECT DISTINCT market_type, direction
      FROM (
        SELECT DISTINCT ON (signal_id, market_type, direction)
          signal_id, market_type, direction, t_net
        FROM generator_edge
        ORDER BY signal_id, market_type, direction, measured_at DESC
      ) le
      WHERE t_net > 0
    ),
    traded AS (
      SELECT m.market_type, p.side AS direction,
             COUNT(*) AS n_trades,
             ROUND(SUM(p.realized_pnl)::numeric, 2) AS total_pnl
      FROM paper_positions p
      JOIN markets m ON m.id = p.market_id
      WHERE p.opened_at >= NOW() - INTERVAL '7 days'
        AND p.realized_pnl IS NOT NULL
      GROUP BY 1, 2
    )
    SELECT
      t.market_type, t.direction,
      t.n_trades::float AS n_trades,
      t.total_pnl::float AS total_pnl
    FROM traded t
    LEFT JOIN latest_positive lp
      ON lp.market_type = t.market_type AND lp.direction = t.direction
    WHERE lp.market_type IS NULL
    ORDER BY 3 DESC
  ) t
")

# 15c2. Today's open distribution by (type, side) — distinct from rolling 7d
# in 15b. Surfaces the bleed cohort BEFORE it accumulates into the 7d window.
# Use this to distinguish "X opens today" from "X in rolling 7d", a framing
# trap surfaced 2026-05-26 (#266 misread event_financial:long).
opens_today=$(query_json "
  SELECT COALESCE(json_agg(t), '[]'::json) FROM (
    SELECT
      m.market_type,
      p.side AS direction,
      COUNT(*)::float AS n_opens_today,
      ROUND(AVG(p.avg_entry_price)::numeric, 3)::float AS avg_entry,
      ROUND(COALESCE(SUM(p.realized_pnl), 0)::numeric, 2)::float AS pnl_so_far,
      COUNT(*) FILTER (WHERE p.realized_pnl > 0)::float AS wins,
      COUNT(*) FILTER (WHERE p.closed_at IS NOT NULL)::float AS closed
    FROM paper_positions p
    JOIN markets m ON m.id = p.market_id
    WHERE p.opened_at >= DATE_TRUNC('day', NOW())
    GROUP BY 1, 2
    ORDER BY n_opens_today DESC
  ) t
")

# 15c3. Market coverage by type — tracked vs priced vs producing predictions.
# Surfaces SignalEngine feed bugs (a type can be tracked + priced but produce
# zero predictions if the feed slice excludes it — the bug that caused
# event_short edge stale 201h alarm on 2026-05-26 #266).
coverage_by_type=$(query_json "
  SELECT COALESCE(json_agg(t), '[]'::json) FROM (
    SELECT
      m.market_type,
      COUNT(DISTINCT m.id) FILTER (WHERE m.tracking_status='active')::float AS tracked,
      COUNT(DISTINCT m.id) FILTER (WHERE m.tracking_status='active' AND EXISTS (
        SELECT 1 FROM price_history ph
        WHERE ph.token_id = m.clob_token_id_yes
          AND ph.time > NOW() - INTERVAL '24 hours'
      ))::float AS priced_24h,
      COUNT(DISTINCT g.market_id) FILTER (WHERE g.time > NOW() - INTERVAL '24 hours')::float AS with_preds_24h,
      COUNT(DISTINCT m.id) FILTER (WHERE m.is_active = true)::float AS active_in_db
    FROM markets m
    LEFT JOIN generator_predictions g ON g.market_id::text = m.id::text
    WHERE m.market_type IS NOT NULL
    GROUP BY 1
    ORDER BY 1
  ) t
")

# 15d. Measurement freshness — when was each market_type last measured?
# Stale (> 48h) means the nightly cron isn't running or is timing out for
# that type. The daily-review should alert when hours_since > 48.
edge_measurement_freshness=$(query_json "
  SELECT COALESCE(json_agg(t), '[]'::json) FROM (
    SELECT
      market_type,
      MAX(measured_at) AS latest_measurement,
      ROUND((EXTRACT(EPOCH FROM (NOW() - MAX(measured_at)))/3600)::numeric, 1)::float
        AS hours_since
    FROM generator_edge
    GROUP BY market_type
    ORDER BY hours_since DESC
  ) t
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

# 17b. ALLOWED_MARKET_TYPES from the running dashboard container — single source
# of truth for the supply-collapse coverage check (#280/#281), so format-review.js
# does not hardcode a list that can drift from the executor config. Falls back to
# the known live-tradeable set if the container or env var is unavailable.
allowed_market_types='["crypto_intraday","crypto_daily","event_financial","event_short"]'
if command -v docker &>/dev/null; then
  raw_allowed=$(docker exec polymarket-dashboard-api printenv ALLOWED_MARKET_TYPES 2>/dev/null | tr -d '\r' || echo "")
  if [ -n "$raw_allowed" ]; then
    parsed_allowed=$(echo "$raw_allowed" | jq -R 'split(",") | map(gsub("^\\s+|\\s+$";"")) | map(select(length > 0))' 2>/dev/null || echo "")
    [ -n "$parsed_allowed" ] && allowed_market_types="$parsed_allowed"
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
  restart_json=$(docker inspect --format='{"name":"{{.Name}}","restart_count":{{.RestartCount}},"started_at":"{{.State.StartedAt}}","oom_killed":{{.State.OOMKilled}}}' $(docker ps -q) 2>/dev/null | jq -s '.' 2>/dev/null || echo "[]")

  oom_events=$(docker inspect --format='{{.State.OOMKilled}}' $(docker ps -q) 2>/dev/null | grep -c "true" || true)
  oom_events=${oom_events:-0}

  container_health=$(jq -n \
    --argjson restarts "$restart_json" \
    --argjson oom_count "$oom_events" \
    '{"restarts": $restarts, "oom_kills_in_dmesg": $oom_count}' 2>/dev/null || echo '{"restarts":[],"oom_kills_in_dmesg":0}')
fi

# 18d. Database security (auth failure count from TimescaleDB logs)
db_security="{}"
if command -v docker &>/dev/null; then
  fatal_count=$(docker logs polymarket-timescaledb --since 24h 2>&1 | grep -c "FATAL" || true)
  fatal_count=${fatal_count:-0}
  auth_fail_count=$(docker logs polymarket-timescaledb --since 24h 2>&1 | grep -c "FATAL.*password authentication failed\|FATAL.*no pg_hba.conf entry" || true)
  auth_fail_count=${auth_fail_count:-0}
  db_security=$(jq -n --argjson fatal_count "$fatal_count" --argjson auth_failures "$auth_fail_count" \
    '{"fatal_log_lines_24h": $fatal_count, "auth_failures_24h": $auth_failures}' 2>/dev/null || echo '{"fatal_log_lines_24h":0,"auth_failures_24h":0}')
fi

# 18e. Disk usage
disk_usage="{}"
disk_pct=$(df / --output=pcent 2>/dev/null | tail -1 | tr -d ' %' || true)
disk_pct=${disk_pct:-0}
docker_size=$(sudo du -sm /var/lib/docker/ 2>/dev/null | cut -f1 || true)
docker_size=${docker_size:-0}
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

# 20. Real PnL check (separate real from phantom/inverted positions)
# Uses LAST_RESET_DATE from the prompt's Account Reset History section
real_pnl_check=$(query_one "
  SELECT row_to_json(t) FROM (
    SELECT
      COUNT(*)::float AS total_closed,
      COUNT(*) FILTER (WHERE ABS(avg_entry_price + current_price - 1.0) < 0.05
        AND EXTRACT(EPOCH FROM (closed_at - opened_at)) < 1800)::float AS inverted_count,
      ROUND(SUM(realized_pnl)::numeric, 2)::float AS reported_pnl,
      ROUND(SUM(realized_pnl) FILTER (WHERE ABS(avg_entry_price + current_price - 1.0) < 0.05
        AND EXTRACT(EPOCH FROM (closed_at - opened_at)) < 1800)::numeric, 2)::float AS phantom_pnl,
      ROUND(SUM(realized_pnl) FILTER (WHERE NOT (ABS(avg_entry_price + current_price - 1.0) < 0.05
        AND EXTRACT(EPOCH FROM (closed_at - opened_at)) < 1800))::numeric, 2)::float AS real_pnl
    FROM paper_positions
    WHERE closed_at >= '2026-03-31' AND realized_pnl IS NOT NULL
  ) t;
")

# ── per-type performance ────────────────────────────────────────────────────

category_performance=$(query_json "
  SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (
    SELECT market_type, win_rate, avg_pnl, sharpe_ratio, n_trades, prior,
           updated_at
    FROM category_performance
    ORDER BY n_trades DESC
  ) t;
")

trades_by_type=$(query_json "
  SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (
    SELECT COALESCE(m.market_type, 'unclassified') AS market_type,
           COUNT(*) AS trades_24h,
           ROUND(AVG(CASE WHEN p.realized_pnl > 0 THEN 1.0 ELSE 0.0 END)::numeric * 100, 1) AS win_pct,
           ROUND(SUM(p.realized_pnl)::numeric, 2) AS pnl_24h
    FROM paper_positions p
    JOIN markets m ON p.market_id = m.id
    WHERE p.closed_at >= NOW() - INTERVAL '24 hours'
      AND p.realized_pnl IS NOT NULL
    GROUP BY m.market_type
    ORDER BY pnl_24h DESC
  ) t;
")

shadow_summary=$(query_json "
  SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (
    SELECT market_type,
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) AS resolved,
           ROUND(AVG(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL)::numeric, 4) AS avg_pnl,
           ROUND(
             (COUNT(*) FILTER (WHERE resolved_at IS NOT NULL AND theoretical_pnl > 0)::numeric
               / NULLIF(COUNT(*) FILTER (WHERE resolved_at IS NOT NULL), 0))::numeric,
             3
           ) AS win_rate,
           ROUND(STDDEV(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL)::numeric, 4) AS pnl_stddev,
           ROUND(
             CASE WHEN STDDEV(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL) > 0
               THEN AVG(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL)
                    / STDDEV(theoretical_pnl) FILTER (WHERE resolved_at IS NOT NULL)
               ELSE 0 END::numeric,
             3
           ) AS sharpe
    FROM shadow_trades
    WHERE time >= NOW() - INTERVAL '30 days'
    GROUP BY market_type
  ) t;
")

# shadow_summary_by_direction — exposes the SHORT-resolves-NO sampling artifact
# (shadow SHORT win rates run very high in prediction markets because most
# markets resolve NO; not a strategy edge). Promotion logic uses this to
# decide whether a high overall win_rate is genuine or SHORT-bias-inflated.
#
# dominant_date_pct exposes the temporal-lumpiness artifact: event markets share
# resolution dates and resolve in batches. A single-day wave can flip the
# 30d win_rate by 70+ percentage points (2026-05-27 → 2026-05-28: event_long
# LONG WR 96.1% → 22% after 3605 resolutions landed on one day). Acts as a
# "do not promote on this sample yet" flag — see feedback_shadow_lumpy_resolutions.
shadow_summary_by_direction=$(query_json "
  WITH resolved_rows AS (
    SELECT market_type, direction, theoretical_pnl, DATE(resolved_at) AS resolved_day
    FROM shadow_trades
    WHERE time >= NOW() - INTERVAL '30 days' AND resolved_at IS NOT NULL
  ),
  per_day AS (
    SELECT market_type, direction, resolved_day, COUNT(*) AS n
    FROM resolved_rows GROUP BY market_type, direction, resolved_day
  ),
  dominant AS (
    SELECT market_type, direction,
           MAX(n) AS top_n,
           SUM(n) AS total_n,
           (ARRAY_AGG(resolved_day ORDER BY n DESC))[1] AS top_day
    FROM per_day GROUP BY market_type, direction
  )
  SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (
    SELECT s.market_type,
           s.direction,
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE s.resolved_at IS NOT NULL) AS resolved,
           ROUND(AVG(s.theoretical_pnl) FILTER (WHERE s.resolved_at IS NOT NULL)::numeric, 4) AS avg_pnl,
           ROUND(
             (COUNT(*) FILTER (WHERE s.resolved_at IS NOT NULL AND s.theoretical_pnl > 0)::numeric
               / NULLIF(COUNT(*) FILTER (WHERE s.resolved_at IS NOT NULL), 0))::numeric,
             3
           ) AS win_rate,
           ROUND(STDDEV(s.theoretical_pnl) FILTER (WHERE s.resolved_at IS NOT NULL)::numeric, 4) AS pnl_stddev,
           ROUND(
             CASE WHEN STDDEV(s.theoretical_pnl) FILTER (WHERE s.resolved_at IS NOT NULL) > 0
               THEN AVG(s.theoretical_pnl) FILTER (WHERE s.resolved_at IS NOT NULL)
                    / STDDEV(s.theoretical_pnl) FILTER (WHERE s.resolved_at IS NOT NULL)
               ELSE 0 END::numeric,
             3
           ) AS sharpe,
           d.top_day AS dominant_resolved_date,
           ROUND(
             CASE WHEN d.total_n > 0 THEN d.top_n::numeric / d.total_n ELSE 0 END,
             3
           ) AS dominant_date_pct
    FROM shadow_trades s
    LEFT JOIN dominant d ON d.market_type = s.market_type AND d.direction = s.direction
    WHERE s.time >= NOW() - INTERVAL '30 days'
    GROUP BY s.market_type, s.direction, d.top_day, d.top_n, d.total_n
    ORDER BY s.market_type, s.direction
  ) t;
")

# ── save review history ──────────────────────────────────────────────────────

HISTORY_ENTRY=$(cat <<HISTEOF
{
  "date": "$(date -u +%Y-%m-%d)",
  "capital": $(echo "$account" | jq '.current_capital // 0'),
  "realized_pnl": $(echo "$account" | jq '.total_realized_pnl // 0'),
  "drawdown_pct": $(echo "$account" | jq '.max_drawdown // 0'),
  "open_positions": $(echo "$open_positions" | jq 'length'),
  "trades_24h": $(echo "$trades_summary" | jq '.total_trades // 0'),
  "signals_1h": $(echo "$signal_freshness" | jq '.count_last_hour // 0'),
  "db_timeout_errors": $(echo "$error_logs" | jq '[.dashboard_api[]?, .data_collector[]? | select(test("timeout exceeded"))] | length' 2>/dev/null || echo 0),
  "zombie_count": $(echo "$zombie_positions" | jq '.count // 0')
}
HISTEOF
)

# Append to history (keep last 30 days)
if [ -f "$HISTORY_FILE" ]; then
  THIRTY_DAYS_AGO=$(date -u -d '30 days ago' +%Y-%m-%d 2>/dev/null || date -u -v-30d +%Y-%m-%d 2>/dev/null || echo "1970-01-01")
  cat "$HISTORY_FILE" | jq --argjson new "$HISTORY_ENTRY" --arg cutoff "$THIRTY_DAYS_AGO" \
    '[.[] | select(.date >= $cutoff)] + [$new]' \
    > "${HISTORY_FILE}.tmp" && mv "${HISTORY_FILE}.tmp" "$HISTORY_FILE"
else
  echo "[$HISTORY_ENTRY]" > "$HISTORY_FILE"
fi
echo "Saved review history entry" >&2

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
  --argjson real_pnl_check "$real_pnl_check" \
  --argjson category_performance "$category_performance" \
  --argjson trades_by_type "$trades_by_type" \
  --argjson shadow_summary "$shadow_summary" \
  --argjson shadow_summary_by_direction "$shadow_summary_by_direction" \
  --argjson edge_cohorts_positive "$edge_cohorts_positive" \
  --argjson edge_cohorts_traded "$edge_cohorts_traded" \
  --argjson opens_today "$opens_today" \
  --argjson coverage_by_type "$coverage_by_type" \
  --argjson allowed_market_types "$allowed_market_types" \
  --argjson edge_gap "$edge_gap" \
  --argjson edge_measurement_freshness "$edge_measurement_freshness" \
  --argjson review_history "$(cat "$HISTORY_FILE" 2>/dev/null | jq 'sort_by(.date) | .[-7:]' 2>/dev/null || echo "[]")" \
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
    error_logs: $error_logs,
    real_pnl_check: $real_pnl_check,
    category_performance: $category_performance,
    trades_by_type: $trades_by_type,
    shadow_summary: $shadow_summary,
    shadow_summary_by_direction: $shadow_summary_by_direction,
    edge_cohorts_positive: $edge_cohorts_positive,
    edge_cohorts_traded: $edge_cohorts_traded,
    opens_today: $opens_today,
    coverage_by_type: $coverage_by_type,
    allowed_market_types: $allowed_market_types,
    edge_gap: $edge_gap,
    edge_measurement_freshness: $edge_measurement_freshness,
    review_history: $review_history
  }'
