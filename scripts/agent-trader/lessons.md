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

## Run 5 — 2026-06-24 (zero new bets, deepest universe scan yet)

**Open bet status updates:**

**Bet 2 (Romania/Bolojan NO) — NEAR-CERTAIN WIN.** Third PM-designate NOT yet nominated (President Dan pushed responsibility back to parties June 23, did NOT immediately nominate again). Constitutional process physically cannot complete before June 30. p_hat_yes revised to ~0.01-0.02. Market YES at 0.284 — still very lagged. Expected win.

**Bet 3 (Hormuz 40-ships Jun30 YES) — UNCERTAIN, LIKELY LOSS.** Research confirmed: AIS-visible transits ranged 5–36/day through June 23. Highest AIS-visible was ~36 on June 22. CENTCOM cited 55 ships on June 20, but those include dark (AIS-off) vessels which Portwatch EXCLUDES. The 40-threshold on any single day in 6 days requires a meaningful step-change — possible but unlikely given current 12–36/day AIS-visible range. Revised p_hat ~0.40-0.45 vs market 0.61. Entered at 0.63; likely a loss.

**Bet 1 (Hormuz MA≥60 Jul31 YES) — ROUGHLY FAIR, SLIGHTLY AGAINST US.** Market moved to 0.425 (entry 0.46). Research: 4-month analyst estimate to full normalization; mine clearing July 10-20; MA≥60 window July 17-27 only. p_hat ~0.35-0.40. Thesis was correct in direction but physical constraint underestimated. Hold — no reason to close early.

**Bet 4 (Israel-Hezbollah permanent peace Jul31 NO) — STRONG, CONFIRMED.** 5th round of talks scheduled June 23-25, but Hezbollah explicitly demands full Israeli military withdrawal (precondition Israel categorically rejects). No permanent peace negotiations underway — only fragile temporary ceasefire framework. p_hat_yes remains ~0.05-0.08. Market stable at YES=0.15. Our strongest remaining position.

**New universe — World Cup advancement markets (thorough scan):**

Discovered the "World Cup: Team to advance to Knockout Stages" event with all 48-team advancement markets. The 2026 format: 12 groups of 4, top 2 qualify directly + 8 best 3rd-place teams = 32 total advance.

**Research agent data quality error detected:** Research subagent reported Croatia advancement at 37% — WRONG. Actual API price: 93.5% (correct given Croatia had 3 pts entering MD3 vs Panama who was eliminated). **Rule: Always verify market prices via direct API calls, never trust subagent-reported prices for betting decisions.**

**Detailed Group H analysis (Uruguay 36.5%):**
Reconstructed actual match results from standings:
- Spain 4-0 Saudi Arabia, Spain 2-2 Cape Verde (Spain: 4 pts, +4 GD)
- Uruguay 3-3 Saudi Arabia, Uruguay 0-0 Cape Verde (Uruguay: 2 pts, 0 GD, GF=3)
- Cape Verde drew both matches (2 pts, 0 GD, GF=2)
- Saudi Arabia: 1 pt, -4 GD

MD3: Uruguay vs Spain, Cape Verde vs Saudi Arabia.

Mathematical finding: In a draw scenario (Uruguay draws Spain, Cape Verde draws Saudi Arabia), Uruguay finishes 2nd ahead of Cape Verde on goals scored tiebreaker (Uruguay GF=3 > Cape Verde GF=2). The draw path is MUCH better for Uruguay than naive analysis suggests.

However: Market implies Spain wins ~67% vs Uruguay. Sensitivity analysis:
- Spain wins 60%: Uruguay advance = 42%, edge = 4.6% net (below threshold)
- Spain wins 65%: Uruguay advance = 38%, edge = 0.9% net (no edge)  
- Spain wins 55%: Uruguay advance = 46%, edge = 8.8% net (clears threshold)

The edge exists only if Spain wins <60% of the time. For #1 ranked Spain vs #12-15 Uruguay at neutral venue, 60-65% win probability for Spain is reasonable, meaning the market's 67% is plausible. **Edge is too sensitive to Spain's win probability assumption. Decline.**

**Group K analysis (DR Congo 54.5%):**
DR Congo (1 pt, -1 GD) vs Uzbekistan (0 pts, -7 GD) in MD3. Uzbekistan conceded 7 goals in 2 games vs Colombia and Portugal — clearly the weakest team in the group. DR Congo held Colombia and Portugal to competitive results.

Estimated P(DR Congo beats Uzbekistan) = 75-80%. If wins: 4 pts as 3rd-place team → P(advance) ≈ 75-82%. Estimated P(DR Congo advances) = 60-68% vs market 54.5%. Net edge = 4.5-12.5%, wide range.

However: The uncertainty interval for both P(DR Congo wins) and P(3rd-place advance) is large. Under pessimistic assumptions (DR Congo wins 70%, 3rd-place advance 70%), estimated advance = 52% — essentially same as market. **Too many compounding uncertainties. Decline.**

**Other World Cup markets analyzed and declined:**
- Bosnia & Herzegovina 69.5%: On 1 pt, must win Qatar AND rely on 4-pt 3rd-place route. True p_hat ≈ 60-63% → thin NO edge (~6%), but uncertain.
- Saudi Arabia 33%: Roughly fairly priced given their path requires beating Cape Verde to reach 2nd.
- Scotland 75%, Algeria 81.5%: Without knowing specific standings details and match difficulty, can't establish ≥5% net edge.

**Romania Grindeanu YES @ 72.35%:**
PSD unanimously nominated Grindeanu June 23 after Vestea's rejection. PSD is the largest party; both previous nominees (Tomac, Vestea) failed without PSD. President Dan's June 23 response: pushed responsibility back to parties. PSD veto argument is strong — eventually Grindeanu or another PSD-acceptable figure wins.

But: Dan might attempt one more non-PSD option (3rd designate) before capitulating. Snap elections (unprecedented in Romania) are a tail risk that could change everything. My p_hat ≈ 0.75-0.80 vs market 0.7235. Net edge ~3-8%. **Timeline is unclear (could take months), and edge is thin. Decline.**

**NEW BETS: ZERO.** Universe genuinely exhausted for this run.

**Refined selection rules (cumulative additions):**
1. **Sensitivity-test your edge.** When the edge depends on a single parameter assumption (e.g., "Spain wins 60% vs 67%"), explicitly compute the break-even assumption and ask: is the market's implied assumption actually unreasonable? If not, there's no edge.
2. **Compounding uncertainties kill edges.** A bet requiring P(A) × P(B) where both A and B are uncertain (like DR Congo WIN × 3rd-place ADVANCE) needs both to be estimated correctly. Each source of uncertainty amplifies the other. Require the edge to survive pessimistic assumptions for both.
3. **Verify prices from API directly.** Subagents can report wrong prices (e.g., Croatia was cited at 37% by a research subagent but actual market = 93.5%). Never bet without confirming the price from the Gamma API directly.
4. **Group advancement markets: edge requires standing-based math, not match prediction.** Uruguay's case showed the mathematical analysis (tiebreaker rules, goals scored) is tractable, but the edge still vanishes if match win probability assumptions shift by 5-7 points. Sports advancement markets are harder than they appear — reject unless both the standings math AND the match probability give clear edge.

**Running record: 4 open, 0 resolved, $100 at risk.**

## Run 6 — 2026-07-06 (two new bets; resolved post-mortems)

**Resolved bet post-mortems (bets 2 & 3 settled between runs 5 and 6):**

**Bet 2 (Bolojan NO) — WON +$11.50.** Thesis fully confirmed: third PM-designate cycle never completed, Bolojan remained interim PM past June 30. Market had priced YES=0.276-0.321 right up to expiry; our NO entry at 0.685 was the correct call. Template: market mispriced SPEED of a known-direction process. Calibration: p_hat_yes=0.18, resolved NO. ✓

**Bet 3 (Hormuz 40-ships Jun30 YES) — WON +$14.68.** Counterintuitive: in Run 3 I revised p_hat DOWN to ~0.45-0.50 after the AIS-only constraint analysis, thinking we'd lose. But it resolved YES — AIS-visible transits did hit ≥40 on at least one day before June 30. Key lesson: **the single-day "any day" bar is genuinely easier than I estimated.** Even with suppressed traffic, a single-day spike can clear a lower threshold. My Run 3 pessimism was overcalibrated.

**Open bet status updates:**

**Bet 1 (Hormuz MA≥60 Jul31 YES, entry 0.46, now 0.135) — LIKELY LOSS.** Portwatch 7-day MA at ~33 as of late June vs threshold of 60. Iran re-asserted control (IRGC active harassment, vessel warnings, July 4 swarm incidents). Mine clearance 6-month operation — UK/France minehunters just deployed early July. Iran demanding toll/fee sovereignty regime. Iran literally lost track of its own mines. The market correctly collapsed from 45.5% to 13.5%; p_hat_yes revised to ~0.10-0.12 (roughly fair). Original thesis correct on direction but badly underestimated (a) physical mine-clearance timeline and (b) Iran's willingness to re-assert control politically rather than simply stand down. **Post-mortem to write on resolution.**

**Bet 4 (Israel-Hezbollah permanent peace NO, entry 0.86, market YES still ~0.14-0.15) — REMAINS STRONG.** No peace negotiations underway; active skirmishing in Lebanon security zone; 44-year zero-deal baseline. Thesis unchanged. High conviction.

**New bets placed (Run 6):**

**Bet 5 — Machado NO @ YES=0.335, p_hat_yes=0.19, edge=0.14. Medium-high conviction.**
Thesis: market dramatically overprices her physical entry into Venezuela by July 31. Key facts: (1) Copa Airlines refused to carry her July 1 from Panama; (2) Venezuela shut down Caracas air traffic specifically to block her; (3) Trump admin called it "grotesque political opportunism" and won't facilitate; (4) Rodriguez explicitly threatened arrest; (5) her own stated timeline is "return by end of 2026," not July. Resolution requires physical entry into Venezuelan TERRESTRIAL territory — not airspace or maritime. The 33.5% YES price appears to anchor on her stated intent and the chaotic post-Rodriguez political vacuum, but practical transport and security barriers are overwhelming.

**Bet 6 — Sulyok YES @ 0.825, p_hat=0.92, edge=0.08. High conviction.**
Thesis: Peter Magyar filed 17th Amendment to Hungary's Fundamental Law on July 4 (explicitly terminating Sulyok's mandate); Tisza Party holds 141/199 seats (supermajority) — passage mathematically certain. CRITICAL market feature: resolution criterion includes announcement clause ("announcement of removal before July 31 resolves YES regardless of effective date") — market resolves YES as soon as parliament announces the amendment's passage, even if the effective removal date is later. Expected vote: July 14-21. Risk: Hungarian parliamentary summer recess delaying vote past July 31 (material but minority risk given amendment just filed and Magyar is urgent).

**Declined this run:**

- **El-Sayed Michigan Senate Primary YES @ 0.80:** Leads 10/12 polls; UAW endorsement; McMorrow dropped out July 5 (helps him). But p_hat ~0.85-0.87 gives only ~2-5% net edge after 2% spread. Below threshold.
- **US-Iran diplomatic meeting July 17 YES @ 0.37:** "Formal senior-level round" criterion is stricter than informal technical talks. Funeral pause ends ~July 10; edge depends on whether restart qualifies as formal AND happens by July 17. Too much ambiguity. Marginal to zero edge.
- **Mojtaba Khamenei NO (seen in public July 31) @ YES=0.145:** Strong structural case (120+ days absent; skipped own father's state funeral July 3-9 — the most symbolically important moment). But NO edge only ~3-4% after spread. Below threshold.
- **NVIDIA largest market cap July 31 YES @ 0.785:** Apple only 4% behind; gap reversible on a bad week. Market is fair. No bet.

**Key new selection rules:**

1. **Always check the announcement clause.** Sulyok's market resolves YES on the *announcement* of removal, not the effective date. Constitutional/political removal markets often have this clause — it dramatically reduces timing risk. Always read the full resolution criteria.
2. **Physical transport barriers are hard constraints.** Machado can state intent; with no airline willing to carry her and explicit government threats, market-perceived intent ≠ physical ability to arrive. Structural logistics trump stated intent.
3. **Single-day "any day" threshold is genuinely easier than sustained moving averages.** Hormuz 40-ships (any day) won despite my pessimism; MA≥60 (sustained average) is losing. When comparing similar-sounding thresholds, "any single day" is significantly more achievable.
4. **The Hormuz original YES thesis failed on two counts:** (a) physical mine clearance timeline (40-50d from early June = not ready until July 10-20) and (b) Iran re-asserted political control rather than standing down. Both were researchable at entry and underweighted.

**Running record: 2-0 resolved, 4 open, $100 at risk. P&L net: +$26.18.**
