/**
 * DoD.gr Tichu Card Tracker - Content Script
 *
 * Tracks visible cards, trade selections, remaining-card probabilities, and a
 * heuristic move recommendation. Hidden hands are never read; probability
 * estimates assign unknown card identities uniformly across the remaining
 * opponent hand slots, except for known trade ownership. If tracking begins
 * mid-hand, unidentified cards beyond current hand slots remain in an explicit
 * out-of-hand bucket instead of being forced into hidden hands.
 */
(() => {
  "use strict";

  const RANKS = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];
  const ASC_RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
  const SUITS = [
    { id: "s", symbol: "♠", cssClass: "tt-suit-s" },
    { id: "h", symbol: "♥", cssClass: "tt-suit-h" },
    { id: "d", symbol: "♦", cssClass: "tt-suit-d" },
    { id: "c", symbol: "♣", cssClass: "tt-suit-c" }
  ];

  const SPECIAL_DEFS = [
    { key: "DRAGON", label: "Dragon", aliases: ["d", "dr", "dragon", "drag", "_dr"] },
    // DoD can expose the Phoenix as P4 when it is used as a four in a straight.
    { key: "PHOENIX", label: "Phoenix", aliases: ["p", "ph", "phoenix", "phx", "_ph", "p4"] },
    { key: "DOG", label: "Dog", aliases: ["dg", "dog", "dogs", "sk", "hounds", "_dg"] },
    { key: "MAHJONG", label: "Mahjong (1)", aliases: ["1", "mj", "mahjong", "mah jong", "sparrow", "ma", "_1"] }
  ];
  const SPECIAL_KEYS = SPECIAL_DEFS.map(item => item.key);
  const STANDARD_CARDS = [];
  for (const rank of ASC_RANKS) {
    for (const suit of SUITS) STANDARD_CARDS.push(`${rank}${suit.id}`);
  }
  const ALL_CARDS = [...STANDARD_CARDS, ...SPECIAL_KEYS];
  const CARD_SET = new Set(ALL_CARDS);

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

  const state = {
    currentRoundText: "",
    inHand: new Set(),
    everInHand: new Set(),
    tradedOut: new Map(),         // historical outgoing trade: card key -> L / P / R
    tradedIn: new Set(),          // incoming card identities observed after the exchange
    pendingTrades: new Map(),     // card key -> L / P / R, provisional selection only
    played: new Set(),            // public-play evidence only
    unresolved: new Map(),        // temporarily absent from my hand, not yet proven played/traded
    preTradeHand: new Set(),      // last observed hand before the trade phase
    unmappedSpecials: new Set(),
    tradingActive: null,
    lastActionText: "",
    lastTableSignature: "",
    lastPlayActor: null,
    lastTableCards: [],
    lastNonPhoenixSingleRank: null,
    tichuCalls: new Set(), // observed declaration calls; absence is not proof of no call
    ignoreBoardForScan: false,
    comboCacheSignature: "",
    comboCache: [],
    scanTimer: null,
    scanInProgress: false,
    forceCommitTrades: false,
    observer: null,
    observedRoot: null,
    fallbackScanTimer: null,
    bootTimer: null,
    clickListenerAttached: false,
    probabilityCacheSignature: "",
    probabilityCacheWorlds: null,
    probabilityCacheSamples: 24,
    probabilityEstimateCacheSignature: "",
    probabilityEstimateCache: new Map()
  };

  const hudElements = {
    root: null,
    body: null,
    cardCells: new Map(),
    specialCells: new Map(),
    roundLabel: null,
    wishLabel: null,
    countsLabel: null,
    tradedLabel: null,
    unmappedLabel: null,
    adviceTitle: null,
    adviceDetails: null,
    declarationTitle: null,
    declarationDetails: null,
    dragonTitle: null,
    dragonDetails: null,
    probabilityRows: null,
    probabilityNote: null,
    statusLabel: null
  };

  function isStandardCard(code) {
    if (!code || code.length !== 2) return false;
    return RANKS.includes(code[0]) && SUITS.some(suit => suit.id === code[1]);
  }

  function resolveSpecialKey(rawCode) {
    if (!rawCode) return null;
    let normalized = rawCode.trim().toLowerCase().replace(/\s+/g, " ");
    normalized = normalized.replace(/^_/, "");
    for (const spec of SPECIAL_DEFS) {
      if (spec.aliases.includes(normalized) || spec.aliases.includes(`_${normalized}`)) return spec.key;
    }
    // Phoenix is occasionally rendered as P followed by its chosen straight value (e.g. P4).
    if (/^p(?:h)?\d+$/.test(normalized) || normalized.startsWith("phoenix")) return "PHOENIX";
    if (normalized.startsWith("dr") || normalized === "dragon") return "DRAGON";
    if (normalized.startsWith("do") || normalized.startsWith("dg")) return "DOG";
    if (normalized === "1" || normalized.startsWith("mah") || normalized.startsWith("sparrow")) return "MAHJONG";
    state.unmappedSpecials.add(rawCode);
    return null;
  }

  function normalizeCardCode(rawCode) {
    if (!rawCode) return null;
    const raw = String(rawCode).trim();
    if (!raw) return null;

    // Standard codes are rank + suit. Be tolerant of uppercase suits and "10" for ten.
    const canonical = raw.match(/^(10|[AKQJT2-9])([SHDC])$/i);
    if (canonical) {
      const rank = canonical[1] === "10" ? "T" : canonical[1].toUpperCase();
      const suit = canonical[2].toLowerCase();
      const code = `${rank}${suit}`;
      if (isStandardCard(code)) return code;
    }
    if (isStandardCard(raw)) return raw;

    const special = resolveSpecialKey(raw);
    if (special) return special;
    return `UNKNOWN:${raw}`;
  }

  function clearRoundData(newRoundText = "") {
    state.currentRoundText = newRoundText;
    state.inHand.clear();
    state.everInHand.clear();
    state.tradedOut.clear();
    state.tradedIn.clear();
    state.pendingTrades.clear();
    state.played.clear();
    state.unresolved.clear();
    state.preTradeHand.clear();
    state.unmappedSpecials.clear();
    state.lastActionText = "";
    state.lastTableSignature = "";
    state.lastPlayActor = null;
    state.lastTableCards = [];
    state.lastNonPhoenixSingleRank = null;
    state.tichuCalls.clear();
    state.ignoreBoardForScan = false;
    state.comboCacheSignature = "";
    state.comboCache = [];
    state.tradingActive = null;
    state.forceCommitTrades = false;
    state.probabilityCacheSignature = "";
    state.probabilityCacheWorlds = null;
    state.probabilityEstimateCacheSignature = "";
    state.probabilityEstimateCache.clear();
  }

  function resetRoundState(newRoundText = "") {
    clearRoundData(newRoundText);
    scheduleScan();
  }

  function createHud() {
    const existing = document.getElementById("tichu-tracker-hud");
    if (existing && existing.isConnected && hudElements.root === existing && hudElements.body) return;
    // A framework-driven body replacement can detach the old HUD while this
    // content-script instance remains alive. Never keep references to its cells.
    if (existing) existing.remove();
    hudElements.cardCells.clear();
    hudElements.specialCells.clear();
    for (const key of Object.keys(hudElements)) {
      if (key !== "cardCells" && key !== "specialCells") hudElements[key] = null;
    }

    const root = document.createElement("div");
    root.id = "tichu-tracker-hud";

    const header = document.createElement("div");
    header.id = "tichu-tracker-header";
    const title = document.createElement("span");
    title.textContent = "TICHU TRACKER";
    header.appendChild(title);

    const controls = document.createElement("div");
    controls.className = "tt-controls";
    const resetBtn = document.createElement("button");
    resetBtn.className = "tt-btn";
    resetBtn.textContent = "Reset";
    resetBtn.title = "Clear tracked cards for a new round";
    resetBtn.addEventListener("click", () => {
      const roundEl = document.getElementById("txtRound");
      resetRoundState(roundEl ? roundEl.textContent.trim() : "");
    });

    const minBtn = document.createElement("button");
    minBtn.className = "tt-btn";
    minBtn.textContent = "—";
    minBtn.title = "Minimize / Restore";
    controls.appendChild(resetBtn);
    controls.appendChild(minBtn);
    header.appendChild(controls);
    root.appendChild(header);

    const body = document.createElement("div");
    body.id = "tichu-tracker-body";
    minBtn.addEventListener("click", () => {
      const isHidden = body.style.display === "none";
      body.style.display = isHidden ? "" : "none";
      minBtn.textContent = isHidden ? "—" : "+";
    });

    for (const suit of SUITS) {
      const row = document.createElement("div");
      row.className = "tt-suit-row";
      const suitLabel = document.createElement("div");
      suitLabel.className = `tt-suit-label ${suit.cssClass}`;
      suitLabel.textContent = suit.symbol;
      row.appendChild(suitLabel);
      for (const rank of RANKS) {
        const cardCode = `${rank}${suit.id}`;
        const cell = document.createElement("div");
        cell.className = "tt-card-cell tt-state-unknown";
        cell.textContent = rank;
        cell.title = cardCode;
        row.appendChild(cell);
        hudElements.cardCells.set(cardCode, cell);
      }
      body.appendChild(row);
    }

    const specialsRow = document.createElement("div");
    specialsRow.id = "tichu-tracker-specials";
    for (const spec of SPECIAL_DEFS) {
      const cell = document.createElement("div");
      cell.className = "tt-special-cell tt-state-unknown";
      cell.textContent = spec.label;
      cell.title = spec.key;
      specialsRow.appendChild(cell);
      hudElements.specialCells.set(spec.key, cell);
    }
    body.appendChild(specialsRow);

    const meta = document.createElement("div");
    meta.id = "tichu-tracker-meta";
    const row1 = document.createElement("div");
    row1.className = "tt-meta-row";
    hudElements.roundLabel = document.createElement("span");
    hudElements.roundLabel.textContent = "Round: -";
    hudElements.wishLabel = document.createElement("span");
    hudElements.wishLabel.className = "tt-wish-label";
    hudElements.wishLabel.textContent = "Wish: None";
    row1.appendChild(hudElements.roundLabel);
    row1.appendChild(hudElements.wishLabel);

    const row2 = document.createElement("div");
    row2.className = "tt-meta-row";
    hudElements.countsLabel = document.createElement("span");
    hudElements.countsLabel.textContent = "Cards [L / P / R]: - / - / -";
    row2.appendChild(hudElements.countsLabel);

    const statusRow = document.createElement("div");
    statusRow.className = "tt-meta-row tt-status-row";
    hudElements.statusLabel = document.createElement("span");
    hudElements.statusLabel.textContent = "Waiting for game board…";
    statusRow.appendChild(hudElements.statusLabel);

    const row3 = document.createElement("div");
    row3.className = "tt-meta-row tt-trade-row";
    hudElements.tradedLabel = document.createElement("span");
    hudElements.tradedLabel.textContent = "Trades: None recorded";
    row3.appendChild(hudElements.tradedLabel);

    const row4 = document.createElement("div");
    row4.className = "tt-meta-row";
    hudElements.unmappedLabel = document.createElement("span");
    hudElements.unmappedLabel.className = "tt-unmapped-label";
    row4.appendChild(hudElements.unmappedLabel);

    meta.appendChild(row1);
    meta.appendChild(row2);
    meta.appendChild(statusRow);
    meta.appendChild(row3);
    meta.appendChild(row4);
    body.appendChild(meta);

    const advice = document.createElement("section");
    advice.id = "tichu-tracker-advice";
    const adviceHeading = document.createElement("div");
    adviceHeading.className = "tt-section-title";
    adviceHeading.textContent = "Move recommendation (heuristic)";
    advice.appendChild(adviceHeading);
    hudElements.adviceTitle = document.createElement("div");
    hudElements.adviceTitle.className = "tt-advice-title";
    hudElements.adviceTitle.textContent = "Waiting for board state…";
    advice.appendChild(hudElements.adviceTitle);
    hudElements.adviceDetails = document.createElement("div");
    hudElements.adviceDetails.className = "tt-advice-details";
    hudElements.adviceDetails.textContent = "The recommendation will update as visible cards change.";
    advice.appendChild(hudElements.adviceDetails);
    body.appendChild(advice);

    const probabilities = document.createElement("section");
    probabilities.id = "tichu-tracker-probabilities";
    const probHeading = document.createElement("div");
    probHeading.className = "tt-section-title";
    probHeading.textContent = "Hand probabilities";
    probabilities.appendChild(probHeading);
    hudElements.probabilityNote = document.createElement("div");
    hudElements.probabilityNote.className = "tt-probability-note";
    hudElements.probabilityNote.textContent = "Estimates assume unknown cards are evenly distributed.";
    probabilities.appendChild(hudElements.probabilityNote);
    hudElements.probabilityRows = document.createElement("div");
    hudElements.probabilityRows.className = "tt-probability-rows";
    probabilities.appendChild(hudElements.probabilityRows);
    body.appendChild(probabilities);

    const declarations = document.createElement("section");
    declarations.id = "tichu-tracker-declarations";
    const declarationHeading = document.createElement("div");
    declarationHeading.className = "tt-section-title";
    declarationHeading.textContent = "Tichu declaration advisor";
    declarations.appendChild(declarationHeading);
    hudElements.declarationTitle = document.createElement("div");
    hudElements.declarationTitle.className = "tt-advice-title";
    hudElements.declarationTitle.textContent = "Waiting for a stable hand…";
    declarations.appendChild(hudElements.declarationTitle);
    hudElements.declarationDetails = document.createElement("div");
    hudElements.declarationDetails.className = "tt-advice-details";
    hudElements.declarationDetails.textContent = "Grand Tichu advice uses the initial eight cards; Tichu advice uses all 14 before your first play.";
    declarations.appendChild(hudElements.declarationDetails);
    body.appendChild(declarations);

    const dragonAdvice = document.createElement("section");
    dragonAdvice.id = "tichu-tracker-dragon-advice";
    const dragonHeading = document.createElement("div");
    dragonHeading.className = "tt-section-title";
    dragonHeading.textContent = "Dragon gift adviser";
    dragonAdvice.appendChild(dragonHeading);
    hudElements.dragonTitle = document.createElement("div");
    hudElements.dragonTitle.className = "tt-advice-title";
    hudElements.dragonTitle.textContent = "Waiting for opponent card counts…";
    dragonAdvice.appendChild(hudElements.dragonTitle);
    hudElements.dragonDetails = document.createElement("div");
    hudElements.dragonDetails.className = "tt-advice-details";
    hudElements.dragonDetails.textContent = "When you win a trick with Dragon, give the whole trick to one of the opponents—not just the Dragon card.";
    dragonAdvice.appendChild(hudElements.dragonDetails);
    body.appendChild(dragonAdvice);

    const legend = document.createElement("div");
    legend.className = "tt-legend";
    legend.textContent = "Blue: Hand | Gold: Traded | Dim: Played";
    body.appendChild(legend);

    root.appendChild(body);
    document.body.appendChild(root);
    hudElements.root = root;
    hudElements.body = body;
    makeDraggable(root, header);
  }

  function makeDraggable(container, handle) {
    let offsetX = 0;
    let offsetY = 0;
    let isDragging = false;
    handle.style.touchAction = "none";
    handle.addEventListener("pointerdown", event => {
      if (event.target.closest("button")) return;
      isDragging = true;
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
    });
    const stopDragging = () => { isDragging = false; };
    handle.addEventListener("pointerup", stopDragging);
    handle.addEventListener("pointercancel", stopDragging);
    handle.addEventListener("lostpointercapture", stopDragging);
  }

  function extractCardCode(cardEl) {
    if (!cardEl) return null;
    const attr = cardEl.getAttribute("card");
    if (attr) return normalizeCardCode(attr);
    const bg = cardEl.querySelector(".cardbg");
    if (bg) {
      for (const className of bg.classList) {
        if (className.startsWith("_") && className.length > 1) return normalizeCardCode(className.slice(1));
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

  function getTradingPhaseActive() {
    // Destination holders and wrappers may remain mounted outside the exchange.
    // A visible Send button or explicit trading container is the strongest phase
    // signal; the generic #trading wrapper counts only when it contains cards.
    if (isElementVisible(document.getElementById("btnSend"))) return true;
    const trading = document.getElementById("trading");
    if (trading && isElementVisible(trading) && trading.querySelector(".card")) return true;
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

    // Certain DoD layouts keep the dragged card under #trading or #hand and
    // position it over a destination instead of reparenting it into the holder.
    // Use actual rendered coordinates as a fallback, with a conservative radius
    // so ordinary cards in the hand row are not mistaken for trades.
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
      // Do not assign a normal hand card to a destination merely because it is
      // nearby on screen. The card must overlap/closely touch a slot, or carry
      // an explicit drag-state marker while close to the slot.
      if ((distanceToHolder < 14 || (looksLikeActiveDrag && distanceToHolder < 34)) && distance < nearestDistance) {
        nearest = player.key;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  function readTradeSelections() {
    const selections = new Map();
    // Best signal: a card is physically inside a destination holder.
    for (const player of PLAYER_DEFS) {
      const holder = document.getElementById(player.tradeId);
      if (!holder || !isElementVisible(holder)) continue;
      for (const cardNode of holder.querySelectorAll(".card")) {
        const code = extractCardCode(cardNode);
        if (code && CARD_SET.has(code)) selections.set(code, player.key);
      }
    }

    // Fallback for layouts that render dragged cards in #trading rather than
    // nesting them in a destination element.
    const trading = document.getElementById("trading");
    if (trading && isElementVisible(trading)) {
      for (const cardNode of trading.querySelectorAll(".card")) {
        const code = extractCardCode(cardNode);
        if (!code || !CARD_SET.has(code) || selections.has(code)) continue;
        const target = inferTradeTarget(cardNode);
        if (target) selections.set(code, target);
      }
    }

    // Some versions move the visual card over a trade slot but leave the node in
    // #hand. Only accept cards whose rendered position is close to a slot.
    const hand = document.getElementById("hand");
    if (hand && isElementVisible(document.getElementById("tradingContainer"))) {
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
      // Selection/drag/animation classes are not proof of a play. A card is
      // removed from the hand model only after public-board evidence appears.
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

  function getActionText() {
    const el = document.querySelector("#txtLastAction #textContainer") || document.getElementById("txtLastAction");
    return el ? el.textContent.trim().replace(/\s+/g, " ") : "";
  }

  function actionContainsPlayerName(text, name) {
    if (!text || !name) return false;
    const escaped = String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!escaped) return false;
    // Match a complete displayed name, not a shorter name embedded in another
    // player's name (e.g. "Ann" inside "Annabelle"). Unicode boundaries also
    // work for Greek names and localized DoD action text.
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(String(text));
  }

  function findActorFromText(text) {
    if (!text) return null;
    const playersWithNames = [...PLAYER_DEFS, ME_DEF].map(player => {
      const holder = document.getElementById(player.holderId);
      const name = holder && holder.querySelector(".playerName") ? holder.querySelector(".playerName").textContent.trim() : "";
      return { player, name };
    }).filter(item => item.name).sort((left, right) => right.name.length - left.name.length);
    for (const { player, name } of playersWithNames) {
      if (actionContainsPlayerName(text, name)) return { key: player.key, name };
    }
    return null;
  }

  function actionLooksLikePlay(text) {
    const value = (text || "").toLocaleLowerCase();
    return /\bplayed\b|\bplays\b|έπαιξε|έπαιξαν|έπαιξ/.test(value);
  }

  function actionLooksLikeDogPlay(text) {
    const value = (text || "").toLocaleLowerCase();
    // DoD action text can describe the Dog handoff without using the usual
    // "played" wording (for example, "passed the Dog to ...").
    return /\bdog\b|\bdogs\b|\bhound\b|σκύλ|σκυλ/.test(value);
  }

  function getTableCards() {
    if (state.ignoreBoardForScan) return [];
    // In current DoD boards, #cardsHolder is the most reliable representation of
    // the active trick; fallback locations cover other layouts and animations.
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

  function cardRank(code) {
    if (code === "MAHJONG") return 1;
    if (code === "DOG") return 0;
    if (code === "PHOENIX") return 14.5;
    if (code === "DRAGON") return 15;
    if (!isStandardCard(code)) return -1;
    return ASC_RANKS.indexOf(code[0]) + 2;
  }

  function standardRank(code) {
    if (code === "MAHJONG") return 1;
    if (!isStandardCard(code)) return null;
    return ASC_RANKS.indexOf(code[0]) + 2;
  }

  function classifyStraight(cards, requireFlush = false) {
    if (!cards || cards.length < 5 || new Set(cards).size !== cards.length) return null;
    if (cards.some(card => !CARD_SET.has(card))) return null;
    if (cards.includes("DRAGON") || cards.includes("DOG")) return null;

    const phoenixCount = cards.filter(card => card === "PHOENIX").length;
    if (phoenixCount > 1) return null;
    const nonPhoenix = cards.filter(card => card !== "PHOENIX");

    if (requireFlush) {
      if (phoenixCount || cards.some(card => !isStandardCard(card))) return null;
      if (new Set(cards.map(card => card[1])).size !== 1) return null;
      const ranks = cards.map(standardRank);
      if (new Set(ranks).size !== ranks.length) return null;
      const low = Math.min(...ranks);
      const high = Math.max(...ranks);
      if (high - low + 1 !== cards.length) return null;
      return { type: "bomb-straight-flush", count: cards.length, rank: high, bomb: true };
    }

    // Mahjong is rank 1 and may only join a normal straight (not a pair, full
    // house, or bomb). Phoenix may fill a missing normal rank, but may not
    // impersonate Mahjong. All other ranks in a straight must be distinct.
    if (nonPhoenix.some(card => card !== "MAHJONG" && !isStandardCard(card))) return null;
    const ranks = nonPhoenix.map(standardRank);
    if (ranks.some(rank => rank === null) || new Set(ranks).size !== ranks.length) return null;
    const hasMahjong = nonPhoenix.includes("MAHJONG");
    const totalCount = cards.length;

    // Search legal rank windows instead of blindly assigning Phoenix to
    // (highest real rank + 1). A legal straight may never end above Ace (rank 14).
    // If Mahjong is present, the window must start at rank 1; otherwise it
    // starts at 2 or higher, so Phoenix cannot stand in for Mahjong.
    const minLow = hasMahjong ? 1 : 2;
    const maxLow = hasMahjong ? 1 : 15 - totalCount;
    let bestHigh = null;
    for (let low = minLow; low <= maxLow; low++) {
      const high = low + totalCount - 1;
      if (high > 14) continue;
      if (ranks.some(rank => rank < low || rank > high)) continue;
      let missing = 0;
      let missingRank = null;
      for (let rank = low; rank <= high; rank++) {
        if (!ranks.includes(rank)) {
          missing++;
          missingRank = rank;
        }
      }
      if (missing !== phoenixCount) continue;
      if (phoenixCount && missingRank === 1) continue;
      if (bestHigh === null || high > bestHigh) bestHigh = high;
    }
    if (bestHigh === null) return null;
    return { type: "straight", count: totalCount, rank: bestHigh, bomb: false };
  }

  function classifyCombo(cards) {
    // A hand is a set of physical card identities. Reject malformed duplicate
    // inputs explicitly instead of accidentally treating one physical card as a pair.
    if (!cards || !cards.length || new Set(cards).size !== cards.length) return null;
    if (cards.some(card => !CARD_SET.has(card))) return null;
    const count = cards.length;
    if (count === 1) {
      const isPhoenix = cards[0] === "PHOENIX";
      return {
        type: "single",
        count: 1,
        rank: isPhoenix ? 1.5 : cardRank(cards[0]),
        phoenixSingle: isPhoenix,
        bomb: false,
        dog: cards[0] === "DOG"
      };
    }
    if (cards.includes("DRAGON") || cards.includes("DOG") || cards.filter(card => card === "PHOENIX").length > 1) return null;
    // Mahjong cannot be paired with Phoenix or used in triples/full houses/
    // bombs. Its only multi-card combination is a normal straight.
    if (cards.includes("MAHJONG")) return count >= 5 ? classifyStraight(cards, false) : null;

    if (count >= 5) {
      const straightFlush = classifyStraight(cards, true);
      if (straightFlush) return straightFlush;
    }
    if (count === 4 && cards.every(isStandardCard) && new Set(cards.map(card => card[0])).size === 1) {
      return { type: "bomb-four", count: 4, rank: standardRank(cards[0]), bomb: true };
    }

    const phoenixCount = cards.filter(card => card === "PHOENIX").length;
    const ranks = cards.filter(card => card !== "PHOENIX").map(standardRank);
    if (ranks.some(rank => rank === null)) return null;
    const rankCounts = new Map();
    for (const rank of ranks) rankCounts.set(rank, (rankCounts.get(rank) || 0) + 1);
    const countValues = [...rankCounts.values()].sort((a, b) => b - a);

    if (count === 2) {
      return rankCounts.size === 1 ? { type: "pair", count, rank: ranks[0], bomb: false } : null;
    }

    if (count === 3) {
      if (rankCounts.size === 1 && countValues[0] === 3) return { type: "triple", count, rank: ranks[0], bomb: false };
      if (phoenixCount === 1 && ranks.length === 2 && rankCounts.size === 1 && countValues[0] === 2) {
        return { type: "triple", count, rank: ranks[0], bomb: false };
      }
      return null;
    }

    if (count === 5) {
      if (rankCounts.size === 2 && countValues[0] === 3 && countValues[1] === 2) {
        const tripleRank = [...rankCounts.entries()].find(([, amount]) => amount === 3)[0];
        return { type: "full-house", count, rank: tripleRank, bomb: false };
      }
      if (phoenixCount === 1 && rankCounts.size === 2 && countValues[0] === 3 && countValues[1] === 1) {
        const tripleRank = [...rankCounts.entries()].find(([, amount]) => amount === 3)[0];
        return { type: "full-house", count, rank: tripleRank, bomb: false };
      }
      if (phoenixCount === 1 && rankCounts.size === 2 && countValues[0] === 2 && countValues[1] === 2) {
        // Phoenix can extend either pair into the triple; conservatively classify
        // by the higher triple rank for comparison purposes.
        const pairRanks = [...rankCounts.entries()].filter(([, amount]) => amount === 2).map(([rank]) => rank);
        return { type: "full-house", count, rank: Math.max(...pairRanks), bomb: false };
      }
      const straight = classifyStraight(cards, false);
      if (straight) return straight;
      return null;
    }

    if (count >= 5) {
      const straight = classifyStraight(cards, false);
      if (straight) return straight;
    }

    // Consecutive pairs: every rank appears twice, with at most one singleton
    // completed by Phoenix. Four cards can also be a pair run, not a bomb.
    if (count >= 4 && count % 2 === 0) {
      const pairCount = count / 2;
      const values = [...rankCounts.keys()].sort((a, b) => a - b);
      const counts = [...rankCounts.values()];
      const noPhoenixPairs = phoenixCount === 0 && values.length === pairCount && counts.every(amount => amount === 2) && values[values.length - 1] - values[0] + 1 === pairCount;
      const onePhoenixCompletesPair = phoenixCount === 1 && values.length === pairCount && counts.filter(amount => amount === 1).length === 1 && counts.filter(amount => amount === 2).length === pairCount - 1 && values[values.length - 1] - values[0] + 1 === pairCount;
      if (noPhoenixPairs || onePhoenixCompletesPair) return { type: "pair-run", count, rank: values[values.length - 1], bomb: false };
    }
    return null;
  }

  function comboLabel(combo) {
    const isPhoenixSingle = Boolean(combo.phoenixSingle) || combo.rank === 14.5 || combo.rank === 1.5;
    const rankLabel = combo.rank === 1
      ? "Mahjong"
      : isPhoenixSingle
        ? "Phoenix"
        : combo.rank === 15
          ? "Dragon"
          : combo.rank === 0
            ? "Dog"
            : rankNameFromValue(Math.floor(combo.rank));
    switch (combo.type) {
      case "single": return combo.dog ? "Dog" : `${rankLabel} single`;
      case "pair": return `Pair of ${rankLabel}s`;
      case "triple": return `Triple ${rankLabel}s`;
      case "full-house": return `Full house (triple ${rankLabel}s)`;
      case "straight": return `${combo.count}-card straight to ${rankLabel}`;
      case "pair-run": return `${combo.count / 2} consecutive pairs to ${rankLabel}`;
      case "bomb-four": return `Bomb: four ${rankLabel}s`;
      case "bomb-straight-flush": return `Bomb: straight flush to ${rankLabel}`;
      default: return combo.type;
    }
  }

  function rankNameFromValue(value) {
    if (value === 10) return "10";
    const code = ASC_RANKS[value - 2];
    return code === "T" ? "10" : (code || String(value));
  }

  function displayCard(card) {
    if (isStandardCard(card)) {
      const suit = SUITS.find(item => item.id === card[1]);
      const rank = card[0] === "T" ? "10" : card[0];
      return `${rank}${suit ? suit.symbol : card[1]}`;
    }
    const spec = SPECIAL_DEFS.find(item => item.key === card);
    return spec ? spec.label : card;
  }

  function displayCards(cards) {
    return cards.map(displayCard).join(" + ");
  }

  function enumerateCombos(hand) {
    const signature = [...hand].sort().join(",");
    if (signature === state.comboCacheSignature) return state.comboCache;
    state.comboCacheSignature = signature;
    state.comboCache = [];
    const cards = [...hand];
    if (!cards.length) return state.comboCache;
    // A normal Tichu hand has 14 cards (16,383 subsets), which is small enough
    // for complete subset enumeration. The fallback protects odd game states.
    if (cards.length > 16) {
      for (const card of cards) state.comboCache.push({ cards: [card], ...classifyCombo([card]) });
      return state.comboCache;
    }
    const totalMasks = 1 << cards.length;
    for (let mask = 1; mask < totalMasks; mask++) {
      const selection = [];
      for (let index = 0; index < cards.length; index++) {
        if (mask & (1 << index)) selection.push(cards[index]);
      }
      const combo = classifyCombo(selection);
      if (combo) state.comboCache.push({ ...combo, cards: selection });
    }
    return state.comboCache;
  }

  function canBeat(candidate, current) {
    // The Dog ends the trick by handing the lead to the partner; it cannot be
    // beaten by an ordinary play or a bomb.
    if (!candidate || !current || candidate.dog || current.dog) return false;
    if (candidate.bomb) {
      if (!current.bomb) return true;
      if (candidate.type === "bomb-straight-flush" && current.type === "bomb-four") return true;
      if (candidate.type === "bomb-four" && current.type === "bomb-straight-flush") return false;
      if (candidate.type === "bomb-straight-flush" && current.type === "bomb-straight-flush") {
        return candidate.count > current.count || (candidate.count === current.count && candidate.rank > current.rank);
      }
      return candidate.type === current.type && candidate.count === current.count && candidate.rank > current.rank;
    }
    if (current.bomb) return false;
    // A single Phoenix in hand beats any single on the table except the Dragon (15).
    if (candidate.type === "single" && current.type === "single" && candidate.phoenixSingle) {
      return current.rank < 15;
    }
    return candidate.type === current.type && candidate.count === current.count && candidate.rank > current.rank;
  }

  function actionLooksLikeTichuCall(text) {
    const value = String(text || "").toLocaleLowerCase();
    const namesTichu = /\b(?:grand\s+)?tichu\b|γκραντ\s*τίτσου|γκραντ\s*τιτσου|τίτσου|τιτσου/i.test(value);
    const declares = /\b(?:call(?:ed|s)?|declar(?:e|ed|es|ing)|announc(?:e|ed|es|ing))\b|δήλωσ|δηλωσ|ανακοίνωσ|ανακοινωσ|κάλεσ|καλεσ/i.test(value);
    return namesTichu && declares;
  }

  function recordTichuCallFromAction(text) {
    if (!actionLooksLikeTichuCall(text)) return false;
    const actor = findActorFromText(text);
    if (!actor) return false;
    state.tichuCalls.add(actor.key);
    return true;
  }

  function hasOpponentNearlyOut(counts) {
    // Opponent urgency must not be triggered merely because our partner is low.
    // Zero cards means the player has already gone out; do not confuse that
    // state with the urgent one-card-left case.
    return ["L", "R"].some(key => Number.isFinite(counts && counts[key]) && counts[key] === 1);
  }

  function updateActorForNewTable(parsedActor) {
    // A new visible table play replaces the previous actor evidence. Passing null
    // intentionally clears a stale actor instead of inferring the old winner.
    state.lastPlayActor = parsedActor || null;
    return state.lastPlayActor;
  }

  function getDragonGiftAdvice(counts, calledSeats = state.tichuCalls) {
    const leftCount = counts && counts.L;
    const rightCount = counts && counts.R;
    const unavailable = (title, details, tone = "neutral") => ({ seat: null, tone, title, details });
    if (!Number.isFinite(leftCount) || !Number.isFinite(rightCount) || leftCount < 0 || rightCount < 0) {
      return unavailable(
        "Dragon gift: waiting for both opponents' card counts",
        "The adviser needs reliable Left and Right remaining-card counts. It will not guess a recipient when either count is missing.",
        "warn"
      );
    }
    if (leftCount === 0 && rightCount === 0) {
      return unavailable("Dragon gift: no active opponents detected", "Both opponent counts are zero; the round may already be ending or the counters may be temporarily stale.", "warn");
    }

    if (leftCount !== rightCount) {
      const seat = leftCount > rightCount ? "L" : "R";
      const label = seat === "L" ? "Left opponent" : "Right opponent";
      const chosenCount = seat === "L" ? leftCount : rightCount;
      const otherCount = seat === "L" ? rightCount : leftCount;
      const knownCall = calledSeats && typeof calledSeats.has === "function" && calledSeats.has(seat);
      const callCaveat = knownCall
        ? " A Tichu/Grand Tichu declaration has been observed for this opponent; that is a strategic warning, but the larger hand count is still the primary rule-of-thumb signal."
        : " No declaration call is recorded for this opponent; that does not prove they have not called if tracking started late or DoD's action text was unrecognized.";
      return {
        seat,
        tone: "good",
        title: `Dragon gift: ${label}`,
        details: `${label} has ${chosenCount} cards versus ${otherCount}, so they are currently furthest from going out. The usual heuristic is to give the entire Dragon-winning trick to the opponent with more cards; the last player's captured tricks transfer to the first finisher. This is a heuristic, not a guaranteed optimal choice.${callCaveat} Per-player captured-point totals are not reliably exposed by the current tracker, so they are not fabricated or used as a tie-break.`
      };
    }

    const leftCalled = Boolean(calledSeats && typeof calledSeats.has === "function" && calledSeats.has("L"));
    const rightCalled = Boolean(calledSeats && typeof calledSeats.has === "function" && calledSeats.has("R"));
    if (leftCalled !== rightCalled) {
      const seat = leftCalled ? "R" : "L";
      const label = seat === "L" ? "Left opponent" : "Right opponent";
      const calledLabel = leftCalled ? "Left" : "Right";
      return {
        seat,
        tone: "warn",
        title: `Dragon gift: lean ${label}`,
        details: `Both opponents have ${leftCount} cards, so card count gives no preference. A Tichu/Grand Tichu call was observed for ${calledLabel} only, so this heuristic leans toward the other opponent. Declaration tracking is based on recognized action text; no recorded call is not proof that no call occurred. Collected point totals are not reliably available, so confidence is low.`
      };
    }

    return unavailable(
      "Dragon gift: no clear favourite",
      `Both opponents have ${leftCount} cards and the observed declaration information does not distinguish them. Either recipient is reasonable based on the visible data. A reliable tie-break would need captured-point totals and complete declaration history, which are not available from the current tracker.`,
      "neutral"
    );
  }

  function getActionContext() {
    const actionText = getActionText();
    const actionChanged = Boolean(actionText && actionText !== state.lastActionText);

    if (actionChanged) {
      state.lastActionText = actionText;
      recordTichuCallFromAction(actionText);
      // Re-resolve the actor before querying table cards so seat-specific
      // containers (#cardsHolderLeft/Up/Right/Bottom) use the latest actor.
      if (actionLooksLikePlay(actionText) || actionLooksLikeDogPlay(actionText)) {
        const actor = findActorFromText(actionText);
        state.lastPlayActor = actor || null;
      }
    }

    const tableCards = getTableCards();
    const signature = [...tableCards].sort().join(",");

    if (!tableCards.length) {
      state.lastTableSignature = "";
      state.lastPlayActor = null;
      state.lastNonPhoenixSingleRank = null;
    } else if (signature !== state.lastTableSignature) {
      if (
        tableCards.length === 1 &&
        tableCards[0] === "PHOENIX" &&
        state.lastTableCards.length === 1 &&
        state.lastTableCards[0] !== "PHOENIX"
      ) {
        state.lastNonPhoenixSingleRank = cardRank(state.lastTableCards[0]);
      } else if (tableCards.length !== 1 || tableCards[0] !== "PHOENIX") {
        state.lastNonPhoenixSingleRank = null;
      }
      state.lastTableSignature = signature;
      // A new table signature means a new visible play. Always re-resolve the
      // actor from current action text; never carry the previous trick winner
      // forward when DoD uses an unexpected/localized action verb.
      updateActorForNewTable(findActorFromText(actionText));
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

  function resolveDogHandoffContext(actionContext, isOurTurn) {
    const context = actionContext || { tableCards: [], currentCombo: null, actor: null, actionText: "" };
    const oneCardDog = context.currentCombo && context.currentCombo.dog &&
      Array.isArray(context.tableCards) && context.tableCards.length === 1 && context.tableCards[0] === "DOG";
    if (!oneCardDog) return { ...context, dogHandoff: false };

    const actorKey = context.actor && context.actor.key;
    // The Dog is not a normal active trick that anyone can beat: it ends the
    // trick immediately and gives the next lead to the Dog player's partner.
    // Prefer explicit actor evidence. If actor parsing fails, use local history
    // to avoid mistaking our own recently played Dog for a teammate handoff.
    const knownDogTradeTarget = state.tradedOut.get("DOG") || null;
    const likelyOurOwnDog = state.everInHand.has("DOG") && !knownDogTradeTarget;
    const knownOpponentDog = knownDogTradeTarget === "L" || knownDogTradeTarget === "R";
    if (isOurTurn && actorKey === "P") {
      return { ...context, tableCards: [], currentCombo: null, dogHandoff: true };
    }
    if (isOurTurn && actorKey == null && !likelyOurOwnDog && !knownOpponentDog) {
      return { ...context, tableCards: [], currentCombo: null, dogHandoff: true };
    }
    return { ...context, dogHandoff: false };
  }

  function getPointPenalty(card) {
    if (card === "DRAGON") return 7;
    if (card === "PHOENIX") return 5.5;
    if (card === "DOG") return 1.5;
    if (card === "MAHJONG") return 0.6;
    const rank = card[0];
    if (rank === "A") return 1.6;
    if (rank === "K") return 1.1;
    if (rank === "T" || rank === "5") return 0.5;
    return 0;
  }

  function breaksUsefulGroup(candidate, hand) {
    const remaining = new Set(hand);
    let penalty = 0;
    for (const card of candidate.cards) remaining.delete(card);
    const allRanks = new Map();
    for (const card of hand) {
      if (isStandardCard(card)) allRanks.set(card[0], (allRanks.get(card[0]) || 0) + 1);
    }
    for (const card of candidate.cards) {
      if (isStandardCard(card) && allRanks.get(card[0]) >= 2) {
        const stillSameRank = [...remaining].filter(other => isStandardCard(other) && other[0] === card[0]).length;
        if (stillSameRank === 1 && candidate.count === 1) penalty += 2.2;
      }
    }
    return penalty;
  }

  function scoreLead(candidate, hand) {
    const specialCost = candidate.cards.reduce((sum, card) => sum + getPointPenalty(card), 0);
    const groupPenalty = breaksUsefulGroup(candidate, hand);
    // Shed more cards early, but avoid spending the strongest cards and breaking pairs.
    return candidate.count * 6 - specialCost - groupPenalty - Math.max(0, candidate.rank) * 0.025;
  }

  function scoreReply(candidate, current, hand, opponentNearlyOut) {
    const specialCost = candidate.cards.reduce((sum, card) => sum + getPointPenalty(card), 0);
    const bombCost = candidate.bomb ? 12 : 0;
    const groupPenalty = breaksUsefulGroup(candidate, hand);
    const controlBonus = opponentNearlyOut ? 18 : 0;
    // Prefer inexpensive over-calls while assigning extra value to stopping a player
    // who has only one card left.
    return candidate.count * 5 + controlBonus - specialCost - bombCost - groupPenalty - candidate.rank * 0.08;
  }

  function parseWishRank(text) {
    const value = String(text || "").trim();
    if (!value) return null;
    const contextual = value.match(/(?:wish(?:ed)?|ζήτησε|ζητησε|ζητά|ζητα)[^0-9AKQJT]*(10|[2-9]|[AKQJT])\b/i);
    const fallbackMatches = [...value.matchAll(/\b(10|[2-9]|[AKQJT])\b/gi)];
    const token = contextual ? contextual[1] : (fallbackMatches.length ? fallbackMatches[fallbackMatches.length - 1][1] : null);
    if (!token) return null;
    return token === "10" ? "T" : token.toUpperCase();
  }

  function getWishRank() {
    const wishEl = document.getElementById("txtAskedCard");
    if (!wishEl || !isElementVisible(wishEl)) return null;
    return parseWishRank(wishEl.textContent);
  }

  function candidateContainsWish(candidate, wishRank) {
    return Boolean(wishRank && candidate.cards.some(card => isStandardCard(card) && card[0] === wishRank));
  }

  function chooseWithEstimatedSurvival(candidates, heuristicScore, probabilityContext, limit = 4) {
    const finalists = candidates.slice().sort((a, b) => heuristicScore(b) - heuristicScore(a)).slice(0, limit);
    let chosen = null;
    let chosenScore = -Infinity;
    for (const candidate of finalists) {
      const baseline = heuristicScore(candidate);
      const threat = estimateNoResponseProbability(candidate, probabilityContext);
      candidate._trackerThreat = threat;
      // Simulation is a bounded tie-breaker/adjustment, not an assertion of
      // game-theoretic optimality. Keep the existing hand-shedding heuristic primary.
      // Dog resolves by transferring the lead to the partner; do not reward it
      // as if an unanswerable play gave the player normal trick control.
      const score = baseline + (threat && !candidate.dog ? (threat.probability - 0.5) * 10 : 0);
      if (score > chosenScore) {
        chosen = candidate;
        chosenScore = score;
      }
    }
    return chosen;
  }

  function confidenceLabel(probabilityContext, threat) {
    if (!probabilityContext || !probabilityContext.consistent) return "low — incomplete card ledger";
    if (!threat || threat.samples < 24) return "low — insufficient simulation data";
    return "low–moderate — small finite sample under a uniform-deal assumption";
  }

  function declarationHandMetrics(cards) {
    const hand = [...new Set(cards || [])];
    let score = 28;
    const rankCounts = new Map();
    const presentRanks = new Set();
    const controls = [];

    for (const card of hand) {
      if (card === "DRAGON") { score += 18; controls.push("Dragon"); }
      else if (card === "PHOENIX") { score += 15; controls.push("Phoenix"); }
      else if (card === "DOG") score += 3;
      else if (card === "MAHJONG") { score += 1.5; presentRanks.add(1); }
      else if (isStandardCard(card)) {
        const rank = standardRank(card);
        presentRanks.add(rank);
        rankCounts.set(rank, (rankCounts.get(rank) || 0) + 1);
        if (card[0] === "A") { score += 8.5; controls.push("Ace"); }
        else if (card[0] === "K") score += 4.2;
        else if (card[0] === "Q") score += 2.2;
        else if (card[0] === "J") score += 1.1;
        else if (card[0] === "T") score += 0.4;
      }
    }

    const pairedRanks = [];
    const aceCount = hand.filter(card => isStandardCard(card) && card[0] === "A").length;
    let tripleCount = 0;
    let bombCount = 0;
    for (const [rank, amount] of rankCounts) {
      if (amount >= 2) pairedRanks.push(rank);
      if (amount === 3) tripleCount++;
      if (amount === 4) bombCount++;
      if (amount === 2) score += 2.5;
      else if (amount === 3) score += 4.5;
      else if (amount === 4) score += 6.5;
    }

    // Potentially easy shedding structures: long straights (including a 1-card
    // Phoenix bridge for normal ranks >= 2) and adjacent pairs.
    const hasPhoenix = hand.includes("PHOENIX");
    let bestRun = [];
    for (let low = 1; low <= 14; low++) {
      if (low === 1 && !presentRanks.has(1)) continue;
      const currentRun = [];
      let gapsLeft = hasPhoenix ? 1 : 0;
      for (let rank = low; rank <= 14; rank++) {
        if (presentRanks.has(rank)) {
          currentRun.push(rank);
        } else if (gapsLeft > 0 && rank > 1) {
          gapsLeft--;
          currentRun.push(rank);
        } else {
          break;
        }
      }
      if (currentRun.length > bestRun.length) bestRun = currentRun;
    }
    if (bestRun.length >= 5) score += Math.min(8, 3 + (bestRun.length - 5) * 1.2);

    pairedRanks.sort((a, b) => a - b);
    let pairRun = 0;
    let bestPairRun = 0;
    let previousPairRank = null;
    for (const rank of pairedRanks) {
      pairRun = previousPairRank !== null && rank === previousPairRank + 1 ? pairRun + 1 : 1;
      bestPairRun = Math.max(bestPairRun, pairRun);
      previousPairRank = rank;
    }
    if (bestPairRun >= 2) score += 2.5 + Math.min(3, bestPairRun - 2);
    if (tripleCount && pairedRanks.length > tripleCount) score += 2.5;
    if (bombCount) score += 1.5;

    const bestRunSet = new Set(bestRun.length >= 5 ? bestRun : []);
    let weakLooseCards = 0;
    for (const [rank, amount] of rankCounts) {
      if (amount !== 1 || bestRunSet.has(rank)) continue;
      if (rank <= 8) { score -= 1.8; weakLooseCards++; }
      else if (rank <= 10) { score -= 1; weakLooseCards++; }
      else if (rank <= 12) score -= 0.4;
    }

    return {
      score: Math.max(0, Math.min(100, Math.round(score))),
      controls: [...new Set(controls)],
      aceCount,
      pairedRanks: pairedRanks.length,
      tripleCount,
      bombCount,
      longestRun: bestRun.length,
      weakLooseCards
    };
  }

  function getDeclarationAdvice(hand, context = {}) {
    const cards = [...new Set(hand || [])];
    const handCount = cards.length;
    const tradingActive = Boolean(context.tradingActive);
    const playedCount = Number.isFinite(context.playedCount) ? context.playedCount : 0;
    const myPlayedCount = Number.isFinite(context.myPlayedCount) ? context.myPlayedCount : 0;
    const tradedOutCount = Number.isFinite(context.tradedOutCount) ? context.tradedOutCount : 0;

    const unavailable = (title, details, tone = "neutral") => ({
      stage: null, score: null, tone, title, details
    });
    if (tradingActive) {
      return unavailable("Declaration advice: wait for trading to finish", "The hand is changing during the exchange; wait for a stable 8-card or 14-card hand before evaluating a call.", "warn");
    }

    let stage;
    if (handCount === 8 && playedCount === 0 && tradedOutCount === 0) {
      stage = "grand-tichu";
    } else if (handCount === 14 && myPlayedCount === 0) {
      stage = "tichu";
    } else if (myPlayedCount > 0) {
      return unavailable("Declaration window likely closed", "Tichu must be called before your first play. Grand Tichu advice is only shown for the initial eight-card deal before any play is observed.");
    } else {
      return unavailable("Tichu declaration advisor", "For Grand Tichu, evaluate the initial 8 cards before any card is played. For Tichu, evaluate all 14 cards before your first play.");
    }

    const metrics = declarationHandMetrics(cards);
    const grand = stage === "grand-tichu";
    const callThreshold = grand ? 68 : 65;
    const borderlineThreshold = grand ? 55 : 52;
    let action;
    let tone;
    if (metrics.score >= callThreshold) {
      action = "CALL CANDIDATE";
      tone = "good";
    } else if (metrics.score >= borderlineThreshold) {
      action = "BORDERLINE — lean pass";
      tone = "warn";
    } else {
      action = "DO NOT CALL";
      tone = "neutral";
    }

    const label = grand ? "Grand Tichu" : "Tichu";
    const controlLabels = metrics.controls.filter(name => name !== "Ace");
    if (metrics.aceCount) controlLabels.push(`${metrics.aceCount} Ace${metrics.aceCount === 1 ? "" : "s"}`);
    const controls = controlLabels.length
      ? controlLabels.join(", ")
      : "no Dragon, Phoenix, or Ace";
    const structure = [
      metrics.pairedRanks ? `${metrics.pairedRanks} paired rank${metrics.pairedRanks === 1 ? "" : "s"}` : "no pairs",
      metrics.longestRun >= 5 ? `rank run of ${metrics.longestRun}` : null,
      metrics.weakLooseCards ? `${metrics.weakLooseCards} weak loose low card${metrics.weakLooseCards === 1 ? "" : "s"}` : null
    ].filter(Boolean).join("; ");
    const timing = grand
      ? "Grand Tichu is worth +200 if you finish first and −200 otherwise. This recommendation assumes these are the initial eight cards and the declaration window is still open."
      : "Tichu is worth +100 if you finish first and −100 otherwise; call only before your first play.";
    return {
      stage,
      score: metrics.score,
      tone,
      title: `${label}: ${action} · hand index ${metrics.score}/100`,
      details: `High-card control: ${controls}. Structure: ${structure}. ${timing} The hand index is a heuristic, not a win probability; opponent behavior, partner declarations, team score, and table tendencies are not modeled. If you have already declared, ignore this reminder.`,
      metrics
    };
  }

  function getRecommendation(hand, actionContext, counts, isOurTurn, isTradingActive, probabilityContext = null) {
    // renderHud may already have normalized the Dog handoff for the probability
    // display; preserve that evidence instead of trying to infer it a second time.
    actionContext = actionContext && actionContext.dogHandoff
      ? actionContext
      : resolveDogHandoffContext(actionContext, isOurTurn);
    if (isTradingActive) {
      return {
        title: "Trade phase active — finish the exchange first",
        details: "Selections are provisional until DoD completes the exchange. Selected/dragged cards remain in your hand model until the trade is committed.",
        tone: "neutral"
      };
    }
    if (!isOurTurn) {
      return {
        title: "Waiting for your turn",
        details: "Card tracking continues as public information changes. Probabilities assume uniformly distributed hidden cards; move advice is a heuristic, not perfect-information play.",
        tone: "neutral"
      };
    }
    if (actionContext.currentCombo && actionContext.currentCombo.dog && actionContext.actor && actionContext.actor.key === "ME") {
      return {
        title: "DOG played — lead transferred to your partner",
        details: "The Dog ends the trick and transfers the next lead to your partner. DoD's turn indicator has not advanced yet, so wait for the board to update rather than trying to beat the Dog.",
        tone: "neutral"
      };
    }
    if (!hand.length) {
      return { title: "No cards detected in your hand", details: "Check whether DoD has finished dealing or whether the hand selector changed.", tone: "warn" };
    }

    const { tableCards, currentCombo, actor } = actionContext;
    const hasTablePlay = tableCards.length > 0;
    const wishRank = getWishRank();
    const candidates = enumerateCombos(hand);

    if (!hasTablePlay) {
      let leads = candidates;
      const wishLeads = wishRank ? leads.filter(candidate => candidateContainsWish(candidate, wishRank)) : [];
      const satisfyingWish = wishLeads.length > 0;
      if (satisfyingWish) leads = wishLeads;
      if (!leads.length) return { title: "No lead identified", details: "No legal combination was found in the visible hand.", tone: "warn" };
      const chosen = chooseWithEstimatedSurvival(leads, candidate => scoreLead(candidate, hand), probabilityContext);
      const wishReason = satisfyingWish ? ` The Mahjong wish for ${rankNameFromValue(ASC_RANKS.indexOf(wishRank) + 2)} is active, and this move satisfies it.` : "";
      const dogHandoffReason = actionContext.dogHandoff
        ? " Your partner's Dog ended the previous trick and transferred the lead to you; this is a fresh lead, not a response to beat the Dog."
        : "";
      const threat = chosen && chosen._trackerThreat;
      const simulation = chosen.dog
        ? " Dog transfers the lead to your partner; its unbeatability is not scored as ordinary self-control."
        : threat
          ? ` Sampled-deal estimate: ${percent(threat.probability)} of modeled deals had no other player with a beating combination (95% Monte Carlo interval ${percentRange(threat.interval)}, ${threat.samples} samples; opponents' actual choices are not modeled).`
          : " Hidden-hand confidence is low because the card ledger does not reconcile.";
      const candidatesText = leads.filter(item => item !== chosen).slice(0, 2).map(item => displayCards(item.cards)).join("; ");
      const alternatives = candidatesText ? ` Alternatives considered: ${candidatesText}.` : "";
      return {
        title: `LEAD: ${displayCards(chosen.cards)} — ${comboLabel(chosen)}`,
        details: `Heuristic + sampled threat estimate: shed ${chosen.count} card${chosen.count === 1 ? "" : "s"} while balancing power-card cost and preserving useful groups.${dogHandoffReason}${wishReason}${simulation}${alternatives} Confidence: ${confidenceLabel(probabilityContext, threat)}. Not guaranteed optimal.`,
        tone: threat && threat.probability < 0.2 ? "warn" : "good"
      };
    }

    if (!currentCombo) {
      return {
        title: "Review the current trick",
        details: `Detected ${displayCards(tableCards)}, but the table combination could not be classified confidently. I will not guess a legal response. This can also happen while DoD is animating/rebuilding the board.`,
        tone: "warn"
      };
    }

    const opponentNearlyOut = hasOpponentNearlyOut(counts);
    let replies = candidates
      .filter(candidate => canBeat(candidate, currentCombo))
      .map(candidate => (
        candidate.phoenixSingle && currentCombo.type === "single"
          ? { ...candidate, rank: currentCombo.rank + 0.5 }
          : candidate
      ));
    const wishReplies = wishRank ? replies.filter(candidate => candidateContainsWish(candidate, wishRank)) : [];
    const satisfyingWish = wishReplies.length > 0;
    if (satisfyingWish) replies = wishReplies;

    const partnerWinning = actor && actor.key === "P";
    if (partnerWinning && !satisfyingWish) {
      return {
        title: "PASS — let your partner keep the trick",
        details: wishRank
          ? `The latest detected play belongs to your partner. No detected beating reply satisfies the active wish for ${rankNameFromValue(ASC_RANKS.indexOf(wishRank) + 2)}, so passing preserves your team's lead.`
          : "The latest detected play belongs to your partner. Passing avoids taking the lead away from your team; reconsider if the board state or team risk changes.",
        tone: "good"
      };
    }

    if (!replies.length) {
      return {
        title: `PASS — no detected reply beats ${comboLabel(currentCombo)}`,
        details: `Current play: ${displayCards(tableCards)}. No matching higher combination or bomb was found in your detected hand.`,
        tone: "neutral"
      };
    }

    const chosen = chooseWithEstimatedSurvival(
      replies,
      candidate => scoreReply(candidate, currentCombo, hand, opponentNearlyOut),
      probabilityContext,
      4
    );
    const reason = satisfyingWish
      ? `The Mahjong wish for ${rankNameFromValue(ASC_RANKS.indexOf(wishRank) + 2)} is active, so this beating move also satisfies the wish.`
      : chosen.bomb
        ? (opponentNearlyOut ? "A bomb is recommended to regain control because a player is nearly out." : "This bomb scores well in the heuristic, but conserving it may be better when the trick has little team value.")
        : (opponentNearlyOut ? "A player has one card left, so taking control is weighted more heavily." : "This is a low-cost beating option adjusted by sampled hidden-hand threat estimates.");
    const threat = chosen && chosen._trackerThreat;
    const simulation = threat
      ? ` Sampled-deal estimate: ${percent(threat.probability)} of modeled deals had no remaining player with a beating combination (95% Monte Carlo interval ${percentRange(threat.interval)}, ${threat.samples} samples; capability only, not predicted play behavior).`
      : " Hidden-hand confidence is low because the card ledger does not reconcile.";
    const alternatives = replies.filter(item => item !== chosen).slice(0, 2).map(item => displayCards(item.cards)).join("; ");
    return {
      title: `PLAY: ${displayCards(chosen.cards)} — ${comboLabel(chosen)}`,
      details: `${reason} Current play: ${displayCards(tableCards)}.${simulation}${alternatives ? ` Alternatives: ${alternatives}.` : ""} Confidence: ${confidenceLabel(probabilityContext, threat)}. Not guaranteed optimal.`,
      tone: chosen.bomb ? "warn" : (threat && threat.probability < 0.2 ? "warn" : "good")
    };
  }

  function buildProbabilityContext(counts) {
    const knownBySeat = new Map();
    for (const player of PLAYER_DEFS) knownBySeat.set(player.key, new Set());
    for (const [card, target] of state.tradedOut.entries()) {
      if (!CARD_SET.has(card) || !knownBySeat.has(target)) continue;
      if (state.inHand.has(card) || state.played.has(card) || state.unresolved.has(card)) continue;
      knownBySeat.get(target).add(card);
    }

    const knownOwner = new Map();
    for (const [seat, cards] of knownBySeat.entries()) {
      for (const card of cards) {
        if (knownOwner.has(card)) continue;
        knownOwner.set(card, seat);
      }
    }
    const unresolvedCards = new Set([...state.unresolved.keys()].filter(card => !state.inHand.has(card) && !state.played.has(card) && !knownOwner.has(card)));
    const unknownCards = ALL_CARDS.filter(card =>
      !state.inHand.has(card) && !state.played.has(card) && !unresolvedCards.has(card) && !knownOwner.has(card)
    );
    const slots = {};
    let slotsKnown = true;
    for (const player of PLAYER_DEFS) {
      const observed = counts[player.key];
      if (!Number.isFinite(observed) || observed < 0) {
        slots[player.key] = null;
        slotsKnown = false;
        continue;
      }
      const remainingSlots = observed - knownBySeat.get(player.key).size;
      slots[player.key] = remainingSlots;
      if (remainingSlots < 0) slotsKnown = false;
    }
    const slotTotal = PLAYER_DEFS.reduce((sum, player) => sum + (Number.isFinite(slots[player.key]) ? slots[player.key] : 0), 0);
    // The tracker may be initialized mid-hand or miss a public-play DOM transition.
    // In that case, some identities remain unknown even though hand counters prove
    // those cards are no longer held. Treat the surplus as an unobserved out-of-hand
    // bucket rather than incorrectly forcing every unknown identity into a hand.
    // A deficit is impossible and still invalidates the probability model.
    const unobservedOutOfHandCount = slotsKnown && slotTotal <= unknownCards.length
      ? unknownCards.length - slotTotal
      : null;
    const overlaps = [];
    for (const card of state.played) {
      if (state.inHand.has(card)) overlaps.push(`${card}: played and in hand`);
      if (state.unresolved.has(card)) overlaps.push(`${card}: played and unresolved`);
    }
    for (const card of state.inHand) {
      if (state.unresolved.has(card)) overlaps.push(`${card}: in hand and unresolved`);
      if (knownOwner.has(card)) overlaps.push(`${card}: in hand and assigned to ${knownOwner.get(card)}`);
    }
    const consistent = slotsKnown && overlaps.length === 0 && unresolvedCards.size === 0 && slotTotal <= unknownCards.length;
    let reason = "";
    if (overlaps.length) reason = `Conflicting card states: ${overlaps.slice(0, 2).join("; ")}`;
    else if (unresolvedCards.size) reason = `${unresolvedCards.size} card(s) have unresolved ownership while DoD updates the hand/board.`;
    else if (!slotsKnown) reason = "One or more opponent card counts are unavailable or inconsistent.";
    else if (slotTotal > unknownCards.length) reason = `Unseen-card mismatch: ${unknownCards.length} unknown cards but ${slotTotal} unassigned hand slots.`;

    // Every canonical physical card belongs to one active category. This count
    // is useful as a diagnostic, but state conflicts still invalidate the model.
    const accounted = new Set([
      ...state.inHand,
      ...state.played,
      ...unresolvedCards,
      ...knownOwner.keys(),
      ...unknownCards
    ]);
    const missingCards = ALL_CARDS.filter(card => !accounted.has(card));
    const duplicateCount = state.inHand.size + state.played.size + unresolvedCards.size + knownOwner.size + unknownCards.length - accounted.size;
    if (!reason && (missingCards.length || duplicateCount)) {
      reason = `Deck ledger incomplete: ${missingCards.length} unaccounted, ${duplicateCount} overlapping card entries.`;
    }
    return {
      knownBySeat, knownOwner, unknownCards, unresolvedCards, slots, counts,
      unobservedOutOfHandCount,
      consistent: consistent && missingCards.length === 0 && duplicateCount === 0,
      reason, accountedCount: accounted.size, missingCards, duplicateCount,
      signature: [
        [...state.inHand].sort().join(","), [...state.played].sort().join(","),
        [...unresolvedCards].sort().join(","), [...knownOwner.entries()].sort().map(([card, seat]) => `${card}:${seat}`).join(","),
        unknownCards.slice().sort().join(","), PLAYER_DEFS.map(player => `${player.key}:${slots[player.key]}`).join(","),
        `unobserved-out:${unobservedOutOfHandCount}`
      ].join("|")
    };
  }

  function cardProbability(card, seat, probabilityContext) {
    const { knownOwner, unknownCards, slots } = probabilityContext;
    // Exact observations remain exact even if some other part of the ledger is
    // temporarily inconsistent; only estimates are suppressed in that case.
    if (state.inHand.has(card) || state.played.has(card)) return 0;
    if (probabilityContext.unresolvedCards.has(card)) return null;
    const owner = knownOwner.get(card);
    if (owner) return owner === seat ? 1 : 0;
    if (!unknownCards.includes(card)) return 0;
    if (!probabilityContext.consistent) return null;
    const availableSlots = slots[seat];
    if (!Number.isFinite(availableSlots) || !unknownCards.length) return null;
    return Math.max(0, Math.min(1, availableSlots / unknownCards.length));
  }

  function probabilityOfAny(cards, seat, probabilityContext) {
    const { knownBySeat, knownOwner, unknownCards, slots } = probabilityContext;
    if (cards.some(card => knownBySeat.get(seat).has(card))) return 1;
    if (cards.some(card => probabilityContext.unresolvedCards.has(card))) return null;
    if (cards.every(card => state.inHand.has(card) || state.played.has(card) || knownOwner.has(card))) {
      return 0;
    }
    if (!probabilityContext.consistent) return null;
    const unknownTargets = cards.filter(card => unknownCards.includes(card) && !knownOwner.has(card));
    const handSlots = slots[seat];
    if (!Number.isFinite(handSlots) || !unknownCards.length) return null;
    if (handSlots <= 0 || unknownTargets.length === 0) return 0;
    const population = unknownCards.length;
    const targetCount = unknownTargets.length;
    if (handSlots > population - targetCount) return 1;
    // Hypergeometric probability: 1 - P(no target cards in this player's slots).
    let probabilityNone = 1;
    for (let index = 0; index < handSlots; index++) {
      probabilityNone *= (population - targetCount - index) / (population - index);
    }
    return Math.max(0, Math.min(1, 1 - probabilityNone));
  }

  function probabilityAtLeastOneAbove(rank, seat, probabilityContext) {
    const threshold = typeof rank === "string"
      ? (rank === "T" ? 10 : (ASC_RANKS.indexOf(rank) >= 0 ? ASC_RANKS.indexOf(rank) + 2 : Number(rank)))
      : Number(rank);
    if (!Number.isFinite(threshold)) return null;
    const targets = ALL_CARDS.filter(card => cardRank(card) > threshold);
    return probabilityOfAny(targets, seat, probabilityContext);
  }

  function makeSeededRandom(seed) {
    let value = (seed >>> 0) || 0x6d2b79f5;
    return function random() {
      value += 0x6D2B79F5;
      let t = value;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashText(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function sampleHiddenHands(probabilityContext, random = Math.random) {
    if (!probabilityContext || !probabilityContext.consistent) return null;
    const slotsTotal = PLAYER_DEFS.reduce((sum, player) => sum + probabilityContext.slots[player.key], 0);
    // It is valid for the unknown identity pool to exceed remaining hand slots:
    // the surplus represents cards already out of hands whose identities were not
    // observed (commonly when tracking starts mid-hand). A deficit is impossible.
    if (slotsTotal > probabilityContext.unknownCards.length) return null;
    const shuffled = probabilityContext.unknownCards.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const hands = {};
    let cursor = 0;
    for (const player of PLAYER_DEFS) {
      hands[player.key] = new Set(probabilityContext.knownBySeat.get(player.key));
      const slotCount = probabilityContext.slots[player.key];
      for (let i = 0; i < slotCount; i++) hands[player.key].add(shuffled[cursor++]);
      if (hands[player.key].size !== probabilityContext.counts[player.key]) return null;
    }
    if (cursor !== slotsTotal) return null;
    // Any shuffled identities after cursor are deliberately left unassigned to
    // hands. Their exact identities are unknown; only their count is inferred.
    return hands;
  }

  function getCachedSampleWorlds(probabilityContext) {
    if (!probabilityContext || !probabilityContext.consistent) return null;
    if (state.probabilityCacheSignature === probabilityContext.signature && state.probabilityCacheWorlds) {
      return state.probabilityCacheWorlds;
    }
    const random = makeSeededRandom(hashText(probabilityContext.signature));
    const worlds = [];
    for (let i = 0; i < state.probabilityCacheSamples; i++) {
      const hands = sampleHiddenHands(probabilityContext, random);
      if (!hands) return null;
      worlds.push(hands);
    }
    state.probabilityCacheSignature = probabilityContext.signature;
    state.probabilityCacheWorlds = worlds;
    return worlds;
  }

  function findBeatingStraightFlush(cards, currentCombo) {
    const bySuit = new Map(SUITS.map(suit => [suit.id, new Map()]));
    for (const card of cards) {
      if (!isStandardCard(card)) continue;
      bySuit.get(card[1]).set(standardRank(card), card);
    }
    for (const [suitId, rankMap] of bySuit.entries()) {
      for (let low = 2; low <= 14; low++) {
        const sequence = [];
        for (let high = low; high <= 14; high++) {
          const card = rankMap.get(high);
          if (!card) break;
          sequence.push(card);
          if (sequence.length >= 5) {
            const bomb = { type: "bomb-straight-flush", count: sequence.length, rank: high, bomb: true, cards: sequence.slice(), suit: suitId };
            if (canBeat(bomb, currentCombo)) return true;
          }
        }
      }
    }
    return false;
  }

  function handCanBeatCombo(hand, currentCombo) {
    if (!currentCombo || !hand || !hand.size || currentCombo.dog) return false;
    const cards = [...hand];
    const hasPhoenix = hand.has("PHOENIX");
    const hasDragon = hand.has("DRAGON");
    const hasMahjong = hand.has("MAHJONG");

    const rankCounts = new Map();
    for (const card of cards) {
      if (isStandardCard(card)) {
        const rank = standardRank(card);
        rankCounts.set(rank, (rankCounts.get(rank) || 0) + 1);
      }
    }
    if (hasMahjong) rankCounts.set(1, 1);

    // 1. Four-of-a-kind bombs beat non-bombs and lower four-of-a-kind bombs.
    if (currentCombo.type !== "bomb-straight-flush") {
      for (const [rank, count] of rankCounts.entries()) {
        if (rank >= 2 && count === 4) {
          if (!currentCombo.bomb || (currentCombo.type === "bomb-four" && rank > currentCombo.rank)) {
            return true;
          }
        }
      }
    }

    // 2. Straight-flush bombs beat everything except higher/longer straight-flush bombs.
    if (findBeatingStraightFlush(cards, currentCombo)) return true;
    if (currentCombo.bomb) return false;

    // 3. O(n) rank-frequency evaluation for standard combinations.
    const targetRank = currentCombo.rank;
    const count = currentCombo.count;
    if (cards.length < count) return false;

    switch (currentCombo.type) {
      case "single":
        if (hasDragon && 15 > targetRank) return true;
        if (hasPhoenix && targetRank < 15) return true;
        for (const rank of rankCounts.keys()) {
          if (rank > targetRank) return true;
        }
        return false;

      case "pair":
        for (const [rank, amt] of rankCounts.entries()) {
          if (rank >= 2 && rank > targetRank && (amt >= 2 || (amt >= 1 && hasPhoenix))) return true;
        }
        return false;

      case "triple":
        for (const [rank, amt] of rankCounts.entries()) {
          if (rank >= 2 && rank > targetRank && (amt >= 3 || (amt >= 2 && hasPhoenix))) return true;
        }
        return false;

      case "full-house":
        for (const [tRank, tAmt] of rankCounts.entries()) {
          if (tRank < 2 || tRank <= targetRank) continue;
          const needsPhoenixForTriple = tAmt === 2 && hasPhoenix;
          if (tAmt < 3 && !needsPhoenixForTriple) continue;
          const phoenixLeft = hasPhoenix && !needsPhoenixForTriple;
          for (const [pRank, pAmt] of rankCounts.entries()) {
            if (pRank < 2 || pRank === tRank) continue;
            if (pAmt >= 2 || (pAmt >= 1 && phoenixLeft)) return true;
          }
        }
        return false;

      case "pair-run": {
        const pairLen = count / 2;
        for (let high = Math.max(2 + pairLen - 1, targetRank + 1); high <= 14; high++) {
          const low = high - pairLen + 1;
          let missing = 0;
          for (let r = low; r <= high; r++) {
            const amt = rankCounts.get(r) || 0;
            if (amt < 2) missing += (2 - amt);
            if (missing > 1) break;
          }
          if (missing === 0 || (missing === 1 && hasPhoenix)) return true;
        }
        return false;
      }

      case "straight":
        for (let high = Math.max(count, targetRank + 1); high <= 14; high++) {
          const low = high - count + 1;
          if (low < 1) continue;
          let missing = 0;
          let missingRank = null;
          for (let r = low; r <= high; r++) {
            if (!rankCounts.has(r)) {
              missing++;
              missingRank = r;
              if (missing > 1) break;
            }
          }
          if (missing === 0 || (missing === 1 && hasPhoenix && missingRank !== 1)) return true;
        }
        return false;

      default:
        return false;
    }
  }

  function wilsonInterval(hits, samples, z = 1.96) {
    if (!Number.isFinite(hits) || !Number.isFinite(samples) || samples <= 0) return null;
    const p = Math.max(0, Math.min(1, hits / samples));
    const z2 = z * z;
    const denominator = 1 + z2 / samples;
    const center = (p + z2 / (2 * samples)) / denominator;
    const margin = z * Math.sqrt((p * (1 - p) / samples) + (z2 / (4 * samples * samples))) / denominator;
    return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
  }

  function percentRange(interval) {
    return interval ? `${percent(interval.lower)}–${percent(interval.upper)}` : "—";
  }

  function evaluateComboThreat(candidate, probabilityContext) {
    if (!candidate || !probabilityContext || !probabilityContext.consistent) return null;
    const worlds = getCachedSampleWorlds(probabilityContext);
    if (!worlds || !worlds.length) return null;
    if (state.probabilityEstimateCacheSignature !== probabilityContext.signature) {
      state.probabilityEstimateCacheSignature = probabilityContext.signature;
      state.probabilityEstimateCache.clear();
    }
    const comboKey = `${candidate.type}:${candidate.count}:${candidate.rank}:${Boolean(candidate.bomb)}:${Boolean(candidate.dog)}`;
    if (state.probabilityEstimateCache.has(comboKey)) return state.probabilityEstimateCache.get(comboKey);
    const hits = { L: 0, P: 0, R: 0 };
    let worldsWithNoResponse = 0;
    for (const hands of worlds) {
      let someoneCanBeat = false;
      for (const player of PLAYER_DEFS) {
        if (probabilityContext.counts[player.key] > 0 && handCanBeatCombo(hands[player.key], candidate)) {
          hits[player.key]++;
          someoneCanBeat = true;
        }
      }
      if (!someoneCanBeat) worldsWithNoResponse++;
    }
    const seatEstimates = {};
    for (const player of PLAYER_DEFS) {
      const seatHits = probabilityContext.counts[player.key] === 0 ? 0 : hits[player.key];
      seatEstimates[player.key] = {
        probability: seatHits / worlds.length,
        samples: worlds.length,
        interval: wilsonInterval(seatHits, worlds.length)
      };
    }
    const estimate = {
      probability: worldsWithNoResponse / worlds.length,
      samples: worlds.length,
      interval: wilsonInterval(worldsWithNoResponse, worlds.length),
      seatEstimates
    };
    state.probabilityEstimateCache.set(comboKey, estimate);
    return estimate;
  }

  function estimateSeatsCanBeat(candidate, probabilityContext) {
    const estimate = evaluateComboThreat(candidate, probabilityContext);
    return estimate ? estimate.seatEstimates : null;
  }

  function estimateNoResponseProbability(candidate, probabilityContext) {
    return evaluateComboThreat(candidate, probabilityContext);
  }

  function percent(probability) {
    return probability === null || !Number.isFinite(probability) ? "—" : `${Math.round(probability * 100)}%`;
  }

  function renderProbabilities(counts, context = buildProbabilityContext(counts), currentCombo = null) {
    const highTargets = ["DRAGON", "PHOENIX", ...STANDARD_CARDS.filter(card => card[0] === "A")];
    hudElements.probabilityRows.replaceChildren();

    const selfHighCount = highTargets.filter(card => state.inHand.has(card)).length;
    const selfRow = document.createElement("div");
    selfRow.className = "tt-prob-row tt-prob-self";
    const selfName = document.createElement("span");
    selfName.className = "tt-prob-seat";
    selfName.textContent = `You (${state.inHand.size})`;
    const selfValue = document.createElement("span");
    selfValue.className = "tt-prob-value";
    selfValue.textContent = `${state.inHand.has("DRAGON") ? "D ✓" : "D —"} · ${state.inHand.has("PHOENIX") ? "Ph ✓" : "Ph —"} · high cards ${selfHighCount}`;
    selfRow.append(selfName, selfValue);
    hudElements.probabilityRows.appendChild(selfRow);

    const responseEstimates = currentCombo ? estimateSeatsCanBeat(currentCombo, context) : null;
    for (const player of PLAYER_DEFS) {
      const count = counts[player.key];
      const dragon = cardProbability("DRAGON", player.key, context);
      const phoenix = cardProbability("PHOENIX", player.key, context);
      const anyHigh = probabilityOfAny(highTargets, player.key, context);
      const aboveQueen = probabilityAtLeastOneAbove(12, player.key, context);
      const canBeatText = currentCombo
        ? ` · can beat table ${responseEstimates ? `${percent(responseEstimates[player.key].probability)} [${percentRange(responseEstimates[player.key].interval)}]` : "—"}`
        : "";
      const row = document.createElement("div");
      row.className = `tt-prob-row ${player.key === "P" ? "tt-prob-partner" : ""}`;
      const name = document.createElement("span");
      name.className = "tt-prob-seat";
      name.textContent = `${player.label} (${Number.isFinite(count) ? count : "?"})`;
      const value = document.createElement("span");
      value.className = "tt-prob-value";
      value.textContent = `D ${percent(dragon)} · Ph ${percent(phoenix)} · ≥1 A/D/Ph ${percent(anyHigh)} · >Q ${percent(aboveQueen)}${canBeatText}`;
      row.append(name, value);
      hudElements.probabilityRows.appendChild(row);
    }

    const unknown = context.unknownCards.length;
    if (!context.consistent) {
      hudElements.probabilityNote.textContent = `Estimates paused: ${context.reason || "the card ledger is inconsistent"} Exact visible facts are retained.`;
      hudElements.probabilityNote.classList.add("tt-status-warn");
    } else {
      hudElements.probabilityNote.classList.remove("tt-status-warn");
      const unobservedNote = context.unobservedOutOfHandCount > 0
        ? ` ${context.unobservedOutOfHandCount} identities are modeled as already out of hands based on current hand counts; their exact identities were not observed.`
        : "";
      hudElements.probabilityNote.textContent = currentCombo
        ? `Uniform hidden-hand model; ${unknown} untracked identities.${unobservedNote} Table-beat odds use ${state.probabilityCacheSamples} sampled deals; capability ≠ likely play.`
        : `Uniform hidden-hand model; ${unknown} untracked identities.${unobservedNote} Exact card odds use hand-slot constraints; no active combo classified.`;
    }
  }

  function applyCellState(cell, key, probabilityContext) {
    cell.classList.remove("tt-state-unknown", "tt-state-hand", "tt-state-traded", "tt-state-played", "tt-state-unresolved");
    if (state.played.has(key)) {
      cell.classList.add("tt-state-played");
      cell.title = `${displayCard(key)} — played`;
      return;
    }
    if (state.inHand.has(key)) {
      cell.classList.add("tt-state-hand");
      const pendingTarget = state.pendingTrades.get(key);
      cell.title = `${displayCard(key)} — in your hand${pendingTarget ? `; selected for trade to ${PLAYER_BY_KEY.get(pendingTarget).label}` : ""}`;
      return;
    }
    if (state.unresolved.has(key)) {
      cell.classList.add("tt-state-unresolved");
      cell.title = `${displayCard(key)} — temporarily absent from hand; not counted as played until public-board evidence appears.`;
      return;
    }
    const target = state.tradedOut.get(key) || state.pendingTrades.get(key);
    if (target) {
      cell.classList.add("tt-state-traded");
      const player = PLAYER_BY_KEY.get(target);
      cell.title = `${displayCard(key)} — ${state.tradedOut.has(key) ? "known traded" : "pending trade"} to ${player ? player.label : target}`;
      return;
    }

    cell.classList.add("tt-state-unknown");
    const odds = PLAYER_DEFS.map(player => `${player.label} ${percent(cardProbability(key, player.key, probabilityContext))}`).join(" · ");
    cell.title = `${displayCard(key)} — estimated ownership: ${odds}. Assumes uniform distribution of unknown cards.`;
  }

  function renderHud() {
    const counts = {
      L: getSeatCardCount("nickholder_left"),
      P: getSeatCardCount("nickholder_up"),
      R: getSeatCardCount("nickholder_right")
    };
    const probabilityContext = buildProbabilityContext(counts);
    for (const [cardCode, cell] of hudElements.cardCells.entries()) applyCellState(cell, cardCode, probabilityContext);
    for (const [specKey, cell] of hudElements.specialCells.entries()) applyCellState(cell, specKey, probabilityContext);

    hudElements.roundLabel.textContent = `Round: ${state.currentRoundText || "-"}`;
    const wishEl = document.getElementById("txtAskedCard");
    const wishVisible = wishEl && isElementVisible(wishEl) && wishEl.textContent.trim() !== "";
    hudElements.wishLabel.textContent = wishVisible ? wishEl.textContent.trim() : "Wish: None";

    hudElements.countsLabel.textContent = `Cards [L / P / R]: ${counts.L ?? "?"} / ${counts.P ?? "?"} / ${counts.R ?? "?"}`;
    const hasHandNode = Boolean(document.getElementById("hand"));
    if (!hasHandNode && !document.getElementById("cardsHolder")) {
      hudElements.statusLabel.textContent = "Waiting for DoD game board…";
      hudElements.statusLabel.className = "tt-status-warn";
    } else if (!state.inHand.size) {
      hudElements.statusLabel.textContent = "No hand cards currently detected — awaiting a stable board update";
      hudElements.statusLabel.className = "tt-status-warn";
    } else if (!probabilityContext.consistent) {
      hudElements.statusLabel.textContent = `Cards detected (${state.inHand.size}); probability model paused: ${probabilityContext.reason || "ledger mismatch"}`;
      hudElements.statusLabel.className = "tt-status-error";
    } else if (probabilityContext.unobservedOutOfHandCount > 0) {
      hudElements.statusLabel.textContent = `Tracking ${state.inHand.size} hand cards · ${probabilityContext.unobservedOutOfHandCount} earlier card identities unobserved · ledger ${probabilityContext.accountedCount}/56`;
      hudElements.statusLabel.className = "tt-status-warn";
    } else {
      hudElements.statusLabel.textContent = `Tracking ${state.inHand.size} hand cards · ledger ${probabilityContext.accountedCount}/56 · ${state.unresolved.size} unresolved`;
      hudElements.statusLabel.className = "tt-status-ok";
    }

    const tradeEntries = [];
    for (const [card, target] of state.tradedOut.entries()) {
      const playedMark = state.played.has(card) ? " (publicly played)" : "";
      const player = PLAYER_BY_KEY.get(target);
      tradeEntries.push(`sent ${player ? player.label : target}: ${displayCard(card)}${playedMark}`);
    }
    if (state.tradedIn.size) tradeEntries.push(`received: ${[...state.tradedIn].map(displayCard).join(", ")}`);
    for (const [card, target] of state.pendingTrades.entries()) {
      if (state.tradedOut.has(card)) continue;
      const player = PLAYER_BY_KEY.get(target);
      tradeEntries.push(`pending ${player ? player.label : target}: ${displayCard(card)}`);
    }
    hudElements.tradedLabel.textContent = tradeEntries.length ? `Trades: ${tradeEntries.join(" | ")}` : "Trades: None recorded";
    hudElements.tradedLabel.title = "Pending selections are not committed trades. Outgoing and incoming trades are tracked separately.";

    const warnings = [];
    if (state.unmappedSpecials.size) warnings.push(`Unmapped code(s): ${[...state.unmappedSpecials].join(", ")}`);
    if (state.unresolved.size) warnings.push(`Temporarily unresolved: ${[...state.unresolved.keys()].map(displayCard).join(", ")}`);
    hudElements.unmappedLabel.textContent = warnings.join(" · ");

    const isOurTurn = isElementVisible(document.getById ? document.getById("infoYourTurn") : document.getElementById("infoYourTurn"));
    const actionContext = resolveDogHandoffContext(getActionContext(), isOurTurn);
    const recommendation = getRecommendation(
      [...state.inHand], actionContext, counts, isOurTurn, Boolean(state.tradingActive), probabilityContext
    );
    hudElements.adviceTitle.textContent = recommendation.title;
    hudElements.adviceTitle.className = `tt-advice-title tt-advice-${recommendation.tone}`;
    hudElements.adviceDetails.textContent = recommendation.details;
    const myPlayedCount = [...state.played].filter(card => state.everInHand.has(card) && !state.tradedOut.has(card)).length;
    const declarationAdvice = getDeclarationAdvice([...state.inHand], {
      playedCount: state.played.size,
      myPlayedCount,
      tradedOutCount: state.tradedOut.size,
      tradingActive: Boolean(state.tradingActive) || getTradingPhaseActive()
    });
    hudElements.declarationTitle.textContent = declarationAdvice.title;
    hudElements.declarationTitle.className = `tt-advice-title tt-advice-${declarationAdvice.tone}`;
    hudElements.declarationDetails.textContent = declarationAdvice.details;
    const dragonAdvice = getDragonGiftAdvice(counts);
    hudElements.dragonTitle.textContent = dragonAdvice.title;
    hudElements.dragonTitle.className = `tt-advice-title tt-advice-${dragonAdvice.tone}`;
    hudElements.dragonDetails.textContent = dragonAdvice.details;
    renderProbabilities(counts, probabilityContext, actionContext.currentCombo);
  }

  function scanBoardState() {
    if (state.scanInProgress) return;
    state.scanInProgress = true;
    try {
      if (!hudElements.root || !hudElements.root.isConnected || !hudElements.body) createHud();

      const roundEl = document.getElementById("txtRound");
      let roundChanged = false;
      if (roundEl) {
        const roundText = roundEl.textContent.trim();
        if (roundText && state.currentRoundText && roundText !== state.currentRoundText) {
          // Reset before reading the newly dealt cards for the next hand.
          clearRoundData(roundText);
          roundChanged = true;
        } else if (roundText && !state.currentRoundText) {
          state.currentRoundText = roundText;
        }
      }

      // Some DoD games reuse the same round label after a fresh game. A new
      // full-sized deal following a near-complete public deck is a second reset
      // signal; requiring many public plays avoids resetting on transient empty DOM.
      if (!roundChanged && state.inHand.size === 0 && state.played.size >= 50) {
        const handProbe = readHandCards();
        if (handProbe.size >= 10) {
          clearRoundData(roundEl ? roundEl.textContent.trim() : state.currentRoundText);
          roundChanged = true;
        }
      }

      const previousHand = new Set(state.inHand);
      const wasTradingActive = state.tradingActive;
      const isTradingActive = getTradingPhaseActive();
      if (isTradingActive && wasTradingActive !== true) {
        state.preTradeHand = new Set(previousHand);
      }
      const selectionsNow = isTradingActive ? readTradeSelections() : new Map();
      if (isTradingActive) {
        // Ordinarily replace live selections so unselecting a card is reflected.
        // On the Send-click edge, preserve the last known slots if DoD cleared
        // them before the next observer callback can run.
        state.pendingTrades = state.forceCommitTrades
          ? new Map([...state.pendingTrades, ...selectionsNow])
          : selectionsNow;
      }
      const completingTrade = wasTradingActive === true && !isTradingActive;
      if (state.forceCommitTrades || completingTrade) commitPendingTrades();
      state.tradingActive = isTradingActive;

      const currentHandSet = readHandCards();
      if (isTradingActive) {
        // DoD may reparent a selected card into its trade slot. It is still
        // owned by me until Send commits the exchange, so retain it in my hand.
        for (const card of state.pendingTrades.keys()) currentHandSet.add(card);
      } else {
        // A committed outgoing card can remain in #hand briefly while DoD animates.
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

      if (!isTradingActive) {
        // Disappearance is only an unresolved transition. A play is confirmed
        // below from visible public-board evidence, never from absence alone.
        for (const prevCard of previousHand) {
          if (!currentHandSet.has(prevCard) && !state.tradedOut.has(prevCard) && !state.played.has(prevCard)) {
            state.unresolved.set(prevCard, "missing from hand; awaiting public-play or trade evidence");
          }
        }
      }
      state.inHand = currentHandSet;

      // Public board/seat play containers are the positive evidence for a play.
      // Sets prevent cards represented in overlapping animation containers from
      // being counted twice. The .droppedCard class alone is deliberately ignored.
      const visiblePlayed = new Set();
      const selector = PLAY_CONTAINERS.map(container => `${container} .card`).join(", ");
      // During a detected round boundary, board DOM can lag behind the new deal.
      // Do not import the previous hand's final trick into the reset state.
      if (!roundChanged) {
        for (const cardEl of document.querySelectorAll(selector)) {
          const code = extractCardCode(cardEl);
          if (code && CARD_SET.has(code)) visiblePlayed.add(code);
        }
      }
      for (const code of visiblePlayed) {
        state.played.add(code);
        state.unresolved.delete(code);
        state.inHand.delete(code);
      }

      // Keep categories mutually exclusive even when DoD leaves stale DOM nodes
      // in the hand during animation or trade transitions.
      for (const code of state.played) {
        state.inHand.delete(code);
        state.unresolved.delete(code);
      }
      for (const code of state.tradedOut.keys()) {
        state.unresolved.delete(code);
        if (!isTradingActive) state.inHand.delete(code);
      }

      state.ignoreBoardForScan = roundChanged;
      ensureObserver();
      renderHud();
    } catch (error) {
      console.error("[DoD Tichu Tracker] Board scan failed:", error);
      if (hudElements.statusLabel) {
        hudElements.statusLabel.textContent = `Tracker error: ${error && error.message ? error.message : "unknown error"}`;
        hudElements.statusLabel.className = "tt-status-error";
      }
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

  function ensureObserver() {
    const boardRoot = document.documentElement;
    if (!boardRoot) return false;
    if (!state.observer || state.observedRoot !== boardRoot) {
      if (state.observer) state.observer.disconnect();
      state.observer = new MutationObserver(mutations => {
        const relevant = mutations.some(mutation => {
          const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
          if (hudElements.root && target && hudElements.root.contains(target)) return false;
          const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
          if (hudElements.root && changedNodes.length && changedNodes.every(node =>
            node === hudElements.root || (node.nodeType === 1 && hudElements.root.contains(node))
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
      state.fallbackScanTimer = window.setInterval(scheduleScan, 1500);
    }
    if (!state.clickListenerAttached) {
      document.addEventListener("click", event => {
        const target = event.target && event.target.closest ? event.target.closest("#btnSend") : null;
        if (!target) return;
        state.forceCommitTrades = true;
        // Preserve the last-known destinations if the Send handler immediately
        // removes the trade-slot elements.
        if (state.tradingActive) state.pendingTrades = new Map([...state.pendingTrades, ...readTradeSelections()]);
        window.setTimeout(scheduleScan, 0);
      }, true);
      state.clickListenerAttached = true;
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

  const testApi = {
    RANKS, ASC_RANKS, SUITS, SPECIAL_DEFS, STANDARD_CARDS, ALL_CARDS, CARD_SET,
    state, normalizeCardCode, resolveSpecialKey, isStandardCard, cardRank,
    standardRank, classifyStraight, classifyCombo, comboLabel, canBeat, parseWishRank,
    actionLooksLikeDogPlay, actionLooksLikeTichuCall, actionContainsPlayerName, recordTichuCallFromAction,
    hasOpponentNearlyOut, updateActorForNewTable, getDragonGiftAdvice, resolveDogHandoffContext,
    enumerateCombos, buildProbabilityContext, cardProbability, probabilityOfAny,
    sampleHiddenHands, makeSeededRandom, handCanBeatCombo, estimateSeatsCanBeat,
    probabilityAtLeastOneAbove,
    estimateNoResponseProbability, wilsonInterval, percentRange, getRecommendation, candidateContainsWish,
    declarationHandMetrics, getDeclarationAdvice,
    clearRoundData,
    commitPendingTrades, readTradeSelections, readHandCards, getTradingPhaseActive,
    scanBoardState, createHud, renderHud
  };
  if (typeof module !== "undefined" && module.exports) module.exports = testApi;
  // Tests can load the pure card/probability core in Node without a fake DOM.
  if (typeof window === "undefined" || typeof document === "undefined") return;

  if (!initTracker()) {
    let attempts = 0;
    const maxAttempts = window === window.top ? Infinity : 30;
    state.bootTimer = window.setInterval(() => {
      attempts++;
      if (initTracker() || attempts >= maxAttempts) {
        window.clearInterval(state.bootTimer);
        state.bootTimer = null;
      }
    }, 1000);
  }

})();
