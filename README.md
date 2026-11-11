# DoD Games tichu tracker

A browser content script that adds a live Tichu card-tracking and strategy panel to the game board on [www.dod.gr](https://www.dod.gr/). It tracks information visible in the page, estimates the distribution of unseen cards, and offers heuristic suggestions while you play.

Current version: **1.5.0** (also shown in the panel header).

## Features

- **Live 56-card ledger** — tracks the 52 standard cards and the four special cards: Dragon, Phoenix, Dog, and Mahjong.
- **Played-card tracking** — marks cards as played when they appear in the public board/seat areas. A card disappearing from your hand alone is not treated as proof that it was played.
- **Manual card overrides** — click any card cell (or focus it and press Enter/Space) to mark it as played when DoD's DOM misses a play. Manual marks are drawn with a gold ring, are listed in the warning row, and can be reverted one at a time with the **↶** button.
- **Unseen-by-rank counter** — a compact row shows how many copies of each rank are neither in your hand nor played yet, so counting Aces, Kings and Queens never needs mental arithmetic.
- **Trade tracking** — records outgoing trade selections, commits them when the exchange completes, and tracks incoming cards when they can be identified.
- **Hidden-hand probabilities** — estimates which opponent may hold an unseen card, including Dragon, Phoenix, Aces, and cards above a Queen. Known traded cards are assigned to their recorded recipient.
- **Move recommendations** — suggests leads, replies, or passes; classifies common combinations and bombs; considers the active Mahjong wish, your partner's lead, and opponents who are down to one card.
- **Sampled response estimates** — estimates how often a modeled remaining hand could beat the current table combination, with an uncertainty interval when available.
- **Tichu declaration advisor** — gives a heuristic Grand Tichu assessment for the initial eight cards and a Tichu assessment before the first play.
- **Dragon gift advisor** — recommends which opponent to give the Dragon-winning trick to, primarily using the opponents' remaining card counts and any recognized declaration calls.
- **Observed declaration log** — records whether a recognized call was Tichu or Grand Tichu per seat.
- **Dog handoff handling** — recognizes that playing Dog ends the trick and transfers the lead to your partner.
- **Movable, minimizable, remembered HUD** — drag the header to reposition the panel, resize it from the corner, and use `—` / `+` to minimize or restore it. Position, size and collapsed state are stored in `localStorage` and restored on the next load.
- **Wish highlighting** — every card that matches the active Mahjong wish gets a gold outline.
- **Diagnostics snapshot** — the **⧉** button copies a JSON summary of the tracker state (hand, played cards, trades, calls, counts, version) for bug reports.
- **Automatic updates** — watches for game-board DOM changes and also performs periodic fallback scans.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Alt` + `Shift` + `T` | Minimize / restore the panel |
| `Alt` + `Shift` + `R` | Reset the tracked round |
| `Alt` + `Shift` + `C` | Copy the diagnostics snapshot |

Shortcuts are ignored while typing in an input, textarea or contenteditable element.

## Requirements

- A supported [www.dod.gr](https://www.dod.gr/) Tichu game page with the expected game-board elements.
- A browser that supports Manifest V3-style content scripts (for example, a compatible Chromium or Firefox setup).
- The extension files: `manifest.json`, `tracker.js`, and `tracker.css`.

The JavaScript uses the page's existing DOM structure and selectors, so significant changes to [www.dod.gr's](https://www.dod.gr/) game interface may require code updates. The stylesheet is separate: make sure `tracker.css` is included by the extension so the panel and card states are styled correctly.

## Installation

### 1. Prepare the Extension Directory

Clone the repository or download the source files to your local machine. Ensure the root directory matches the following file structure:

```text
.
├── icons/
├── manifest.json
├── README.md
├── tracker.css
└── tracker.js
```

`test/`, `package.json` and `.github/` are only needed for development; the extension itself loads just the files above.

### 2. Load the Extension in Your Browser

#### Chromium-Based Browsers (Chromium, Google Chrome, Brave, Microsoft Edge)

1. Open the browser and navigate to `chrome://extensions/`.
2. Enable **Developer mode** using the toggle switch in the top-right corner.
3. Click **Load unpacked** in the top-left action bar.
4. Select the root directory containing `manifest.json`, `tracker.js`, `tracker.css`, and `icons/`.
5. Confirm that **Tichu Tracker** appears in your extensions list and is enabled.

#### Mozilla Firefox

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Navigate to the extension directory and select the `manifest.json` file.
4. Confirm that the extension is listed under **Temporary Extensions**. *(Note: Temporary add-ons in standard Firefox builds persist only for the current browser session and must be reloaded after a browser restart.)*

## Usage

1. Start or join a Tichu game on [www.dod.gr](https://www.dod.gr).
2. Keep the tracker panel visible while playing. It updates as the page's hand, table, trade slots, and player card counts change.
3. Use the panel's card grid to review card status. Hover over a card cell for the tracker's current details and, when available, estimated opponent ownership.
4. If a play was not detected (for example because the trick resolved during a DOM rebuild), click the card to mark it played manually. Use **↶** if you marked the wrong card.
5. Read **Move recommendation (heuristic)** for a suggested lead, response, or pass.
6. Check **Hand probabilities** for estimates about special/high cards and the chance a player can beat the current combination.
7. Review **Tichu declaration advisor** before declaring, and **Dragon gift adviser** after winning a trick with Dragon.
8. If tracking gets out of sync, use **Reset** (or `Alt`+`Shift`+`R`) to clear the ledger and let it rebuild from the current visible game state.

## Card-state legend

- **Blue — Hand:** the card is currently detected in your hand.
- **Gold — Traded:** the card is recorded as sent or selected for a trade.
- **Dim — Played:** the card has been observed in public-play areas, or you marked it manually. Manual marks additionally carry a gold inset ring.
- **Gold outline — Wish:** the rank currently wished with the Mahjong.
- **Unknown:** the card has not been conclusively identified as in your hand, traded, or played. Estimates may appear in its tooltip.
- **Unresolved:** the card temporarily disappeared from your hand, but the tracker has not yet found public-board or trade evidence to confirm its destination. Click it to resolve the entry manually.

Trade selections remain provisional until the exchange is committed. The tracker intentionally avoids treating drag animations or temporary card disappearance as confirmed plays.

## How estimates work

The tracker does **not** read opponents' hidden hands. It builds a ledger from your detected hand, public plays, recognized trades, and visible remaining-card counts. Unknown card identities are modeled as uniformly distributed among the remaining opponent hand slots, subject to the known information. If tracking starts partway through a hand, the model can keep unidentified cards in an explicit “out-of-hand” category rather than forcing them into an opponent's hand.

When the ledger is inconsistent—for example, because the page is still animating or a card transition was missed—the tracker pauses uncertain probability estimates and reports the issue rather than presenting them as reliable. Monte Carlo estimates describe what the sampled hands *could* beat; they do not predict what an opponent will actually choose to play.

Manual marks are your own observations, not page evidence. They are treated as known facts for the rest of the hand (and cleared by **Reset**), which is why they are visually distinguished and reversible.

## Limitations

- Recommendations are heuristic, not guaranteed optimal. They do not model every strategic factor, such as opponents' tendencies, team score, or all possible partner intentions.
- Probability estimates rely on a uniform hidden-card distribution and accurate visible card counts. They can be unavailable or less reliable if tracking starts mid-hand or the board is changing.
- Tichu-call recognition depends on the action text being exposed in a recognizable form. A call not recorded by the tracker does not prove that no call was made.
- The Dragon gift adviser cannot use per-player captured-point totals because the current tracker does not reliably obtain them from the page.
- The tracker depends on [www.dod.gr's](https://www.dod.gr) current DOM selectors and card-code conventions. Website changes may break detection until the script is updated.

## Development

The tracker core is plain JavaScript with no build step. Tests run on Node 20 or newer:

```text
npm install
npm test
```

- `test/logic.test.js` covers card normalization, combination classification, bomb ordering, the exhaustive-vs-fast beat check, wish parsing, declaration advice, the probability ledger and the Dragon gift heuristic.
- `test/hud.test.js` boots `tracker.js` inside jsdom against a mocked DoD board and checks HUD rendering, the unseen counter, manual overrides, the undo button, keyboard shortcuts, layout persistence and Tichu-call parsing.
- `tracker.js` exports its internals through `module.exports` when it is loaded in Node, which is what the tests use. In a browser it stays an isolated IIFE.

`npm test` is also run by GitHub Actions on every push and pull request.

## Changelog

### 1.5.0

- Fix: a newly observed Tichu declaration was only rendered on the following scan; the HUD now resolves the action context before painting.
- Fix: hand-only trade detection required `#tradingContainer`, so builds exposing `#trading` never used that fallback.
- Fix: the “your turn” check no longer relies on the non-existent `document.getById`.
- Fix: manual marks, persisted layout and diagnostics no longer depend on a HUD that DoD may have detached.
- Add: click-to-mark manual played overrides with a reversible undo history.
- Add: unseen-copies-by-rank counter and Mahjong-wish highlighting.
- Add: Tichu vs Grand Tichu call tracking, shown in the panel and used by the Dragon adviser.
- Add: diagnostics snapshot button and keyboard shortcuts.
- Add: persisted panel position, size and collapsed state.
- Add: Node test suite and CI workflows.

### 1.4.1

- Ledger reconciliation, sampled response estimates and Dragon gift advice refinements.
