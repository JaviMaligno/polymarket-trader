#!/bin/bash
# check-trades.sh - Query the Dashboard API to review trading status and trades
#
# Usage:
#   ./scripts/check-trades.sh <VM_IP>
#   ./scripts/check-trades.sh <VM_IP> <PORT>
#
# Examples:
#   ./scripts/check-trades.sh 34.123.45.67
#   ./scripts/check-trades.sh 34.123.45.67 3001
#
# To get your GCP VM IP:
#   gcloud compute instances describe polymarket-vm \
#     --zone=us-east1-b \
#     --format='get(networkInterfaces[0].accessConfigs[0].natIP)'

set -euo pipefail

if [[ "$1" == "--help" || "$1" == "-h" || -z "${1:-}" ]]; then
  echo "Usage: $0 <VM_IP> [PORT]"
  echo ""
  echo "Query the Dashboard API to review trading status and trades."
  echo ""
  echo "Arguments:"
  echo "  VM_IP   External IP of the GCP VM"
  echo "  PORT    API port (default: 3001)"
  echo ""
  echo "To get your VM IP, run:"
  echo "  gcloud compute instances describe polymarket-vm \\"
  echo "    --zone=us-east1-b \\"
  echo "    --format='get(networkInterfaces[0].accessConfigs[0].natIP)'"
  exit 0
fi

VM_IP="$1"
PORT="${2:-3001}"
BASE_URL="http://${VM_IP}:${PORT}"

BLUE='\033[0;34m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

section() {
  echo ""
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}${CYAN}  $1${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

api_call() {
  local endpoint="$1"
  local label="${2:-$endpoint}"
  local result
  result=$(curl -s --connect-timeout 5 --max-time 10 "${BASE_URL}${endpoint}" 2>/dev/null) || {
    echo -e "${RED}  [ERROR] Failed to reach ${endpoint}${NC}"
    return 1
  }
  echo "$result"
}

format_json() {
  if command -v python3 &>/dev/null; then
    python3 -m json.tool 2>/dev/null || cat
  elif command -v jq &>/dev/null; then
    jq '.' 2>/dev/null || cat
  else
    cat
  fi
}

extract() {
  local json="$1"
  local field="$2"
  echo "$json" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    d = data.get('data', data)
    keys = '$field'.split('.')
    val = d
    for k in keys:
        if isinstance(val, dict):
            val = val.get(k, 'N/A')
        else:
            val = 'N/A'
            break
    print(val if val is not None else 'N/A')
except:
    print('N/A')
" 2>/dev/null || echo "N/A"
}

echo -e "${BOLD}${GREEN}Polymarket Trader - Trade Review${NC}"
echo -e "Target: ${BOLD}${BASE_URL}${NC}"
echo -e "Time:   $(date '+%Y-%m-%d %H:%M:%S %Z')"

# ─── 1. Health Check ───
section "1. Health Check"
health=$(curl -s --connect-timeout 5 --max-time 5 "${BASE_URL}/health" 2>/dev/null) && {
  echo -e "${GREEN}  [OK] API is responding${NC}"
} || {
  echo -e "${RED}  [FAIL] Cannot reach API at ${BASE_URL}${NC}"
  echo ""
  echo "Possible issues:"
  echo "  1. VM is not running"
  echo "  2. Dashboard API container is down"
  echo "  3. Firewall rule for port ${PORT} is missing"
  echo ""
  echo "To fix firewall:"
  echo "  gcloud compute firewall-rules create allow-dashboard \\"
  echo "    --allow=tcp:${PORT} --target-tags=http-server"
  echo ""
  echo "To check VM status:"
  echo "  gcloud compute instances list"
  exit 1
}

# ─── 2. System Status ───
section "2. System Status"
status=$(api_call "/api/status")
if [ $? -eq 0 ] && [ -n "$status" ]; then
  echo -e "  Trading:        $(extract "$status" "isTrading")"
  echo -e "  Connected:      $(extract "$status" "isConnected")"
  echo -e "  Equity:         \$$(extract "$status" "equity")"
  echo -e "  Cash:           \$$(extract "$status" "cash")"
  echo -e "  Total PnL:      \$$(extract "$status" "totalPnl")"
  echo -e "  Today PnL:      \$$(extract "$status" "todayPnl")"
  echo -e "  Open Positions: $(extract "$status" "openPositions")"
  echo -e "  Open Orders:    $(extract "$status" "openOrders")"
  echo -e "  Drawdown:       $(extract "$status" "drawdown")"
  echo -e "  Trading Halted: $(extract "$status" "isTradingHalted")"
fi

# ─── 3. Paper Account ───
section "3. Paper Account"
paper=$(api_call "/api/paper/account")
if [ $? -eq 0 ] && [ -n "$paper" ]; then
  echo -e "  Initial Capital:     \$$(extract "$paper" "initial_capital")"
  echo -e "  Current Capital:     \$$(extract "$paper" "current_capital")"
  echo -e "  Available Capital:   \$$(extract "$paper" "available_capital")"
  echo -e "  Realized PnL:       \$$(extract "$paper" "total_realized_pnl")"
  echo -e "  Unrealized PnL:     \$$(extract "$paper" "total_unrealized_pnl")"
  echo -e "  Fees Paid:          \$$(extract "$paper" "total_fees_paid")"
  echo -e "  Max Drawdown:       $(extract "$paper" "max_drawdown")"
  echo -e "  Peak Equity:        \$$(extract "$paper" "peak_equity")"
  echo -e "  Total Trades:       $(extract "$paper" "total_trades")"
  echo -e "  Winning Trades:     $(extract "$paper" "winning_trades")"
  echo -e "  Losing Trades:      $(extract "$paper" "losing_trades")"
  echo -e "  Win Rate:           $(extract "$paper" "win_rate")"
fi

# ─── 4. Open Positions ───
section "4. Open Positions"
positions=$(api_call "/api/positions")
if [ $? -eq 0 ] && [ -n "$positions" ]; then
  python3 -c "
import sys, json
try:
    data = json.loads('''$positions''')
    positions = data.get('data', [])
    if not positions:
        print('  No open positions')
    else:
        print(f'  Total: {len(positions)} position(s)')
        print()
        for p in positions:
            mid = p.get('marketId', 'N/A')[:30]
            side = p.get('side', 'N/A')
            size = p.get('size', 0)
            entry = p.get('entryPrice', 0)
            pnl = p.get('unrealizedPnl', 0)
            print(f'  Market: {mid}...')
            print(f'    Side: {side} | Size: {size} | Entry: \${entry} | uPnL: \${pnl}')
            print()
except Exception as e:
    print(f'  Error parsing positions: {e}')
" 2>/dev/null || echo "  Could not parse positions"
fi

# ─── 5. Paper Positions ───
section "5. Paper Positions"
paper_pos=$(api_call "/api/paper-positions")
if [ $? -eq 0 ] && [ -n "$paper_pos" ]; then
  python3 -c "
import sys, json
try:
    data = json.loads('''$paper_pos''')
    positions = data.get('data', [])
    if not positions:
        print('  No paper positions')
    else:
        print(f'  Total: {len(positions)} paper position(s)')
        print()
        for p in positions:
            mid = p.get('market_id', p.get('marketId', 'N/A'))[:40]
            side = p.get('side', 'N/A')
            size = p.get('size', p.get('quantity', 0))
            entry = p.get('entry_price', p.get('avgPrice', 0))
            pnl = p.get('unrealized_pnl', p.get('unrealizedPnl', 0))
            print(f'  Market: {mid}...')
            print(f'    Side: {side} | Size: {size} | Entry: \${entry} | uPnL: \${pnl}')
            print()
except Exception as e:
    print(f'  Error parsing paper positions: {e}')
" 2>/dev/null || echo "  Could not parse paper positions"
fi

# ─── 6. Recent Trades (Journal) ───
section "6. Recent Trades (Last 20)"
journal=$(api_call "/api/journal?page=1&pageSize=20")
if [ $? -eq 0 ] && [ -n "$journal" ]; then
  python3 -c "
import sys, json
try:
    data = json.loads('''$journal''')
    d = data.get('data', {})
    items = d.get('items', [])
    total = d.get('total', 0)
    if not items:
        print('  No trades in journal')
    else:
        print(f'  Total trades in journal: {total}')
        print(f'  Showing last {len(items)}:')
        print()
        print(f'  {\"Time\":<20} {\"Market\":<30} {\"Side\":<5} {\"Size\":>6} {\"Price\":>7} {\"PnL\":>8}')
        print(f'  {\"─\"*20} {\"─\"*30} {\"─\"*5} {\"─\"*6} {\"─\"*7} {\"─\"*8}')
        for t in items:
            ts = str(t.get('timestamp', ''))[:19]
            market = str(t.get('marketQuestion', t.get('marketId', 'N/A')))[:30]
            side = t.get('side', 'N/A')
            size = t.get('size', 0)
            price = t.get('price', 0)
            pnl = t.get('realizedPnl', '-')
            pnl_str = f'\${pnl:.2f}' if isinstance(pnl, (int, float)) else str(pnl)
            print(f'  {ts:<20} {market:<30} {side:<5} {size:>6.2f} {price:>7.4f} {pnl_str:>8}')
except Exception as e:
    print(f'  Error parsing journal: {e}')
" 2>/dev/null || echo "  Could not parse journal"
fi

# ─── 7. Journal Stats ───
section "7. Trade Statistics"
jstats=$(api_call "/api/journal/stats")
if [ $? -eq 0 ] && [ -n "$jstats" ]; then
  echo -e "  Total Entries:    $(extract "$jstats" "totalEntries")"
  echo -e "  Open Positions:   $(extract "$jstats" "openPositions")"
  echo -e "  Closed Trades:    $(extract "$jstats" "closedTrades")"
  echo -e "  Total PnL:        \$$(extract "$jstats" "totalPnl")"
  echo -e "  Win Rate:         $(extract "$jstats" "winRate")"
  echo -e "  Avg Win:          \$$(extract "$jstats" "avgWin")"
  echo -e "  Avg Loss:         \$$(extract "$jstats" "avgLoss")"
fi

# ─── 8. Performance Analytics ───
section "8. Performance Analytics"
perf=$(api_call "/api/analytics/performance")
if [ $? -eq 0 ] && [ -n "$perf" ]; then
  echo -e "  Total Return:        $(extract "$perf" "totalReturn")"
  echo -e "  Annualized Return:   $(extract "$perf" "annualizedReturn")"
  echo -e "  Volatility:          $(extract "$perf" "volatility")"
  echo -e "  Sharpe Ratio:        $(extract "$perf" "sharpeRatio")"
  echo -e "  Sortino Ratio:       $(extract "$perf" "sortinoRatio")"
  echo -e "  Max Drawdown:        $(extract "$perf" "maxDrawdown")"
  echo -e "  Total Trades:        $(extract "$perf" "totalTrades")"
  echo -e "  Win Rate:            $(extract "$perf" "winRate")"
  echo -e "  Profit Factor:       $(extract "$perf" "profitFactor")"
  echo -e "  Avg Win:             \$$(extract "$perf" "avgWin")"
  echo -e "  Avg Loss:            \$$(extract "$perf" "avgLoss")"
fi

# ─── 9. Automation Status ───
section "9. Automation Status"
auto=$(api_call "/api/automation/status")
if [ $? -eq 0 ] && [ -n "$auto" ]; then
  echo "$auto" | format_json | head -30
fi

# ─── 10. Recent Paper Trades ───
section "10. Recent Paper Trades"
ptrades=$(api_call "/api/paper-trades?limit=20")
if [ $? -eq 0 ] && [ -n "$ptrades" ]; then
  python3 -c "
import sys, json
try:
    data = json.loads('''$ptrades''')
    trades = data.get('data', [])
    if not trades:
        print('  No paper trades found')
    else:
        print(f'  Showing {len(trades)} recent paper trade(s):')
        print()
        print(f'  {\"Time\":<20} {\"Market\":<25} {\"Side\":<5} {\"Size\":>6} {\"Price\":>7} {\"Signal\":<12}')
        print(f'  {\"─\"*20} {\"─\"*25} {\"─\"*5} {\"─\"*6} {\"─\"*7} {\"─\"*12}')
        for t in trades:
            ts = str(t.get('created_at', t.get('timestamp', '')))[:19]
            mid = str(t.get('market_id', 'N/A'))[:25]
            side = t.get('side', 'N/A')
            size = t.get('size', 0)
            price = t.get('price', 0)
            signal = t.get('signal_type', '-')
            print(f'  {ts:<20} {mid:<25} {side:<5} {size:>6.2f} {price:>7.4f} {signal:<12}')
except Exception as e:
    print(f'  Error parsing paper trades: {e}')
" 2>/dev/null || echo "  Could not parse paper trades"
fi

# ─── Summary ───
section "Done"
echo -e "  ${GREEN}Trade review complete.${NC}"
echo ""
echo "  Useful follow-up commands:"
echo "    curl ${BASE_URL}/api/portfolio | python3 -m json.tool"
echo "    curl ${BASE_URL}/api/analytics/equity-curve | python3 -m json.tool"
echo "    curl ${BASE_URL}/api/automation/performance | python3 -m json.tool"
echo "    curl '${BASE_URL}/api/journal?page=1&pageSize=50' | python3 -m json.tool"
echo ""
