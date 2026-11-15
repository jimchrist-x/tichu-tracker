# DoD Games Tichu Tracker

A browser content script that adds a compact Tichu card tracker, hidden-hand odds and a move advisor to the game board on [www.dod.gr](https://www.dod.gr/). It only reads information the page already shows: your hand, public plays, trade slots, opponent card counts, the action log and the Mahjong wish. It never reads an opponent's hidden hand.

Current version: **2.0.0**.

---

## What is new in 2.0

2.0 is a UI and inference rewrite, not just a feature patch.

- **Much smaller UI.** The old panel stacked eight dense sections. The HUD now has three tabs — **Play**, **Cards** and **Odds** — one recommendation card, a few chips and a collapsed “Why this play?” section. The Dragon and Tichu advisors appear only when they are relevant.
- **Hidden-hand odds with pass evidence.** A player who passed on a combination is hard evidence that they could not beat it. Those observations now constrain the sampled hands, which sharpens every ownership estimate. The model falls back to a uniform deal and says so if the evidence conflicts.
- **Combo-presence probabilities.** The Odds tab answers questions like “how likely is Left to hold a bomb or a full house right now?” with a 95% interval for every seat.
- **Minimum-play hand plan.** The tracker computes the fewest legal plays needed to empty your hand, so “shed cards” advice is tied to a concrete route out.
- **Simulated Tichu / Grand Tichu odds.** A fast heuristic playout estimates the chance you finish first, the chance your team finishes first, and the chance of a 1–2 finish. Grand Tichu samples the six unseen cards before evaluating the call.
- **Team-aware threat estimates.** “No response” used to count your partner as a threat. It now separates opponents who can beat your play from a partner who can beat it, which is usually good news.
- **Faster tracking.** Structural combination generation replaces the 2¹⁴ subset scan on every render, and unchanged board scans exit immediately. The fallback poll is slower and no longer repaints the HUD needlessly.
- **Bugs fixed** include Greek action verbs never matching because of ASCII `\b`, wish parsing treating an unrelated number as a wish, a stale actor after the action log was cleared, and missing straights when the Mahjong was in hand. See [DESIGN-REVIEW.md](DESIGN-REVIEW.md) for the full list.

---

## Using the panel

### Play tab

The Play tab answers one question: **what should I do now?**

- A large action card shows **LEAD**, **PLAY**, **PASS**, **WAIT** or **DECIDE** with the recommended cards and combination.
- One line explains the reason.
- Up to three chips summarise the **plan**, the chance the play **holds the trick**, and the **opponent bomb risk**.
- Alerts appear only when they matter: an opponent down to one card, a bomb risk above 35%, a Tichu call, unresolved cards, or a paused model.
- **Why this play?** expands to the sampled-deal estimate, alternatives, partner information and model confidence.
- During the initial eight-card deal the tab becomes a **Grand Tichu decision card** instead of suggesting a play before the deal is complete.

### Cards tab

The compact 4×13 grid is the ledger.

- **Blue** cards are in your hand.
- **Gold** cards are traded or selected for a trade.
- **Dim/struck-through** cards have been played.
- **Dashed gold** means a card left your hand but public evidence has not confirmed where it went.
- A gold inset ring marks a **manual** played override.
- A gold outline marks every card matching the active **Mahjong wish**.

The unseen row shows how many copies of each rank are neither in your hand nor played. Click any card to mark it played manually; the ↶ button in the header undoes the last mark. Manual marks are your observations, not page evidence, and are cleared by Reset.

### Odds tab

| Column | Meaning |
| --- | --- |
| **Cards** | Remaining cards for that seat |
| **Bomb** | Chance the hand contains a four-of-a-kind or straight-flush bomb |
| **Full** | Chance the hand contains a full house |
| **Str** | Chance the hand contains a straight |
| **K+** | Chance the hand contains a King, Ace, Dragon or Phoenix |
| **Beats** | Chance the hand can beat the current table combination |

Below the table are the **hand plan**, the **simulation** summary and the model note (sample count, pass constraints, ledger reconciliation).

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Alt` + `Shift` + `T` | Collapse / restore the panel |
| `Alt` + `Shift` + `R` | Reset the tracked round |
| `Alt` + `Shift` + `C` | Copy a diagnostics snapshot |
| `Alt` + `Shift` + `1/2/3` | Switch to Play / Cards / Odds |

Shortcuts are ignored while typing in an input, textarea or contenteditable element.

---

## How the estimates work

### Ledger

The tracker reconciles a 56-card ledger from:

1. the cards in your hand,
2. cards that appear in public play containers,
3. committed outgoing trades (which give a known owner),
4. manual marks,
5. the opponents' visible remaining-card counts.

If the ledger conflicts — for example, a card is in your hand and also on the board while DoD animates — estimates pause instead of inventing a distribution. Cards that cannot fit into any opponent's hand are kept in an explicit **out-of-hand** bucket; the tracker does not force them into a hidden hand.

### Uniform hidden-hand model

The baseline model distributes unseen card identities uniformly across the remaining opponent hand slots. Exact per-card and “at least one of these cards” probabilities use the hypergeometric distribution. When pass evidence or an out-of-hand bucket is present, per-card and “at least one” odds are taken from the same sampled worlds as the Odds tab, so the numbers stay consistent.

### Pass evidence

When the action log says a player passed while an unchanged, classified combination was on the table, the tracker records a constraint: that player does not hold a combination capable of beating it. Sampling rejects worlds that contradict the constraint. This is the strongest free information in Tichu and often changes the odds substantially.

The tracker is deliberately conservative: it only records a pass when the table signature did not change between scans and the actor was recognised. Conflicting evidence (for example, a card known from a trade that would have allowed a beat) falls back to the unconstrained model with a warning.

### Combo presence

For each sampled world and each seat, the rules engine checks whether that hand contains at least one bomb, full house, straight, pair run, triple, pair or K+ card. The fraction of worlds gives the probability; a Wilson interval communicates sampling uncertainty.

### Simulated playout

The simulation samples opponents' hands (respecting known trades and pass constraints), then plays the hand out with a deterministic heuristic policy:

- lead long combinations, keep control cards and defer bombs;
- feed a partner who is nearly out with the Dog;
- take a trick cheaply, but do not spend a top control card on a low single while the hand is long;
- pass when the partner is winning unless going out immediately;
- model the Dragon gift and the Dog handoff.

It reports **you first**, **partner first**, **team first** and **1–2 finish**. This is a strength estimate, not a solved game. The policy does not model Mahjong wishes, trick points, opponent tendencies or team score. Treat the number as a second opinion, not a promise.

### Move recommendation

The recommendation combines:

- the minimum-play hand plan,
- combination cost (breaking pairs, spending Dragon/Phoenix/Aces),
- the active Mahjong wish (a legal wished reply is preferred),
- partner ownership of the current trick,
- opponents down to one card,
- the sampled probability that an opponent can beat the candidate,
- the number of cards the play sheds.

It is a heuristic advisor, not perfect-information play, and it says so in the expanded details.

---

## Installation

The extension itself needs only these files:

```text
.
├── icons/
├── manifest.json
├── tracker.css
├── tracker.js
└── src/
    ├── core.js
    └── probability.js
```

`test/`, `preview/`, `package.json` and `.github/` are development-only. The `preview/` folder contains a mocked DoD board for inspecting the HUD without a game.

### Chromium-based browsers

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the repository root.
4. Confirm that **Tichu Tracker** is enabled.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on…**.
3. Select `manifest.json`.
4. Temporary add-ons persist only for the current browser session.

---

## Development

No build step is required. Tests run on Node 20 or newer:

```bash
npm install
npm test
```

The test suite covers:

- `test/logic.test.js` — card normalisation, combination rules, bombs, straights, the exhaustive-vs-fast beat check, probability reconciliation and the legacy API compatibility layer.
- `test/engine.test.js` — structural combo generation equivalence, minimum-play plans, pass constraints, combo presence, the playout, known-trade deals, the Grand Tichu decision and structured recommendations.
- `test/hud.test.js` — jsdom boot of the three content scripts, tabbed layout, card states, manual overrides, pass evidence, Tichu calls, shortcuts, collapse and layout persistence.

`npm test` runs on GitHub Actions for every push and pull request; a separate workflow checks JavaScript syntax and validates the manifest.

### Preview harness

```bash
npm run preview
# open http://localhost:8765/preview/index.html
```

The preview page mocks the DoD board and exposes buttons to deal strong/weak/Grand Tichu hands, play a card, pass, call Tichu and toggle the turn. It is the fastest way to check the HUD without a live table.

### Debug API

On `localhost` (or when `window.__TICHU_TRACKER_DEBUG__` is set before the scripts load), the tracker exposes `window.TichuTracker` with the ledger, recommendation, odds and diagnostics helpers. It is not exposed on dod.gr.

---

## Limitations

- The recommendation is heuristic. It does not model opponent tendencies, team score, trick points, or every partner intention.
- The playout policy is intentionally simple and deterministic; its percentages are comparative, not authoritative.
- Pass evidence depends on DoD exposing a recognisable pass action while the trick is stable. A missed pass only removes information; it does not corrupt the ledger.
- Tichu-call recognition depends on the action text. A missing call is not proof that nobody declared.
- Per-player captured-point totals are not reliably exposed by the page, so the Dragon adviser cannot use them.
- Tracking that starts mid-hand keeps unobserved identities in an out-of-hand bucket; early-hand probabilities are less precise in that case.
- The DOM selectors and card-code conventions are DoD-specific and may need updating if the site changes.

---

## Design review

The 2.0 rewrite was driven by a design review of the 1.5 codebase. The full list of identified problems, fixes and remaining trade-offs is in [DESIGN-REVIEW.md](DESIGN-REVIEW.md).

---

## Changelog

### 2.0.0

- Rewrite: pure rules/probability core in `src/core.js` and `src/probability.js`; the DOM layer is now only responsible for reading the board and rendering.
- Simplified three-tab HUD with progressive disclosure; removed the always-on declaration/Dragon sections and long duplicated explanatory text.
- Added pass-constrained hidden-hand sampling and pass-adjusted card probabilities.
- Added per-seat bomb / full-house / straight / K+ presence probabilities with Wilson intervals.
- Added minimum-play hand planning.
- Added Monte Carlo Tichu and Grand Tichu odds, including a proper six-card completion for Grand Tichu.
- Added team-aware threat estimates (partner beats are not treated as threats).
- Added a Grand Tichu decision card instead of a premature play recommendation.
- Fixed Greek action verbs, wish parsing, stale action text, Mahjong straights and the Phoenix lead value.
- Added fingerprint-based scan skipping, structural combo generation and slower fallback polling for lower CPU use.
- Added tab persistence, collapsible tab strip, SVG copy icon, ARIA labels and an accessible tabbed layout.
- Added engine tests, a mocked preview harness and a syntax workflow covering all source files.

### 1.5.0

- Manual played overrides with reversible undo.
- Unseen-copies-by-rank counter and wish highlighting.
- Tichu vs Grand Tichu call tracking.
- Diagnostics snapshot and keyboard shortcuts.
- Persisted panel position, size and collapsed state.
- Node test suite and CI workflows.
- Fixes for the action-context paint order, the `#trading` fallback and the non-existent `document.getById`.

### 1.4.1

- Ledger reconciliation, sampled response estimates and Dragon gift advice refinements.
