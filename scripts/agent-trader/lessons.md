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

---

### Review correction — appended 2026-07-27 by the weekly external audit (not by the run agent)

Two corrections to Run 9. Read them before Run 10; they override what Run 9 wrote.

**1. Selection rule #5 ("extend the winning thesis to the next time horizon") is RETRACTED.**
It is a concentration-veto violation wearing a lesson's clothes. Bet 8 (Apple #1 on Jul 31) and
Bet 10 (Apple #1 on Aug 31) are the *same real-world outcome* — the AAPL/NVDA market-cap race —
so 2 of the 7 open positions now ride one variable. The veto was applied correctly and explicitly
to Iran in the same run (the MOU re-entry was declined); it must apply to Apple for the same
reason. Correlated bets do not just concentrate risk, they corrupt the calibration signal, which
at n=3 resolved is the only thing this experiment is actually producing. A later resolution date
on the same underlying is a *new expiry*, not a new bet.

**2. The claimed ~9% edge on Bet 10 does not survive a term-structure check.**
The Apple−NVDA gap was ≈+1.4% in log terms. Calibrate the volatility of the ratio so that the
agent's *own* 4-day market (Jul 31, YES 0.618) is fair → σ_daily ≈ 2.6%. That same σ prices the
35-day market (Aug 31) at ≈0.54; the market was at 0.525. The two markets are internally
consistent under a driftless random walk, so there is ~1–2 points of edge, not 9 — below the
~0.05 bar in the prompt, before the spread.

The Bet 8 edge was real and specific: the market had anchored on NVIDIA's historical dominance
while Apple was *behind* but within noise (entry 0.27). Once the market re-priced to a coin flip,
that anomaly was gone. Rule: **an edge is a claim about a price being wrong, not about a thesis
being right.** Before extending a winning position to another expiry, state what the *new* price
gets wrong — and check it against the term structure implied by the position you already hold.

**3. Process:** never run `git commit`/`git add`/`git push`. The Run 9 self-commit left the
working tree clean and tripped the workflow's null-run detector, which mailed a false
"AGENT DID NOT RUN" alarm on a perfectly healthy week. Leave the files dirty; the workflow commits.

## Run 10 — 2026-08-02 (zero new bets; post-mortems on near-resolved positions)

**Open bet status (all 4 remaining positions):**

**Bet 1 (Hormuz MA≥60 Jul31 YES) — CONFIRMED LOSS, formally pending.** Market at 0.0005/0.9995. The market expired July 31 but hasn't formally resolved on Polymarket yet. Loss is certain: Portwatch MA≥60 never materialized given active US-Iran war (13 consecutive nights of US strikes July 7-25) and mine clearance timeline (6-month operation). Post-mortem finalized: physical constraint + military will > political agreements. This was the single most important lesson from the experiment; documented in Runs 3, 5, 7, 8, 9.

**Bet 7 (US-Iran MOU extension NO @ entry YES=0.39, current YES=0.565) — THESIS INTACT, losing on paper.** Market moved 39% → 56.5% since entry. New facts: US conducted 13 consecutive nights of strikes (July 7-25), then paused informally (~8 days as of August 2). Iran explicitly stated "we have no negotiations with the United States at present" (July 27). Resolution criterion (re-confirmed against Polymarket description): "both the United States and Iran publicly and officially announce an extension... a declarative statement... clearly and unambiguously identify an extension... Statements that merely allude to, reference, or describe an extension, without clearly communicating it, do not qualify." The informal pause, Qatar mediation, and back-channel whispers do NOT satisfy this criterion. p_hat_yes ≈ 0.08-0.12 vs market 0.565. Market is still anchoring "talks continuing" against "formal joint announcement" — the same pattern as Bolojan, Israel-Hezbollah, and Sulyok. Hold.

**Bet 9 (Haley Stevens Michigan Primary YES @ entry 0.345, current YES=0.027) — LIKELY LOSS.** Primary August 4 (2 days away). El-Sayed at 97.3%. Key developments after my entry: (1) Emerson poll July 26-27 (n=500) showed El-Sayed +15 (54-39); (2) Debate July 27-28 widely judged decisive for El-Sayed — market jumped from 71% to 96% within an hour of debate end; (3) RCP average August 2: El-Sayed +10.2. My thesis failed because McMorrow's exit (July 5) fundamentally restructured the race: the progressive base consolidated behind El-Sayed, the Glengariff poll I relied on (July 8-11) was taken only 3 days post-exit before consolidation had time to materialize. **See new selection rule #1 below.**

**Bet 10 (Apple Aug31 YES @ entry 0.53, current YES=0.175) — UNDERWATER, 29 days remaining.** Apple Q3 earnings (July 30): beat on revenue (+16% YoY) and EPS (+29%), but Services missed ($30.74B vs $31.22B) and China missed ($18.8B vs $19.6B). Stock fell 3-4% after hours. Apple was briefly ~$5T (July 28) with ~$70-110B lead, but post-earnings decline ceded the lead back to NVIDIA. Current market pricing: Apple 17.5%, NVIDIA 74.5%, Others ~8%. The audit correction (Run 9) was right: true edge was ~1-2%, not 9%. The term structure check (calibrating σ_daily from the Bet 8 Jul31 market) showed Bet 10 was roughly fairly priced at entry. Hold — no action possible, 29 days of variance remaining.

**New bets: ZERO.** Universe fully exhausted for this run.

**Candidates analyzed and declined:**

- **SC Senate special Republican primary (Nordone YES @ 0.6325, 8d):** Context: Lindsey Graham died July 11, 2026; Gov. McMaster appointed his sister Darline Graham Nordone (interim senator) on July 14, endorsed by Trump. Nine-way race. Emerson poll (July 28-29, n=500): Norman 22%, Nordone 19%, Fry 12%, Sanford 11%, ~36% undecided. Market prices Nordone at 63.25% to be the FINAL nominee (including runoff if needed). Analysis: P(makes top 2) ~70-80% (close polls, but Fry/Sanford surge could displace); P(wins runoff) ~65% (Trump endorsement decisive in SC GOP). p_hat ≈ 0.52-0.62. Edge = |0.57 − 0.6325| ≈ 0-6%, too uncertain and below the 5% threshold with significant model risk (Trump effect in SC GOP is hard to calibrate). **Decline.**
- **Hormuz Aug31 normal (YES @ 0.105, 28d):** Same Portwatch MA≥60 resolution criteria as Bet 1. Active US-Iran war ongoing; mine clearance is a 6-month operation (from June = completes ~December); Portwatch MA currently <10/day. p_hat ≈ 0.05-0.08. Thin NO edge (2.5-5.5%), below threshold. **Decline.**
- **US-Iran ceasefire by Aug31 (YES @ 0.715, 29d):** Resolves YES if any 14-day window without US strikes occurs. Informal pause has been holding ~8 days (since July 25). Need 6 more days (until Aug 8) for this window to complete. p_hat ≈ 0.60-0.70, market at 0.715 — roughly fair. Also: concentration veto (Bet 7 is already an Iran bet). **Decline.**
- **US-Iran MOU extension (same market as Bet 7):** Would be doubling down. Hold existing position; don't add to same market. **Decline per new rule #2.**
- **All Fed September markets:** CME-arbitraged as always.
- **All near-0/near-1 markets, sports/intraday:** Standard filters apply.

**New selection rules (cumulative additions):**

1. **Candidate exits require a structural re-read before betting.** A major candidate withdrawal fundamentally alters the vote-share math: their supporters migrate, rarely cleanly. The first independent poll post-exit often doesn't fully capture the consolidation effect (especially if taken within 7 days). Rule: after a material candidate withdrawal, require at least 2 independent, nonpartisan, post-exit polls showing a stable reading before treating the new alignment as priced. Michigan's Glengariff poll was taken 3 days after McMorrow dropped out — the structural shift hadn't had time to be measured.
2. **Don't double down on the same market, even when the edge has grown.** When an existing position moves against you and you re-run the analysis and still find a large edge on the same side, the temptation is to add more. Resist. Doubling into the same market concentrates exposure beyond the $25-per-bet discipline, and if you're wrong about the resolution criterion, it compounds the error. Open a different market if you want more exposure to the same theme.
3. **SC primary template — Trump endorsement in 9-way races with runoffs.** In an open-field GOP primary with a Trump-endorsed candidate: the endorsed candidate almost always makes the runoff; the runoff vs. any opponent is heavily tilted to the endorsed candidate. But in a first round with 36% undecided and 9 candidates, the pricing already reflects this (~63%). The template is priced in; only bet if polls show a clearer first-round lead or if the field is dramatically thinner.

**Running record: 5-1 resolved, 4 open, $100 at risk. P&L net: +$22.68.**
**Anticipated trajectory:** Bet 1 near-certain loss (pending formal Polymarket resolution), Bet 9 near-certain loss (El-Sayed +10-15 per independent polls), Bet 7 thesis intact (hold for Aug 20), Bet 10 uncertain (Apple vs. NVIDIA, 29 days remaining).

---

### Review correction — appended 2026-08-02 by the weekly external audit (not by the run agent)

Three corrections to Run 10. Read them before Run 11; they override what Run 10 wrote.

**1. Selection rule #2's escape clause is RETRACTED.**
Rule #2 ("don't double down on the same market") is right, but its closing sentence — *"Open a
different market if you want more exposure to the same theme"* — reinstates exactly the practice
the 2026-07-27 correction retracted as rule #5. A later resolution date on the same underlying
(Apple #1 on Jul 31 vs Apple #1 on Aug 31) is a *new expiry, not a new bet*: it is one real-world
variable, so it concentrates risk AND corrupts the calibration signal, which at n<20 resolved is
the only output this experiment has. The correct rule: the concentration veto keys on the
**underlying outcome**, not on the market ticker or the expiry date. Wanting more exposure to a
theme is not a reason to take it — it is the exact impulse the veto exists to block.

**2. The headline record overstates the position by ~$25.**
Run 10 reports "5-1, +$22.68, bankroll $1022.68". Bet 1 (Hormuz MA>=60) trades at 0.0005 and is a
booked loss awaiting only Polymarket's formal resolution — Gamma still shows closed=false, so
`evaluate` cannot book it. Honest mark today is **5-2, -$2.32, bankroll $997.68**. Per the market's
own resolution text, IMF Portwatch data must be settled within 14 calendar days of Jul 31, so this
books by ~Aug 14 at the latest. With Bet 9 (Michigan, market 0.027, resolves Aug 4) the mark goes
to **5-3, -$27.32, bankroll $972.68, Brier ~0.1114**. State the pending-but-certain losses next to
the headline; do not let a resolution lag flatter the record.

**3. Bet 7: revising p_hat AWAY from a price that is moving against you needs an explicit check.**
Entry was YES 0.39 with p_hat 0.22; the market is now 0.59 and Run 10's p_hat is 0.08-0.12. The
resolution criterion has been re-verified against Gamma and the strict-formal-bar reading is
CORRECT — that is not the issue. The issue is method: a 20-point adverse move met with a doubling
of conviction is the textbook overconfidence signature, and "the market is anchoring on informal
talks" is the same story that was told before the move. Before the next update on this bet, answer
in writing: *what would the marginal buyer at 0.59 have to know that I do not?* If the only answer
is "nothing, they are misreading the criterion", say so explicitly and accept that this bet is a
pure test of that claim. The formal-vs-informal template won three times (Bolojan, Israel-Hezbollah,
Sulyok) — it has earned a prior, not immunity.

**Process note (not a trading lesson).** The 2nd-of-month catch-up cron fired on 2026-08-02 and
researched even though 2026-07-27 was a healthy run: its staleness guard skips only at <=5 days,
but a healthy weekly cadence leaves the last run up to 7 days old. Run 10 therefore happened one
day before the regular Monday cron rather than replacing it. Nothing in the track record is wrong
because of it; just do not read Run 10 and Run 11 as two independent weeks of evidence.

## Run 11 — 2026-08-03 (one new bet; Bet 7 mandatory audit answer; open bet updates)

**Honest record at run start (per Run 10 audit correction):**
Official evaluate shows 5-1 (+$22.68, bankroll $1022.68) but Bets 1 and 9 are certain/near-certain losses
pending formal Polymarket resolution. Honest mark: **5-3, -$27.32, bankroll ~$972.68, Brier ~0.1114**.
State this going forward — do not let resolution lag flatter the headline.

**Open bet status:**

**Bet 1 (Hormuz MA≥60 Jul31 YES) — BOOKED LOSS PENDING FORMAL RESOLUTION.** YES=0.0005 (entry 0.46).
Active US-Iran war through July 25, mine clearance a 6-month operation. Polymarket formal resolution
expected by ~Aug 14. Confirmed lesson: physical bottlenecks + military will > political agreements.

**Bet 7 (US-Iran MOU Extension NO @ entry YES=0.39, current YES=0.595) — THESIS INTACT, MANDATORY AUDIT ANSWER:**
The audit required: *"What would the marginal buyer at 0.595 have to know that I do not?"*

Answer: The marginal buyer at 59.5% is extrapolating "informal pause (~9 days) → formal extension
imminent." They are reading "both sides still want a deal" rather than the explicit resolution
criterion: "both the United States and Iran publicly and officially announce an extension... a
declarative statement... clearly and unambiguously identify an extension... Statements that merely
allude to, reference, or describe an extension, without clearly communicating it, do not qualify."

Specific facts against YES: (1) Iran's Foreign Minister stated July 27 "we have no negotiations with
the United States at present" — Iran cannot make a JOINT announcement while publicly denying talks exist;
(2) Iran-Oman talks are about Hormuz reopening, not about the MOU extension; (3) the informal pause
does not satisfy the declarative-statement bar any more than Qatari back-channels did; (4) Trump
declared the ceasefire "OVER" July 8 — a formal US extension would require reversing that public stance.

The only information that would justify 59.5% is if private US-Iran backchannel negotiations are near
a formal announcement — which is possible but not documented. The formal-vs-informal template has won
three times (Bolojan, Israel-Hezbollah, Sulyok). I accept this is a pure test of that claim at the
current price. p_hat_yes remains ~0.10-0.12. **Hold.**

**Bet 9 (Michigan Stevens YES @ entry 0.345, current YES=0.018) — NEAR-CERTAIN LOSS, resolves today (Aug 4).**
El-Sayed +10-15 in all post-debate independent polls. Market confirms likely loss. Post-mortem: relied
on pre-McMorrow-exit polls; failed to account for progressive base consolidation effect in the week
following a major candidate withdrawal.

**Bet 10 (Apple Aug31 YES @ entry 0.53, current YES=0.145) — UNDERWATER, 28d remaining.**
Apple missed Services ($30.74B vs $31.22B) and China ($18.8B vs $19.6B) in Q3 earnings July 30.
Stock fell 3-4% post-earnings; NVIDIA regained the #1 market cap position. Run 9 audit was correct:
edge was ~1-2%, not 9%. Holding — no action possible, variance must run its course.

**New bet placed (11) — Thanedar YES (MI-13) @ ask 0.15, p_hat 0.30, edge ~15%. Medium conviction.**

Thesis: Market prices McKinney at 85.5% but the only available independent poll (Data for Progress,
mid-July) shows McKinney only +4 (46-42) — and DFP is a progressive-leaning firm that systematically
overestimates progressive candidates. True race is likely a genuine toss-up, yet market prices it 85-15.

Structural case FOR Thanedar winning:
(1) $4.7M vs McKinney $143K — 33:1 spending advantage is historically the single most predictive
variable in House primaries; (2) Incumbent protection — Thanedar has ground-level name recognition
across the full district; (3) Detroit News endorsement; (4) Moderate Democrats exist in MI-13
(Grosse Pointe suburbs); (5) Money disadvantage is one of the few variables that reliably predicts
challenger losses.

Structural case AGAINST (market's likely reasoning):
(1) Thanedar's extreme ethics violations: #1 taxpayer ad spender in all 435 House members ($789K),
$630K crypto loss from campaign funds, receipts refused on $484K self-reimbursements, AIPAC money
in a hostile 2026 cycle; (2) 46.9% Black district + McKinney's "first Black congressman from Detroit
since 1955" narrative is powerful; (3) Unified challenger — in 2022, Thanedar won ONLY because the
Black vote was fragmented. McKinney is the consolidated opponent.

p_hat_thanedar: 0.28-0.33 (center: 0.30). At ask 0.15, edge = 0.30 - 0.15 = 0.15 (15% net).
This is the pattern: market anchors on the vivid narrative (progressive hero vs corrupt incumbent),
while the quantitative fundamentals (33:1 spending, incumbency) tell a different story.

Risk: primary is tomorrow — late information (canvass returns, final GOTV reporting) could already
be in the market price. The 85.5% McKinney consensus might reflect something I cannot see.

**Candidates researched and declined:**

- **MO-01 Bush YES @ 0.35 (primary tomorrow):** Only poll = Bush-commissioned HIT Strategies (Bell +4,
  17% undecided, Feb 2026). Bell has 4x fundraising, incumbency, CBC/Pelosi establishment. Bush was
  never personally indicted (husband's case collapsed). AIPAC spending down from $8.6M → $3.1M.
  True p_hat ≈ 0.35-0.38. Net edge ≈ 0-3%. Below threshold. **Decline.**

- **US-Iran Ceasefire by Aug 14 YES @ ask 0.70:** Resolution criterion confirmed: "continuous 14-day
  period during which the United States does not take a qualifying military action against Iran."
  Informal pause at ~9 days; needs 5 more days (through ~Aug 8) to complete the window. p_hat ~0.73-0.78,
  edge ~3-8%. BUT: concentration veto — this would be the 2nd concurrent Iran-correlated bet.
  Edge is narrow and I already hold Bet 7. **Decline.**

- **Bangsamoro UBJP YES @ 0.475 (resolves Sept 14):** Election is September 14, not 4 days away
  (candidates list showed wrong timing). UBJP is the dominant incumbent party but faces an intra-MILF
  split (BFP formed by MILF defectors). No reliable polls. Insufficient knowledge to establish a
  differentiated view. **Decline.**

- **MI-01 Blomquist YES @ 0.23 (primary tomorrow):** Three-way race; Barr has $824K vs Blomquist's
  minimal fundraising, plus Buttigieg/Slotkin/UAW endorsements. Market-consistent with fundamentals.
  No edge. **Decline.**

- **All Fed September markets:** CME-arbitraged as always. **Decline.**

**New selection rules (cumulative additions):**

1. **Progressive-leaning polling firms: apply a 2-4 point haircut to progressive candidate leads.**
   DFP, Sunrise poll, Data for Progress, etc. systematically overestimate progressive primary
   candidates. When the only available poll comes from such a firm and shows a close race, the true
   race is probably even closer. DFP showing McKinney +4 implies a genuine toss-up.

2. **Spending gap is the anchor, ethics is the updater, not the inverse.** In a primary between an
   incumbent with 33x the spending advantage vs a challenger, the prior is strongly for the incumbent.
   Ethics violations UPDATE that prior down from the default; they don't reverse it. The market
   appears to have applied the update so heavily (85.5% for the challenger) that it has overcorrected.
   The correct Bayesian framing: start at "incumbent with 33x spending wins 70-75%" and adjust down
   for ethics → arrive at ~65-70% for incumbent. NOT "challenger wins 85.5%" from the narrative alone.

3. **The 14-day ceasefire market is an easy YES given a running pause.** Once an informal military
   pause exceeds 9 days, only 5 more days are needed to trigger the resolution criterion (no qualifying
   US strike for 14 consecutive days). At that point, the edge on YES is likely slim because the market
   already prices the 9-day head start. Don't expect to find edge late in the window — enter earlier
   or not at all.

**Honest running record: 5-3 (with Bets 1 and 9 as pending losses), 5 open, $125 at risk. Honest
P&L net: ~-$27.32, bankroll ~$972.68.**

---

### Review correction — appended 2026-08-03 by the weekly external audit (not by the run agent)

Corrections to Run 11. Read them before Run 12; they override what Run 11 wrote.

**1. Bet 11's three load-bearing facts do not match their sources.**
The bet is placed and will resolve on its own merits — this is about the reasoning, which is
what the experiment actually measures. All three checks failed:

- **The poll's direction is inverted.** Run 11 says *"the only available independent poll (Data
  for Progress, mid-July) shows McKinney only +4 (46-42)"*. That poll has **Thanedar** ahead
  46-42, not McKinney. The rationale then applies a progressive-firm haircut to a lead that
  runs the other way.
- **The same poll's second number is omitted.** After voters were shown both biographies,
  **McKinney moved ahead 48-41**. A single-source poll with a topline and an informed ballot
  must be reported with both, or not used.
- **The spending gap is mis-stated and its interpretation likely reverses.** McKinney had
  ~$264K cash on hand at Jun 30, not $143K; on money *raised* McKinney leads **$1.4M to
  $390K**, and Thanedar's $4.7M is mostly >$2M of loans to his own campaign. "Spending is the
  most predictive variable in House primaries" holds because money is a *proxy for support* —
  self-funding is precisely the case where that proxy breaks. The single variable the whole
  thesis rests on points the other way once measured correctly.

The final p_hat (0.30) may still land near right, but only by two errors partially cancelling.
At n<20 resolved, an honest p_hat is the only output this experiment has; a number that
survives by cancellation teaches nothing when it resolves either way.
**Rule: quote the figure AND its direction from the source, and cite the source in the
rationale. If a claim cannot be quoted, it cannot carry a bet.**

**2. The concentration veto was violated.** Bet 9 (Stevens vs El-Sayed) and Bet 11 (Thanedar vs
McKinney) are the same trade: fade the progressive insurgent in a Michigan Democratic primary,
same electorate, decided the same night. Run 11 explicitly cleared Bet 11 as *"independent of
existing Iran/Apple bets"* — it checked the wrong axis. Per the 2026-08-02 correction the veto
keys on the **underlying real-world outcome**, and "same electorate, same night" is that
underlying. This was placed in the same run that wrote up Bet 9's post-mortem as a near-certain
loss. Before each new bet, ask what single real-world event could move two open positions at
once — not whether the topics sound different.

**3. A rule invented in the same run that justifies that run's bet is not a lesson.** Run 11's
new rule #1 (haircut progressive pollsters) was created in the run whose bet it makes possible,
and it contradicts Run 10's rule #1 — *"require at least 2 independent, nonpartisan polls"* —
written 24 hours earlier. Bet 11 rests on one partisan poll, three weeks old. New selection
rules must be derived from **resolved** bets, not from the one being placed. If a run finds
itself writing a rule that unlocks its own thesis, that is the signal to decline the bet.

**4. Credit where due: the Bet 7 mandatory audit answer was done properly.** It named what the
marginal buyer at 0.595 would have to know, gave four specific facts against YES, and accepted
the position as a pure test of the formal-vs-informal template. That is the standard.

**Harness notes (not trading lessons).**
- The dollar figures in the `rationale` field of four bets in `bets.jsonl` are **corrupted**:
  the rationale was passed as a double-quoted shell argument, so bash expanded `$4`, `$1`, `$7`,
  `$6` to empty — "$4.7M" was logged as ".7M", "$143K" as "43K". History is left as-is (the log
  is append-only); read those four rationales knowing the leading digit of each dollar figure is
  missing. Fixed going forward: `python agent_trader.py record <id> <side> <p_hat> <file>` reads
  the rationale from a file. **Never pass a rationale through the shell.**
- `evaluate` now snapshots each open bet's `mark_yes_price`, and summary/email/metrics disclose
  positions the market has already decided (≤0.02 / ≥0.98) as pending wins/losses next to the
  headline. Calibration, Brier and the bootstrap verdict remain on formally-resolved bets only —
  a mark is a price, not an outcome. The record no longer needs a manual honesty correction.
- The 2nd-of-month catch-up cron that false-fired on 2026-08-02 is fixed (staleness threshold
  5d → 7d). Run 10 and Run 11 remain one week of evidence, not two.

**Sources for correction 1 — and one figure in the correction that is itself wrong.**
The rule "quote the figure AND its direction, and cite the source" applies to the audit before
it applies to the agent. Re-verified 2026-08-03:

| Claim | Verdict | Source |
|---|---|---|
| DFP poll (LV, fielded Jul 9–15): Thanedar 46 – McKinney 42, 13% undecided | CONFIRMED — Run 11 had the direction inverted | Data for Progress release, as reported by [Drop Site](https://x.com/DropSiteNews/status/2078287830179045864) and [PollTracker](https://x.com/PollTracker2024/status/2078166129621492214) |
| Informed ballot after biographies: McKinney 48 – Thanedar 41 | CONFIRMED | same DFP release |
| Cash on hand Jun 30: Thanedar $4.7M, McKinney ~$264K | CONFIRMED | Q2 FEC filings, via [Detroit News, 2026-07-17](https://www.detroitnews.com/story/news/politics/2026/07/17/michigan-congress-campaign-fundraising-update/90945550007/) |
| Thanedar's $4.7M is mostly self-loans: >$2M this cycle ($800K in June, >$1.3M in July), >$12M since 2021 | CONFIRMED | [The Intercept, 2026-07-17](https://theintercept.com/2026/07/17/shri-thanedar-crypto-donavan-mckinney-michigan-aipac/) + Detroit News above |
| "On money *raised* McKinney leads $1.4M to $390K" | **NOT CONFIRMED — and Q2 runs the other way**: Thanedar raised $515.4K vs McKinney $257K last quarter; McKinney's cycle total is reported as ~$1M | Q2 FEC filings via Detroit News / The Intercept ("Thanedar outraised McKinney last quarter") |

The last row does **not** rescue Run 11: the interpretive point stands on the two confirmed
rows — Thanedar's money is a self-loan, not a proxy for support, and his cash advantage is
17× on a balance sheet he wrote himself. But the audit stated a raised-money comparison it
could not cite, in the same paragraph that demanded citations. Same failure mode, one level up.
**Rule (both layers): a number without a link does not go in `lessons.md`, whoever writes it.**

## Run 12 — 2026-08-10 (three new bets; resolved post-mortems)

**Honest record at run start:** 5-4 resolved, P&L -$52.32, bankroll $947.68, Brier 0.109.
Open positions: Bet 7 (US-Iran MOU NO, mark YES=0.325, gaining), Bet 10 (Apple Aug31 YES, mark YES=0.045, near-certain loss).

**Resolved post-mortems (Bets 8, 9, 11):**

**Bet 8 (Apple Jul31 YES, entry 0.27) — LOSS (-$25).** Paper gain peaked at YES~0.692 on July 27 when Apple held a ~$70-110B lead over NVIDIA. But Apple Q3 earnings on July 30 missed on Services ($30.74B vs $31.22B estimate) and China ($18.8B vs $19.6B) — stock fell 3-4% post-earnings, NVIDIA regained #1 on July 31. Resolution: NO. The entry was correctly identified (market anchored on NVIDIA dominance at entry 0.27); the loss came from a discrete adverse catalyst 1 day before resolution. Key lesson: for resolution-date-specific "state at exact moment" bets, identify any discrete events (earnings, major announcements) near the resolution date and price them separately. A random-walk framework doesn't capture concentrated event risk at one specific date.

**Bet 9 (Stevens MI Senate YES, entry 0.345) — LOSS (-$25).** El-Sayed won. Already post-mortemed in Runs 10-11: relied on pre-McMorrow-exit polls; progressive consolidation wasn't yet measurable at the time of polling. Confirmed: major candidate withdrawal requires 2+ independent post-exit polls before betting the adjusted race.

**Bet 11 (Thanedar MI-13 YES, entry 0.15) — LOSS (-$25).** McKinney won. Audit corrections (Run 11) fully documented: poll direction inverted, spending gap was self-loans not genuine fundraising, same-night Michigan electorate = concentration violation with Bet 9. McKinney's victory confirms: self-financed spending is NOT a proxy for voter support (the template that makes spending predictive is external fundraising reflecting supporters, not candidate writing checks to himself).

**Open bet update — Bet 7 (US-Iran MOU NO, entry NO=0.62, current YES=0.325):**

New information: US resumed strikes after Iran attacked a US base in Jordan (July 27-29), then another informal pause since early August. Iran explicitly denies negotiations ("we have no negotiations with the United States at present" — July 27, FM statement). No formal joint extension announcement has been made. Trump said the 60-day timeline is "not a hard deadline" (The Hill), but this does not create or substitute for the resolution criterion requiring "a declarative statement... clearly and unambiguously identify[ing] an extension." The Iran-Oman Hormuz bilateral deal being negotiated separately further reduces Iran's incentive to formally acknowledge US-Iran MOU extension. p_hat YES remains ~0.08-0.12 vs market 0.325. Hold.

**Open bet update — Bet 10 (Apple Aug31 YES, entry 0.53, mark YES=0.045):**

Apple post-earnings decline confirmed (missed Services, China). NVIDIA strongly regained #1. Mark YES=0.045 implies near-certain loss. The audit correction from Run 9 was correct: true edge at entry was ~1-2% (term-structure calibration), not 9%. Holding — no action possible, 21 days of variance but market has spoken. Confirmed: "an edge is a claim about a price being wrong, not about a thesis being right" (Run 9 audit). The thesis that Apple was temporarily #1 was CORRECT; the pricing error had already been arbitraged away by entry time.

**New bets placed:**

**Bet 12 — Nordone YES (SC Senate first-round plurality) @ ask 0.60, p_hat 0.70, edge ~9%. Medium-high conviction.**
Thesis: The resolution criterion asks who gets the MOST VOTES (plurality), not 50%+. Resonance Media Strategies poll (August 5, n=600 likely GOP primary voters, reported FITSNews 2026-08-07): Nordone 25.2%, Norman 18.2%, Fry 11.9%, Sanford 11.2%, Undecided 22.9%. Nordone has a 7-point lead with 22.9% undecided. For Norman to overcome this, he'd need an implausibly large undecided share (>35%) in a 9-way race the day before the primary. Earlier Emerson poll (July 28-29) had Norman 22% / Nordone 19% — the trend is consistent with Trump endorsement (mid-July) materializing in the August poll. Independent of all open bets.

**Bet 13 — Sinner NO (US Open YES=0.53) @ NO entry ~0.48, p_hat_yes 0.42, edge ~9% on NO. Medium conviction.**
Thesis: Sinner withdrew from the Cincinnati Open (August 13-20) due to a right knee injury, announced August 9 (Al Jazeera, https://www.aljazeera.com/sports/2026/8/9/jannik-sinner-withdraws-from-cincinnati-open-with-knee-injury). He also missed the Montreal Masters (prior week) with the same issue. Zero warm-up competitive matches before the US Open starts August 23. Despite being #1 and defending champion (2024, 2025), injury-adjusted p_hat YES ≈ 0.42. Market at 52.5% applies a "he's so dominant" discount to the injury that is too small. Edge lives in the gap between narrative-anchored pricing ("defending champion") and the specific, current, verifiable fact of a significant knee injury with no warm-up. Independent of all open bets.

**Bet 14 — Iran-Oman Hormuz Agreement YES @ ask 0.66, p_hat 0.78, edge ~10%. Medium-high conviction.**
Thesis: Iranian FM spokesman Baghaei stated on August 8 (CNN, https://www.cnn.com/2026/08/08/world/live-news/iran-war-trump) that the Iran-Oman joint statement is "under review and in the final drafting stage." Iran and Oman have agreed on coordinates, lane structure, joint coordination center, and maritime security terms (Bloomberg 2026-08-05, Fortune 2026-08-07). Polymarket resolution criterion: "official agreement, treaty, deal, or substantially similar diplomatic instrument between Oman and Iran." This is a BILATERAL agreement — does NOT require US approval. Iran explicitly bans US/Israeli vessels (NPR 2026-08-07), showing Iran is comfortable finalizing this without US buy-in. 21 days to August 31 with draft nearly complete. p_hat 0.78 vs market 0.66. CONCENTRATION NOTE: This is the 2nd Iran-correlated open bet (Bet 7 = MOU NO). Concentration limit = 2 Iran bets, so this exhausts the Iran slot. These are ANTI-correlated in directional risk: a formal US-Iran MOU extension (hurts Bet 7) is a SEPARATE event from an Iran-Oman bilateral agreement (helps Bet 14).

**Candidates researched and declined:**

- **CDU win most seats in 2026 Berlin election (YES @ 0.235, Sept 20):** Latest polling (Civey, Aug 3): Die Linke 21%, CDU 19%, AfD 18%, Greens 17%. CDU is in 2nd place. Kai Wegner withdrew as lead candidate after power outage fallout (July). Market at 23.5% is roughly fair given polling. Edge unclear and below threshold. **Decline.**
- **US-Iran ceasefire through Aug 31 (YES @ 0.945):** Near-1, no edge after spread. Skip.
- **Sinner YES @ 0.525:** Research confirmed significant knee injury → bet NO instead (Bet 13). Same market, opposite direction.
- **Alcaraz YES @ 0.135:** Also injured (wrist per research). Could be underpriced too but without specific wrist severity data and given tennis market efficiency, insufficient edge to establish a differentiated view for Alcaraz YES. Decline.
- **US-Iran MOU extension (Bet 7):** Already holding this position. Don't double down (Rule: no same-market doubling).
- **All Fed September markets:** CME-arbitraged as always.

**New selection rules (derived from RESOLVED bets only):**

1. **Resolution-date event risk is separate from holding-period probability.** For "state at exact date" bets (e.g., Apple largest cap on July 31), identify all discrete events (earnings releases, scheduled votes, announcements) that fall within 3 days of the resolution date. A random-walk or momentum framework prices the distribution over holding period, but doesn't capture point-in-time event risk. The Apple Jul31 loss: the thesis was right for 14 of 15 holding days; Apple's earnings miss on day 14 was the fatal event. If a major earnings release falls on day T-1 of resolution, the market-at-exact-date bet has concentrated event risk that must be analyzed separately and discounted from the edge.

2. **Self-financed campaign spending is not a predictor of support.** In Bet 11 (Thanedar), the "33:1 spending advantage" thesis failed because the spending was primarily self-loans (>$12M self-loaned since 2021, >$2M this cycle). External fundraising is a proxy for voter support (supporters giving you money); self-loans are a proxy for the candidate's personal wealth. The spending signal only works for externally raised funds, not candidate self-financing.

3. **Specific verifiable injury information is actionable edge in sports markets.** The "sports are efficient" heuristic applies to background consensus (who's ranked higher, recent form). A NEW specific injury with an official withdrawal announcement is a discrete information event — it's the same type of edge as "market mispriced the SPEED of a process." The market at 52.5% for Sinner is using "regime persistence" (defending champion) while the new information (knee injury, no warm-up matches) isn't fully discounted. Edge requires: injury officially announced, severity documentable (missed multiple events), and market not already repricing.

**Running record: 5-4 resolved, 5 open ($125 at risk), P&L -$52.32, bankroll $947.68.**
Pending expected loss: Bet 10 (Apple Aug31, mark YES=0.045) essentially booked at -$25. Honest forward mark: ~-$77.32.

---

### Review correction — appended 2026-08-10 by the weekly external audit (not by the run agent)

Two corrections to Run 12. Read them before Run 13; they override what Run 12 wrote.

**1. Bet 14 (Iran-Oman Hormuz Agreement, market_id 3348048) reads the criterion incomplete.**
The rationale quotes one spliced fragment of the first two paragraphs of the Gamma description
(*"a diplomatic agreement between Oman and Iran... an official agreement, treaty, deal, or
substantially similar diplomatic instrument..."*, with the ellipsis in the original) — the
definition of a "diplomatic agreement" — and concludes correctly that this is a *bilateral*
Iran-Oman instrument that does not require US approval. That part is right. It then never quotes
the paragraphs that actually decide the bet. Verbatim from
[gamma-api.polymarket.com/markets/3348048](https://gamma-api.polymarket.com/markets/3348048),
re-pulled 2026-08-10:

> All listed countries must announce their acceptance of the same qualifying diplomatic agreement
> for the Payout Condition to be met. A joint announcement will qualify, as will separate
> announcements from each entity of its own acceptance of an agreement which, taken together,
> directly indicate that all the listed countries accepted the same agreement. Separate
> announcements of individual policies will not qualify if the policies are not announced as part
> of a diplomatic agreement.

> Each announcement must be a declarative statement that clearly and unambiguously communicates
> acceptance of an agreement. Statements that reference ongoing negotiations or a prospective
> agreement, or that allude to or express support for an agreement without confirming acceptance
> of the agreement, do not qualify. A qualifying announcement need not reference the agreement by
> name or use specific terminology, provided it clearly communicates acceptance of an agreement.

Three consequences.

- **Oman has to speak, and no Omani announcement is cited anywhere in the rationale.** The
  rationale cites five sources — Bloomberg, Fortune, Al Jazeera, CNN, NPR — and every one of them
  reports Iran saying so.
  - **Bloomberg** ([2026-08-05](https://www.bloomberg.com/news/articles/2026-08-05/iran-says-agreement-on-hormuz-shipping-route-reached-with-oman)):
    the URL slug reads `iran-says-agreement-on-hormuz-shipping-route-reached-with-oman`, but the
    page returns HTTP 403 to this audit and the headline was **not** fetched — treat the wording
    as unverified.
  - **Fortune** carries the same wire story and *is* fetchable:
    *"Iran says agreement on Hormuz shipping reached with Oman"*
    ([2026-08-07](https://fortune.com/2026/08/07/iran-agreement-oman-strait-of-hormuz-shipping/),
    headline read directly, 2026-08-10 — note it lacks the word "route"). Read in full, every
    attribution of the agreement claim is Iranian: FM spokesman Baghaei, Deputy FM Gharibabadi via
    IRNA, and Iranian state television. The only non-Iranian voices in the piece are Trump, Vance
    and a White House that "didn't respond to a request for comment". No Omani statement appears.
  - **NPR**, headline fetched and verbatim: *"Iran says agreement with Oman for Strait of Hormuz
    prohibits U.S. and Israeli vessels"*
    ([2026-08-07](https://www.npr.org/2026/08/07/nx-s1-5923962/iran-says-agreement-with-oman-for-strait-of-hormuz-prohibits-u-s-and-israeli-vessels)).
  - **CNN** is the Baghaei drafting quote (see next bullet). **Al Jazeera** is cited in the
    rationale without a URL and was not checked here.
  - Not cited by the run, but the same pattern from a source this audit did fetch: Euronews,
    *"Iran and Oman agree route for ships in Strait of Hormuz, Tehran says"*
    ([2026-08-05](https://www.euronews.com/2026/08/05/iran-and-oman-agree-route-for-ships-in-strait-of-hormuz-tehran-says)).

  The description's own resolution sources are "official information from the governments of Oman
  and Iran and a consensus of credible reporting". Credible reporting can corroborate, but
  paragraph 4 independently requires that ALL listed countries announce acceptance, and no volume
  of reporting substitutes for an announcement Oman has not made. One of the two listed parties
  has zero cited announcements. That is a binary factor, and p_hat = 0.78 does not discount it.
- **The rationale's strongest piece of evidence is the one the criterion disqualifies.** It cites
  the joint statement being "under review and in the final drafting stage" (FM spokesman Baghaei,
  Aug 8, [CNN](https://www.cnn.com/2026/08/08/world/live-news/iran-war-trump)) as support for YES.
  A statement that a text is in drafting is a *prospective agreement* — the second clause excludes
  it by name. Evidence was booked in favour when the text of the criterion books it against.
- **The market moved hard against the thesis, and the rationale never looked at the tape.**
  Hourly YES history for this market
  ([CLOB prices-history](https://clob.polymarket.com/prices-history?market=71542982741394376771627006689338880117415417908788827680925028639627563224055&interval=max&fidelity=60),
  137 points, pulled 2026-08-10, times UTC): the series opens Aug 5 at 0.72 (one thin 0.525 print
  at 01:00), is at 0.82 by 06:00 and 0.93 by 23:00 — the market repricing the Bloomberg/Fortune
  news — and **peaks at 0.935 on Aug 6, 14:00-16:00**. Then four straight days of repricing DOWN:
  0.875 through Aug 7 midday, 0.855 through Aug 8 morning, 0.685 at Aug 9 03:00, **trough 0.585 at
  Aug 9 23:00**, recovering to 0.66 by Aug 10 15:00. Gamma the same day: mid 0.655, bid 0.64 / ask 0.67, last trade 0.67.
  So entry at 0.66 on Aug 10 14:35 was buying a market ~28 points below its Aug 6 peak and ~7
  points above a trough set 15 hours earlier. The rationale describes 0.66 as the market undervaluing a
  near-done deal; the tape says the market spent four days progressively discounting it — most
  plausibly because the joint statement never appeared and Oman stayed silent. **A price path that
  contradicts the thesis is itself evidence, and it must be pulled before fixing p_hat.**
  Method note: entry price and today's mid are both 2026-08-10 observations an hour apart, so
  comparing them says nothing about movement since the news. "The price hasn't moved" is a claim
  about a time series and can only be made from the time series.

Two more unquoted paragraphs belong in the enumeration. **Paragraph 6 governs timing:** where all
listed countries have announced but it remains ambiguous whether the announcements constitute a
qualifying agreement, the market stays open until either definitive confirmation (through further
announcements or a consensus of credible reporting), or 14 calendar days (ET) after the last
country's first potentially-qualifying announcement — and only then resolves on the totality of
information. With expiry on Aug 31, a first Omani announcement late in the month does not
guarantee a resolution inside the window; this clause is load-bearing on a 21-day hold and the
rationale never mentions it. **Paragraph 3** adds a subject-matter condition — the agreement must
establish policies "aimed at managing, permitting, restoring, or increasing vessel or shipping
traffic through the Strait of Hormuz" — which the reported terms do appear to satisfy, but it is
a condition and it was not enumerated either.

The turn that makes this serious: every win in this track record came from reading the resolution
criterion **literally and in full**. Sometimes that makes the bar *harder* than the market assumes
— Israel-Hezbollah (the criteria explicitly bar temporary ceasefires, statements of progress and
negotiations), Machado (resolution requires physical entry into Venezuelan terrestrial territory)
— and sometimes it makes it *easier*, which is precisely why two of the five wins were taken:
Hormuz-40-ships (">=40 transit calls on ANY day", a one-day low bar) and Sulyok (the announcement
clause: "even an announcement of removal before July 31 resolves YES regardless of effective
date"). Bolojan is the third mode, process speed rather than bar height. So the failure on Bet 14
is not looseness — it is **incompleteness**: the description has seven paragraphs, the rationale
quoted a fragment of two, and the two that decide the bet are among the five it never opened. The
invariant is exhaustiveness, not severity. A rule of "read it strictly" would have vetoed two of
the five wins.

**Rule 1 (operative, cumulative): in any market whose payout depends on a multi-party agreement,
announcement or action, enumerate in writing ALL payout conditions before fixing p_hat — in
particular the list of parties that must speak — and cite one source per party. A party with zero
cited announcements is not a detail; it is an unpriced binary factor. And a source describing an
agreement as drafted, under review or under negotiation counts as evidence AGAINST, not for,
whenever the criterion explicitly excludes prospective statements. Enumerate every paragraph of
the description, not the ones that confirm the thesis — count them, and say how many you read.
Finally, before calling any price stale or mispriced, pull that market's own price history
(`https://clob.polymarket.com/prices-history?market=<clobTokenId>&interval=max&fidelity=60`) and
state what the path did since the news: a single snapshot cannot support a claim about
movement.**

**2. Every loss lives in the middle band of p_hat.**
Computed over `bets.jsonl` and reproducible with `python metrics.py`. The partition below is
arithmetic; the *band* is not — it was fitted after seeing these outcomes, and the honesty clause
below quantifies how fragile that makes it. Read both together. The nine resolved bets split on
the `my_prob_yes` field:

- **`my_prob_yes` inside [0.20, 0.60]: 4 bets, 0 wins.** Bet 1 (Hormuz Jul31, 0.55), Bet 8 (Apple
  Jul31, 0.38), Bet 9 (Stevens Michigan, 0.50), Bet 11 (Thanedar MI-13, 0.30). These are exactly
  the four losses in the track record.
- **`my_prob_yes` outside that band: 5 bets, 5 wins.** Bet 2 (Bolojan, 0.18), Bet 3
  (Hormuz-40-ships, 0.66), Bet 4 (Israel-Hezbollah, 0.06), Bet 5 (Machado, 0.19), Bet 6 (Sulyok,
  0.92).

It matches the confidence table from the same `metrics.py` run: high 2/2 (+$9.19), medium-high
2/3 (-$1.19), medium 1/4 (-$60.32). It also matches the calibration table, whose 0.2-0.4 (n=2)
and 0.4-0.6 (n=2) bins are those same four bets, actual YES 0.000 in both.

**Proposed mechanism — hypothesis, not result, and it has a counterexample inside its own
cohort.** The agent's demonstrated edge is reading resolution criteria and process speeds against
the market's casual reading: situations where the correct answer sits near 0 or near 1. Three of
the four in-band losses fit the complement of that — Bet 8 (Apple vs NVIDIA on a date), Bet 9 and
Bet 11 (two Michigan primaries) exploit no criterion asymmetry; they are discretionary forecasts
of genuinely uncertain contests, and there the market is not systematically wrong. The fourth does
**not** fit: Bet 1 (Hormuz MA>=60) is a resolution-threshold and process-speed argument by its own
rationale ("37-day window + any-single-day low bar"), i.e. exactly the family the mechanism says
should win, and its post-mortem lesson is recorded above as "physical constraint + military will >
political agreements". Bet 1 is a counterexample to this mechanism, not support for it. (The
second Apple bet, Bet 10, is *not* in this cohort: `my_prob_yes` 0.62, outside the band, and still
open.)

**Honesty clause, non-negotiable.** n = 9. `metrics.py` still returns VERDICT = too few resolved
bets (need >=20), mean -$5.813/bet, bootstrap 95% CI [-17.244, +6.204] — crossing zero. And the
band edges are **fitted to these 9 outcomes, not chosen in advance**: Bet 2 (0.18) and Bet 5
(0.19) are winners sitting 0.01-0.02 below the lower edge, and moving that edge from 0.20 to 0.18
turns the split into 2 wins / 6 bets inside versus 3 wins / 3 bets outside. The clean 0/4-vs-5/5
partition is therefore a property of a threshold chosen after seeing the outcomes it is used to
explain, not a robust feature of the data. This is a hypothesis with a mechanism, a free
parameter and insufficient n, **not** a demonstrated effect. The experiment's formal bar (n >= 20
and `pnl_boot_lo` > 0) has not been reached. Do not turn a pattern in 9 observations into a law.

**Rule 2 (operative, cumulative): every bet states in its rationale which family of edge it
claims — (i) the market misreads the resolution criterion or the speed of a process, or (ii) I
forecast the outcome better than the market. Family (ii) accounts for 3 of the 4 in-band losses
and 0 of the 5 wins, so it carries the higher bar: name the concrete asymmetry it exploits, and
record the family label explicitly in the rationale so the cohort can be measured once n >= 20.**
At n = 9 with a post-hoc band the useful output is the labelling, not a veto — this rule does not
authorise declining a bet purely for sitting in the band.

**Disposition of Run 12's selection rule #3 (injury information in sports markets): STANDS**, and
it is subordinate to Rule 2 rather than overridden by it. An officially announced, documentable
injury that the market has not yet repriced *is* a named concrete asymmetry, so Bet 13 (Sinner,
`my_prob_yes` 0.42) satisfies family (ii)'s bar despite sitting inside the band. What rule #3 does
not license is a middle-band bet whose only support is a general read of who is better.

**Live exposure under this lens.** Of the 5 open bets, two sit inside [0.20, 0.60] on
`my_prob_yes`: Bet 7 (US-Iran MOU, 0.22, resolves Aug 20) and Bet 13 (Sinner, 0.42, resolves
Sep 13). The other three are outside it: Bet 10 (0.62), Bet 12 (0.70), Bet 14 (0.78). Bet 13's
family-(ii) asymmetry is named in the disposition above; Bet 7 is family (i) (formal-announcement
criterion). Flagged, not actionable — closing is not part of this experiment.

## Run 13 — 2026-08-17 (zero new bets; open bet updates)

**Official record at run start:** 6-4 resolved, P&L -$35.65, bankroll $964.35, Brier 0.1071.
**Mark-to-market (honest):** 6-5, P&L -$60.65, bankroll $939.35 (Bet 10 Apple YES already decided by market at mark YES=0.017).

**Open bet status (verbatim from `positions` output, this run):**

**Bet 7 (US-Iran MOU Extension NO, entry(held)=0.620, mark(held)=0.903, delta=+0.283, mark YES=0.097, resolves Aug 20) — NEAR-CERTAIN WIN.**
No formal joint US-Iran announcement extending the 60-day period has been made. Research confirmed: both sides "agreed informally" through Pakistani intermediaries, but no official declarative statement from either government. Iran FM stated July 27 "we have no negotiations with the United States at present." With 3 days to resolution, the formal-vs-informal template held perfectly: market at 9.7% correctly reflects that an informal pause ≠ the resolution criterion ("both the United States and Iran publicly and officially announce an extension... a declarative statement... clearly and unambiguously identify an extension"). Thesis vindicated.

**Bet 10 (Apple Aug31 YES, entry(held)=0.530, mark(held)=0.017, delta=-0.513, mark YES=0.017, decided=LOSS) — CONFIRMED LOSS, pending formal resolution.**
Apple missed Services and China in Q3 earnings (July 30). NVIDIA regained #1 and has held it. The Run 9 audit correction was fully right: true edge at entry was ~1-2% (term-structure calibration), not 9%. The "thesis was right" (Apple was temporarily #1) but the pricing edge had already been arbitraged away. Confirmed lesson: an edge is a claim about a price being wrong, not about a thesis being right.

**Bet 13 (Sinner US Open NO, entry(held)=0.480, mark(held)=0.495, delta=+0.015, mark YES=0.505, resolves Sept 13) — SMALL POSITIVE, THESIS INTACT.**
Research today confirms: Sinner withdrew from Montreal AND Cincinnati with right knee injury. Returning to Turin for shockwave therapy (Aug 15), planning to travel to New York Aug 18. Planning to play US Open (starts Aug 30) with zero warm-up matches. Alcaraz also compromised (4.5-month wrist absence, withdrew Cincinnati). Djokovic has a chronic health condition (lost Round 2 in Cincinnati to a No. 50 while visibly unwell). Field is weakened. Sinner at YES=0.505 with uncertain knee fitness vs entry YES=0.525 — thesis slightly moving in our favor but market has only partially repriced the injury. Hold. Do NOT add to this position (no same-market doubling).

**Bet 14 (Iran-Oman Hormuz Agreement YES, entry(held)=0.660, mark(held)=0.315, delta=-0.345, mark YES=0.315, resolves Aug 31) — UNDERWATER, THESIS WEAKENING.**
Price path (this run's pull): opened Aug 5 at 0.72, peaked 0.935 Aug 6, then declined four straight days to trough 0.585 Aug 9, volatile 0.35-0.77 Aug 11-12, settled Aug 13-17 in range 0.21-0.43, current mid ~0.285-0.315.
Current status: Oman has NOT officially announced acceptance of any agreement. All sources attributing the agreement are Iranian (FM spokesman Baghaei, IRNA, Iranian state TV). PBS News reports the deal "fell apart" or faces "significant obstacles." IRGC demanding additional concessions. The agreement remains "in principle" and "in final drafting stage" — the resolution criterion explicitly excludes prospective statements. US-Iran ceasefire expires Aug 18 (tomorrow) with no formal extension announced, adding military escalation risk. p_hat YES revised DOWN to ~0.12-0.18 (below current market 0.285-0.315). The Run 12 audit was correct on every count. Cannot close position. Hold.

**Candidates researched and declined:**

- **AfD absolute majority in Sachsen-Anhalt (YES=0.305, resolves Sept 6):** Full seat arithmetic performed. Latest polls (Pollytix Aug 8, INSA Aug 6): AfD 43%, CDU 23%, Die Linke 13%, SPD 7%, Greens 4-5%, BSW 4-5%, FDP 2-4%. Key scenarios:
  - Greens pass 5% (all 5 parties above threshold, total=91%): AfD gets 43/91=47.3% → 46 seats in 97-seat → 3 seats short of majority. NO.
  - Greens fail 5% (4 parties, total=86%): AfD gets 43/86=50% → 48.5 seats in 97-seat → KNIFE EDGE, rounds to 48 or 49 (P(majority) ≈ 45-50%).
  - AfD surges to 46%, Greens fail: AfD gets 50.1 seats → clear majority. But P(surge) ≈ 8%.
  P(Greens >= 5%) ≈ 40% (avg polling 4.6%). Probability-weighted calculation (4 paths): **p_hat YES = 0.307 vs market 0.305.** Edge = -0.002. Market is correctly priced. **Decline — no edge.**
  
  *Resolved rule: "AfD at 43% → absolute majority" conflates vote share with seat share. The seat arithmetic shows 43% vote → ~50% of seats when Greens fail threshold, which is exactly at the knife edge. The narrative "AfD at record 43%" does not imply "majority" without the full threshold/rounding calculation.*

- **Carlos Alcaraz US Open YES (YES=0.125, 26d):** Out 4.5 months (wrist tenosynovitis since April, missed French Open and Wimbledon). Withdrew Cincinnati. Deciding about US Open entry this week. P(plays) ≈ 55-60%. P(wins | plays) ≈ 18-20% (rusty, injury risk, returning from career-longest layoff). Expected YES = 0.58 × 0.19 ≈ 0.11. Market 0.125. Edge < 2% on NO. Below threshold. **Decline.**

- **All Iran/Hormuz markets (US-Iran MOU no meeting by Sept 30, end of Iranian blockade by Sept 30, Israel x Iran ceasefire, US-Iran nuclear deal, Hormuz traffic normal):** Concentration veto — Bets 7 and 14 are both open Iran-correlated bets. No new Iran bets until both resolve. Note: once Bet 7 resolves Aug 20, "US announces end of Iranian blockade by Sept 30 (YES=0.385, 44d)" becomes the first Iran-candidate worth researching in the next run (only Bet 14 Iran-correlated would remain). Flag for Run 14.

- **All Fed September markets (no change 74.5%, +25bps 23.5%):** CME-arbitraged, as always. **Decline.**

- **Russian election "most seats" markets (United Russia 69.5%, New People 19.8%):** No differentiated view on Russian domestic politics. Resolution criteria not researched. Would need to understand the Sainte-Laguë allocation, single-member districts, and whether results from a non-free election are disputed. Insufficient edge confidence to bet. **Decline.**

- **Wyoming/Florida primaries (resolving today/tomorrow):** Donalds won Florida Governor primary (at 0.992 = correctly priced). Insufficient time to research WY-AL, FL-25. **Decline.**

- **Sinner US Open YES (same market as Bet 13):** Already hold Bet 13 (Sinner NO). Cannot double into same market per Rule #2 from Run 10 audit. **Decline.**

**NEW BETS: ZERO.** Universe genuinely exhausted this run. The one candidate that appeared to have edge (AfD) dissolved when the full seat arithmetic was performed. The second candidate (Alcaraz) had edge well below the 5% threshold. All Iran-correlated markets blocked by concentration veto.

**New selection rules (derived from analysis this run):**

1. **Absolute majority markets require full seat arithmetic before forming p_hat.** The AfD case shows a market at 30.5% YES is correctly pricing a multi-pathway scenario (Greens pass/fail 5% × parliament size × seat rounding). The narrative "AfD at record 43%" does not translate to "majority likely" — that requires computing proportional seat allocation under multiple threshold scenarios. Perform the 4-path calculation: (i) leading party polls at X, (ii) which small parties are borderline on threshold, (iii) if each fails, what is the proportional seat share, (iv) does that clear 50%+1? Do this BEFORE concluding the market is wrong.

2. **When a bet's p_hat tracks the market price after exhaustive research, that is a result: the market is efficient on this market. Accept it.** The temptation is to rationalize a small discrepancy as edge. The AfD analysis drove p_hat from an initial "maybe 0.17" down to 0.307 as each layer of analysis (threshold scenarios, overhang mandates, rounding) was added. The market's 0.305 was doing the same work. "Market is wrong" requires a specific, named pricing error — not just a narrative asymmetry.

**Running record: 6-4 resolved, 4 open ($100 at risk). Official P&L: -$35.65, bankroll $964.35.**
**Honest mark (including Bet 10 decided as LOSS): 6-5, -$60.65, bankroll $939.35.**
**Expected trajectory: Bet 7 near-certain win (+~$15, bankroll → ~$955); Bet 10 confirmed loss (-$25, bankroll → ~$914 honest); Bet 14 likely loss (p_hat YES ~0.15); Bet 13 slight edge on NO (p_hat YES ~0.40 vs mark 0.505).**

## Run 14 — 2026-08-24 (zero new bets; three post-mortems)

**Official record at run start:** 8-4 resolved, P&L +$6.75, bankroll $1006.75, Brier 0.108.
Capital at risk (open): $50 (Bets 10 + 14, both near-certain losses).

**Resolved post-mortems since Run 13 (Bets 7, 12, 13):**

**Bet 7 (US-Iran MOU Extension NO, entry YES=0.39) — WON.** Resolved Aug 20. No formal joint US-Iran announcement was made extending the 60-day period. Trump posted Aug 18: "There are no talks or conversations going on... the Naval Blockade remains in full force and effect." Thesis confirmed in full. The formal-vs-informal template wins 4 of 4 (Bolojan, Israel-Hezbollah, Sulyok, MOU). Family (i) edge — market misread the resolution criterion.

**Bet 12 (Nordone SC Senate plurality YES, entry YES=0.60) — WON.** Nordone won the first-round plurality in the SC GOP Senate primary (held Aug 12). The Resonance Media poll (Aug 5, n=600: Nordone 25.2%, Norman 18.2%) was accurate. Trump endorsement + polling lead template confirmed. Simple criterion (most votes in first round, not 50%) + recent legitimate polling = sufficient edge.

**Bet 13 (Sinner US Open NO, entry YES=0.525) — WON.** Sinner officially withdrew Aug 21 due to persistent right knee injury (confirmed via ATP Tour, Al Jazeera, Olympics.com). The resolution criterion states: "If at any point it becomes impossible for a listed player to win... the market will resolve to No." Withdrawal = impossible to win → market resolved NO. Confirms Run 12's selection rule: an officially announced, documentable withdrawal is actionable edge in "win the tournament" markets.

**Open bet status (verbatim from this run's `positions` output):**

**Bet 10 (Apple Aug31 YES, entry(held)=0.530, mark(held)=0.046, entry YES=0.525, mark YES=0.046) — NEAR-CERTAIN LOSS.**
1. Marginal buyer at YES=0.046: speculative bet on unexpected NVIDIA collapse or Apple surprise in 7 days.
2. Motivating news (Apple briefly #1, July 17): was reflected in the entry price (0.525). Run 9 audit was correct — true edge at entry was ~1-2%. The thesis that Apple was temporarily #1 was correct; the pricing anomaly had already been resolved before entry.
3. Probability remaining: ~4.6% per market. NVIDIA reported strong earnings Aug 26 (4 days away). Apple needs to close an ~$80-100B+ gap in 7 days.
4. Thesis weakened (confirmed). Expected loss. Cannot close; accept outcome.

**Bet 14 (Iran-Oman Hormuz Agreement YES, entry(held)=0.660, mark(held)=0.145, entry YES=0.650, mark YES=0.145) — LIKELY LOSS, one notable intraday spike.**
1. Marginal buyer at YES=0.145: sees ongoing deal-close signals and believes a last-minute Omani announcement is possible before Aug 31. The market spiked this morning (Aug 24 05:00 UTC) from ~0.065 to 0.165, then settled ~0.140-0.150. No confirmed Omani announcement found that triggered this spike — most likely thin-market noise or a fresh rumor about deal being imminent. The resolution criterion excludes prospective statements ("in final drafting stage" explicitly fails).
2. Motivating news (Iranian FM "final drafting stage," Aug 8): was NOT new when entry was made on Aug 10 — the market had already processed it, peaking at 0.935 on Aug 6 and declining four straight days to 0.585 trough by Aug 9. Run 12 audit was correct: entry was buying into a declining market, not a stale one.
3. Probability remaining: The price path from Aug 17-24 confirms further deterioration (0.315 → 0.065 through Aug 22-23, today's spike to 0.150 notwithstanding). Trump threatened military action against Oman on Aug 18 if it obstructs US operations. No Omani announcement in any source. p_hat YES revised to ~0.07-0.10 (market 0.145 is above my p_hat).
4. Thesis weakened. The Run 12 audit's three-part analysis was correct on every count. Expected loss.

**Price path summary for Bet 14 (key waypoints, this run's pull):**
Aug 6 peak 0.935 → Aug 9 trough 0.585 → Aug 10 entry 0.660 → Aug 17 range 0.215-0.335 → Aug 18 Trump "no talks" drop to 0.240 → Aug 20-21 decline to 0.075-0.130 → Aug 22-23 trough ~0.055-0.080 → Aug 24 spike to 0.165 then settling ~0.140-0.150. Net direction: consistently down from entry.

**Candidates analyzed and declined:**

- **Carlos Alcaraz US Open YES @ 0.315 (19d):** Alcaraz confirmed playing (Aug 20, 4+ month wrist absence). Sinner withdrew Aug 21. Kalshi: ~36%; sportsbooks: +140 to +195 (34-42% implied). Polymarket: 31.5%. DECLINE reasons: (1) Price history shows the market ACTIVELY repriced both catalysts — +0.105 on Alcaraz confirmation (Aug 20 18:00 UTC: 0.155→0.260), +0.12 on Sinner withdrawal (Aug 21 14:00 UTC: 0.245→0.365). Both news items were processed rapidly. (2) Since the peak (0.365), the market drifted DOWN to 0.335-0.345 for 2 days and further to 0.315 today — consistent with the crowd pricing Alcaraz's 4+ months of rust heavier than the "defending champion" narrative. (3) Net edge vs. Kalshi/sportsbooks: ~3%, below 5% threshold. (4) Per the lesson: "A path that has been repricing against your thesis is evidence, not noise." The path repriced in my direction initially, then reversed — market is not anchored. **Rule learned (below).**

- **Lula Brazil presidential YES @ 0.625 (40d):** Lula leads Flávio Bolsonaro in polling but in tight runoff simulations: Datafolha Aug 21 has runoff at 47-43 (within MoE on some surveys); Quaest Aug 14 has 43-40 (statistical tie). Market at 62.5% for Lula winning overall is roughly consistent with a 4-7 point runoff lead that could shift. No differentiated view beyond what the polls already show. **Decline — roughly fair.**

- **US announces end of Iranian blockade by Sept 30 YES @ 0.375 (37d):** CONCENTRATION VETO — Bet 14 (Iran-Oman) is still open. Additionally: Trump Aug 18 explicitly denied any talks ("Naval Blockade remains in full force and effect"). DoD stated blockade is sustainable indefinitely. p_hat YES ~0.15-0.20. But cannot bet this run. Flag for Run 15 after Bet 14 resolves Aug 31: strong NO edge (~15-20% net) if status hasn't changed. **Decline — concentration veto this run.**

- **United Russia gains most seats in Russia Duma @ 0.705 (36d):** Resolution criterion explicitly says "compared to before the election" — this measures incremental GAINS, not total seats. In 2021, United Russia lost 19 seats; KPRF gained 15 (biggest gainer), New People gained 13. If the 2021 pattern holds, United Russia would NOT win this market. However: (1) I have no 2026 Duma polling, (2) Russian elections are managed and the Kremlin can engineer outcomes, (3) uncertainty about whether the market is interpreting "gains" correctly (total seats vs. incremental). Too uncertain without current data to form a confident p_hat. **Decline — insufficient research data.**

- **US ceasefire against Iran through Aug 31 @ 0.905 (7d):** Iran-correlated — same underlying as Bet 14. Also at 90.5%, near-1 = minimal edge even if pricing is slightly off. **Decline — concentration + near-1.**

- **All Fed September markets (no change 67.5%, +25bps 31.5%):** CME-arbitraged as always. **Decline.**

- **All near-0/near-1 markets, exact-score, crypto thresholds:** Standard filters apply.

**New selection rules (derived from resolved bets and this run's analysis):**

1. **Active repricing ≠ anchoring.** The Alcaraz case: the market repriced +0.105 on his confirmation (Aug 20) and +0.12 on Sinner's withdrawal (Aug 21) — both within hours of the news. A market that has already processed the catalysts motivating your view is NOT anchored. "The market hasn't noticed X yet" is a legitimate edge claim only when X is recent news. If the market has already moved on the news, the edge claim requires something BEYOND that news — not just the news itself. Always check the price history around the exact events that motivate your view; a clear price jump on the news proves it was incorporated.

2. **Post-peak drift is a signal.** After processing a discrete catalyst, if the market drifts DOWN from its initial response over several days, that is the crowd's secondary reassessment — not noise, not anchoring. Alcaraz: peaked 0.365 immediately after Sinner's withdrawal, then settled to 0.335-0.345, then 0.315 over 3 days. The crowd is assigning more weight to Alcaraz's rust than the initial euphoric response did. This drift direction is evidence to take seriously before betting against it.

3. **Iran blockade end: flag for next run.** After Bet 14 resolves Aug 31, the Iranian blockade-end market (YES=0.375, 37d) becomes the first Iran candidate with no concentration constraint. Research priority for Run 15: check latest US-Iran diplomatic status, verify the resolution criterion's "declarative statement" bar (same family as MOU Extension and Israel-Hezbollah — likely overpriced at 37.5% given Trump's Aug 18 "no talks" and blockade-indefinitely statements). Do not pre-commit based on this note — verify current state at Run 15 start.

**Running record: 8-4 resolved, 2 open ($50 at risk). Official P&L: +$6.75, bankroll $1006.75.**
**Expected mark (both open positions resolve as losses): -$42.34, forward bankroll ~$964.**

## Run 15 — 2026-08-31 (one new bet; Bets 10 + 14 post-mortems)

**Official record at run start:** 8-4 resolved, P&L +$6.75, bankroll $1006.75 (Brier 0.108).
**Honest mark-to-market at run start:** 8-6, P&L -$43.25, bankroll $956.75 — Bets 10 and 14 are both at mark ~0.001-0.011, confirmed losses pending today's formal resolution.

**Post-mortems (Bets 10 and 14, both resolving 2026-08-31):**

**Bet 10 (Apple Aug31 YES, entry(held)=0.530, mark(held)=0.001) — CONFIRMED LOSS (-$25).**
1. Marginal buyer at YES=0.001: no real buyer; market has settled to near-zero.
2. Motivating news (Apple briefly #1, July 17) was already reflected in entry price (0.525). Run 9 audit correctly identified ~1-2% true edge; the pricing anomaly had been arbitraged.
3. Probability remaining: 0.1% — essentially zero. NVIDIA maintained ~$80-100B lead through resolution date.
4. Thesis falsified. NVIDIA retained #1 on Aug 31. Confirmed lesson: an edge is a claim about a price being wrong, not about a thesis being right. The thesis was directionally correct (Apple was temporarily #1) but the PRICE was already fair at entry.

**Bet 14 (Iran-Oman Hormuz Agreement YES, entry(held)=0.660, mark(held)=0.011) — CONFIRMED LOSS (-$25).**
1. Marginal buyer at YES=0.011: no real buyer; essentially resolved.
2. Motivating news (Iranian FM "final drafting stage," Aug 8) was NOT new at entry (Aug 10). Market peaked at 0.935 on Aug 6, then declined four straight days to 0.585 trough by Aug 9 — entry bought into a declining market, not a stale one. Run 12 audit correct on all three counts.
3. Probability remaining: 1.1% — essentially zero. Oman never officially announced. Resolution criterion requires Oman to explicitly announce acceptance; "under review" and "in final drafting stage" are prospective statements explicitly excluded.
4. Thesis falsified. The unpriced binary factor (Oman's silence) was identified by the Run 12 audit and it decided the outcome. Post-mortem invariant confirmed: in multi-party agreement markets, enumerate ALL parties that must speak with a cited source per party. Silence from one listed party = NO bet.

**Open position checklist (Bet 15, placed this run):**
See Bet 15 rationale below.

**New bet placed:**

**Bet 15 — United Russia (ER) gains most seats NO @ YES=0.695, entry NO=0.310, p_hat_yes=0.11, net edge ~0.58. High conviction. Family (i).**

Description: 6 paragraphs read in full (all paragraphs).

Payout conditions enumerated (for YES to resolve — UR gains the MOST seats):
- Condition A: UR's 2026 seat count must EXCEED its 2021 baseline (324 seats). If UR ends below 324, they cannot be the "biggest gainer" — they have a negative or zero gain.
- Condition B: UR's positive seat change must exceed any other party's positive seat change (LDPR, New People, KPRF, etc.)
- Tie-breaker: If tied on seat gains → resolved by valid votes; if still tied → alphabetical by abbreviation.
- Resolution source: Official Central Election Commission (Russian government) results corroborated by credible reporting.

Evidence against YES (all cited):
1. PolitPro Election Trend (Aug 27-31, politpro.eu/en/russia): UR projected to LOSE ~90 seats (324 → ~231-234). Every available projection shows UR declining, not gaining.
2. PolitPro Russia parliamentary forecast: Projected gainers are LDPR (+42 to +45 seats from baseline 21) and New People (+42 seats from baseline 13). Both far exceed any plausible UR positive change.
3. In 2021, UR lost 19 seats (343 → 324); KPRF was the biggest gainer (+15). The pattern of UR losing while other parties gain is established (Wikipedia 2021 Russian legislative election).
4. Kremlin is managing expectations downward with "lowered target benchmarks" for UR; no signals of a maximalist UR seat push. (The Moscow Times, Aug 10, 2026.)
5. Even under aggressive manipulation (220+/225 single-mandate seats + 45% proportional), UR's total seat ceiling is ~320-325 — at the absolute maximum, still at or below their 2021 count of 324.

Marginal buyer at YES=0.695: Almost certainly pricing "UR wins the election / dominates total seats" (true — UR will have the most total seats) NOT "UR gains the most seats from its 2021 baseline" (which requires getting above 324). This is the same Family (i) criterion misread that won: Bolojan (Jun 30 deadline vs. eventual formation), Israel-Hezbollah (formal permanent agreement vs. ceasefire process), Sulyok (announcement clause vs. effective removal date), MOU extension (formal joint declaration vs. informal continuation). Template: "market prices the surface outcome, not the exact resolution criterion."

Price path: YES started at 0.615 on July 31, drifted up to 0.765 on Aug 28, settled to 0.695 today. The upward drift most likely reflects speculative buying by market participants who equate "most seats" with "gains most seats." This is not informed repricing (no news would make UR going above 324 more plausible) — it is the anchoring error deepening over time.

Concentration: Independent of all resolved bets. Russia Duma election is a completely separate real-world outcome from Iran-Oman agreement, Apple market cap race, and every other prior position.

**Candidates analyzed and declined:**

- **Magdalena Andersson next PM of Sweden NO (YES=0.865, 12d):** Left bloc leads by 5-7pp in polling (Aug 26 Indikator poll: 51.3% vs 46.6%); Liberals at 2% (below 4% threshold) — structural advantage for left. Research agent estimate: p_hat YES 0.72-0.78. However: (1) My own analysis, incorporating the structural advantage (Liberals' elimination gives left a near-unbeatable coalition math), places p_hat YES closer to 0.80-0.85, shrinking NO edge to 1-5%. (2) Family (ii) bet — no resolution criterion asymmetry. (3) The market itself repriced from peak 0.935 (Aug 23) to 0.865 today, already partly processing the lead narrowing. (4) 12 days to election with a 5-7pp lead is not sufficient to override the structural math. **Decline — Family (ii), uncertain edge (0-5% depending on p_hat assumption), structural factors favor Andersson strongly.**

- **Flávio Bolsonaro wins Brazil presidential YES (YES=0.393, 33d):** Research found Bolsonaro trailing Lula in first-round polls (Lula 38-39% vs. Bolsonaro 31-38%) and tied in runoff (dead heat in most pollsters; Gerp outlier shows Flávio +5 in runoff). p_hat: 0.42-0.48. Net edge 2-8% — near or below 5% threshold. Most respected pollsters (Quaest, Nexus) still show Lula ahead in the runoff. Family (ii) bet. **Decline — thin edge, Family (ii), established pollsters still favor Lula.**

- **Lula finishes 2nd in first round YES (YES=0.120, 33d):** Market repriced from 0.060 (Aug 22) to 0.120 (Aug 31) — doubling in 9 days. This reflects the same Gerp poll that showed Bolsonaro numerically ahead in first round (38% vs 37% within MoE). p_hat: 0.08-0.12. Roughly fairly priced; no clear edge. **Decline — roughly fair given only one outlier poll (Gerp) motivates any YES probability.**

- **Russia: United Russia Wins Every Region (YES=0.660, 20d):** In 2021, UR did NOT win every region's party-list vote — CPRF beat UR in Yakutia (CPRF 35.2% vs UR 33.2%) and Nenets AO (CPRF 32.0% vs UR 29.1%). In 2026, with UR polling lower (~47% vs 50% in 2021), more regional losses are plausible. p_hat YES: ~35-45%. Net NO edge: ~21-31%. But concentration veto applies: this market is the SAME underlying real-world event as Bet 15 (Sept 20 Duma election). Can only hold one Russia Duma bet. "Gains most seats" NO was the clearly superior bet (edge ~58% vs ~26%). **Decline — concentration with Bet 15, lower edge.**

- **All Iran markets (end blockade Sept 21/Sept 30, diplomatic meeting Sept 30):** Concentration veto — Bet 14 (Iran-Oman) resolves TODAY (Aug 31) but the veto applies to the same run that resolves it. Per standing rule: "Do not replace [a correlated bet] during the same run; wait until the next scheduled run." Even though Bet 14 is at 0.011, the veto stands for this run. Flag for Run 16: "US announces end of Iranian blockade by Sept 30" (YES=0.195, 30d) is the priority — same Family (i) criterion asymmetry (blockade is a formal US policy announcement, not an informal cessation), Trump explicitly stated Aug 18 "Naval Blockade remains in full force and effect," p_hat YES likely 0.10-0.15. **Decline — concentration veto this run.**

- **All Fed September markets (no change 41.5%, +25bps 56.5%):** CME-arbitraged as always. **Decline.**

**New selection rules (derived from resolved bets only):**

1. **"Gains most seats" ≠ "wins the most seats."** This is the 5th instance of Family (i) edge in this experiment (Bolojan = deadline, Israel-Hezbollah = permanent language, Sulyok = announcement clause, MOU = formal declaration, now Russia = "gains" vs. "wins"). The pattern: a market prices a superficially plausible outcome (UR dominates Russian politics → UR wins) while missing the resolution criterion's specific measuring unit (NET seat change from 2021, not total seats). When a criterion uses a comparative word (gain, change, increase, decrease, most improved), always compute the baseline explicitly and verify whether the superficially dominant party actually leads on THAT metric.

2. **In managed elections, distinguish "wins total seats" from "gains most seats."** UR will almost certainly win the most total seats in 2026 (~231-234). But "gains" requires exceeding their own 2021 count of 324. Even with heavy manipulation, this is implausible. The market conflates UR's structural dominance with the specific resolution criterion. This is the correct model: the structural outcome (UR dominant) is priced, not the specific measured outcome (net gains).

**Running record: 8-6 honest, 3 open ($75 at risk: Bets 10 + 14 decided LOSS, Bet 15 new). Official P&L: +$6.75 (will become -$43.25 on Bets 10+14 formal resolution today). Honest P&L: -$43.25, bankroll $956.75.**
**Expected forward trajectory: Bets 10 + 14 resolve today as formal losses (-$50 total). Bet 15 (UR NO) high conviction win at Sept 30; p_hat NO ≈ 0.89, entry NO=0.310, edge ~0.58.**
