"use strict";

/**
 * DOM smoke tests for the 2.0 HUD: boot the three content-script files inside
 * jsdom against a mocked DoD board and check the compact tabbed UI, manual
 * overrides, pass evidence, shortcuts and layout persistence.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const SOURCES = ["src/core.js", "src/probability.js", "tracker.js"]
  .map(file => fs.readFileSync(path.join(__dirname, "..", file), "utf8"));

const openDoms = [];
test.after(() => {
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
  <div id="infoYourTurn"></div>
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
  dom.window.__TICHU_TRACKER_DEBUG__ = true;
  for (const source of SOURCES) dom.window.eval(source);
  openDoms.push(dom);
  return { dom, window: dom.window, document: dom.window.document, errors, api: dom.window.TichuTracker };
}

const settle = (ms = 260) => new Promise(resolve => setTimeout(resolve, ms));
const cardCell = (document, code) => document.querySelector(`#tichu-tracker-hud [data-card="${code}"]`);

test("the compact HUD boots with three tabs and the live recommendation", () => {
  const { document, errors } = boot();
  assert.equal(errors.length, 0, errors.join("\n"));

  assert.ok(document.getElementById("tichu-tracker-hud"));
  assert.equal(document.querySelectorAll("#tichu-tracker-hud .tt-tab").length, 3);
  assert.equal(document.querySelectorAll("#tichu-tracker-hud .tt-panel").length, 3);
  assert.equal(document.getElementById("tichu-tracker-panel-play").hidden, false);
  assert.equal(document.getElementById("tichu-tracker-panel-cards").hidden, true);
  assert.equal(document.getElementById("tichu-tracker-panel-odds").hidden, true);

  // The old long-form sections are gone; one recommendation is the focus.
  assert.equal(document.querySelectorAll(".tt-section-title").length, 0);
  assert.equal(document.getElementById("tichu-tracker-declarations"), null);
  assert.equal(document.getElementById("tichu-tracker-dragon-advice"), null);
  assert.ok(document.querySelector(".tt-action-kind").textContent.length > 0);
  assert.ok(document.querySelector(".tt-action-cards-value").textContent.length > 0);
  assert.ok(document.querySelector(".tt-reason").textContent.length > 0);

  assert.match(cardCell(document, "As").className, /tt-st-hand/);
  assert.match(cardCell(document, "9d").className, /tt-st-hand/);
  assert.match(cardCell(document, "Qc").className, /tt-st-played/);
  assert.match(cardCell(document, "7c").className, /tt-st-unknown/);
});

test("the unseen counter shows four copies minus hand and played cards", () => {
  const { document } = boot();
  const chips = [...document.querySelectorAll(".tt-unseen-chip")];
  assert.equal(chips.length, 13);
  const count = rank => chips.find(chip => chip.querySelector(".tt-unseen-rank").textContent === rank)
    .querySelector(".tt-unseen-count").textContent;
  assert.equal(count("A"), "3");
  assert.equal(count("K"), "3");
  assert.equal(count("Q"), "3");
  assert.equal(count("J"), "4");
});

test("the active Mahjong wish highlights matching ranks", () => {
  const { document } = boot();
  assert.match(cardCell(document, "Kh").className, /tt-wish-card/);
  assert.doesNotMatch(cardCell(document, "As").className, /tt-wish-card/);
});

test("tabs switch panels and the choice is remembered", () => {
  const { window, document } = boot();
  const oddsTab = document.getElementById("tichu-tracker-tab-odds");
  oddsTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  assert.equal(document.getElementById("tichu-tracker-panel-odds").hidden, false);
  assert.equal(document.getElementById("tichu-tracker-panel-play").hidden, true);
  assert.equal(oddsTab.getAttribute("aria-selected"), "true");
  assert.equal(JSON.parse(window.localStorage.getItem("tichu-tracker.layout.v2")).tab, "odds");

  const storage = { "tichu-tracker.layout.v2": JSON.stringify({ tab: "cards" }) };
  const second = boot({ storage });
  assert.equal(second.document.getElementById("tichu-tracker-panel-cards").hidden, false);
  assert.equal(second.document.getElementById("tichu-tracker-tab-cards").getAttribute("aria-selected"), "true");
});

test("clicking a card marks it played manually and the undo button reverts it", () => {
  const { window, document } = boot();
  const cell = cardCell(document, "Kh");
  cell.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  assert.match(cardCell(document, "Kh").className, /tt-st-played/);
  assert.match(cardCell(document, "Kh").className, /tt-manual/);

  const undoButton = document.querySelector('#tichu-tracker-header [data-action="undo"]');
  assert.equal(undoButton.hidden, false);
  assert.equal(undoButton.disabled, false);
  undoButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  assert.match(cardCell(document, "Kh").className, /tt-st-hand/);
  assert.doesNotMatch(cardCell(document, "Kh").className, /tt-manual/);
  assert.equal(undoButton.hidden, true);
});

test("Alt+Shift+T toggles the panel and remembers the choice", () => {
  const { window, document } = boot();
  const body = document.getElementById("tichu-tracker-body");
  const press = () => document.dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "T",
    code: "KeyT",
    altKey: true,
    shiftKey: true,
    bubbles: true
  }));

  assert.notEqual(body.style.display, "none");
  press();
  assert.equal(body.style.display, "none");
  assert.equal(JSON.parse(window.localStorage.getItem("tichu-tracker.layout.v2")).minimized, true);
  press();
  assert.notEqual(body.style.display, "none");
});

test("a saved panel position is restored on the next load", () => {
  const { document } = boot({
    storage: { "tichu-tracker.layout.v2": JSON.stringify({ left: 120, top: 64, width: 360, height: 420 }) }
  });
  const root = document.getElementById("tichu-tracker-hud");
  assert.equal(root.style.left, "120px");
  assert.equal(root.style.top, "64px");
  assert.equal(root.style.width, "360px");
  assert.equal(root.style.height, "420px");
});

test("DoD action text is parsed into a Tichu declaration", async () => {
  const { window, document, errors } = boot();
  const action = document.getElementById("textContainer");
  action.textContent = "Ann called Tichu";
  action.appendChild(document.createElement("span"));
  await settle();

  assert.equal(errors.length, 0, errors.join("\n"));
  const labels = [...document.querySelectorAll(".tt-alert")].map(node => node.textContent);
  assert.ok(labels.some(text => /Tichu/i.test(text)), labels.join(" | "));
});

test("a pass on an unchanged trick becomes hard evidence in the odds model", async () => {
  const { window, document, api } = boot();
  const action = document.getElementById("textContainer");
  action.textContent = "Ann passed";
  action.appendChild(document.createElement("span"));
  await settle();

  assert.equal(api.state.passConstraints.length, 1);
  assert.equal(api.state.passConstraints[0].seat, "L");
  assert.equal(api.state.passConstraints[0].combo.type, "single");
  assert.match(document.querySelector(".tt-model-note").textContent, /pass constraint/i);
});

test("Greek action verbs are recognised instead of relying on ASCII word boundaries", () => {
  const { api } = boot();
  assert.equal(api.actionLooksLikePlay("Ο Bob έπαιξε 9♠"), true);
  assert.equal(api.actionLooksLikePlay("Ο Bob έπαιξαν"), true);
  assert.equal(api.actionLooksLikePass("Η Ann πέρασε"), true);
  assert.equal(api.actionLooksLikePass("Η Ann πάσο"), true);
});

test("the Odds tab shows per-seat combo probabilities and a hand plan", () => {
  const { document } = boot();
  const rows = [...document.querySelectorAll(".tt-odds tbody tr")];
  assert.equal(rows.length, 3);
  for (const row of rows) {
    const cells = [...row.querySelectorAll("th, td")];
    assert.equal(cells.length, 7);
    assert.match(cells[2].textContent, /%|—/);
    assert.match(cells[3].textContent, /%|—/);
    assert.match(cells[4].textContent, /%|—/);
    assert.match(cells[5].textContent, /%|—/);
  }
  assert.match(document.querySelector(".tt-plan").textContent, /Plan:/);
});

test("collapsing hides the tab strip too, leaving only the header", () => {
  const { window, document } = boot();
  const tabs = document.querySelector("#tichu-tracker-hud .tt-tabs");
  const body = document.getElementById("tichu-tracker-body");
  assert.notEqual(tabs.style.display, "none");
  document.dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "T", code: "KeyT", altKey: true, shiftKey: true, bubbles: true
  }));
  assert.equal(tabs.style.display, "none");
  assert.equal(body.style.display, "none");
  assert.equal(document.getElementById("tichu-tracker-hud").dataset.collapsed, "true");
});

test("the Play tab turns into a Grand Tichu decision card", async () => {
  const { document } = boot();
  const hand = document.getElementById("hand");
  hand.replaceChildren();
  for (const card of ["DRAGON", "PHOENIX", "As", "Ah", "Ad", "Ac", "Ks", "Kh"]) {
    const node = document.createElement("div");
    node.className = "card";
    node.setAttribute("card", card);
    hand.append(node);
  }
  document.getElementById("txtRound").textContent = "Round 9";
  document.getElementById("cardsHolder").replaceChildren();
  document.getElementById("textContainer").textContent = "New deal";
  await settle(500);
  assert.equal(document.querySelector(".tt-action-kind").textContent, "DECIDE");
  assert.match(document.querySelector(".tt-action-cards-value").textContent, /finish first|Hand index/i);
  assert.equal(document.querySelector(".tt-more-summary").textContent, "Why this call?");
});

test("a detached HUD is rebuilt and painted on the next scan", async () => {
  const { document } = boot();
  document.getElementById("tichu-tracker-hud").remove();
  const action = document.getElementById("textContainer");
  action.textContent = "Cara played 9d";
  action.appendChild(document.createElement("span"));
  await settle();

  const rebuilt = document.getElementById("tichu-tracker-hud");
  assert.ok(rebuilt);
  assert.match(rebuilt.querySelector('[data-card="As"]').className, /tt-st-hand/);
  assert.ok(rebuilt.querySelector(".tt-action-kind").textContent.length > 0);
});

test("arrow keys move between tabs", () => {
  const { window, document } = boot();
  const playTab = document.getElementById("tichu-tracker-tab-play");
  playTab.focus();
  playTab.dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "ArrowRight", code: "ArrowRight", bubbles: true
  }));
  assert.equal(document.getElementById("tichu-tracker-tab-cards").getAttribute("aria-selected"), "true");
  assert.equal(document.getElementById("tichu-tracker-panel-cards").hidden, false);
});
