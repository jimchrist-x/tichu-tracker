# Tichu Tracker 2.0 — design review

This document records the problems found in the 1.5 codebase, what 2.0 changed, and what is still deliberately approximate. It is a companion to the README, not a promise that the model is optimal.

The short version: 1.5 had a good ledger but a monolithic architecture, a very noisy UI and a probability model that ignored the best free information in the game (passes). 2.0 separates the rules engine from the DOM layer, makes the panel three tabs, and turns observed passes into hard constraints on the sampled hidden hands.

---

## 1. Architecture

### 1.1 One 2,600-line file mixed four responsibilities

`tracker.js` contained:

- card and combination rules,
- the visible-card ledger,
- probability sampling and Monte Carlo estimates,
- all DOM reading,
- all HUD construction, layout persistence and event wiring.

That made the pure logic impossible to load without a browser and encouraged hidden coupling: probability functions read and mutated the global `state` directly. It also meant a UI bug could break the rules engine and vice versa.

**2.0:** split into:

- `src/core.js` — card model, combination classification, structural combo generation, planning, `handCanBeatCombo`, statistics helpers. No DOM.
- `src/probability.js` — explicit ledger/context building, hypergeometric and sampled probabilities, combo presence, playout, advisors. No DOM.
- `tracker.js` — DOM reads, the round state machine, HUD rendering and events. It consumes the two core namespaces.

The files are classic-script IIFEs (content scripts cannot be ES modules without more manifest work), expose `globalThis.TichuTrackerCore` / `TichuTrackerProbability`, and still support `require()` in Node.

### 1.2 Probability functions depended on ambient global state

`buildProbabilityContext()`, `cardProbability()` and `probabilityOfAny()` read `state.inHand`, `state.played` and `state.unresolved` from a module global. Tests had to mutate that global, and two different hypothetical hands could not be evaluated at the same time.

**2.0:** `buildProbabilityContext(counts, ledger, options)` takes an explicit ledger. The context carries `inHand`, `played`, `unresolvedCards`, `knownBySeat`, `knownOwner`, slots and pass constraints. The tracker has a thin compatibility wrapper for the old state-driven API used by the existing tests.

### 1.3 One cache key was not enough

The old code cached a single sample set (`probabilityCacheWorlds`) and a single combo-threat map. A change in one part of the ledger silently invalidated another part; stale `_trackerThreat` values could survive on cached combo objects.

**2.0:** caches are keyed by the full context signature (hand, played, unresolved, known owners, slots, pass constraints), the requested sample count and the combo signature. `clearProbabilityCaches()` is called on every ledger invalidation. Candidate combo objects are freshly generated per recommendation, so a threat cannot leak from a previous board state.

---

## 2. Logic bugs fixed

### 2.1 Greek action verbs never matched

`actionLooksLikePlay()` used `\bplayed\b|Έπαιξε`, but JavaScript `\b` is ASCII-only. `\b` before a Greek letter does not match, so a Greek action log could fail to identify a play or an actor. This affected actor tracking, Tichu calls and pass detection.

**Fix:** match verb stems directly with `u`/`i` flags and no ASCII word-boundary assumption. Added tests for `Ο Bob έπαιξε 9♠`.

### 2.2 Wish parsing turned unrelated numbers into wishes

The fallback in `parseWishRank()` took the last rank-like token anywhere, so text such as “Round 12” could become a wish. Wish text could also be missed when the keyword was followed by other words.

**Fix:** accept a bare rank (`K`, `10`) or a rank following wish/asked language, with a token boundary. `Round 12` now returns `null`.

### 2.3 A cleared action log froze the actor

`actionChanged` required a non-empty action text. If DoD cleared the action log and later displayed the same text again, the tracker never saw a change, so the actor and pass evidence went stale.

**Fix:** compare including the empty string. A transition to empty is a change, and the next non-empty action is re-processed.

### 2.4 Mahjong hands lost most straights

`generateCombos()` started its straight window at rank 1 whenever the Mahjong was present. That correctly built 1-2-3-4-5, but skipped straights such as 2-3-4-5-6 that do not use the Mahjong. The exhaustive reference implementation did not have this bug, which is why an equivalence test was valuable.

**Fix:** scan all windows starting at 1, using rank 1 only when the Mahjong is actually in hand. Added a regression test for both 1-5 and 2-6.

### 2.5 Phoenix was overvalued as a lead in the playout

`makeSingle("PHOENIX")` used `cardRank("PHOENIX") === 14.5`, which is correct when the Phoenix is *following* a single but wrong when it is *led*. Leading the Phoenix as a 14.5 single made the playout treat it as nearly unbeatable.

**Fix:** the single is stored as rank 1.5 for leading. `canBeat()` already implements the “0.5 above the previous single, never above the Dragon” rule for replies.

### 2.6 “No response” counted the partner as an opponent

`evaluateComboThreat()` counted any of L/P/R as a threat. A lead that the partner can beat is usually good for the team, but the model penalised it as if an opponent had taken the trick.

**Fix:** the threat object now reports:

- `probability` — no *opponent* can beat the play (keeps the trick for the team),
- `cleanProbability` — nobody can beat it,
- `partnerBeat` — the partner can beat it (positive information, shown in details).

### 2.7 The sample size was too small to display a percentage

The old model used 24 sampled worlds and printed percentages as if they were stable. A 24-sample estimate has a ±20-point 95% interval near 50%.

**Fix:** 160 worlds by default (320 maximum), Wilson intervals for every seat/kind, and the interval in the tooltip. The model note states the sample count and whether pass constraints were applied.

### 2.8 A pass was ignored

This was the largest missed opportunity. In Tichu, a pass on a combination is hard evidence: if a player could not beat it then, the subset of that hand they hold now cannot beat it either. The old tracker never used pass evidence.

**Fix:** the action log is parsed for pass verbs (English and Greek). A pass is recorded only when:

- the table signature is unchanged between scans,
- the current table cards still classify as a legal combination,
- the actor is recognised,
- the passer is not the player who just played.

Worlds that contradict a constraint are rejected. If acceptance is too low (conflicting evidence), the model falls back to the unconstrained deal and labels it.

### 2.9 Known trades were ignored by the playout

After the exchange, the cards you sent have known owners. The 1.5 probability model respected this for per-card odds, but the new playout initially dealt opponents' hands from the full unseen pool.

**Fix:** `buildDeals()` seeds each opponent with `knownBySeat` cards and fills the remaining slots, for both the Tichu and Grand Tichu simulations. A test asserts a traded card appears in the recipient's hand in every sampled deal.

### 2.10 The Dragon adviser was permanently visible

The 1.5 panel always rendered the Dragon gift advice, even when no Dragon was on the table, and it was one of eight dense sections. Most of the time it was irrelevant noise.

**Fix:** the Dragon advice is computed only for a visible Dragon and shown as an alert while the relevant trick is on the table. The rule text lives in the tooltip/expanded details.

### 2.11 UI state could point at a detached HUD

The old code sometimes kept references to card cells after DoD replaced the HUD container. 1.5 had already fixed several cases; 2.0 rebuilds all element references when `createHud()` recreates the panel, and every render checks `root.isConnected`.

---

## 3. UI / UX problems

### 3.1 Too many sections, too much prose

The 1.5 panel showed, at once:

- 52 card cells,
- specials,
- unseen counts,
- round/wish/counts/calls/status/trades/warnings,
- move recommendation,
- hand probabilities,
- declaration advisor,
- Dragon adviser,
- legend.

Every section also contained long explanatory paragraphs. The information was useful but the panel was a wall of text during a timed card game.

**2.0:** three tabs with one job each.

- **Play** — one recommendation, one reason, at most three chips, conditional alerts, one collapsed “Why this play?”.
- **Cards** — the ledger, unseen counts, trades and the legend.
- **Odds** — the seat table, hand plan, simulation and model note.

Long prose moved into tooltips and the collapsed details. Permanent sections became conditional alerts.

### 3.2 The status row repeated the same information

The old status line mixed ledger health, unresolved counts and model state. It was updated on every scan, sometimes several times per second.

**Fix:** a small sync pill in the header (`Live` / `Paused` / `Waiting` / `Error`) carries the short state; the full reason is in its tooltip. The model note in Odds carries the sample/ledger details.

### 3.3 No way to focus on one decision

There was no concept of “the current action”. The move recommendation was buried between probabilities and declarations.

**Fix:** the Play tab leads with a large action card. During Grand Tichu it becomes a **DECIDE** card rather than recommending a play from an incomplete eight-card hand.

### 3.4 Collapse did not really collapse

The 1.5 panel hid the body but the new tab strip would remain if moved outside the body. 2.0 hides both body and tabs, shrinks the root to `min-height: 0`, and records `data-collapsed`.

### 3.5 Tabs were not persisted

Position, size and collapsed state were persisted; the selected section was not.

**Fix:** the active tab is stored in the same layout object (`tichu-tracker.layout.v2`). The layout key was intentionally bumped so a 1.5 panel size cannot distort the new tabbed layout.

### 3.6 The copy glyph was a tofu box in some fonts

`⧉` is not present in every system font. The 2.0 header uses an inline SVG copy icon, so it renders everywhere.

### 3.7 Accessibility

Card cells were clickable divs with a `title` but no accessible name. Tabs did not exist. Buttons had titles but no `aria-label`.

**Fix:** tabs use `role="tablist"`/`role="tab"`/`aria-selected`/`aria-controls`; panels use `role="tabpanel"`; card cells are keyboard-focusable buttons with `aria-label` describing state; header buttons have `aria-label`; the minimised state sets `aria-expanded`.

### 3.8 Unnecessary information density

Removed or demoted:

- the permanent legend (now a single line on Cards),
- the duplicated “hand probabilities” explanatory paragraph (now the model note/tooltips),
- the always-on declaration and Dragon sections (conditional),
- the separate calls row (now an alert plus a line in the Cards meta),
- the manual-mark warning row (now an alert only when present).

---

## 4. Probability and strategy features added

### 4.1 Combo-presence probabilities

The model now answers “what might they hold?” per seat:

- bomb (four-of-a-kind or straight flush),
- full house,
- straight,
- pair run,
- triple,
- pair,
- K or higher.

It reuses `handCanBeatCombo()` with a minimal synthetic combination as a “contains at least one” detector. Bombs use a dedicated detector because a rank-1 single probe would also match a lone Dragon/Phoenix.

### 4.2 Minimum-play hand plan

A bounded DFS over structurally generated combinations finds the fewest legal plays needed to empty the hand, with a tie-break that avoids spending bombs and high control cards. A greedy fallback protects the HUD in pathological states. The plan is used as a lead-scoring bonus and displayed in Odds.

### 4.3 Monte Carlo Tichu / Grand Tichu odds

The playout samples opponents' hands and plays the round with a deterministic heuristic policy. It reports finish position, team-first and 1–2 finish probabilities. Grand Tichu samples the six unseen cards, so the call decision is based on a **completed 14-card hand**, not just the strength of the first eight cards.

### 4.4 Team-aware recommendation

Lead and reply scoring now use the probability that no *opponent* can beat the candidate. Partner capability is reported separately. A partner who can beat your lead is not treated as a reason to avoid it.

### 4.5 Pass-adjusted per-card odds

When pass constraints exist, per-card ownership tooltips and “at least one” probabilities are computed from the same sampled worlds as the Odds tab, so the numbers no longer contradict each other.

---

## 5. Performance

### 5.1 Exhaustive combination enumeration on every render

`enumerateCombos()` walks all 2¹⁴ subsets and classifies each one. Measured on a random 14-card hand: about 100 ms and 750 legal combos. The HUD called it on every render, and `renderHud()` could run several times per second.

**Fix:** `generateCombos()` builds representative combinations structurally (pairs, triples, full houses, straights, pair runs, bombs) in roughly 1–3 ms. An equivalence test compares its `(type, count, rank)` set with the exhaustive enumerator on 30 random hands. The exhaustive version remains the reference implementation.

### 5.2 Every fallback poll repainted the HUD

A 1.5-second interval called the full scan and render even when nothing had changed.

**Fix:** a board fingerprint (round, hand, board cards, action text, counts, wish, trade selections, trading phase) short-circuits unchanged scans. The fallback interval is now 3 seconds. Manual actions set `forceRender` so they still repaint immediately.

### 5.3 The probability model was recomputed per section

Threat estimates, presence and the simulation were computed independently and repeatedly.

**Fix:** the context signature keys world caches, threat caches, presence caches and simulation caches. The Odds simulation is lazy (only on the Odds tab) except during a declaration window, where it is needed for the call decision.

---

## 6. Remaining limitations / next steps

These are deliberate trade-offs, not hidden bugs.

1. **The playout policy is simple.** It does not model trick points, team score, opponent tendencies, Mahjong wishes or deliberate sandbagging. It is a comparative strength estimate.
2. **Pass inference is conservative.** A missed pass only loses information. A misattributed actor could add a wrong constraint; the unchanged-signature requirement reduces that risk but does not eliminate it. A future version could require two independent scans of the same pass.
3. **Dragon point totals are unavailable.** The page does not reliably expose captured points, so the Dragon gift heuristic uses card counts and observed calls only.
4. **Mid-hand tracking has an out-of-hand bucket.** That is the honest representation, but early-hand odds are necessarily less precise.
5. **The DOM is still DoD-specific.** The live lobby and game shell were inspected, but a logged-in four-player table could not be reached in the review environment. The selectors and card-code aliases remain the main integration risk; the mocked preview and jsdom tests protect the logic, not a future DoD rewrite.
6. **No build step.** Three IIFE files are simple to load and test, but a future version could use a bundler and ES modules if the manifest target allows it.
7. **No persistent history across rounds.** The ledger resets by design. A per-session log of calls, trades and results would enable opponent modelling, which is the natural next informational edge.

---

## 7. Verification performed

- 58 automated tests pass (`npm test`): rules, probability, planning, playout, pass evidence, known trades, recommendation, Grand Tichu decision, jsdom HUD, keyboard/layout, Greek actions.
- Structural combo generation was compared with exhaustive enumeration on random 14-card hands.
- The real `manifest.json` was loaded into Chromium and injected into a mocked DoD board served on a `www.dod.gr` origin. The content scripts, CSS and HUD loaded with no page errors, which validates the manifest wiring beyond the jsdom tests.
- The HUD was rendered in headless Chromium against the `preview/` mocked board at 1440×900, including Play/Cards/Odds, Grand Tichu, pass evidence and collapsed states.
- The live `www.dod.gr` lobby and Tichu app shell were inspected. A real table requires an authenticated account; no game-state DOM was available without joining one, so the selectors were not re-validated against a live deal.
