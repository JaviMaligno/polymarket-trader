# Agent-Trader — Lessons Learned

Loaded into the decision prompt each run. Append after resolutions + each session.

## Run 1 — 2026-06-24 (setup + first batch)

**Universe reality (selection layer):** 312 liquid binary markets ≤45d; 183 after excluding
sports/intraday-noise. Themes: Iran/Israel geopolitics (dominant — active 2026 Hormuz crisis),
Fed/macro, AI-model races, crypto thresholds.

**Efficiency is the wall, again — now for my own judgment:**
- **Fed July markets = CME FedWatch almost exactly** (Polymarket no-change 0.735 / +25bps 0.244 vs
  CME 74% / 25%). My research reproduces the consensus → NO edge. Do not bet rate markets; they're
  arbitraged to the rates curve.
- **Near-0 / near-1 longshots are correctly extreme** (regime-fall 0.003, aliens 0.006, NVIDIA-largest
  0.986). Betting the obvious side earns ~spread, not edge. Skip — capital lock for pennies.
- **Edge only appears where I hold a genuine DIFFERENTIATED analytical view**, not where I merely
  reproduce the market read. Rare. Be selective; forcing marginal bets corrupts the calibration signal.

**Process lesson — read the resolution criterion BEFORE sizing conviction.** On Hormuz, my initial
"0.58" dropped when I saw resolution = IMF Portwatch 7-day MA of transit calls ≥60 (≈2× current daily
12-35), not vague "traffic flowing". Precise thresholds shrink apparent edges. Always fetch the
description and quantify the bar first.

**Bet placed (1):** Hormuz "normal by July 31" YES @ 0.46, p_hat 0.55, medium conviction. Thesis: the
Jun17 toll-free 60-day MOU + huge latent shipping/oil demand + the low "any single day in 37" bar make
MA≥60 likelier than the market's 0.455, which looks anchored on Iran's closure rhetoric. Risk: ceasefire
is fragile (Jun21 reclosure). **VERIFY on resolution whether the deal-holds thesis or the fragility won.**

**Declined (documented):** Fed July (efficient=CME); regime-fall/aliens/permanent-peace longshots
(correctly ~0); Iran-ends-enrichment-by-Jun30 NO and Trump-transit-fees NO (edge <0.02, marginal);
AI-model "best by end June" (resolution ambiguity, knowledge past cutoff).

**Open question to test over many bets:** does my "differentiated view" selection actually beat the
market net of spread, or am I fooling myself? Only the resolved track record + Brier answers this.

## Run 2 — 2026-06-24 (deeper search, 2 more bets)

**Where edge actually lives (refined selection rule):** filter to MID-PRICED (0.10–0.90 = genuinely
uncertain) researchable markets, then find ones whose resolution hinges on a SPECIFIC knowable
current fact (a timeline, a status) that the market prices coarsely. The blue-chips (Fed, top-liquidity)
are efficient; the edge is in less-watched political/event markets where fresh status research beats the
crowd's coarse read.

**Bet placed (2) — Bolojan NO @ 0.685, p_hat_yes 0.18, edge 0.135 (strongest, INDEPENDENT of Iran).**
His govt already fell (no-confidence 281-4, May 5); he's interim PM. Market prices 32% a NEW govt is
sworn in by Jun30, but credible reporting = "protracted negotiations lasting weeks" + still at informal
consultations ~7 weeks in. Market overprices the speed of govt formation. This is the template: market
mispriced the SPEED of a known-direction process.

**Bet placed (3) — Hormuz "40 ships any day by Jun30" YES @ 0.63, p_hat 0.66, edge 0.03 (thin; ask
moved up on execution).** Correlated with bet #1 (same Iran-recovery thesis) — placed mainly for FAST
feedback (resolves Jun30, 6d) to seed the learning loop. Lesson: watch concentration — 2 of 3 bets ride
one real-world outcome (Hormuz recovery); prefer independent bets for clean calibration.

**Declined run 2:** Israel-Knesset-dissolved (≈fair at 0.13 — bill passed 1st reading but 2 more unscheduled
+ averting talks); Anthropic-best-AI-model (resolution-ambiguous + own-ecosystem); Musk-tweet-count &
esports (noise — TODO: add to is_researchable exclusions); crypto/WTI thresholds (track spot, no edge).

**3 open bets, $75 at risk.** Themes: Romania govt-formation (independent), Iran/Hormuz recovery (×2).

## Run 3 — 2026-06-24 (status check, zero new bets)

**Open bet updates (new information):**

**Bet 2 (Bolojan NO) — thesis CONFIRMED strongly.** Second PM-designate Adrian Vestea REJECTED by parliament June 22 (189 votes in favor vs 233 needed; AUR walked out). Third nomination cycle now required: President Dan must nominate again + 10-day cabinet assembly + parliamentary scheduling. With only 6 days to June 30, the constitutional process physically cannot complete. p_hat_yes revised DOWN to ~0.03 (from 0.18). Market still pricing YES=0.321 — seems lagged; our NO bet is essentially a certain winner. **Thesis validated: market mispriced speed of government formation exactly as diagnosed.**

**Bet 3 (Hormuz 40-ships Jun30 YES) — key new information revises p_hat DOWN.** Critical finding: (1) Portwatch resolution is AIS-visible only — dark transits EXPLICITLY DON'T COUNT. (2) ~80 mines in central deep-water channel take 40-50 days to clear (from early June = cleared ~July 10-20). (3) Current AIS-visible transit: 24-36/day. CENTCOM claims 55+ on June 20-21 but those aren't Portwatch-countable. Getting 40 AIS-visible on any single day in 6d requires a step-change in Oman corridor traffic or partial mine clearance. Revised p_hat ~0.45-0.50 vs market 0.655. Entered at 0.63; thesis was more optimistic than warranted given the AIS-only constraint. Likely a marginal loss.

**Bet 1 (Hormuz MA≥60 Jul31 YES) — also revised DOWN.** Same mines/AIS issue applies. If mines clear by ~July 10-20 and Portwatch ramp-up needs 7 days after that, the window for hitting MA≥60 exists but is tight (July 17-27). Revised p_hat ~0.40-0.45 vs market 0.455 — roughly fair now, edge nearly gone. Original thesis was correct in direction but underestimated the physical mine-clearance constraint.

**NEW BETS THIS RUN: ZERO** — universe genuinely exhausted:
- Israel withdraws from Lebanon Jul31 @ 0.085: Netanyahu explicitly "stay as long as necessary," no withdrawal timeline. Below 0.10 threshold AND priced fairly. Skip.
- US-Iran Final Nuclear Deal Jul31 @ 0.045: Day 1 of talks produced immediate public contradiction on IAEA inspections. Historical precedent: 18-20 months from framework to final deal. Market at 0.045 is FAIR or slightly generous. Skip.
- Hormuz Jul15 @ 0.235: Mines won't clear by Jul15 (40-50d from early June). AIS ceiling ~36. MA≥60 by Jul15 looks harder than 0.235 implies, p_hat ~0.15-0.18. BUT: adding a 3rd Hormuz bet would make 3/4 bets correlated on one real-world outcome. Concentration veto wins. Skip.
- Fed markets: still efficient = CME. Skip always.

**Revised selection rules:**
1. **AIS vs total-transit distinction matters for Hormuz-type markets.** Always check if resolution uses Portwatch (AIS-only) vs any-transit-method. Dark transits are large (~30% of flow) and explicitly excluded.
2. **Physical bottlenecks (mines, damage) are binding constraints independent of political agreements.** The MOU doesn't remove mines; always check the physical clearing timeline.
3. **Concentration veto**: If ≥2 of N open bets share a real-world outcome (here: Hormuz recovery), decline any new correlated bet regardless of apparent edge. Clean calibration requires independent signals.
4. **Zero-bet discipline**: When no market clears ≥0.05 net edge + independence + researchability, ZERO is the correct bet count. Don't force volume.

**Calibration check so far (0 resolved):** Cannot judge yet, but subjective view: Bolojan NO is near-certain win, Hormuz bets are murkier than expected. Original Hormuz thesis (40-ships, MA≥60) may have been too optimistic on the recovery speed given physical mine constraints.

**Running record: 3 open, 0 resolved, $75 at risk.**
