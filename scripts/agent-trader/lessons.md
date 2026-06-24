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

## Run 4 — 2026-06-24 (one new bet, richer universe scan)

**Open bet status updates:**

- **Bet 2 (Romania/Bolojan NO) — thesis rock-solid.** Second PM-designate Vestea rejected June 22 (189 vs 233 needed). A THIRD nomination cycle is now required (nominate → 10-day cabinet assembly → parliamentary vote). With only 6 days to June 30, physically impossible to complete. Market still prices YES=0.276, which seems very lagged. p_hat_yes revised DOWN to ~0.02. Near-certain NO win. Market will likely crash toward 0 as the deadline approaches.

- **Bet 3 (Hormuz 40-ships Jun30 YES) — uncertain.** Current AIS-visible transits hover 25-36/day. Need 40 on any single day in 6d. Market moved slightly against (0.63 → 0.61). Thesis intact but AIS-only constraint is the binding limit.

- **Bet 1 (Hormuz MA≥60 Jul31 YES) — revised down.** Market moved 0.455 → 0.425. Mines take 40-50d to clear; MA≥60 requires a ramp-up after clearance (~July 17-27 window). Roughly fair at current price; held.

**New universe themes (Run 4):** FIFA World Cup 2026 dominates mid-priced markets (Group I, L winners; individual match wins; Golden Boot). Also: Claude Fable 5 US suspension (unique market), Israel/Hezbollah peace deal.

**Bet placed (4) — Israel/Hezbollah permanent peace deal Jul31 NO @ 0.86, p_hat_yes 0.06, edge 0.08.** Resolution requires explicit formal agreement ending hostilities permanently — not a ceasefire. Current status: temporary MOU only; active skirmishing over Lebanon security zone; no formal peace negotiations; 44-year historical baseline of zero Israel-Hezbollah peace deals. Market at 15% YES dramatically overprices speed of political resolution. High conviction NO. Independent of existing Hormuz bets (different political track, provides some portfolio balance).

**Declined this run:**
- **Claude Fable 5 restored by July 1 YES @ 0.23**: p_hat ~0.30-0.32. Edge 5-7% net, but the natural restoration path (Anthropic ID verification policy) takes effect July 8, AFTER the deadline. June 23 worsening (removed from subscription plans) argues against imminent deal. Edge too thin given timing argument strongly favors July 8+, not July 1. Declined.
- **England win Group L @ 0.875**: p_hat ~0.90-0.93, net edge only 1.5-4.5% after 1% spread. Below 5% threshold. England faces eliminated Panama with GD cushion — highly likely to win group, but market already prices it correctly.
- **France win Group I @ 0.795**: France needs only draw vs Norway to win on GD (+5 vs +4). p_hat ~75-78%. Market is fair to slightly generous already. No bet.
- **Messi top goalscorer @ 0.378**: Messi leads with 5 goals (Mbappe/Haaland at 4). With many tournament games remaining, 37.8% for the current 1-goal leader seems roughly fair. Too much variance in knockout rounds and Messi is 38.
- **Hormuz Jul15 @ 0.235**: Concentration veto — 3rd Hormuz-correlated bet would compromise calibration signal.
- **Israel airspace Jul31 @ 0.115**: Ceasefire MOU holding, Israel has explicit policy against full closure. Fair at 11.5%. No compelling edge.
- **World Cup individual match wins**: Sports are efficient with 1% spread; no edge without deep football analytics.
- **Fed July markets**: CME-arbitraged, as always.

**Refined selection rules (cumulative):**
1. **NO bets on peace deals (permanent/permanent-language required)** are a reliably overpriced market segment. The resolution criteria for "permanent" deals are much stricter than casual pricing implies — ceasefires and temporary MOUs explicitly DON'T qualify. Market anchors on the word "peace" not on the resolution criteria.
2. **Timing is often the key variable, not direction.** Both the Bolojan and the Hormuz bets were primarily about SPEED of a known-direction process, not about predicting the direction. This remains the richest seam for genuine edge.
3. **Claude Fable 5 follow-up**: If the market extends to July 10 or July 17, p_hat for those dates is ~55-65% (ID verification path), which would represent a significant edge over current pricing. Monitor for new markets.
4. **Sports markets for group-stage winners**: Edge exists only if the math is clear (facing an eliminated opponent with GD cushion), but the ≥5% net threshold is hard to clear once the market already prices the obvious. Pass unless a calculation clearly yields >5% net.

**Running record: 4 open, 0 resolved, $100 at risk.**
