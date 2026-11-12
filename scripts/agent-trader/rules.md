# Agent-Trader — rules in force

The rules currently in force, distilled from `lessons.md`; read this file in full every run. `lessons.md` is the history behind them.
Curated by the operator from `lessons.md`: later results and review corrections replace earlier rules, so only the current version appears here.
Propose a new rule in your run's `lessons.md` section on a line starting `**Proposed rules:**` (the operator folds it in). Never edit `rules.md` yourself.

These rules add to `agent-trader-prompt.md`; they do not repeat it. Each one names the bet, run or review it comes from.

## Reading the resolution criterion

- An "effective ceasefire" or "no strike for N days" can resolve on observed inactivity without any agreement. Read the exact description before applying the formal-act template; identify the qualifying strikes, actors, territory, window-start deadline and reporting delay, then estimate from a documented strike calendar. Run 26 applied the formal-act template without reading the description; Run 27 corrected it for 6831494/5/6. [Runs 26-27, 6831495]
- Find out what instrument measures the outcome before estimating it. Hormuz "normal" resolved on IMF Portwatch's 7-day average of AIS-visible transit calls; dark (AIS-off) transits, a large share of real traffic, did not count, and official claims of 55 ships/day were not Portwatch-countable. [Bets 1 and 3, Runs 1-3]
- Price "on any single day" thresholds and sustained averages as different problems. A one-day spike cleared ">=40 transits on any day" despite suppressed traffic; a 7-day moving average >=60 in the same strait never came close. [Bet 3 won, Bet 1 lost; Run 6]
- Look for an announcement clause. "An announcement of removal before the deadline resolves YES regardless of effective date" made a constitutional removal resolve on the parliamentary vote, not the later effective date. [Bet 6, Runs 6-7]
- When the criterion requires a formal, declarative, official act (a joint extension announcement, a permanent peace agreement, an official end of a blockade), list what does NOT qualify: informal pauses, back-channel talks, "both parties still want a deal", drafts, ceasefires, temporary MOUs. Markets repeatedly priced the existence of the process rather than the act the criterion names. [Bets 2, 4, 7, 16, 17; Runs 4, 7, 19]
- That template has earned a prior, not immunity. When its price moves against you, answer in writing what the marginal buyer would have to know that you do not, and accept the bet as a test of the criterion reading if the honest answer is "nothing". [Review correction 2026-08-02, Bet 7]
- Distinct legal acts are distinct criteria even in the same conflict: a ceasefire is not a blockade termination, and a ceasefire announcement does not resolve a market that needs a blockade-end declaration. Identify the specific act the criterion requires, not whether the situation is "improving". [Bet 16, Runs 18-19]
- Stated intent is not physical ability. Where the criterion requires a physical event (entry into a country's terrestrial territory, a strait reaching a transit count), documented barriers (no carrier willing to fly, closed airspace, mines with a months-long clearance operation) bind over statements and political agreements. [Bet 5 won, Bet 1 lost; Runs 6-9]
- Tournament markets usually say a player who can no longer win resolves No. An officially announced, documented injury (withdrawals from several events, no warm-up matches) that the price has not absorbed is a usable edge; a general view of who is better is not. [Bet 13, Run 12 and Review correction 2026-08-10]
- Check whether an election market pays on a plurality, a majority or the final nominee after a runoff; "most votes in the first round" with a recent independent poll lead is a different question from winning the nomination. [Bet 12, Runs 12 and 14]

## Probability and evidence

- An edge is a claim that a price is wrong, not that a thesis is right. Apple briefly being #1 was true; by entry the price was already fair, and the bet lost. [Review correction 2026-07-27, Bet 10]
- Before betting a later expiry of the same underlying, check the term structure: calibrate volatility so the market you already hold is fair, then price the later expiry with it. Bet 10's claimed 9-point edge was 1-2 points under that check. [Review correction 2026-07-27, Bet 10]
- For "state on an exact date" markets, list every scheduled event (earnings, votes, announcements) near the resolution date and price it separately. A random-walk spread model ignores a point event; Apple's earnings miss one day before resolution decided Bet 8. [Bet 8, Run 12]
- State every figure with its direction and its source, and link the source. Bet 11 inverted a poll's direction and dropped the informed-ballot number; a poll that reports a topline and an informed ballot is quoted with both or not used. A number without a link does not go into `lessons.md` or a rationale. [Review correction 2026-08-03, Bet 11]
- Campaign money predicts votes only when it is raised from supporters. Self-loans measure the candidate's wealth, not support. [Bet 11, Review correction 2026-08-03 and Run 12]
- After a major candidate withdraws, do not trust the race's new shape until at least two independent, nonpartisan polls taken after the exit agree; a poll taken three days after the exit missed the consolidation. [Bet 9, Runs 10 and 12]
- Rules come from resolved bets, documented failures or operator corrections. A rule you invent in the same run that unlocks that run's bet is the signal to decline it. [Review correction 2026-08-03]
- Label every bet's edge family in the rationale: (i) the market misreads the criterion or the speed of a process, or (ii) you forecast the outcome better than the market. A family-(ii) bet must name the concrete thing the market has not priced (an official injury, a documented procedural deadline); "the polls look better to me" is not one. [Review correction 2026-08-10]
- Label the family honestly. A thesis that rests on a projection or forecast is family (ii) even when it quotes the criterion; Bet 15 called a bad seat projection a criterion misread and inflated its confidence. [Bet 15, Run 18]
- A `p_hat` that leaned on pages you could not open is not a defended edge. Re-derive it from what you did open, starting from a base rate built from a documented event list (e.g. strikes per month over the last year). [Runs 23-24, Pakistan-Afghanistan market]
- When declining for insufficient edge, state the contemporaneous executable entry, fees and conservative probability, and show that they fail the threshold. If uncertainty invalidates the original estimate, give the revised estimate or say it is not defensible; do not describe an above-threshold calculation as below threshold. Crossing the spread is already in executable entry and must not be deducted twice. [Review 2026-11-12, Run 27, 6831495]

## Price history and timing

- Read the whole series: fetch it in full, find its max and min, and narrate every regime before writing about the path. Run 17 read the first 5 and last 20 of 744 points, called a post-crash floor "stable at the recent high", and missed a 0.055 trough and a 0.295 spike; the reviewer vetoed it. [Run 17 veto]
- If the price jumped within hours of the news that motivates you, that news is in the price, and your edge has to rest on something beyond it. Read the intraday series before estimating a probability on a same-day catalyst; the candidate-list price shows only the end state. Bet 14 entered after a four-day slide from a 0.935 peak that had already absorbed the "agreement reached" story; the Saudi pipeline moved from 0.31 to 0.90 in about seven hours. [Bet 14, Runs 14-15; Run 26, 5401796]
- Drift after the first reaction to a catalyst is the crowd's second assessment, not noise. Weigh it before betting against it. [Bet 14, Run 14]
- On strict-criterion markets, a sharp spike that reverses within hours to a day is informed traders rejecting the news as non-qualifying. Treat the reversal as evidence for the strict reading, not as an opening. [Bet 16, Runs 16-17]
- A market created after the motivating news is not barred: `record` accepts it when its `createdAt` is later than `news_at` and its hourly series starts within 24 h of creation. Judge the edge against the opening price, which already carries the news. Set `news_at` to when the evidence actually appeared; never move it to fit a series. [Review correction 2026-11-02]
- Say where a series starts only by quoting `history <id>`; do not infer it. Run 23 wrote that a series "starts Nov 1" when it started two hours after creation on Oct 30. [Review correction 2026-11-02]

## Concentration and exposure

- Never add to a market you already hold, even when your edge looks larger after an adverse move; if you misread the criterion, adding doubles the error. [Run 10, Review correction 2026-08-02]
- Wanting more exposure to a theme is never a reason to take a correlated bet: that impulse is what the veto blocks. Before each new bet, ask which single real-world event could move it and an open position together, not whether the topics sound different. Run 11 cleared a Michigan primary as "independent of Iran/Apple" while holding another Michigan primary decided the same night. [Review corrections 2026-08-02 and 2026-08-03, Bets 9 and 11]

## Tooling and process

- Take every price from the Gamma/CLOB API yourself. A research subagent once reported a 93.5% market as 37%. [Run 5]
- Label any source you did not open (403, 404, paywall, timeout) as headline- or snippet-only, in lessons and in the proposal. Never quote it as read and never let it carry a payout condition. [Runs 20 and 22; Review correction 2026-08-10]
- Searching: long natural-language queries to `web_search` return junk and guessed publisher URLs return 404/403. Use `news_search` for dated headlines, short title-style queries, and Wikipedia polling tables opened with WebFetch. [Run 22]
- `is_researchable` takes the question string, not the candidate dict. [Run 22]

## Market families

- Fed and other rate-decision markets track CME FedWatch within a few points; research reproduces the rates curve. Skip them. [Runs 1, 7, 23]
- Heavily traded elections with no criterion misreading to exploit (national races on the eve of the vote, US midterm control) are family (ii) with no named edge. Decline them unless you can name the concrete thing the price misses. [Review correction 2026-08-10; Bets 9 and 11]
