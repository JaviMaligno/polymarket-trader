# Demo Frontend Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the dashboard frontend work with real VM data for a 5-10 min demo video recording.

**Architecture:** React 19 + Vite SPA connects to live API at 34.148.24.147:3001. Local dev only (Vercel stretch goal). Overview tab must look great with real data. Hide broken features.

**Tech Stack:** React 19, Vite 7, Tailwind CSS 4, Recharts 3, TanStack React Query 5

---

### Task 1: Get Frontend Running Locally

**Files:**
- Modify: `packages/dashboard/frontend/.env` (create if not exists)
- Read: `packages/dashboard/frontend/package.json`

**Step 1: Install dependencies**

```bash
cd packages/dashboard/frontend && npm install
```

**Step 2: Create .env file for local dev**

Create `packages/dashboard/frontend/.env`:
```
VITE_API_URL=http://34.148.24.147:3001
VITE_WS_URL=ws://34.148.24.147:3001/ws
```

No API key needed for GET requests (auth only required for POST).

**Step 3: Start dev server**

```bash
cd packages/dashboard/frontend && npm run dev
```

Expected: Vite dev server starts on http://localhost:5173. May show TypeScript or runtime errors — that's fine, we'll fix them in subsequent tasks.

**Step 4: Check for build errors**

```bash
cd packages/dashboard/frontend && npx tsc --noEmit
```

Note all errors for the next task.

**Step 5: Verify API connectivity**

Open browser devtools Network tab, check if requests to `http://34.148.24.147:3001/api/status` return data. If CORS error, we'll fix in Task 2.

---

### Task 2: Fix Build Errors and API Connectivity

**Files:**
- Modify: `packages/dashboard/frontend/src/lib/api.ts` (if fetch wrapper needs fixes)
- Modify: `packages/dashboard/frontend/src/types/api.ts` (if types need updating)
- Possibly modify: `packages/dashboard/src/api/server.ts` (if CORS needs fixing)

**Step 1: Fix any TypeScript compilation errors from Task 1**

Common issues to expect:
- Import path issues
- Type mismatches with newer library versions
- Missing type definitions

Fix each error. Run `npx tsc --noEmit` after each fix until clean.

**Step 2: Test API connectivity in browser**

Open http://localhost:5173 and check Network tab:
- If CORS error: backend already has `origin: '*'` so this should work. If not, SSH to VM and check CORS_ORIGIN env var in docker-compose.gcp.yml
- If connection refused: verify VM firewall allows port 3001 (it should — dashboard is already exposed)
- If 401: only POST requests need auth, GET should work without API key

**Step 3: Verify data loads in console**

Open browser console. The Dashboard component calls `Promise.all([api.getStatus(), api.getPositions(), api.getAlerts(10), api.getPerformance()])` on mount. Check that at least `getStatus()` returns valid data.

**Step 4: Commit**

```bash
git add packages/dashboard/frontend/.env packages/dashboard/frontend/package-lock.json
git commit -m "chore: configure frontend for local dev with VM API"
```

Note: .env has no secrets (just public VM IP), safe to commit. If preferred, add to .gitignore instead.

---

### Task 3: Fix Dashboard Overview Data Mapping

The Dashboard expects a `DashboardState` type from `/api/status`, but the backend response may not match exactly. Also, some data is better sourced from `/api/paper/account`.

**Files:**
- Modify: `packages/dashboard/frontend/src/components/Dashboard.tsx`
- Modify: `packages/dashboard/frontend/src/lib/api.ts`
- Modify: `packages/dashboard/frontend/src/types/api.ts`

**Step 1: Add paper account API call**

In `api.ts`, there's already `getPaperTradingStatus()` pointing to `/api/paper-trading/status`. Add or verify a function for the paper account:

```typescript
getPaperAccount: async () => fetchApi<PaperAccount>('/api/paper/account'),
```

Add the `PaperAccount` type to `types/api.ts`:

```typescript
export interface PaperAccount {
  initial_capital: number;
  current_capital: number;
  available_capital: number;
  total_realized_pnl: number;
  total_unrealized_pnl: number;
  total_fees_paid: number;
  max_drawdown: number;
  peak_equity: number;
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  win_rate: number;
  updated_at: string;
}
```

**Step 2: Update Dashboard to use paper account data**

In Dashboard.tsx, add `api.getPaperAccount()` to the initial `Promise.all`. Use it to populate the stat cards with accurate data:

- **Total Equity**: `paperAccount.current_capital` (this is the real number from DB)
- **Total P&L**: `paperAccount.total_realized_pnl`
- **Win Rate**: `paperAccount.win_rate` (note: backend returns 0-100, not 0-1)
- **Total Trades**: `paperAccount.total_trades`

The `/api/status` endpoint returns calculated values from the trading system's in-memory state, which may be stale or zero after restarts. The paper account DB values are the source of truth.

**Step 3: Fix stat card display**

Ensure the 4 top-level stat cards show:
1. **Total Equity**: `formatCurrency(paperAccount.current_capital)` with trend based on PnL sign
2. **Total P&L**: `formatCurrency(paperAccount.total_realized_pnl)` with percentage `(pnl/initial * 100)`
3. **Win Rate**: `paperAccount.win_rate.toFixed(1) + '%'` (already 0-100 from backend)
4. **Open Positions**: from status or positions array length

**Step 4: Handle loading/error states gracefully**

If any API call fails, show what we have rather than an error screen. Use optional chaining and fallback values:

```typescript
const equity = paperAccount?.current_capital ?? state?.equity ?? 0;
const totalPnl = paperAccount?.total_realized_pnl ?? state?.totalPnl ?? 0;
```

**Step 5: Verify in browser**

Load http://localhost:5173 — stat cards should show real numbers ($12,493, +$2,498, etc.)

**Step 6: Commit**

```bash
git add packages/dashboard/frontend/src/
git commit -m "feat: connect dashboard overview to paper account real data"
```

---

### Task 4: Connect Equity Curve to Real Data

The equity chart in Dashboard.tsx uses HARDCODED dummy data. Must connect to real API.

**Files:**
- Modify: `packages/dashboard/frontend/src/components/Dashboard.tsx`
- Modify: `packages/dashboard/frontend/src/lib/api.ts`
- Modify: `packages/dashboard/frontend/src/types/api.ts`

**Step 1: Add equity curve API function**

In `api.ts`, add or verify:

```typescript
getEquityCurve: async (days: number = 30) =>
  fetchApi<EquityCurvePoint[]>('/api/portfolio/equity-curve?days=' + days),
```

Add type to `types/api.ts`:

```typescript
export interface EquityCurvePoint {
  timestamp: string;
  value: number;
}
```

Note: The backend returns `{ points: [...], drawdowns: [...] }` from the equity curve endpoint. The frontend may need to extract `.points` — check actual response shape and adjust.

**Step 2: Fetch equity curve data on mount**

Add to the `Promise.all` in Dashboard.tsx:

```typescript
api.getEquityCurve(30)
```

Store in state: `equityCurve: EquityCurvePoint[]`

**Step 3: Replace hardcoded chart data**

Find the hardcoded `chartData` array in Dashboard.tsx and replace with:

```typescript
const chartData = equityCurve.map(point => ({
  date: new Date(point.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  value: point.value,
}));
```

**Step 4: Handle empty equity curve**

If no data or API fails, show a message like "Collecting equity data..." instead of an empty chart.

**Step 5: Verify chart shows real data**

The chart should show the equity progression from ~$10,000 to ~$12,500 over time.

**Important**: If `/api/portfolio/equity-curve` returns empty (no snapshots in DB), we may need to fall back to `/api/paper/account` data and construct a minimal curve, or ensure the backend has `paper_account_equity_daily` data. Check by hitting the endpoint directly: `curl http://34.148.24.147:3001/api/portfolio/equity-curve?days=30`

**Step 6: Commit**

```bash
git add packages/dashboard/frontend/src/
git commit -m "feat: connect equity curve chart to real historical data"
```

---

### Task 5: Fix Positions and Trades Display

**Files:**
- Modify: `packages/dashboard/frontend/src/components/Dashboard.tsx`
- Modify: `packages/dashboard/frontend/src/types/api.ts`

**Step 1: Check positions API response**

The frontend `Position` type expects: `marketId`, `outcome`, `size`, `avgEntryPrice`, `currentPrice`, `unrealizedPnl`, `realizedPnl`, `openedAt`.

The backend `/api/paper-positions` returns: `market_id`, `token_id`, `side`, `size`, `entry_price`, `current_price`, `unrealized_pnl`, etc. (snake_case).

Either:
a) Map snake_case to camelCase in the API call, OR
b) Update the frontend types to use snake_case

Option (a) is cleaner — add a mapper in api.ts.

**Step 2: Use paper-positions endpoint**

The Dashboard calls `api.getPositions()` which hits `/api/positions`. This is the trading engine's in-memory positions, which may be empty after restart. Switch to `/api/paper-positions` which reads from DB:

```typescript
getPositions: async () => {
  const raw = await fetchApi<any[]>('/api/paper-positions');
  return raw.map(p => ({
    marketId: p.market_id,
    outcome: p.side === 'long' ? 'YES' : 'NO',
    size: p.size,
    avgEntryPrice: p.entry_price,
    currentPrice: p.current_price ?? p.entry_price,
    unrealizedPnl: p.unrealized_pnl ?? 0,
    realizedPnl: p.realized_pnl ?? 0,
    openedAt: p.entry_time,
  }));
},
```

**Step 3: Show market question instead of market ID**

The positions table shows `marketId` which is a long hash. For the demo, showing the market question is much better. If the position doesn't include the question, we can either:
a) Join from `/api/polymarket/markets` data, or
b) Truncate the market ID to first 8 chars as fallback

Prefer (a) if data is available.

**Step 4: Verify positions display**

Load the dashboard. If positions are open, they should show in the table with readable names, entry/current prices, and PnL colored green/red.

If no positions are currently open (issue #40 says 0 open positions), that's fine — the table should show an empty state message like "No open positions".

**Step 5: Commit**

```bash
git add packages/dashboard/frontend/src/
git commit -m "feat: connect positions table to paper positions with proper field mapping"
```

---

### Task 6: Add Performance Metrics from Real Data

**Files:**
- Modify: `packages/dashboard/frontend/src/components/Dashboard.tsx`

**Step 1: Check /api/analytics/performance response**

Hit the endpoint: `curl http://34.148.24.147:3001/api/analytics/performance`

If it returns empty/error (likely if analytics service depends on in-memory state), fall back to computing from paper account:

```typescript
const metrics = performance ?? {
  sharpeRatio: 0,
  maxDrawdown: paperAccount?.max_drawdown ?? 0,
  winRate: (paperAccount?.win_rate ?? 0) / 100, // convert 0-100 to 0-1
  profitFactor: paperAccount?.winning_trades && paperAccount?.losing_trades
    ? paperAccount.winning_trades / paperAccount.losing_trades : 0,
  totalTrades: paperAccount?.total_trades ?? 0,
  volatility: 0,
};
```

**Step 2: Display performance metrics grid**

The 6 metric cards should show:
1. **Sharpe Ratio**: from performance or "N/A"
2. **Max Drawdown**: `formatPercent(maxDrawdown)` — remember to check if it's already 0-1 or 0-100
3. **Win Rate**: `formatPercent(winRate)`
4. **Profit Factor**: `formatNumber(profitFactor, 2)`
5. **Total Trades**: `formatNumber(totalTrades, 0)`
6. **Volatility**: from performance or "N/A"

**Step 3: Verify metrics display**

At minimum, win rate (~34.57%), max drawdown (~1.15%), and total trades (~162) should show real values.

**Step 4: Commit**

```bash
git add packages/dashboard/frontend/src/
git commit -m "feat: display real performance metrics with paper account fallback"
```

---

### Task 7: Hide Broken Features and Polish UI

**Files:**
- Modify: `packages/dashboard/frontend/src/components/Dashboard.tsx`

**Step 1: Conditionally hide Backtest tab**

The Backtest tab is not needed for the demo. Hide it:

```typescript
// In the tab buttons, remove or hide the Backtest button
// Only show Overview and Automation tabs
```

Or simply remove the tab button. Keep the component code but don't render the tab trigger.

**Step 2: Review Automation tab**

Check if AutomationPanel works by visiting the tab. It polls `/api/automation/status`, `/api/signals/status`, `/api/polymarket/status`. These should work since the services are running on the VM.

If it works: keep it — showing start/stop controls is impressive for the demo.
If it errors: hide the tab too, keep only Overview.

**Step 3: Hide "Today's P&L" if not available**

`todayPnl` from `/api/status` depends on in-memory tracking which resets on restart. If it shows $0 while total PnL is $2,498, it's confusing. Either:
- Replace with a different useful metric (e.g., "Fees Paid", "Total Return %")
- Show it but mark as "since restart"

**Step 4: Clean up the alerts section**

If `/api/alerts` returns empty (likely), either:
- Hide the alerts section entirely
- Show a "No recent alerts" message

**Step 5: Polish risk metrics bars**

The exposure and drawdown progress bars should show real data from `/api/status`. Verify they display correctly (drawdown 1.15% should show a tiny bar).

**Step 6: Add subtle branding**

Add a small text at the bottom or top: "Polymarket Trading System — Paper Trading Mode" to make it clear in the video what this is.

**Step 7: Verify full Overview tab**

Walk through the entire Overview tab and confirm:
- [ ] Stat cards show real numbers
- [ ] Equity curve shows real progression
- [ ] Performance metrics show real values
- [ ] Positions table works (even if empty)
- [ ] No error states visible
- [ ] No broken/empty sections

**Step 8: Commit**

```bash
git add packages/dashboard/frontend/src/
git commit -m "feat: polish dashboard for demo — hide broken features, clean empty states"
```

---

### Task 8: Add "Claude is Watching" Indicator (Optional Enhancement)

**Files:**
- Modify: `packages/dashboard/frontend/src/components/Dashboard.tsx`
- Modify: `packages/dashboard/frontend/src/lib/api.ts`

**Step 1: Determine data source**

Option A: Fetch latest GitHub issue from the auto-review via GitHub API (adds external dependency)
Option B: Add a simple static indicator that links to the GitHub issues page
Option C: Show last auto-review timestamp from a simple file/endpoint on the VM

Recommend Option B for simplicity — a small card or badge:

```tsx
<div className="flex items-center gap-2 px-3 py-1.5 bg-purple-900/30 border border-purple-700/50 rounded-lg text-sm">
  <div className="w-2 h-2 bg-purple-400 rounded-full animate-pulse" />
  <span className="text-purple-300">Auto-Review Active</span>
  <span className="text-purple-500">· Daily at 08:00 UTC</span>
</div>
```

Place this in the Dashboard header, next to the connection status indicator.

**Step 2: Make it link to GitHub issues**

Wrap in an anchor tag:
```tsx
<a href="https://github.com/JaviMaligno/polymarket-trader/issues?q=is%3Aissue+label%3Adaily-review"
   target="_blank" rel="noopener noreferrer"
   className="hover:bg-purple-900/50 transition-colors ...">
```

**Step 3: Verify it looks good**

The purple badge should complement the dark theme and be visible but not dominating.

**Step 4: Commit**

```bash
git add packages/dashboard/frontend/src/
git commit -m "feat: add Claude auto-review indicator to dashboard header"
```

---

### Task 9: Final Testing and Recording Prep

**Files:** None (testing only)

**Step 1: Full page test**

1. Start frontend: `cd packages/dashboard/frontend && npm run dev`
2. Open http://localhost:5173
3. Verify Overview tab loads with real data
4. Verify Automation tab shows service statuses (if kept)
5. Click through all visible UI elements
6. Check browser console for errors — fix any that appear

**Step 2: Test at recording resolution**

Set browser to a clean state:
- No bookmarks bar
- No extensions visible
- Zoom level that makes the dashboard readable on video (try 90% or 100%)
- Window size ~1920x1080 or 1280x720

**Step 3: Prepare browser tabs for recording**

1. Tab 1: Dashboard (http://localhost:5173)
2. Tab 2: GitHub Issue #40 (https://github.com/JaviMaligno/polymarket-trader/issues/40)
3. Tab 3: GitHub PR #41 (https://github.com/JaviMaligno/polymarket-trader/pull/41)

**Step 4: Test screen recording setup**

Record a 30-second test with Loom/OBS to verify:
- Dashboard is visible and readable
- Webcam circle is positioned and not covering important UI
- Audio is clear

---

### Task 10 (Stretch): Deploy to Vercel

**Files:**
- Create: `packages/dashboard/frontend/vercel.json`

**Step 1: Create vercel.json**

```json
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "framework": "vite"
}
```

**Step 2: Deploy**

```bash
cd packages/dashboard/frontend
npx vercel --prod
```

Set environment variables in Vercel dashboard:
- `VITE_API_URL=http://34.148.24.147:3001`
- `VITE_WS_URL=ws://34.148.24.147:3001/ws`

**Step 3: Test CORS**

If CORS fails from Vercel domain, update `CORS_ORIGIN` env var on the VM to include the Vercel URL, or keep it as `*`.

**Step 4: Verify**

Open the Vercel URL and confirm all data loads correctly.

---

## Priority Order

1. **Tasks 1-2**: Get it running (foundation)
2. **Tasks 3-4**: Real data in stat cards + equity curve (visual impact)
3. **Tasks 5-6**: Positions + metrics (completeness)
4. **Task 7**: Hide broken stuff, polish (demo-ready)
5. **Task 8**: "Claude is watching" badge (wow factor)
6. **Task 9**: Recording prep (final)
7. **Task 10**: Vercel (stretch)

## Critical Unknowns to Resolve Early

1. Does `/api/portfolio/equity-curve` return data? If no snapshots exist, the chart will be empty — may need to seed data or use alternative endpoint.
2. Does `/api/analytics/performance` work or is it in-memory only? If in-memory, need paper account fallback.
3. Are there any open positions right now? Issue #40 says 0 — positions table may be empty during recording.
