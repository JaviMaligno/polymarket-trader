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

## Run 7 — 2026-07-13 (one new bet; open bet updates)

**Open bet status updates:**

**Bet 6 (Sulyok YES) — RESOLVING TODAY.** The constitutional amendment vote is scheduled for July 13 at 18:15 local Hungarian time. Tisza Party holds 141/199 seats (supermajority). Passage is near-certain. Sulyok has pre-emptively rejected signing, but parliament can pass the amendment anyway; Magyar says he'll launch impeachment if Sulyok refuses. The resolution criterion includes an announcement clause (resolves YES on announcement, not effective date). The thesis — market mispriced the announcement-vs-effective-date distinction — played out perfectly. Expected win. Market still at 0.845 (entry 0.825).

**Bet 5 (Machado Venezuela NO) — STRONG, MOVING IN OUR FAVOR.** Market moved from entry YES=0.335 to YES=0.155 — a $45 gain in position value. Structural barriers remain unchanged: Copa Airlines refusal, Venezuela closed airspace to block her, Trump admin explicitly unsupportive. 18 days remaining to resolution. Thesis intact.

**Bet 4 (Israel-Hezbollah permanent peace NO) — NEAR-RESOLVED WIN.** YES dropped to 0.021 (entry 0.14-0.15). With active US-Iran military exchanges restarted and Lebanon security zone still contested, permanent peace is even more remote than at entry. Hold.

**Bet 1 (Hormuz MA≥60 Jul31 YES) — CONFIRMED LOSS.** YES=0.036 (entry 0.46). Post-mortem: original thesis was correct on direction (recovery possible) but badly underestimated (a) the physical mine-clearance timeline (6-month operation now, not 40-50 days) and (b) Iran reasserting political control through IRGC harassment. Additionally, the ceasefire broke down entirely July 7-9 (Trump declared "ceasefire OVER," active US-Iran military strikes). Should not have entered this YES bet; physical constraint + Iran political will was the binding factor, not deal structure. Lesson: always weigh physical bottlenecks MORE than political agreements when the physical constraint has a documented multi-month clearing timeline.

**Iran/Hormuz context: Major ceasefire collapse (July 7-13).** Iran targeted commercial vessels in Hormuz (July 7). US struck 170+ Iranian military targets (July 7-9). Iran struck US bases in Bahrain and Kuwait. Trump declared ceasefire "OVER" (July 8) but said talks will continue (July 10). As of July 13: ceasefire de facto suspended, active military exchange, Qatar mediating. Both sides nominally want a deal but Iran won't negotiate under fire.

**Bet placed (7) — US-Iran MOU Extension NO @ YES=0.390, p_hat_yes 0.22, edge ~17%. Medium conviction.**
Thesis: Resolves YES only if BOTH sides formally and publicly announce an extension of the 60-day negotiation framework (initiated June 17, expires ~August 13; market resolves August 20). Three compounding barriers: (1) Iran has stated it won't negotiate while under US military strikes; (2) Trump's "ceasefire OVER" rhetoric creates political barrier to formal extension; (3) "formal joint extension announcement" is a much higher bar than informal Qatari-mediated back-channels continuing. Market at 39% anchors on "both sides still talking" but confuses informal continuation with the strict resolution criterion of a formal declared extension. Pattern match: same error as Israel-Hezbollah (market prices "process existing" not "strict resolution criteria met") and Bolojan (market prices intent, not the formal procedural bar).

**Declined this run:**

- **Russia captures Kostyantynivka by July 31 YES @ 0.385:** Russia controls ~37% of city through infiltration but ISW explicitly says "has NOT secured control." Station not shaded red. ISW requires documented consolidated control; Russia has been advancing since December 2025 and reached only 37%. My p_hat ~25-35% — uncertainty range too wide (edge could be 0-14% NO) to bet confidently.
- **Nirav Shah Maine Senate YES @ 0.117:** Platner withdrew July 9-10. Shah is declared but Jackson has ~69% Polymarket price, ~62% Kalshi — heavy institutional backing (Our Revolution, Ro Khanna, Maine DSA). Shah lacks institutional support by his own admission. Market's 11-15% for Shah is roughly fair. No edge.
- **Fed +25bps July YES @ 0.263:** CME FedWatch shows ~20-22% probability; Polymarket 26.3% is slightly more hawkish. The gap (4%) is below threshold and I have no differentiated view beyond the rates curve. Rule confirmed: always skip Fed markets.
- **US-Iran diplomatic meeting by July 31 YES @ 0.245:** Second formal senior-level round reportedly "under discussion for next week" (July 10) but ceasefire is broken and active strikes ongoing. Resolution requires "deliberate in-person diplomatic meeting" — very ambiguous given ceasefire chaos. Skip.
- **Iran full airspace closure by July 31 YES @ 0.285:** Iran has deliberately avoided full airspace closure even under active US strikes (170+ targets hit, July 7-9). Partial/localized closures only. p_hat ~15-20% vs market 28.5% suggests NO edge (~10%) but concentration veto: three Iran-correlated bets would be two too many.
- **US-Iran MOU withdrawal by July 17 YES @ 0.130:** No formal US withdrawal announced; Trump explicitly said "talks will continue." 4-day window too short. Edge insufficient.

**Refined selection rules (cumulative additions):**
1. **Formal extension criteria > informal talk continuation.** A market requiring a formal joint announcement between adversarial parties under active military conflict is priced very differently from "are they still talking?" Markets consistently over-price the probability that informal back-channels convert to formal announcements (Bolojan, Israel-Hezbollah, now MOU extension).
2. **Concentration limit is 2 correlated bets max.** Three bets on Iran/Middle East outcomes simultaneously compromises calibration and increases correlated drawdown risk. The concentration veto stopped a potentially good Iran-airspace bet from being placed — this is correct process even if ex-post it might have been profitable.
3. **Ceasefire collapse creates asymmetric regime shift.** When a negotiated framework collapses (ceasefire broken, military exchange active), ALL adjacent peace/deal markets become less likely to resolve YES. This is a correlated update across the Iran universe. Update adjacent bets accordingly.
4. **Sulyok template — announcement clause.** When a political removal or constitutional change has a formal announcement step separate from the effective date, the market resolves FASTER than naive analysis suggests. Look for this clause in all constitutional/political removal markets.

**Running record: 2-0 resolved, 5 open, $125 at risk. P&L net: +$26.18.**

## Run 8 — 2026-07-20 (one new bet; open bet updates)

**Open bet status updates:**

**Bet 1 (Hormuz MA≥60 Jul31 YES) — CONFIRMED LOSS, expiring July 31.** YES=0.017 (entry 0.46). Active US-Iran war ongoing as of July 20 — US has struck Iranian targets for 9+ consecutive nights (July 7-19, per CNN/Al Jazeera). US casualties: 2 dead, 1 missing. Portwatch MA≥60 is essentially impossible. Post-mortem: failed on (a) physical mine-clearance timeline (turned out to be 6-month operation, not 40-50 days) and (b) Iran reasserting military control rather than standing down after the MOU. **Lesson confirmed: physical bottlenecks and military will are binding constraints that override political agreements.**

**Bet 4 (Israel-Hezbollah permanent peace NO) — NEAR-CERTAIN WIN.** YES=0.009 (entry 0.86). No permanent peace deal possible with Israel-Lebanon ceasefire still fragile and Hezbollah not a formal signatory. Expires July 31. ✓

**Bet 5 (Machado Venezuela NO) — STRONG WIN.** YES=0.065 (entry 0.67). Moved from 0.155 → 0.065 since last run. New facts: private jet dispatched from Virginia was turned back over North Carolina by Venezuelan authorities; Trump admin has backed Delcy Rodríguez (Maduro loyalist) instead of Machado; Machado explicitly stated target of "return by end of 2026." Physical barriers intact. Expires July 31. ✓

**Bet 7 (US-Iran MOU extension NO) — ACTIVE, thesis strengthened.** YES=0.415 (entry 0.39, slightly against us). US-Iran war has dramatically escalated: 9+ consecutive nights of US strikes, Iran retaliating on US bases in Jordan/Bahrain/Kuwait (2 US killed, 1 missing as of July 17). Trump also announced a naval blockade of Iran (July 13). Iran states it won't negotiate under fire. MOU effectively dead. For YES to resolve, BOTH sides must formally announce extension by August 20. With ongoing war, this is very unlikely — market at 41.5% still anchors on "both sides nominally want a deal," not the strict formal joint announcement criterion. p_hat revised DOWN to ~0.12-0.15. Hold.

**Iran/Hormuz universe — concentration veto still applies.** Multiple Iran markets declined: "US halt offensive operations Aug 31" (YES=0.62, but correlated), "US-Iran effective ceasefire Aug 14/31" (correlated), "Iran full airspace closure" (correlated), "Iran MOU withdrawal Jul 31" (correlated). With Bet 1 (expiring) + Bet 7 (active) = 2 Iran-correlated bets open, no new Iran positions added.

**New bet placed (8) — Apple largest market cap Jul31 YES @ ask 0.27, p_hat 0.38, edge ~11%. Medium conviction.**

Thesis: NVIDIA and Apple are in a dead heat for world's largest market cap as of July 20, 2026 (NVIDIA ~$4.98T, Apple ~$4.89T, gap only ~$80-90B = ~1.8%). Apple was literally #1 on July 17 (3 days ago), then NVIDIA narrowly regained. Apple has much stronger YTD momentum (+22-23% vs NVIDIA +7.3%), suggesting trend continuation.

Quantitative foundation: 11-day volatility of the NVIDIA-Apple market cap spread (accounting for ~70% correlation) is ~$250-460B — far exceeding the $80-90B gap. Pure random walk gives Apple ~36-43% probability of leading on July 31. Market prices Apple at only 25.8% (buy at ask 0.27), anchored on NVIDIA's historical dominance rather than the current near-coin-flip race.

Market anchoring error identified: NVIDIA has been #1 for most of 2025-2026, so the market applies a "regime persistence" discount to Apple. But with Apple having just overtaken 3 days ago and the gap within a single day's trading range, the market should price closer to 50/50 for each. The 68.5% NVIDIA / 25.8% Apple split implies NVIDIA is priced at 2.66× Apple's probability — too asymmetric given the current data.

**Declined this run:**

- **NVIDIA largest market cap YES @ 0.685:** Complementary to Apple bet. If I think Apple is 38%, NVIDIA implied = 57% (with ~5% for others), so NVIDIA at 68.5% might be slightly overpriced, but I can't bet NO efficiently. The Apple YES position gives equivalent exposure.
- **James Fishback Florida GOP nominee @ 0.043:** Primary August 18 (28 days). Fishback polling 4-8%, Donalds leads by 46 points with Trump endorsement + Turning Point. Faces residency challenge + party disinvitation. Market at 4.3% is roughly fair to slightly low vs polling. No meaningful edge.
- **All Iran/ceasefire/MOU/blockade markets:** Concentration veto (2 Iran bets already open). Good individual edges exist on NO sides of several of these, but correlated drawdown risk is the binding constraint.
- **Israel x Iran ceasefire continues July 31/August 31:** Resolution unclear — need to distinguish US strikes vs Israeli strikes on Iran. The April 8 Israel-Iran ceasefire (Pakistan-brokered) may still be in effect even as the US-Iran conflict escalated. Insufficient information to bet with confidence.

**Calibration note on the Hormuz bets:** 3-0 record is flattering — the Hormuz 40-ships bet (#3) won despite my mid-run p_hat revision DOWN to 0.45. I was right to revise down (the "any single day" bar is easier than sustained MA), but the win was real. Brier score of 0.0515 reflects excellent calibration on resolved bets. However, Bet 1 (Hormuz MA≥60) will add a significant loss when it resolves July 31.

**Refined selection rules (additions):**
1. **Random walk analysis for near-parity market cap races.** When two companies are within ~2% of each other's market cap with significant time remaining, the market often anchors on recent history rather than the forward uncertainty. Use a simplified random walk: if 11-day spread volatility >> current gap, P(trailing company leads at expiry) >> market price. This is analogous to the "market misprices speed" pattern but applied to financial markets rather than political processes.
2. **Check who was #1 most recently.** If Company B just overtook Company A days ago, and A is now back ahead by a small margin, the market systematically anchors on A. Company B's probability will be underpriced relative to the close current race.
3. **Iran ceasefire geography matters.** The US-Iran ceasefire (MOU, June 17) and Israel-Iran ceasefire (April 8, Pakistan-brokered) are distinct agreements. US military strikes on Iran may not automatically break the Israel-Iran bilateral ceasefire. Always verify which bilateral relationship the market is measuring.

**Running record: 3-0 resolved, 5 open, $125 at risk. P&L net: +$31.30.**

## Run 9 — 2026-07-27 (two new bets; near-resolution post-mortems)

**Near-resolution post-mortems (bets 1, 4, 5, 8 expire July 31 — 4 days away):**

**Bet 1 (Hormuz MA≥60 Jul31 YES) — CONFIRMED LOSS, expiring July 31.** YES=0.0045 (entry 0.46). Final post-mortem: active US-Iran military conflict through July 24 (9+ consecutive nights of US strikes July 7-24) made MA≥60 impossible. US paused strikes July 25 (informal, unexplained) but far too late for the moving average to recover. Original thesis failed on (a) mine-clearance timeline underestimate and (b) Iran reasserting military control. Confirmed lesson: physical bottlenecks + military will > political agreements.

**Bet 4 (Israel-Hezbollah permanent peace Jul31 NO) — NEAR-CERTAIN WIN.** YES=0.009 (entry 0.86). Resolution criteria requires explicit formal permanent agreement — has never come remotely close. Thesis held perfectly.

**Bet 5 (Machado Venezuela Jul31 NO) — NEAR-CERTAIN WIN.** YES=0.065 (entry 0.67). Structural transport barriers (Copa refusal, Venezuelan airspace closure, Trump backing Rodríguez) intact through July 27. Physical barriers > stated intent template holds.

**Bet 8 (Apple Jul31 YES) — STRONG WIN POSITION.** YES=0.692 NOW (entry 0.27). Apple is #1 today (July 27) with ~$70-110B lead over NVIDIA (~$4.94T vs ~$4.83-4.87T). NVIDIA fell 2.1-2.64% today on WSJ report of $250B OpenAI financial guarantee commitment (balance sheet liability fears). Apple earnings July 30 expected strong (+16% revenue). Original thesis confirmed: market had anchored on NVIDIA's historical dominance vs the actual near-coin-flip race.

**Open bet updates:**

**Bet 7 (US-Iran MOU extension NO) — MARKET MOVED AGAINST ME.** YES=0.58 (entry 0.62 = YES 0.39). US conducted ~14 consecutive nights of strikes July 7-24, then paused informally July 25-27 (Waltz: "giving talks some room"). Iran explicitly DENIED 10-day ceasefire agreement. MOU is in effective collapse (Hormuz still closed, Trump declared it "over" July 8). Market moved 39% → 58% YES anchoring on "informal pause = likely extension" — same error as before: confusing informal continuation with strict resolution criterion requiring BOTH sides to "publicly and officially announce an extension." p_hat YES revised UP slightly to 0.25-0.30 (informal pause is a small positive signal), still far below 58%. Key: Netanyahu visits Washington July 29 — won't improve Iran extension prospects. Concentration veto prevents adding new Iran position until Bet 1 expires July 31.

**New bets placed (Run 9):**

**Bet 9 — Haley Stevens Michigan Primary YES @ ask 0.345, p_hat 0.50, edge ~15.5%. Medium-high conviction.**
Thesis: Market prices El-Sayed 65.5%/Stevens 34% overwhelmingly based on PAC-commissioned internal polls (Tulchin +16, Data for Progress +13 — BOTH commissioned by pro-El-Sayed groups). The only independent nonpartisan live-caller poll (Glengariff/Detroit News, n=500, Jul 8-11) shows Stevens leading 48-41. Largest sample poll (Politico/Tavern, n=2211) shows tied at 42-41. Structural advantages for Stevens: (1) 67% support from Black voters (20% of Dem primary electorate); (2) Whitmer + Clyburn endorsements = Black voter mobilization; (3) $49M outside spending vs El-Sayed's $2.7M; (4) CNN July 27 piece shows deep Black Detroit skepticism of El-Sayed. Aggregators overweight partisan polls. p_hat_yes = 0.50 (effectively coin-flip, market pricing El-Sayed 2:1). Risk: progressive grassroots energy (Sanders/AOC/UAW), El-Sayed's college-white base.

**Bet 10 — Apple largest market cap August 31 YES @ ask 0.53, p_hat 0.62, edge ~9%. Medium conviction.**
Thesis: Extends Apple vs NVIDIA thesis from Bet 8 (Jul31) to Aug31. Apple is #1 today with ~$70-110B lead. NVIDIA has negative catalyst today (OpenAI $250B guarantee, balance sheet fears). Apple has strong positive catalyst July 30 (Q3 earnings, +16% rev expected, 4 consecutive beats). NVIDIA's next major catalyst is August 26 earnings (4d before resolution) — could catalyze catch-up, but a single earnings beat is unlikely to close a $100B+ gap unless dramatically above expectations. Market at 52.5% still applies "NVIDIA regime persistence" discount. Key risk: NVIDIA August 26 earnings surprise close to resolution.

**Declined this run:**

- **US-Iran MOU extension additional NO:** Concentration veto — Bet 1 still open through July 31. After Bet 1 expires, consider adding new NO position at YES~0.58 in next run (excellent edge but correlated-Iran constraint applies until July 31).
- **AfD Sachsen-Anhalt absolute majority YES @ 43.5%:** AfD at 41% in polls but Die Linke is at 14% (well above 5% threshold). Math: if AfD+CDU+Linke+SPD all clear threshold → AfD gets 41/84 = 48.8% of seats (BELOW majority). Absolute majority requires SPD to also fail threshold (borderline at 5%) or AfD to surge to ~46%+. P(YES) ≈ 35-40% — too close to 43.5% market price for a confident NO bet. Edge uncertain. Decline.
- **US x Iran ceasefire July 31 YES @ 53.5%:** Resolution criteria ambiguous — "14-day period that begins before July 31" could mean either (a) period starts before July 31 (which the informal July 25 pause satisfies) or (b) period completes before July 31 (impossible given last strike ~July 24). Too much model risk in interpretation. Decline.
- **Israel-Iran ceasefire through July 31 YES @ 89%:** At 89% with 4 days to go, near-0 edge after 2% spread. No bet.
- **US announces halt in Iran ops by August 31 YES @ 94.5%:** Near-1, no edge. Skip.

**Key new selection rules:**

1. **Partisan internal polls are not data — they're advocacy.** When ALL the leading polls come from PAC-commissioned research, the market is effectively pricing the PAC's narrative. The signal is the independent nonpartisan polls, not the average. In Michigan, stripping PAC polls → race is a coin flip; market pricing 65/35 was a clear inefficiency.
2. **Check poll commissioner identity before trusting leads.** Any poll with "commissioned by [candidate name's PAC/super PAC]" should be heavily discounted or excluded. Live-caller, nonpartisan polls are the only reliable signal.
3. **Black voter math in Dem primaries is structurally underweighted by online polls.** Online polling panels skew younger, more educated, and more progressive. Black voters 55+ (who support establishment/moderate candidates more) are systematically undersampled. When Black voters are 20%+ of the electorate and favor the establishment candidate 2:1, the online polls will systematically overstate the progressive candidate.
4. **Concentration veto + timing:** The veto prevents adding correlated bets NOW, but expiry of the correlated bet creates an opportunity for the NEXT run. After July 31, Bet 1 expires → one new Iran-correlated bet slot opens. US-Iran MOU extension NO at ~58% YES would be an excellent re-entry at that point.
5. **Extend winning market thesis to the next time horizon.** Apple Jul31 (entered @ 0.27, now trading @ 0.69) → Apple Aug31 (entered @ 0.53). The same analytical edge (anchoring on historical dominance vs current near-parity) applies at the next resolution date as long as the current conditions persist.

**Running record: 3-0 resolved, 7 open, $175 at risk. P&L net: +$31.30.**
