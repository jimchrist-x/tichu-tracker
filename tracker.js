/**
 * DoD.gr Tichu Tracker 2.0 — browser content script.
 *
 * The DOM layer only reads what the page already shows: your hand, public
 * plays, trade slots, opponent card counts, the action log and the wish. Hidden
 * hands are never read. All inference lives in src/core.js and
 * src/probability.js so it can be tested without a browser.
 *
 * UI in 2.0 is intentionally small: one recommendation, three tabs
 * (Play / Cards / Odds) and progressive disclosure for the long explanations.
 */
(() => {
  "use strict";

  const Core = (typeof require === "function" && typeof module !== "undefined")
    ? require("./src/core.js")
    : globalThis.TichuTrackerCore;
  const Prob = (typeof require === "function" && typeof module !== "undefined")
    ? require("./src/probability.js")
    : globalThis.TichuTrackerProbability;

  const {
    ALL_CARDS, CARD_SET, SPECIAL_DEFS, SUITS, RANKS, ASC_RANKS,
    TURN_ORDER,
    normalizeCardCode, isStandardCard, displayCard, displayCards, classifyCombo,
    comboLabel, percent, percentRange, handPlan, enumerateCombos
  } = Core;

  const VERSION = "2.0.0";
  const LAYOUT_STORAGE_KEY = "tichu-tracker.layout.v2";
  const FLASH_STATUS_MS = 2600;
  const SETTINGS = {
    worlds: 160,
    simSamples: 56,
    midSimSamples: 32
  };

  const PLAY_CONTAINERS = [
    "#cardsHolder", "#boardCardsHolder",
    "#centerHolderLeft", "#centerHolderRight", "#centerHolderBottom", "#centerHolderUp",
    "#cardsHolderLeft", "#cardsHolderRight", "#cardsHolderBottom", "#cardsHolderUp"
  ];

  const PLAYER_DEFS = [
    { key: "L", label: "Left", holderId: "nickholder_left", tradeId: "tradingHolderLeft", cardsId: "cardsHolderLeft" },
    { key: "P", label: "Partner", holderId: "nickholder_up", tradeId: "tradingHolderUp", cardsId: "cardsHolderUp" },
    { key: "R", label: "Right", holderId: "nickholder_right", tradeId: "tradingHolderRight", cardsId: "cardsHolderRight" }
  ];
  const ME_DEF = { key: "ME", label: "You", holderId: "nickholder_bottom", cardsId: "cardsHolderBottom" };
  const PLAYER_BY_KEY = new Map([...PLAYER_DEFS, ME_DEF].map(player => [player.key, player]));
  const TABS = [
    { id: "play", label: "Play" },
    { id: "cards", label: "Cards" },
    { id: "odds", label: "Odds" }
  ];

  const state = {
    currentRoundText: "",
    inHand: new Set(),
    everInHand: new Set(),
    tradedOut: new Map(),
    tradedIn: new Set(),
    pendingTrades: new Map(),
    played: new Set(),
    manualPlayed: new Set(),
    manualHistory: [],
    unresolved: new Map(),
    preTradeHand: new Set(),
    unmappedSpecials: new Set(),
    tradingActive: null,
    lastActionText: "",
    lastTableSignature: "",
    lastPlayActor: null,
    lastTableCards: [],
    lastNonPhoenixSingleRank: null,
    tichuCalls: new Map(),
    passConstraints: [],
    ignoreBoardForScan: false,
    scanTimer: null,
    scanInProgress: false,
    forceCommitTrades: false,
    forceRender: false,
    lastFingerprint: "",
    observer: null,
    observedRoot: null,
    fallbackScanTimer: null,
    bootTimer: null,
    clickListenerAttached: false,
    keyListenerAttached: false,
    viewportListenerAttached: false,
    minimized: false,
    layout: null,
    resizeObserver: null,
    flashStatus: null,
    flashTimer: null,
    activeTab: "play",
    lastAnalysis: null,
    probabilityContext: null
  };

  const hud = {
    root: null,
    body: null,
    titleVersion: null,
    syncDot: null,
    syncText: null,
    tabButtons: new Map(),
    panels: new Map(),
    tabs: null,
    cardCells: new Map(),
    specialCells: new Map(),
    unseenCells: new Map(),
    actionKind: null,
    actionCards: null,
    actionSub: null,
    reason: null,
    chips: null,
    alerts: null,
    details: null,
    detailsSummary: null,
    handMeta: null,
    oddsRows: new Map(),
    plan: null,
    modelNote: null,
    sim: null,
    statusTitle: null,
    undoBtn: null,
    copyBtn: null,
    resetBtn: null,
    minBtn: null
  };

  // -------------------------------------------------------------------------
  // Layout persistence
  // -------------------------------------------------------------------------

  function loadStoredLayout() {
    try {
      const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function saveLayout(patch) {
    state.layout = { ...(state.layout || {}), ...patch };
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(state.layout));
    } catch (_) { /* storage can be blocked by privacy settings */ }
  }

  function applyStoredLayout(root) {
    if (state.layout === null) state.layout = loadStoredLayout() || {};
    const layout = state.layout || {};
    if (Number.isFinite(layout.left) && Number.isFinite(layout.top)) {
      root.style.right = "auto";
      root.style.left = `${Math.max(0, Math.min(layout.left, Math.max(0, window.innerWidth - 120)))}px`;
      root.style.top = `${Math.max(0, Math.min(layout.top, Math.max(0, window.innerHeight - 80)))}px`;
    }
    if (Number.isFinite(layout.width) && layout.width >= 280) {
      root.style.width = `${Math.min(layout.width, window.innerWidth)}px`;
    }
    if (Number.isFinite(layout.height) && layout.height >= 160) {
      root.style.height = `${Math.min(layout.height, window.innerHeight)}px`;
    }
    if (typeof layout.tab === "string" && TABS.some(tab => tab.id === layout.tab)) {
      state.activeTab = layout.tab;
    }
  }

  function clampToViewport(root) {
    if (!root || !root.style) return;
    if (!root.style.left || root.style.left === "auto") return;
    const rect = root.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const maxLeft = Math.max(0, window.innerWidth - Math.min(rect.width, window.innerWidth));
    const maxTop = Math.max(0, window.innerHeight - Math.min(rect.height, window.innerHeight));
    const left = Math.min(maxLeft, Math.max(0, rect.left));
    const top = Math.min(maxTop, Math.max(0, rect.top));
    if (Math.round(left) !== Math.round(rect.left)) root.style.left = `${left}px`;
    if (Math.round(top) !== Math.round(rect.top)) root.style.top = `${top}px`;
  }

  function observeHudSize(root) {
    if (typeof ResizeObserver !== "function" || !root) return;
    if (state.resizeObserver) state.resizeObserver.disconnect();
    let timer = null;
    const observer = new ResizeObserver(() => {
      if (state.minimized) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        if (!hud.root || !hud.root.isConnected || state.minimized) return;
        if (!root.style.width && !root.style.height) return;
        saveLayout({ width: Math.round(root.offsetWidth), height: Math.round(root.offsetHeight) });
      }, 300);
    });
    observer.observe(root);
    state.resizeObserver = observer;
  }

  function setMinimized(minimized, persist = true) {
    state.minimized = Boolean(minimized);
    if (hud.body) hud.body.style.display = state.minimized ? "none" : "";
    if (hud.tabs) hud.tabs.style.display = state.minimized ? "none" : "";
    if (hud.root) hud.root.dataset.collapsed = String(state.minimized);
    if (hud.minBtn) {
      hud.minBtn.textContent = state.minimized ? "+" : "—";
      hud.minBtn.title = state.minimized
        ? "Restore tracker (Alt+Shift+T)"
        : "Collapse tracker (Alt+Shift+T)";
      hud.minBtn.setAttribute("aria-expanded", String(!state.minimized));
    }
    if (persist) saveLayout({ minimized: state.minimized });
  }

  function makeDraggable(container, handle) {
    let offsetX = 0;
    let offsetY = 0;
    let isDragging = false;
    let moved = false;
    handle.style.touchAction = "none";
    handle.addEventListener("pointerdown", event => {
      if (event.target.closest("button")) return;
      isDragging = true;
      moved = false;
      const rect = container.getBoundingClientRect();
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      container.style.right = "auto";
      try { handle.setPointerCapture(event.pointerId); } catch (_) { /* optional */ }
    });
    handle.addEventListener("pointermove", event => {
      if (!isDragging) return;
      const maxLeft = Math.max(0, window.innerWidth - Math.min(container.offsetWidth, window.innerWidth));
      const maxTop = Math.max(0, window.innerHeight - Math.min(container.offsetHeight, window.innerHeight));
      container.style.left = `${Math.min(maxLeft, Math.max(0, event.clientX - offsetX))}px`;
      container.style.top = `${Math.min(maxTop, Math.max(0, event.clientY - offsetY))}px`;
      moved = true;
    });
    const stopDragging = () => {
      if (!isDragging) return;
      isDragging = false;
      if (!moved) return;
      saveLayout({ left: Math.round(container.offsetLeft), top: Math.round(container.offsetTop) });
    };
    handle.addEventListener("pointerup", stopDragging);
    handle.addEventListener("pointercancel", stopDragging);
    handle.addEventListener("lostpointercapture", stopDragging);
  }

  // -------------------------------------------------------------------------
  // DOM reading
  // -------------------------------------------------------------------------

  function noteUnmapped(code) {
    state.unmappedSpecials.add(code);
  }

  function extractCardCode(cardEl) {
    if (!cardEl) return null;
    const attr = cardEl.getAttribute("card") || cardEl.getAttribute("data-card");
    if (attr) return normalizeCardCode(attr, noteUnmapped);
    const bg = cardEl.querySelector(".cardbg");
    if (bg) {
      for (const className of bg.classList) {
        if (className.startsWith("_") && className.length > 1) {
          return normalizeCardCode(className.slice(1), noteUnmapped);
        }
      }
    }
    return null;
  }

  function isElementVisible(element) {
    if (!element || !element.isConnected) return false;
    let current = element;
    while (current && current.nodeType === 1) {
      const style = window.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
      if (current.hidden) return false;
      current = current.parentElement;
    }
    return true;
  }

  function getSeatCardCount(holderId) {
    const holder = document.getElementById(holderId);
    if (!holder) return null;
    const numberEl = holder.querySelector("#minis .mini_fontSmall, #minis .mini_fontBig");
    if (numberEl) {
      const value = Number.parseInt(numberEl.textContent.trim(), 10);
      if (Number.isFinite(value)) return value;
    }
    const minis = holder.querySelector("#minis");
    if (!minis) return null;
    // An empty #minis container is meaningful: that player has no cards left.
    return minis.querySelectorAll(".mini_card").length;
  }

  function readCounts() {
    return {
      L: getSeatCardCount("nickholder_left"),
      P: getSeatCardCount("nickholder_up"),
      R: getSeatCardCount("nickholder_right")
    };
  }

  function getTradeContainer() {
    for (const id of ["tradingContainer", "trading"]) {
      const container = document.getElementById(id);
      if (container && isElementVisible(container)) return container;
    }
    return null;
  }

  function getTradingPhaseActive() {
    if (isElementVisible(document.getElementById("btnSend"))) return true;
    const trading = getTradeContainer();
    if (trading && trading.querySelector(".card")) return true;
    return PLAYER_DEFS.some(player => {
      const holder = document.getElementById(player.tradeId);
      return Boolean(holder && isElementVisible(holder) && holder.querySelector(".card"));
    });
  }

  function inferTradeTarget(cardNode) {
    const parent = cardNode.closest(
      "#tradingHolderLeft, #tradingHolderUp, #tradingHolderRight, .tradingHolderLeft, .tradingHolderUp, .tradingHolderRight"
    );
    if (parent) {
      const token = `${parent.id} ${parent.className}`;
      if (token.includes("tradingHolderLeft")) return "L";
      if (token.includes("tradingHolderUp")) return "P";
      if (token.includes("tradingHolderRight")) return "R";
    }

    const targetText = `${cardNode.className || ""} ${cardNode.getAttribute("data-target") || ""} ${cardNode.getAttribute("aria-label") || ""} ${cardNode.parentElement ? cardNode.parentElement.className : ""}`.toLowerCase();
    if (/tradingholderleft|target-left|trade-left/.test(targetText)) return "L";
    if (/tradingholderup|target-up|trade-partner|target-partner/.test(targetText)) return "P";
    if (/tradingholderright|target-right|trade-right/.test(targetText)) return "R";

    // Some layouts keep the dragged card under #trading/#hand and position it
    // over a destination. Use rendered coordinates, conservatively.
    const cardRect = cardNode.getBoundingClientRect();
    const cardX = cardRect.left + cardRect.width / 2;
    const cardY = cardRect.top + cardRect.height / 2;
    if (!cardRect.width || !cardRect.height) return null;
    let nearest = null;
    let nearestDistance = Infinity;
    for (const player of PLAYER_DEFS) {
      const holder = document.getElementById(player.tradeId);
      if (!holder || !isElementVisible(holder)) continue;
      const rect = holder.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const dx = cardX - (rect.left + rect.width / 2);
      const dy = cardY - (rect.top + rect.height / 2);
      const distance = Math.sqrt(dx * dx + dy * dy);
      const edgeX = Math.max(rect.left - cardX, 0, cardX - rect.right);
      const edgeY = Math.max(rect.top - cardY, 0, cardY - rect.bottom);
      const distanceToHolder = Math.sqrt(edgeX * edgeX + edgeY * edgeY);
      const looksLikeActiveDrag = /dragging|dragged|moving|ui-draggable/i.test(targetText);
      if ((distanceToHolder < 14 || (looksLikeActiveDrag && distanceToHolder < 34)) && distance < nearestDistance) {
        nearest = player.key;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  function readTradeSelections() {
    const selections = new Map();
    for (const player of PLAYER_DEFS) {
      const holder = document.getElementById(player.tradeId);
      if (!holder || !isElementVisible(holder)) continue;
      for (const cardNode of holder.querySelectorAll(".card")) {
        const code = extractCardCode(cardNode);
        if (code && CARD_SET.has(code)) selections.set(code, player.key);
      }
    }

    const trading = document.getElementById("trading");
    if (trading && isElementVisible(trading)) {
      for (const cardNode of trading.querySelectorAll(".card")) {
        const code = extractCardCode(cardNode);
        if (!code || !CARD_SET.has(code) || selections.has(code)) continue;
        const target = inferTradeTarget(cardNode);
        if (target) selections.set(code, target);
      }
    }

    const hand = document.getElementById("hand");
    if (hand && getTradeContainer()) {
      for (const cardNode of hand.querySelectorAll(".card")) {
        const code = extractCardCode(cardNode);
        if (!code || !CARD_SET.has(code) || selections.has(code)) continue;
        const target = inferTradeTarget(cardNode);
        if (target) selections.set(code, target);
      }
    }
    return selections;
  }

  function commitPendingTrades() {
    for (const [card, target] of state.pendingTrades.entries()) {
      if (CARD_SET.has(card) && !state.played.has(card)) state.tradedOut.set(card, target);
    }
    state.pendingTrades.clear();
    state.forceCommitTrades = false;
  }

  function readHandCards() {
    const result = new Set();
    const hand = document.getElementById("hand");
    if (!hand) return result;
    for (const cardEl of hand.querySelectorAll(".card")) {
      const code = extractCardCode(cardEl);
      if (code && CARD_SET.has(code)) result.add(code);
    }
    return result;
  }

  function readCardsFrom(selector) {
    const container = document.querySelector(selector);
    if (!container) return [];
    const result = [];
    const seen = new Set();
    for (const cardEl of container.querySelectorAll(".card")) {
      const code = extractCardCode(cardEl);
      if (code && CARD_SET.has(code) && !seen.has(code)) {
        seen.add(code);
        result.push(code);
      }
    }
    return result;
  }

  function readBoardCards() {
    const result = [];
    const seen = new Set();
    const selector = PLAY_CONTAINERS.map(container => `${container} .card`).join(", ");
    for (const cardEl of document.querySelectorAll(selector)) {
      const code = extractCardCode(cardEl);
      if (code && CARD_SET.has(code) && !seen.has(code)) {
        seen.add(code);
        result.push(code);
      }
    }
    return result;
  }

  function getActionText() {
    const el = document.querySelector("#txtLastAction #textContainer") || document.getElementById("txtLastAction");
    return el ? el.textContent.trim().replace(/\s+/g, " ") : "";
  }

  function actionContainsPlayerName(text, name) {
    if (!text || !name) return false;
    const escaped = String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!escaped) return false;
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(String(text));
  }

  function findActorFromText(text) {
    if (!text) return null;
    const playersWithNames = [...PLAYER_DEFS, ME_DEF].map(player => {
      const holder = document.getElementById(player.holderId);
      const name = holder && holder.querySelector(".playerName")
        ? holder.querySelector(".playerName").textContent.trim()
        : "";
      return { player, name };
    }).filter(item => item.name).sort((left, right) => right.name.length - left.name.length);
    for (const { player, name } of playersWithNames) {
      if (actionContainsPlayerName(text, name)) return { key: player.key, name };
    }
    return null;
  }

  function getTableCards() {
    if (state.ignoreBoardForScan) return [];
    const center = readCardsFrom("#cardsHolder");
    if (center.length) return center;

    const actorKey = state.lastPlayActor && state.lastPlayActor.key;
    if (actorKey) {
      const actor = PLAYER_BY_KEY.get(actorKey);
      if (actor && actor.cardsId) {
        const fromActor = readCardsFrom(`#${actor.cardsId}`);
        if (fromActor.length) return fromActor;
      }
    }

    const board = readCardsFrom("#boardCardsHolder");
    if (board.length) return board;

    const groups = [
      readCardsFrom("#cardsHolderLeft"), readCardsFrom("#cardsHolderUp"),
      readCardsFrom("#cardsHolderRight"), readCardsFrom("#cardsHolderBottom")
    ].filter(group => group.length);
    if (!groups.length) return [];
    groups.sort((left, right) => right.length - left.length);
    return groups[0];
  }

  function getWishRank() {
    const wishEl = document.getElementById("txtAskedCard");
    if (!wishEl || !isElementVisible(wishEl)) return null;
    return Core.parseWishRank(wishEl.textContent);
  }

  function isYourTurn() {
    return isElementVisible(document.getElementById("infoYourTurn"));
  }

  // -------------------------------------------------------------------------
  // Board state machine
  // -------------------------------------------------------------------------

  function invalidateDerivedCaches() {
    state.probabilityContext = null;
    state.lastAnalysis = null;
    Prob.clearProbabilityCaches();
  }

  function clearRoundData(newRoundText = "") {
    state.currentRoundText = newRoundText;
    state.inHand.clear();
    state.everInHand.clear();
    state.tradedOut.clear();
    state.tradedIn.clear();
    state.pendingTrades.clear();
    state.played.clear();
    state.manualPlayed.clear();
    state.manualHistory = [];
    state.unresolved.clear();
    state.preTradeHand.clear();
    state.unmappedSpecials.clear();
    state.lastActionText = "";
    state.lastTableSignature = "";
    state.lastPlayActor = null;
    state.lastTableCards = [];
    state.lastNonPhoenixSingleRank = null;
    state.tichuCalls.clear();
    state.passConstraints = [];
    state.ignoreBoardForScan = false;
    state.tradingActive = null;
    state.forceCommitTrades = false;
    state.flashStatus = null;
    state.probabilityContext = null;
    state.lastAnalysis = null;
    state.lastFingerprint = "";
    state.forceRender = true;
    if (state.flashTimer !== null) {
      window.clearTimeout(state.flashTimer);
      state.flashTimer = null;
    }
    Prob.clearProbabilityCaches();
  }

  function resetRoundState(newRoundText = "") {
    clearRoundData(newRoundText);
    scheduleScan();
  }

  function flashStatus(text, tone = "ok") {
    state.flashStatus = { text, tone, until: Date.now() + FLASH_STATUS_MS };
    if (state.flashTimer !== null) window.clearTimeout(state.flashTimer);
    state.flashTimer = window.setTimeout(() => {
      state.flashTimer = null;
      state.flashStatus = null;
      if (hud.root && hud.root.isConnected) renderHud();
    }, FLASH_STATUS_MS);
    if (hud.root && hud.root.isConnected) renderHud();
  }

  function toggleManualPlayed(card) {
    if (!CARD_SET.has(card)) return;
    if (state.manualPlayed.has(card)) {
      state.manualPlayed.delete(card);
      state.played.delete(card);
      state.manualHistory.push({ card, action: "unmark" });
      invalidateDerivedCaches();
      flashStatus(`${displayCard(card)} manual mark cleared`);
    } else {
      state.manualPlayed.add(card);
      state.played.add(card);
      state.inHand.delete(card);
      state.unresolved.delete(card);
      state.manualHistory.push({ card, action: "mark" });
    if (state.manualHistory.length > 100) state.manualHistory.shift();
      invalidateDerivedCaches();
      flashStatus(`${displayCard(card)} marked as played`);
    }
    state.forceRender = true;
    scanBoardState();
    if (state.forceRender) scheduleScan();
  }

  function undoManualMark() {
    const last = state.manualHistory.pop();
    if (!last) return;
    if (last.action === "mark" && state.manualPlayed.has(last.card)) {
      state.manualPlayed.delete(last.card);
      state.played.delete(last.card);
      flashStatus(`Undid manual mark on ${displayCard(last.card)}`);
    } else if (last.action === "unmark" && !state.manualPlayed.has(last.card)) {
      state.manualPlayed.add(last.card);
      state.played.add(last.card);
      state.inHand.delete(last.card);
      flashStatus(`Restored manual mark on ${displayCard(last.card)}`);
    }
    invalidateDerivedCaches();
    state.forceRender = true;
    scanBoardState();
    if (state.forceRender) scheduleScan();
  }

  function updateUndoButton() {
    if (!hud.undoBtn) return;
    const pending = state.manualHistory.length;
    hud.undoBtn.hidden = pending === 0;
    hud.undoBtn.disabled = pending === 0;
    hud.undoBtn.title = pending
      ? `Undo the last manual card mark (${pending} reversible)`
      : "No manual card marks to undo";
  }

  function recordTichuCallFromAction(text) {
    if (!Core.actionLooksLikeTichuCall(text)) return false;
    const actor = findActorFromText(text);
    if (!actor) return false;
    const isGrand = /\bgrand\b|\u03b3\u03ba\u03c1\u03b1\u03bd\u03c4/i.test(String(text || ""));
    state.tichuCalls.set(actor.key, isGrand ? "grand" : "tichu");
    return true;
  }

  function recordPassConstraint(seat, combo) {
    if (!seat || seat === "ME" || !combo || combo.dog) return;
    if (state.lastPlayActor && state.lastPlayActor.key === seat) return;
    const key = `${seat}:${combo.type}:${combo.count}:${combo.rank}`;
    if (state.passConstraints.some(item => item.key === key)) return;
    state.passConstraints.push({
      seat,
      key,
      combo: { type: combo.type, count: combo.count, rank: combo.rank, bomb: Boolean(combo.bomb), dog: Boolean(combo.dog) }
    });
    if (state.passConstraints.length > 48) state.passConstraints.shift();
    invalidateDerivedCaches();
  }

  function getActionContext() {
    const actionText = getActionText();
    const actionChanged = actionText !== state.lastActionText;
    const previousSignature = state.lastTableSignature;

    if (actionChanged) {
      state.lastActionText = actionText;
      recordTichuCallFromAction(actionText);
      if (Core.actionLooksLikePlay(actionText) || Core.actionLooksLikeDogPlay(actionText)) {
        state.lastPlayActor = findActorFromText(actionText) || null;
      }
    }

    const tableCards = getTableCards();
    const signature = [...tableCards].sort().join(",");

    if (actionChanged && Core.actionLooksLikePass(actionText) && signature && signature === previousSignature) {
      // Only a pass on an unchanged, still-visible trick is safe evidence.
      const combo = classifyCombo(tableCards);
      const actor = findActorFromText(actionText);
      if (combo && actor) recordPassConstraint(actor.key, combo);
    }

    if (!tableCards.length) {
      state.lastTableSignature = "";
      state.lastPlayActor = null;
      state.lastNonPhoenixSingleRank = null;
    } else if (signature !== previousSignature) {
      if (
        tableCards.length === 1 &&
        tableCards[0] === "PHOENIX" &&
        state.lastTableCards.length === 1 &&
        state.lastTableCards[0] !== "PHOENIX"
      ) {
        state.lastNonPhoenixSingleRank = Core.cardRank(state.lastTableCards[0]);
      } else if (tableCards.length !== 1 || tableCards[0] !== "PHOENIX") {
        state.lastNonPhoenixSingleRank = null;
      }
      state.lastTableSignature = signature;
      state.lastPlayActor = findActorFromText(actionText) || null;
    }

    state.lastTableCards = tableCards;
    const currentCombo = classifyCombo(tableCards);
    if (currentCombo && currentCombo.type === "single" && tableCards[0] === "PHOENIX") {
      currentCombo.rank = Number.isFinite(state.lastNonPhoenixSingleRank)
        ? state.lastNonPhoenixSingleRank + 0.5
        : 1.5;
    }
    return { tableCards, currentCombo, actor: state.lastPlayActor, actionText };
  }

  function boardFingerprint({ roundText, handNow, boardCards, counts, actionText, wishText, selections, tradingActive }) {
    return [
      roundText,
      [...handNow].sort().join(","),
      boardCards.slice().sort().join(","),
      actionText,
      `${counts.L}/${counts.P}/${counts.R}`,
      wishText,
      [...selections.entries()].sort().map(([card, seat]) => `${card}:${seat}`).join(","),
      tradingActive ? "1" : "0"
    ].join("|");
  }

  function scanBoardState() {
    if (state.scanInProgress) return;
    state.scanInProgress = true;
    try {
      const needsHud = !hud.root || !hud.root.isConnected || !hud.body;
      if (needsHud) {
        createHud();
        // A freshly built HUD has no painted values yet even when the board
        // fingerprint is unchanged.
        state.forceRender = true;
      }

      const roundEl = document.getElementById("txtRound");
      const roundText = roundEl ? roundEl.textContent.trim() : "";
      const actionText = getActionText();
      const wishEl = document.getElementById("txtAskedCard");
      const wishText = wishEl && isElementVisible(wishEl) ? wishEl.textContent.trim() : "";
      const tradingActive = getTradingPhaseActive();
      const selections = tradingActive ? readTradeSelections() : new Map();
      const handRead = readHandCards();
      if (tradingActive) {
        // A selected card may be reparented into its trade slot; it is still
        // ours until Send commits the exchange.
        for (const card of selections.keys()) handRead.add(card);
      }
      const boardCards = state.ignoreBoardForScan ? [] : readBoardCards();
      const counts = readCounts();
      const fingerprint = boardFingerprint({
        roundText, handNow: handRead, boardCards, counts, actionText, wishText, selections, tradingActive
      });

      if (!state.forceRender && fingerprint === state.lastFingerprint) return;
      state.lastFingerprint = fingerprint;
      state.forceRender = false;

      let roundChanged = false;
      if (roundText && state.currentRoundText && roundText !== state.currentRoundText) {
        clearRoundData(roundText);
        roundChanged = true;
      } else if (roundText && !state.currentRoundText) {
        state.currentRoundText = roundText;
      }

      // A new full deal after a nearly empty public deck is a second reset
      // signal; DoD sometimes reuses the same round label after a rematch.
      if (!roundChanged && state.inHand.size <= 2 && state.played.size >= 30 && handRead.size >= 10) {
        clearRoundData(roundText || state.currentRoundText);
        roundChanged = true;
      }

      const previousHand = new Set(state.inHand);
      const wasTradingActive = state.tradingActive;
      if (tradingActive && wasTradingActive !== true) {
        state.preTradeHand = new Set(previousHand);
      }
      if (tradingActive) {
        state.pendingTrades = state.forceCommitTrades
          ? new Map([...state.pendingTrades, ...selections])
          : new Map(selections);
      }
      const completingTrade = wasTradingActive === true && !tradingActive;
      if (state.forceCommitTrades || completingTrade) commitPendingTrades();
      state.tradingActive = tradingActive;

      const currentHandSet = new Set(handRead);
      if (!tradingActive) {
        for (const card of state.tradedOut.keys()) currentHandSet.delete(card);
      }
      for (const card of currentHandSet) {
        state.everInHand.add(card);
        state.unresolved.delete(card);
      }

      if (completingTrade && state.preTradeHand.size) {
        for (const card of currentHandSet) {
          if (!state.preTradeHand.has(card) && !state.tradedOut.has(card)) state.tradedIn.add(card);
        }
        state.preTradeHand.clear();
      }

      if (!tradingActive) {
        for (const prevCard of previousHand) {
          if (!currentHandSet.has(prevCard) && !state.tradedOut.has(prevCard) && !state.played.has(prevCard)) {
            state.unresolved.set(prevCard, "missing from hand; awaiting public-play or trade evidence");
          }
        }
      }
      state.inHand = currentHandSet;

      for (const card of state.manualPlayed) {
        state.inHand.delete(card);
        state.played.add(card);
        state.unresolved.delete(card);
      }

      if (!roundChanged) {
        for (const code of boardCards) {
          state.played.add(code);
          state.unresolved.delete(code);
          state.inHand.delete(code);
        }
      }

      for (const code of state.played) {
        state.inHand.delete(code);
        state.unresolved.delete(code);
      }
      for (const code of state.tradedOut.keys()) {
        state.unresolved.delete(code);
        if (!tradingActive) state.inHand.delete(code);
      }

      state.ignoreBoardForScan = roundChanged;
      if (roundChanged) {
        // The board read in this scan happened before the reset, so it was
        // deliberately ignored. Re-scan once the new deal has painted; without
        // this, a static board with no further mutations would never import the
        // first trick of the new round.
        state.lastFingerprint = "";
        window.setTimeout(scheduleScan, 140);
      }
      ensureObserver();
      renderHud();
    } catch (error) {
      console.error("[Tichu Tracker] Board scan failed:", error);
      setSync("error", "Error", error && error.message ? error.message : "unknown error");
    } finally {
      state.ignoreBoardForScan = false;
      state.scanInProgress = false;
    }
  }

  function scheduleScan() {
    if (state.scanTimer !== null) return;
    state.scanTimer = window.setTimeout(() => {
      state.scanTimer = null;
      scanBoardState();
    }, 60);
  }

  // -------------------------------------------------------------------------
  // HUD construction
  // -------------------------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function makeButton(label, title, action) {
    const button = el("button", "tt-btn", label);
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.dataset.action = action;
    return button;
  }

  function copyIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "11");
    svg.setAttribute("height", "11");
    svg.setAttribute("aria-hidden", "true");
    const back = document.createElementNS("http://www.w3.org/2000/svg", "path");
    back.setAttribute("d", "M3.5 10.5V3.2c0-.7.5-1.2 1.2-1.2H10");
    back.setAttribute("fill", "none");
    back.setAttribute("stroke", "currentColor");
    back.setAttribute("stroke-width", "1.4");
    const front = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    front.setAttribute("x", "5");
    front.setAttribute("y", "5");
    front.setAttribute("width", "8");
    front.setAttribute("height", "9");
    front.setAttribute("rx", "1.5");
    front.setAttribute("fill", "none");
    front.setAttribute("stroke", "currentColor");
    front.setAttribute("stroke-width", "1.4");
    svg.append(back, front);
    return svg;
  }

  function wireManualCardCell(cell, cardCode) {
    cell.tabIndex = 0;
    cell.setAttribute("role", "button");
    cell.dataset.card = cardCode;
    cell.addEventListener("click", () => toggleManualPlayed(cardCode));
    cell.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
      event.preventDefault();
      toggleManualPlayed(cardCode);
    });
  }

  function buildHeader(root) {
    const header = el("div");
    header.id = "tichu-tracker-header";
    const brand = el("div", "tt-brand");
    brand.append(el("span", "tt-brand-name", "Tichu"));
    hud.titleVersion = el("span", "tt-version", `v${extensionVersion()}`);
    hud.titleVersion.title = "Tracker version injected in this page";
    brand.append(hud.titleVersion);

    const sync = el("div", "tt-sync");
    sync.id = "tichu-tracker-sync";
    hud.syncDot = el("span", "tt-sync-dot");
    hud.syncText = el("span", "tt-sync-text", "Waiting");
    sync.append(hud.syncDot, hud.syncText);
    sync.title = "Card ledger status";

    const controls = el("div", "tt-controls");
    hud.undoBtn = makeButton("↶", "Undo the last manual card mark", "undo");
    hud.undoBtn.hidden = true;
    hud.copyBtn = makeButton("", "Copy a diagnostics snapshot", "copy");
    hud.copyBtn.classList.add("tt-btn-icon");
    hud.copyBtn.append(copyIcon());
    hud.resetBtn = makeButton("↺", "Reset the tracked round (Alt+Shift+R)", "reset");
    hud.minBtn = makeButton("—", "Collapse tracker (Alt+Shift+T)", "minimize");
    controls.append(hud.undoBtn, hud.copyBtn, hud.resetBtn, hud.minBtn);

    header.append(brand, sync, controls);
    root.append(header);
    makeDraggable(root, header);
    return header;
  }

  function buildTabs(root) {
    const tabs = el("div", "tt-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Tracker sections");
    for (const tab of TABS) {
      const button = el("button", "tt-tab", tab.label);
      button.type = "button";
      button.setAttribute("role", "tab");
      button.id = `tichu-tracker-tab-${tab.id}`;
      button.setAttribute("aria-controls", `tichu-tracker-panel-${tab.id}`);
      button.addEventListener("click", () => setActiveTab(tab.id));
      tabs.append(button);
      hud.tabButtons.set(tab.id, button);
    }
    tabs.addEventListener("keydown", event => {
      const index = TABS.findIndex(tab => tab.id === state.activeTab);
      let next = null;
      if (event.key === "ArrowRight") next = TABS[(index + 1) % TABS.length].id;
      else if (event.key === "ArrowLeft") next = TABS[(index - 1 + TABS.length) % TABS.length].id;
      else if (event.key === "Home") next = TABS[0].id;
      else if (event.key === "End") next = TABS[TABS.length - 1].id;
      if (!next) return;
      event.preventDefault();
      setActiveTab(next);
      hud.tabButtons.get(next)?.focus();
    });
    root.append(tabs);
    hud.tabs = tabs;
    return tabs;
  }

  function buildPlayPanel() {
    const panel = el("section", "tt-panel");
    panel.id = "tichu-tracker-panel-play";
    panel.dataset.panel = "play";
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", "tichu-tracker-tab-play");

    const callout = el("div", "tt-callout");
    callout.setAttribute("aria-live", "polite");
    hud.actionKind = el("div", "tt-action-kind", "WAIT");
    const cardsLine = el("div", "tt-action-cards");
    hud.actionCards = el("span", "tt-action-cards-value", "—");
    cardsLine.append(hud.actionCards);
    hud.actionSub = el("div", "tt-action-sub", "");
    callout.append(hud.actionKind, cardsLine, hud.actionSub);
    panel.append(callout);

    hud.reason = el("p", "tt-reason", "");
    panel.append(hud.reason);

    hud.chips = el("div", "tt-chips");
    panel.append(hud.chips);

    hud.alerts = el("div", "tt-alerts");
    panel.append(hud.alerts);

    const more = el("details", "tt-more");
    more.append(el("summary", "tt-more-summary", "Why this play?"));
    hud.detailsSummary = more.querySelector("summary");
    hud.details = el("div", "tt-more-body");
    more.append(hud.details);
    panel.append(more);
    return panel;
  }

  function buildCardsPanel() {
    const panel = el("section", "tt-panel");
    panel.id = "tichu-tracker-panel-cards";
    panel.dataset.panel = "cards";
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", "tichu-tracker-tab-cards");

    const grid = el("div", "tt-grid");
    for (const suit of SUITS) {
      const row = el("div", "tt-suit-row");
      const label = el("div", `tt-suit-label ${suit.cssClass}`, suit.symbol);
      label.title = suit.id === "s" ? "Spades" : suit.id === "h" ? "Hearts" : suit.id === "d" ? "Diamonds" : "Clubs";
      row.append(label);
      for (const rank of RANKS) {
        const cardCode = `${rank}${suit.id}`;
        const cell = el("div", "tt-card-cell tt-st-unknown", rank === "T" ? "10" : rank);
        cell.title = displayCard(cardCode);
        wireManualCardCell(cell, cardCode);
        row.append(cell);
        hud.cardCells.set(cardCode, cell);
      }
      grid.append(row);
    }
    panel.append(grid);

    const specials = el("div", "tt-specials");
    for (const spec of SPECIAL_DEFS) {
      const cell = el("div", "tt-special-cell tt-st-unknown", spec.short);
      cell.title = spec.label;
      wireManualCardCell(cell, spec.key);
      specials.append(cell);
      hud.specialCells.set(spec.key, cell);
    }
    panel.append(specials);

    const unseen = el("div", "tt-unseen");
    const unseenTitle = el("span", "tt-unseen-title", "Unseen");
    unseen.append(unseenTitle);
    for (const rank of RANKS) {
      const chip = el("span", "tt-unseen-chip");
      chip.append(el("span", "tt-unseen-rank", rank === "T" ? "10" : rank));
      const value = el("span", "tt-unseen-count", "4");
      chip.append(value);
      unseen.append(chip);
      hud.unseenCells.set(rank, { chip, value });
    }
    panel.append(unseen);

    hud.handMeta = el("div", "tt-hand-meta");
    panel.append(hud.handMeta);

    const legend = el("div", "tt-legend");
    legend.textContent = "Blue hand · gold traded · dim played · ring manual · outline wish · click to mark played";
    panel.append(legend);
    return panel;
  }

  function buildOddsPanel() {
    const panel = el("section", "tt-panel");
    panel.id = "tichu-tracker-panel-odds";
    panel.dataset.panel = "odds";
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", "tichu-tracker-tab-odds");

    const table = el("table", "tt-odds");
    const thead = el("thead");
    const headRow = el("tr");
    const columns = [
      ["Seat", "Player"],
      ["Cards", "Remaining cards"],
      ["Bomb", "Chance this hand contains a bomb"],
      ["Full", "Chance this hand contains a full house"],
      ["Str", "Chance this hand contains a straight"],
      ["K+", "Chance this hand contains a K, A, Dragon, or Phoenix"],
      ["Beats", "Chance this hand can beat the current table combination"]
    ];
    for (const [label, title] of columns) {
      const th = el("th", "", label);
      th.title = title;
      headRow.append(th);
    }
    thead.append(headRow);
    table.append(thead);

    const tbody = el("tbody");
    for (const player of PLAYER_DEFS) {
      const row = el("tr", player.key === "P" ? "tt-odds-partner" : "");
      const seat = el("th", "", player.label);
      row.append(seat);
      const cells = {};
      for (const key of ["cards", "bomb", "fullHouse", "straight", "high", "beat"]) {
        const cell = el("td", "", "—");
        row.append(cell);
        cells[key] = cell;
      }
      tbody.append(row);
      hud.oddsRows.set(player.key, cells);
    }
    table.append(tbody);
    panel.append(table);

    hud.plan = el("div", "tt-plan");
    panel.append(hud.plan);

    hud.sim = el("div", "tt-sim");
    panel.append(hud.sim);

    hud.modelNote = el("div", "tt-model-note");
    panel.append(hud.modelNote);
    return panel;
  }

  function createHud() {
    const existing = document.getElementById("tichu-tracker-hud");
    if (existing && existing.isConnected && hud.root === existing && hud.body && hud.actionKind) return;
    if (existing) existing.remove();

    for (const map of [hud.cardCells, hud.specialCells, hud.unseenCells, hud.oddsRows, hud.tabButtons, hud.panels]) {
      map.clear();
    }
    for (const key of Object.keys(hud)) {
      if (hud[key] instanceof Map || Array.isArray(hud[key])) continue;
      if (key === "root" || key === "body") hud[key] = null;
      else if (hud[key] && hud[key] !== false) hud[key] = null;
    }

    const root = el("div");
    root.id = "tichu-tracker-hud";
    root.dataset.tab = state.activeTab;
    buildHeader(root);
    buildTabs(root);

    const body = el("div");
    body.id = "tichu-tracker-body";
    const playPanel = buildPlayPanel();
    const cardsPanel = buildCardsPanel();
    const oddsPanel = buildOddsPanel();
    hud.panels.set("play", playPanel);
    hud.panels.set("cards", cardsPanel);
    hud.panels.set("odds", oddsPanel);
    body.append(playPanel, cardsPanel, oddsPanel);

    root.append(body);
    document.body.append(root);

    hud.root = root;
    hud.body = body;
    hud.minBtn.addEventListener("click", () => setMinimized(!state.minimized));
    hud.resetBtn.addEventListener("click", () => {
      const roundEl = document.getElementById("txtRound");
      resetRoundState(roundEl ? roundEl.textContent.trim() : "");
    });
    hud.undoBtn.addEventListener("click", () => undoManualMark());
    hud.copyBtn.addEventListener("click", () => { copyDiagnostics(); });

    applyStoredLayout(root);
    setMinimized(Boolean(state.layout && state.layout.minimized), false);
    setActiveTab(state.activeTab, false);
    updateUndoButton();
    observeHudSize(root);
  }

  function setActiveTab(tabId, persist = true) {
    if (!TABS.some(tab => tab.id === tabId)) return;
    state.activeTab = tabId;
    if (hud.root) hud.root.dataset.tab = tabId;
    for (const [id, button] of hud.tabButtons.entries()) {
      const active = id === tabId;
      button.classList.toggle("tt-tab-active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
    for (const [id, panel] of hud.panels.entries()) {
      panel.hidden = id !== tabId;
    }
    if (persist) saveLayout({ tab: tabId });
    // The simulation is lazy: switching to Odds computes it for the first time.
    if (tabId === "odds" && hud.root && hud.root.isConnected) renderHud();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function extensionVersion() {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest) {
        const manifest = chrome.runtime.getManifest();
        if (manifest && manifest.version) return manifest.version;
      }
    } catch (_) { /* not available outside Chromium extension pages */ }
    return VERSION;
  }

  function setSync(tone, label, title) {
    if (!hud.syncText) return;
    hud.syncText.textContent = label;
    hud.syncDot.className = `tt-sync-dot tt-sync-${tone}`;
    hud.root.dataset.sync = tone;
    const target = title || "Card ledger status";
    hud.syncText.title = target;
    hud.syncDot.title = target;
  }

  function buildProbabilityContext(counts) {
    return Prob.buildProbabilityContext(counts, {
      inHand: state.inHand,
      played: state.played,
      unresolved: state.unresolved,
      tradedOut: state.tradedOut
    }, {
      passConstraints: state.passConstraints
    });
  }

  function currentSimulationMode(ctx) {
    const handSize = state.inHand.size;
    const myPlayedCount = [...state.played].filter(card => state.everInHand.has(card) && !state.tradedOut.has(card)).length;
    if (state.tradingActive) return null;
    if (handSize === 8 && myPlayedCount === 0 && state.tradedOut.size === 0 && state.played.size === 0) return "grand";
    if (handSize === 14 && myPlayedCount === 0) return "tichu";
    if (state.activeTab === "odds" && ctx && ctx.consistent && handSize >= 5
      && ["L", "P", "R"].every(seat => Number.isFinite(ctx.counts[seat]) && ctx.counts[seat] > 0)) {
      return "mid";
    }
    return null;
  }

  function computeSimulation(mode, ctx) {
    if (!mode) return null;
    try {
      return Prob.simulateRound({
        hand: [...state.inHand],
        context: ctx,
        mode,
        samples: mode === "mid" ? SETTINGS.midSimSamples : SETTINGS.simSamples
      });
    } catch (error) {
      console.error("[Tichu Tracker] Simulation failed:", error);
      return null;
    }
  }

  function buildAlerts({ recommendation, ctx, counts, presence, declaration, dragon, actionContext, isOurTurn }) {
    const alerts = [];
    const oneCard = PLAYER_DEFS.filter(player => counts[player.key] === 1);
    for (const player of oneCard) {
      alerts.push({
        tone: "warn",
        text: `${player.label} has 1 card`,
        title: "Avoid leading a combination this opponent can beat. The Odds tab shows the estimated chance they can beat the current table play."
      });
    }

    if (presence) {
      const risky = PLAYER_DEFS
        .map(player => ({ player, p: presence.seats[player.key].bomb.probability }))
        .filter(item => item.p >= 0.35)
        .sort((a, b) => b.p - a.p);
      if (risky.length) {
        alerts.push({
          tone: "warn",
          text: `Bomb risk ${risky[0].player.label} ${percent(risky[0].p)}`,
          title: "Probability that this opponent currently holds a four-of-a-kind or straight-flush bomb, based on the sampled hidden hands."
        });
      }
    }

    if (declaration && declaration.stage && recommendation.action !== "DECIDE") {
      alerts.push({
        tone: declaration.tone === "good" ? "good" : declaration.tone === "warn" ? "warn" : "neutral",
        text: declaration.title,
        title: declaration.details
      });
    }

    const dragonOnTable = actionContext.tableCards.includes("DRAGON");
    const dragonIsOurs = isOurTurn || (actionContext.actor && actionContext.actor.key === "ME");
    if (dragon && dragonOnTable && dragonIsOurs) {
      alerts.push({
        tone: dragon.tone === "good" ? "good" : "warn",
        text: dragon.title,
        title: dragon.details
      });
    }

    if (state.tichuCalls.size) {
      const callText = [...state.tichuCalls.entries()]
        .map(([seat, call]) => `${PLAYER_BY_KEY.get(seat)?.label || seat} ${call === "grand" ? "Grand Tichu" : "Tichu"}`)
        .join(" · ");
      alerts.push({
        tone: "neutral",
        text: `Call: ${callText}`,
        title: "Parsed from DoD action text. A missing call is not proof that nobody declared."
      });
    }

    if (state.unmappedSpecials.size) {
      alerts.push({
        tone: "warn",
        text: `${state.unmappedSpecials.size} unmapped code${state.unmappedSpecials.size === 1 ? "" : "s"}`,
        title: `DoD exposed card code(s) the tracker does not understand: ${[...state.unmappedSpecials].join(", ")}. Copy diagnostics for a bug report.`
      });
    }

    if (state.unresolved.size) {
      alerts.push({
        tone: "warn",
        text: `${state.unresolved.size} card${state.unresolved.size === 1 ? "" : "s"} unresolved`,
        title: "A card left your hand without public-play evidence. Click it in the Cards tab to mark it played, or wait for the board to update."
      });
    }
    if (state.manualPlayed.size && !state.unresolved.size) {
      alerts.push({
        tone: "neutral",
        text: `${state.manualPlayed.size} manual mark${state.manualPlayed.size === 1 ? "" : "s"}`,
        title: "Manual marks are your observations, not page evidence. Use the ↶ button to undo them."
      });
    }
    if (!ctx.consistent) {
      alerts.push({
        tone: "warn",
        text: "Odds paused",
        title: ctx.reason || "The card ledger does not reconcile yet."
      });
    }
    if (recommendation && recommendation.tone === "warn" && recommendation.action !== "WAIT" && ctx.consistent && alerts.length < 3) {
      alerts.push({
        tone: "warn",
        text: "Low-confidence play",
        title: recommendation.details
      });
    }
    if (recommendation && recommendation.tone === "warn" && recommendation.action !== "WAIT" && ctx.consistent && alerts.length < 3) {
      alerts.push({
        tone: "warn",
        text: "Low-confidence play",
        title: recommendation.details
      });
    }
    const priority = alert => {
      if (alert.text === "Odds paused") return 0;
      if (/unmapped code/i.test(alert.text)) return 1;
      if (/unresolved/i.test(alert.text)) return 2;
      if (/has 1 card/i.test(alert.text)) return 2;
      if (/^Bomb risk/i.test(alert.text)) return 3;
      if (/^(Grand Tichu|Tichu):/i.test(alert.text)) return 4;
      if (/^Dragon gift/i.test(alert.text)) return 5;
      if (/^Call:/i.test(alert.text)) return 6;
      if (/manual/i.test(alert.text)) return 7;
      return 8;
    };
    alerts.sort((left, right) => priority(left) - priority(right));
    return alerts.slice(0, 3);
  }

  function renderPlay(recommendation, alerts) {
    if (!hud.actionKind) return;
    hud.actionKind.textContent = recommendation.action;
    hud.actionKind.className = `tt-action-kind tt-tone-${recommendation.tone || "neutral"}`;
    const cards = recommendation.headline
      || (recommendation.cards && recommendation.cards.length
        ? displayCards(recommendation.cards)
        : recommendation.action === "PASS"
          ? "Pass"
          : "");
    hud.actionCards.textContent = cards;
    hud.actionSub.textContent = recommendation.action === "DECIDE"
      ? "Grand Tichu decision · 8-card hand"
      : recommendation.combo
        ? comboLabel(recommendation.combo)
        : recommendation.title;
    if (hud.detailsSummary) {
      hud.detailsSummary.textContent = recommendation.action === "DECIDE" ? "Why this call?" : "Why this play?";
    }
    hud.reason.textContent = recommendation.reason || "";
    hud.reason.hidden = !recommendation.reason;

    hud.chips.replaceChildren();
    for (const chip of recommendation.chips || []) {
      const node = el("span", `tt-chip tt-chip-${chip.tone || "neutral"}`);
      node.append(el("span", "tt-chip-label", chip.label));
      node.append(el("span", "tt-chip-value", chip.value));
      node.title = chip.title || "";
      hud.chips.append(node);
    }
    hud.chips.hidden = !(recommendation.chips && recommendation.chips.length);

    hud.alerts.replaceChildren();
    for (const alert of alerts) {
      const node = el("div", `tt-alert tt-alert-${alert.tone || "neutral"}`, alert.text);
      node.title = alert.title || "";
      hud.alerts.append(node);
    }
    hud.alerts.hidden = alerts.length === 0;

    const lines = [recommendation.details || ""];
    if (state.lastAnalysis && state.lastAnalysis.declaration && state.lastAnalysis.declaration.stage && recommendation.action !== "DECIDE") {
      lines.push(state.lastAnalysis.declaration.details);
    }
    if (state.lastAnalysis && state.lastAnalysis.dragon && state.lastAnalysis.dragon.seat &&
      state.lastAnalysis.actionContext && state.lastAnalysis.actionContext.tableCards.includes("DRAGON")) {
      lines.push(state.lastAnalysis.dragon.details);
    }
    if (state.passConstraints.length) {
      lines.push(`${state.passConstraints.length} observed pass${state.passConstraints.length === 1 ? "" : "es"} used as evidence in the hidden-hand model.`);
    }
    hud.details.textContent = lines.filter(Boolean).join(" ");
  }

  function renderCards(ctx, wishRank) {
    for (const [cardCode, cell] of hud.cardCells.entries()) {
      applyCellState(cell, cardCode, ctx, wishRank);
    }
    for (const [cardCode, cell] of hud.specialCells.entries()) {
      applyCellState(cell, cardCode, ctx, wishRank);
    }

    for (const rank of RANKS) {
      const entry = hud.unseenCells.get(rank);
      if (!entry) continue;
      let seen = 0;
      for (const suit of SUITS) {
        const code = `${rank}${suit.id}`;
        if (state.inHand.has(code) || state.played.has(code)) seen++;
      }
      const remaining = Math.max(0, 4 - seen);
      entry.value.textContent = String(remaining);
      entry.chip.classList.toggle("tt-unseen-empty", remaining === 0);
      entry.chip.title = `${Core.rankNameFromValue(ASC_RANKS.indexOf(rank) + 2)}s unseen: ${remaining} of 4`;
    }

    const parts = [`Hand ${state.inHand.size}`];
    if (state.tradedOut.size) {
      parts.push(`sent ${[...state.tradedOut.entries()].map(([card, seat]) => `${displayCard(card)}→${PLAYER_BY_KEY.get(seat)?.label || seat}`).join(", ")}`);
    }
    if (state.tradedIn.size) parts.push(`received ${[...state.tradedIn].map(displayCard).join(", ")}`);
    if (state.pendingTrades.size) parts.push(`${state.pendingTrades.size} pending trade${state.pendingTrades.size === 1 ? "" : "s"}`);
    if (state.tichuCalls.size) {
      parts.push(`calls ${[...state.tichuCalls.entries()].map(([seat, call]) => `${PLAYER_BY_KEY.get(seat)?.label || seat} ${call === "grand" ? "GT" : "T"}`).join(", ")}`);
    }
    if (state.manualPlayed.size) parts.push(`${state.manualPlayed.size} manual`);
    hud.handMeta.textContent = parts.join(" · ");
    hud.handMeta.title = "Outgoing and incoming trades are tracked separately. Pending selections are provisional until Send.";
  }

  function applyCellState(cell, key, ctx, wishRank) {
    cell.classList.remove(
      "tt-st-unknown", "tt-st-hand", "tt-st-traded", "tt-st-played", "tt-st-unresolved",
      "tt-manual", "tt-wish-card"
    );
    const manual = state.manualPlayed.has(key);
    if (manual) cell.classList.add("tt-manual");
    if (wishRank && isStandardCard(key) && key[0] === wishRank) cell.classList.add("tt-wish-card");

    let stateLabel;
    let title;
    if (state.played.has(key)) {
      cell.classList.add("tt-st-played");
      stateLabel = manual ? "played (manual)" : "played";
      title = manual
        ? `${displayCard(key)} — marked played manually; click to clear`
        : `${displayCard(key)} — played`;
    } else if (state.inHand.has(key)) {
      cell.classList.add("tt-st-hand");
      const pending = state.pendingTrades.get(key);
      stateLabel = "in hand";
      title = `${displayCard(key)} — in your hand${pending ? `; selected for trade to ${PLAYER_BY_KEY.get(pending)?.label || pending}` : ""}`;
    } else if (state.unresolved.has(key)) {
      cell.classList.add("tt-st-unresolved");
      stateLabel = "unresolved";
      title = `${displayCard(key)} — temporarily absent from hand; click to mark it played`;
    } else {
      const target = state.tradedOut.get(key) || state.pendingTrades.get(key);
      if (target) {
        cell.classList.add("tt-st-traded");
        stateLabel = "traded";
        title = `${displayCard(key)} — ${state.tradedOut.has(key) ? "known traded" : "pending trade"} to ${PLAYER_BY_KEY.get(target)?.label || target}`;
      } else {
        cell.classList.add("tt-st-unknown");
        stateLabel = "unknown";
        const odds = ctx && ctx.consistent
          ? PLAYER_DEFS.map(player => `${player.label} ${percent(Prob.cardProbability(key, player.key, ctx))}`).join(" · ")
          : "estimates paused";
        title = `${displayCard(key)} — ${odds}`;
      }
    }
    cell.setAttribute("aria-label", `${displayCard(key)}: ${stateLabel}`);
    cell.title = `${title}. Click to toggle a manual played mark.`;
  }

  function renderOdds(ctx, counts, actionContext, presence, plan, simulation) {
    const tableThreat = state.activeTab === "odds" && actionContext.currentCombo
      ? Prob.evaluateComboThreat(actionContext.currentCombo, ctx)
      : null;

    for (const player of PLAYER_DEFS) {
      const cells = hud.oddsRows.get(player.key);
      if (!cells) continue;
      cells.cards.textContent = Number.isFinite(counts[player.key]) ? String(counts[player.key]) : "?";
      if (presence) {
        const seat = presence.seats[player.key];
        cells.bomb.textContent = percent(seat.bomb.probability);
        cells.fullHouse.textContent = percent(seat.fullHouse.probability);
        cells.straight.textContent = percent(seat.straight.probability);
        cells.high.textContent = percent(seat.high.probability);
        cells.bomb.title = `${percentRange(seat.bomb.interval)} (95% interval, ${presence.samples} samples)`;
        cells.fullHouse.title = `${percentRange(seat.fullHouse.interval)}`;
        cells.straight.title = `${percentRange(seat.straight.interval)}`;
        cells.high.title = `${percentRange(seat.high.interval)}`;
      } else {
        for (const key of ["bomb", "fullHouse", "straight", "high"]) cells[key].textContent = "—";
      }
      if (tableThreat) {
        cells.beat.textContent = percent(tableThreat.seatEstimates[player.key].probability);
        cells.beat.title = `${percentRange(tableThreat.seatEstimates[player.key].interval)} — chance this hand can beat ${comboLabel(actionContext.currentCombo)}`;
      } else {
        cells.beat.textContent = "—";
        cells.beat.title = "No classified table combination.";
      }
    }

    if (plan) {
      const detail = plan.exact
        ? `${plan.plays} play${plan.plays === 1 ? "" : "s"} to empty your hand`
        : `about ${plan.plays} plays to empty your hand (greedy estimate)`;
      const composition = [
        plan.bombs ? `${plan.bombs} bomb${plan.bombs === 1 ? "" : "s"}` : null,
        plan.singles ? `${plan.singles} single${plan.singles === 1 ? "" : "s"}` : null,
        plan.plays - plan.bombs - plan.singles > 0 ? `${plan.plays - plan.bombs - plan.singles} combo${plan.plays - plan.bombs - plan.singles === 1 ? "" : "s"}` : null
      ].filter(Boolean).join(", ");
      hud.plan.textContent = `Plan: ${detail}${composition ? ` (${composition})` : ""}`;
      hud.plan.title = plan.groups.map(group => `${comboLabel(group)}: ${displayCards(group.cards)}`).join("; ");
    } else {
      hud.plan.textContent = "Plan: —";
    }

    if (simulation) {
      const label = simulation.mode === "grand" ? "Grand Tichu odds" : simulation.mode === "tichu" ? "Tichu odds" : "Team outlook";
      hud.sim.textContent = `${label}: you first ${percent(simulation.first)} · partner first ${percent(simulation.partnerFirst)} · team first ${percent(simulation.teamFirst)} · 1–2 finish ${percent(simulation.doubleWin)} (${simulation.samples} playouts)`;
      hud.sim.title = "Heuristic playout: sampled hidden hands, greedy shed/keep-control policy. Dragon, Dog, Phoenix and bombs are modelled; Mahjong wishes are not.";
    } else {
      hud.sim.textContent = "Simulation: available during the declaration window or on the Odds tab.";
      hud.sim.title = ctx && !ctx.consistent ? ctx.reason : "";
    }

    if (!ctx.consistent) {
      hud.modelNote.textContent = `Model paused: ${ctx.reason || "card ledger mismatch"}. Exact visible facts are still shown.`;
      hud.modelNote.className = "tt-model-note tt-model-warn";
    } else {
      const passNote = state.passConstraints.length
        ? (presence && presence.constrained
          ? ` · ${state.passConstraints.length} pass constraint${state.passConstraints.length === 1 ? "" : "s"}`
          : " · pass evidence conflicted and was ignored")
        : "";
      const outNote = ctx.unobservedOutOfHandCount > 0
        ? ` · ${ctx.unobservedOutOfHandCount} identit${ctx.unobservedOutOfHandCount === 1 ? "y" : "ies"} modelled as out of hand`
        : "";
      hud.modelNote.textContent = `Uniform hidden-hand model · ${SETTINGS.worlds} sampled deals${passNote}${outNote} · ledger ${ctx.accountedCount}/56`;
      hud.modelNote.className = "tt-model-note";
    }
  }

  function renderHud() {
    if (!hud.root || !hud.root.isConnected || !hud.actionKind) return;
    const counts = readCounts();
    const isOurTurn = isYourTurn();
    // Resolve the action context first: it records calls/passes and the actor.
    const rawAction = getActionContext();
    const actionContext = Prob.resolveDogHandoffContext(rawAction, isOurTurn, state);
    const ctx = buildProbabilityContext(counts);
    state.probabilityContext = ctx;
    const wishRank = getWishRank();

    const plan = state.inHand.size ? handPlan(state.inHand) : null;
    const presence = ctx.consistent ? Prob.comboPresence(ctx, { samples: SETTINGS.worlds }) : null;
    const simMode = currentSimulationMode(ctx);
    const simulation = computeSimulation(simMode, ctx);

    const declaration = Prob.getDeclarationAdvice([...state.inHand], {
      playedCount: state.played.size,
      myPlayedCount: [...state.played].filter(card => state.everInHand.has(card) && !state.tradedOut.has(card)).length,
      tradedOutCount: state.tradedOut.size,
      tradingActive: Boolean(state.tradingActive),
      simulation
    });
    const dragon = Prob.getDragonGiftAdvice(counts, state.tichuCalls);

    const recommendation = Prob.getRecommendation({
      hand: [...state.inHand],
      tableCards: actionContext.tableCards,
      currentCombo: actionContext.currentCombo,
      actor: actionContext.actor,
      counts,
      isOurTurn,
      tradingActive: Boolean(state.tradingActive),
      wishRank,
      context: ctx,
      plan,
      presence,
      dogHandoff: Boolean(actionContext.dogHandoff),
      declarationAdvice: declaration
    });

    state.lastAnalysis = { ctx, plan, presence, simulation, declaration, dragon, recommendation, actionContext };

    const alerts = buildAlerts({
      recommendation, ctx, counts, presence, declaration, dragon, actionContext, isOurTurn
    });
    renderPlay(recommendation, alerts);
    renderCards(ctx, wishRank);
    renderOdds(ctx, counts, actionContext, presence, plan, simulation);

    const flashActive = state.flashStatus && Date.now() < state.flashStatus.until;
    if (flashActive) {
      setSync(state.flashStatus.tone, state.flashStatus.text, state.flashStatus.text);
    } else if (!document.getElementById("hand") && !document.getElementById("cardsHolder")) {
      setSync("waiting", "Waiting", "Waiting for a DoD game board");
    } else if (!ctx.consistent) {
      setSync("paused", "Paused", ctx.reason || "Card ledger mismatch");
    } else if (!state.inHand.size) {
      setSync("waiting", "No hand", "No hand cards detected; waiting for a stable board update");
    } else {
      setSync("live", "Live", `Round ${state.currentRoundText || "-"} · ledger ${ctx.accountedCount}/56 · ${state.passConstraints.length} pass constraints · ${SETTINGS.worlds} sampled deals`);
    }
    updateUndoButton();
    // Do not leave a stale panel over the lobby after leaving a table. The
    // observer/fallback scan restores it as soon as a board is present again.
    if (hud.root) {
      const boardPresent = Boolean(document.getElementById("hand") || document.getElementById("cardsHolder"));
      hud.root.style.display = boardPresent ? "" : "none";
    }
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  function buildDiagnostics() {
    const counts = readCounts();
    return JSON.stringify({
      version: extensionVersion(),
      url: typeof location !== "undefined" ? location.href : "",
      round: state.currentRoundText,
      hand: [...state.inHand].sort(),
      played: [...state.played].sort(),
      manualPlayed: [...state.manualPlayed].sort(),
      unresolved: [...state.unresolved.keys()].sort(),
      tradedOut: [...state.tradedOut.entries()],
      tradedIn: [...state.tradedIn].sort(),
      pendingTrades: [...state.pendingTrades.entries()],
      calls: [...state.tichuCalls.entries()],
      passConstraints: state.passConstraints.map(item => ({ seat: item.seat, combo: item.combo })),
      counts,
      unmappedSpecials: [...state.unmappedSpecials],
      tradingActive: Boolean(state.tradingActive),
      analysis: state.lastAnalysis ? {
        plan: state.lastAnalysis.plan ? {
          plays: state.lastAnalysis.plan.plays,
          exact: state.lastAnalysis.plan.exact,
          groups: state.lastAnalysis.plan.groups.map(group => ({ label: comboLabel(group), cards: group.cards }))
        } : null,
        recommendation: state.lastAnalysis.recommendation ? {
          action: state.lastAnalysis.recommendation.action,
          cards: state.lastAnalysis.recommendation.cards,
          chips: state.lastAnalysis.recommendation.chips
        } : null,
        simulation: state.lastAnalysis.simulation,
        presence: state.lastAnalysis.presence ? state.lastAnalysis.presence.seats : null
      } : null,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : ""
    }, null, 2);
  }

  async function copyDiagnostics() {
    const text = buildDiagnostics();
    let copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch (_) {
      copied = false;
    }
    if (!copied) {
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "readonly");
        area.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0;";
        document.body.appendChild(area);
        area.select();
        copied = document.execCommand("copy");
        area.remove();
      } catch (_) {
        copied = false;
      }
    }
    flashStatus(copied ? "Diagnostics copied" : "Could not copy diagnostics", copied ? "ok" : "warn");
  }

  // -------------------------------------------------------------------------
  // Observers, shortcuts and boot
  // -------------------------------------------------------------------------

  function ensureObserver() {
    const boardRoot = document.documentElement;
    if (!boardRoot) return false;
    if (!state.observer || state.observedRoot !== boardRoot) {
      if (state.observer) state.observer.disconnect();
      state.observer = new MutationObserver(mutations => {
        const relevant = mutations.some(mutation => {
          const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
          if (hud.root && target && hud.root.contains(target)) return false;
          const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
          if (hud.root && changedNodes.length && changedNodes.every(node =>
            node === hud.root || (node.nodeType === 1 && hud.root.contains(node))
          )) return false;
          return true;
        });
        if (relevant) scheduleScan();
      });
      state.observer.observe(boardRoot, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["card", "class", "style", "hidden", "aria-label", "data-target"]
      });
      state.observedRoot = boardRoot;
    }

    if (state.fallbackScanTimer === null) {
      // The observer drives normal updates; this slow timer only repairs missed
      // mutations. scanBoardState() exits immediately when nothing changed.
      state.fallbackScanTimer = window.setInterval(scheduleScan, 3000);
    }
    if (!state.clickListenerAttached) {
      document.addEventListener("click", event => {
        const target = event.target && event.target.closest ? event.target.closest("#btnSend") : null;
        if (!target) return;
        state.forceCommitTrades = true;
        if (state.tradingActive) {
          state.pendingTrades = new Map([...state.pendingTrades, ...readTradeSelections()]);
        }
        window.setTimeout(scheduleScan, 0);
      }, true);
      state.clickListenerAttached = true;
    }
    if (!state.keyListenerAttached) {
      document.addEventListener("keydown", event => {
        if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
        const target = event.target;
        if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || ""))) return;
        const code = event.code || "";
        if (code === "KeyT") {
          event.preventDefault();
          setMinimized(!state.minimized);
        } else if (code === "KeyR") {
          event.preventDefault();
          const roundEl = document.getElementById("txtRound");
          resetRoundState(roundEl ? roundEl.textContent.trim() : "");
        } else if (code === "KeyC") {
          event.preventDefault();
          copyDiagnostics();
        } else if (code === "Digit1" || code === "Digit2" || code === "Digit3") {
          event.preventDefault();
          setActiveTab(TABS[Number(code.slice(-1)) - 1].id);
        }
      }, true);
      state.keyListenerAttached = true;
    }
    if (!state.viewportListenerAttached) {
      window.addEventListener("resize", () => clampToViewport(hud.root));
      state.viewportListenerAttached = true;
    }
    return true;
  }

  function initTracker() {
    const hand = document.getElementById("hand");
    const cardsHolder = document.getElementById("cardsHolder");
    if (!hand && !cardsHolder) return false;
    createHud();
    scanBoardState();
    ensureObserver();
    return true;
  }

  // -------------------------------------------------------------------------
  // Exports (Node tests + optional debug harness)
  // -------------------------------------------------------------------------

  const api = {
    ...Core,
    ...Prob,
    VERSION, LAYOUT_STORAGE_KEY, SETTINGS, state, hud,
    buildProbabilityContext: (counts, options) => Prob.buildProbabilityContext(counts, {
      inHand: state.inHand,
      played: state.played,
      unresolved: state.unresolved,
      tradedOut: state.tradedOut
    }, { passConstraints: state.passConstraints, ...(options || {}) }),
    resolveDogHandoffContext: (actionContext, isOurTurn) =>
      Prob.resolveDogHandoffContext(actionContext, isOurTurn, state),
    enumerateCombos,
    invalidateDerivedCaches,
    clearRoundData,
    toggleManualPlayed,
    undoManualMark,
    buildDiagnostics,
    commitPendingTrades,
    readTradeSelections,
    readHandCards,
    getTradingPhaseActive,
    getSeatCardCount,
    readCardsFrom,
    getActionText,
    findActorFromText,
    getTableCards,
    getWishRank,
    isYourTurn,
    scanBoardState,
    createHud,
    renderHud,
    setActiveTab,
    recordPassConstraint,
    recordTichuCallFromAction,
    getActionContext
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const debugHost = typeof location !== "undefined" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (globalThis.__TICHU_TRACKER_DEBUG__ || debugHost) globalThis.TichuTracker = api;

  if (!initTracker()) {
    let attempts = 0;
    const maxAttempts = window === window.top ? 600 : 60;
    state.bootTimer = window.setInterval(() => {
      attempts++;
      if (initTracker() || attempts >= maxAttempts) {
        window.clearInterval(state.bootTimer);
        state.bootTimer = null;
      }
    }, 1000);
  }
})();
