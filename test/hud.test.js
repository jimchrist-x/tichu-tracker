"use strict";

/**
 * DOM smoke tests: boot the content script inside jsdom against a fake DoD
 * board and check the HUD wiring (card states, manual overrides, shortcuts,
 * persisted layout). These guard the parts of tracker.js that cannot run in
 * plain Node.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "tracker.js"), "utf8");

const openDoms = [];
test.after(() => {
  // The tracker installs a periodic fallback scan and MutationObservers; close
  // every window so the test process can exit cleanly.
  for (const dom of openDoms) dom.window.close();
  openDoms.length = 0;
});

const BOARD = `<!doctype html>
<html><body>
  <div id="txtRound">Round 3</div>
  <div id="nickholder_left"><div id="minis"><span class="mini_fontSmall">13</span></div><div class="playerName">Ann</div></div>
  <div id="nickholder_up"><div id="minis"><span class="mini_fontSmall">14</span></div><div class="playerName">Bob</div></div>
  <div id="nickholder_right"><div id="minis"><span class="mini_fontSmall">12</span></div><div class="playerName">Cara</div></div>
  <div id="hand">
    <div class="card" card="As"></div>
    <div class="card" card="Kh"></div>
    <div class="card" card="PHOENIX"></div>
    <div class="card" card="9d"></div>
  </div>
  <div id="cardsHolder"><div class="card" card="Qc"></div></div>
  <div id="txtAskedCard">Wish: K</div>
  <div id="txtLastAction"><div id="textContainer">Bob played Qc</div></div>
</body></html>`;

function boot(options = {}) {
  const dom = new JSDOM(options.html || BOARD, {
    url: "https://www.dod.gr/tichu/table",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  if (options.storage) {
    for (const [key, value] of Object.entries(options.storage)) {
      dom.window.localStorage.setItem(key, value);
    }
  }
  const errors = [];
  dom.window.console.error = (...args) => errors.push(args.join(" "));
  dom.window.eval(SOURCE);
  openDoms.push(dom);
  return { dom, window: dom.window, document: dom.window.document, errors };
}

const settle = (ms = 220) => new Promise(resolve => setTimeout(resolve, ms));

const cardCell = (document, code) => document.querySelector(`#tichu-tracker-hud [data-card="${code}"]`);

test("the HUD boots against a DoD-style board and mirrors the visible hand", () => {
  const { document, errors } = boot();
  assert.equal(errors.length, 0, errors.join("\n"));

  const hud = document.getElementById("tichu-tracker-hud");
  assert.ok(hud, "HUD should be created");
  assert.ok(hud.querySelector("#tichu-tracker-advice"));
  assert.ok(hud.querySelector("#tichu-tracker-probabilities"));

  assert.match(cardCell(document, "As").className, /tt-state-hand/);
  assert.match(cardCell(document, "9d").className, /tt-state-hand/);
  assert.match(cardCell(document, "Qc").className, /tt-state-played/);
  assert.match(cardCell(document, "7c").className, /tt-state-unknown/);
});

test("the unseen counter shows four copies minus hand and played cards", () => {
  const { document } = boot();
  const cells = [...document.querySelectorAll("#tichu-tracker-unseen .tt-unseen-cell")];
  assert.equal(cells.length, 13);
  // RANKS order: A K Q J T 9 8 7 6 5 4 3 2
  const count = rank => cells.find(cell => cell.querySelector(".tt-unseen-rank").textContent === rank)
    .querySelector(".tt-unseen-count").textContent;
  assert.equal(count("A"), "3"); // As in hand
  assert.equal(count("K"), "3"); // Kh in hand
  assert.equal(count("Q"), "3"); // Qc played
  assert.equal(count("J"), "4");
});

test("the active Mahjong wish highlights matching ranks", () => {
  const { document } = boot();
  assert.match(cardCell(document, "Kh").className, /tt-wish-card/);
  assert.doesNotMatch(cardCell(document, "As").className, /tt-wish-card/);
});

test("clicking a card marks it played manually and the undo button reverts it", () => {
  const { window, document } = boot();
  const cell = cardCell(document, "Kh");
  cell.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  assert.match(cardCell(document, "Kh").className, /tt-state-played/);
  assert.match(cardCell(document, "Kh").className, /tt-manual/);
  assert.doesNotMatch(cardCell(document, "Kh").className, /tt-state-hand/);

  const buttons = document.querySelectorAll("#tichu-tracker-header .tt-controls button");
  const undoButton = buttons[1];
  assert.equal(undoButton.disabled, false);
  undoButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  assert.match(cardCell(document, "Kh").className, /tt-state-hand/);
  assert.doesNotMatch(cardCell(document, "Kh").className, /tt-manual/);
  assert.equal(undoButton.disabled, true);
});

test("Alt+Shift+T toggles the panel and remembers the choice", () => {
  const { window, document } = boot();
  const body = document.getElementById("tichu-tracker-body");
  const press = () => window.document.dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "T",
    code: "KeyT",
    altKey: true,
    shiftKey: true,
    bubbles: true
  }));

  assert.notEqual(body.style.display, "none");
  press();
  assert.equal(body.style.display, "none");
  const stored = JSON.parse(window.localStorage.getItem("tichu-tracker.layout.v1"));
  assert.equal(stored.minimized, true);

  press();
  assert.notEqual(body.style.display, "none");
  assert.equal(JSON.parse(window.localStorage.getItem("tichu-tracker.layout.v1")).minimized, false);
});

test("a saved panel position is restored on the next load", () => {
  const { document } = boot({
    storage: { "tichu-tracker.layout.v1": JSON.stringify({ left: 120, top: 64, width: 360, height: 420 }) }
  });
  const hud = document.getElementById("tichu-tracker-hud");
  assert.equal(hud.style.left, "120px");
  assert.equal(hud.style.top, "64px");
  assert.equal(hud.style.width, "360px");
  assert.equal(hud.style.height, "420px");
});

test("DoD action text is parsed into a Tichu declaration", async () => {
  const { window, document, errors } = boot();
  const action = document.getElementById("textContainer");
  action.textContent = "Ann called Tichu";
  // Any mutation wakes the observer, which debounces a board scan.
  action.appendChild(document.createElement("span"));
  await settle();

  assert.equal(errors.length, 0, errors.join("\n"));
  const calls = document.querySelector("#tichu-tracker-meta .tt-meta-row span");
  const labels = [...document.querySelectorAll("#tichu-tracker-meta .tt-meta-row span")].map(node => node.textContent);
  assert.ok(labels.some(text => /Calls:.*Left Tichu/.test(text)), labels.join(" | "));
  assert.notEqual(calls, null);
  assert.ok(window.document.getElementById("tichu-tracker-hud"));
});
