# Demo Video Design — Claude Code Curious + Innate AI

## Context

- **Claude Code Curious**: 5-10 min pre-recorded video for online community (Apple, Anthropic, UK Gov members). Submit to max+demos@claudecodecurious.com
- **Innate AI**: 2-5 min Loom walkthrough of something impressive. Submit to max@innateaiconsulting.com
- **Strategy**: One recording, two cuts. First 3:30-4:00 works standalone for Innate AI.

## Narrative Arc

**Core story**: "Mathematician + AI Engineer, zero trading knowledge, built a full automated trading system with Claude Code. The system debugs itself while I sleep."

**Key hooks**:
- Real PnL numbers (+25% return, $2,498 profit)
- Auto-review that found and fixed a critical bug overnight (issue #40, PR #41)
- Running on a free 1GB VM
- Paper trading with real-money architecture ready

## Format

- Screencast with webcam circle (bottom-right corner)
- Record with Loom or OBS
- English narration
- Dark dashboard UI as primary visual

---

## Script

### 0:00-0:30 — Hook

*[Screen: dashboard showing equity curve and key metrics]*

"I'm Javier — mathematician turned AI engineer. A few weeks ago, I didn't know what PnL was. That's profit and loss — how much you're making or losing. Today I have a fully automated trading system on Polymarket, a prediction market, returning over 36% on paper trading. I'm not a trader. I built the entire thing with Claude Code, learning the domain as I went."

### 0:30-2:00 — Dashboard Live

*[Screen: navigate the dashboard — equity curve, metrics, positions]*

"Let me show you what this looks like. Here's the equity curve — we started with ten thousand dollars of simulated capital. Look at this shape. The system lost money for the first two weeks. That dip? That's when we were finding and fixing bugs — the auto-review system caught a critical one just this morning. But I didn't turn it off."

*[Point to the recovery in the curve]*

"As a mathematician, I trusted the process. The signals were being optimized, the Bayesian weights were adjusting. And in the last few days, the asymmetric wins kicked in. We're now at over thirteen thousand six hundred dollars."

*[Point to metrics]*

"The system doesn't win often — about 50% win rate. But when it wins, it wins big. Profit factor of 5.5 means it earns five and a half dollars for every dollar it loses. Max drawdown is just 1.15%, well below the 15% safety threshold."

"This is paper trading — simulated money. The system is fully wired for real trading with a USDC wallet, but as a mathematician, I don't put real money in until the data tells me to. And it's starting to."

### 2:00-3:45 — The Wow Moment (Auto-Review)

*[Screen: switch to GitHub, open issue #40]*

"But the most impressive part isn't the trading. It's this."

"This is a GitHub issue. It was created automatically at 8 AM this morning by a daily review workflow powered by Claude Code. While I was sleeping, Claude SSHed into the production VM, queried the database schema, read the application code, and found that every single trade execution was failing — ten errors in the logs."

*[Scroll through the issue showing the SQL evidence and diagnosis]*

"Look at the investigation. It ran SQL queries to check the schema, found that an `execution_mode` column was referenced in the code but never added to the database. A migration was missing. It even read the exact lines in `repositories.ts` where the INSERT was failing."

*[Switch to PR #41]*

"And here's the pull request it created. The fix: an idempotent ALTER TABLE migration. It applied it on the VM, verified the schema was updated, confirmed no more errors in the logs, and the PR was merged. All while I was sleeping."

"I woke up, checked GitHub, and the problem was found, documented, and fixed."

### — NATURAL CUT: Innate AI version ends here (~3:45) —

### 3:45-5:30 — The System Under the Hood

*[Screen: signal weights or architecture diagram or API response]*

"Let me show you what's under the hood. The system has five signal generators, each with a weight that determines how much influence it has on trading decisions. And here's where my math background kicks in: I refuse to hardcode values when there's uncertainty. So the weights are optimized automatically using Bayesian optimization with Optuna. The system runs optimization trials against historical data and updates its own strategy."

*[Show signal weights or optimization status]*

"Same philosophy applies to signal confidence. If a market doesn't have enough price data, I don't want the system to trade confidently on noise. So there's a Bayesian confidence cap — a Beta-Binomial model that scales down confidence when data is sparse. More data, more confidence. Less data, the signal is attenuated."

"Markets are also classified by type — crypto intraday, daily crypto, short-term events, long-term events — and each type gets different signal weight profiles. Microstructure signals matter for crypto. Momentum matters for events."

### 5:30-7:30 — The Journey

*[Screen: older GitHub issues/PRs, or before/after metrics]*

"It didn't start this well. The first month was rough."

"Early on, the system had a bug where closing a position would DELETE the database row instead of updating it. Capital got trapped — nearly five thousand dollars just vanished from the books. We found it by noticing the numbers didn't add up, and Claude helped me trace it to a single function."

"Then there was the zombie market bug. A database upsert was accidentally reactivating a hundred and eighteen thousand dead markets every five minutes. CPU hit 375%. The auto-review system found that one too."

*[Briefly show issue #8 or related PR]*

"At one point, drawdown hit 37% and I had to reset the account. But each bug was found the same way: I'd look at the data, ask Claude why something didn't make sense, and we'd investigate together. Run SQL queries, read the code, form a hypothesis, test it."

"The auto-review system itself went through iterations. The first version was too shallow — it created surface-level PRs that didn't find root causes. So I rewrote the prompt with a new philosophy: investigate first, fix second. Give it system invariants to check. And now it catches real bugs, like the one from this morning."

### 7:30-8:00 — Close

*[Screen: dashboard or terminal showing VM stats]*

"Everything you've seen runs on a free-tier Google Cloud VM with one gigabyte of RAM. TimescaleDB, a data collector, and the trading engine — all fitting in under 600 megabytes. The entire stack is TypeScript and Claude Code. The cost is the Claude subscription."

"Next step: plugging in a real wallet. The architecture is ready. The results are starting to justify it."

"Thanks for watching. Stay curious."

---

## Technical Requirements for Demo

### Frontend (Priority: make it work + look good for recording)

**Must work (shown in video):**
- Overview tab: equity curve, PnL stats, metrics (Sharpe, drawdown, win rate)
- Positions table (if positions are open at recording time)
- Recent trades

**Nice to have:**
- Automation tab controls (start/stop buttons, service status)
- Some visual indicator of "system is live" (green dots, signal count)

**Hide if broken:**
- Backtest tab (not shown in video)
- Any feature that shows errors or empty states

**Custom for demo (if time allows):**
- "Claude is watching" indicator — last auto-review timestamp or link to latest issue
- Signal weights visualization

### Deployment
- **Primary**: Local dev (Vite dev server → VM API at 34.148.24.147:3001)
- **Stretch**: Deploy to Vercel pointing to VM API (needs CORS on backend)

### Data Requirements
- Equity curve data must exist (daily snapshots in DB)
- Paper account with current PnL numbers
- Recent trades visible
- Signal weights accessible via API

### Recording Setup
- Loom or OBS with webcam overlay
- Browser in dark mode, clean tabs
- Dashboard at a good zoom level (readable on video)
- GitHub open in separate tab ready to show issue #40 and PR #41
