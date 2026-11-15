/* Preview-only controls. Not loaded by the extension. */
(() => {
  "use strict";

  const CARD_LABELS = {
    T: "10"
  };
  const DECKS = {
    strong: [
      "DRAGON", "PHOENIX", "As", "Ah", "Ad", "Ac",
      "Ks", "Kh", "Kd", "Kc", "Qs", "Qh", "Qd", "Qc"
    ],
    weak: [
      "2s", "3h", "4d", "5c", "6s", "7h", "8d", "9c",
      "Ts", "Jh", "2d", "3c", "4s", "5h"
    ],
    grand: ["DRAGON", "PHOENIX", "As", "Ah", "Ad", "Ac", "Ks", "Kh"]
  };

  const handEl = document.getElementById("hand");
  const handRow = document.getElementById("preview-hand");
  const centerEl = document.getElementById("cardsHolder");
  const centerPreview = document.getElementById("center");
  const actionEl = document.getElementById("textContainer");
  const turnInfo = document.getElementById("turn-info");
  const turnEl = document.getElementById("infoYourTurn");
  const wishEl = document.getElementById("txtAskedCard");
  const counts = {
    up: document.getElementById("count-up"),
    left: document.getElementById("count-left"),
    right: document.getElementById("count-right"),
    bottom: document.getElementById("count-bottom")
  };

  function label(card) {
    const specials = {
      DRAGON: "Dr",
      PHOENIX: "Ph",
      DOG: "Dog",
      MAHJONG: "1"
    };
    if (specials[card]) return specials[card];
    const suit = { s: "♠", h: "♥", d: "♦", c: "♣" }[card[1]];
    return `${CARD_LABELS[card[0]] || card[0]}${suit}`;
  }

  function renderCard(card) {
    const node = document.createElement("div");
    node.className = "card";
    node.dataset.card = card;
    node.textContent = label(card);
    return node;
  }

  function setHand(cards) {
    // A real DoD deal changes the round label; mirror that so the tracker can
    // reset its ledger instead of treating the old hand as unresolved cards.
    const roundEl = document.getElementById("txtRound");
    const round = Number.parseInt(roundEl.textContent.replace(/\D+/g, ""), 10) || 3;
    roundEl.textContent = `Round ${round + 1}`;
    handEl.replaceChildren();
    handRow.replaceChildren();
    for (const card of cards) {
      const node = document.createElement("div");
      node.className = "card";
      node.setAttribute("card", card);
      handEl.append(node);
      handRow.append(renderCard(card));
    }
    counts.bottom.textContent = String(cards.length);
    wishEl.textContent = "";
    centerEl.replaceChildren();
    centerPreview.replaceChildren();
  }

  function setCounts(left, up, right) {
    counts.left.textContent = String(left);
    counts.up.textContent = String(up);
    counts.right.textContent = String(right);
    document.querySelector("#nickholder_left .mini_fontSmall").textContent = String(left);
    document.querySelector("#nickholder_up .mini_fontSmall").textContent = String(up);
    document.querySelector("#nickholder_right .mini_fontSmall").textContent = String(right);
  }

  function bump(el) {
    // Any DOM mutation wakes the tracker's observer.
    el.appendChild(document.createElement("span")).remove();
  }

  function play(card) {
    centerEl.replaceChildren();
    centerPreview.replaceChildren();
    const node = document.createElement("div");
    node.className = "card";
    node.setAttribute("card", card);
    centerEl.append(node);
    centerPreview.append(renderCard(card));
    actionEl.textContent = `Ann played ${label(card)}`;
    setCounts(13, 14, 14);
    turnEl.hidden = false;
    bump(actionEl);
  }

  document.querySelectorAll("[data-deal]").forEach(button => {
    button.addEventListener("click", () => {
      const kind = button.dataset.deal;
      setHand(DECKS[kind]);
      setCounts(14, 14, 14);
      actionEl.textContent = `Deal — ${kind} hand`;
      turnEl.hidden = false;
      bump(actionEl);
    });
  });

  document.querySelector('[data-action="play"]').addEventListener("click", () => play("Qc"));

  document.querySelector('[data-action="pass"]').addEventListener("click", () => {
    actionEl.textContent = "Ann passed";
    bump(actionEl);
  });

  document.querySelector('[data-action="tichu"]').addEventListener("click", () => {
    actionEl.textContent = "Ann called Tichu";
    bump(actionEl);
  });

  document.querySelector('[data-action="turn"]').addEventListener("click", () => {
    turnEl.hidden = !turnEl.hidden;
    turnInfo.hidden = turnEl.hidden;
    bump(actionEl);
  });

  document.querySelector('[data-action="reset"]').addEventListener("click", () => {
    setHand(DECKS.strong);
    setCounts(14, 14, 14);
    actionEl.textContent = "New deal";
    wishEl.textContent = "";
    turnEl.hidden = false;
    bump(actionEl);
  });

  // Start with a realistic hand and an opponent's play on the table.
  setHand(DECKS.strong);
  setCounts(14, 14, 14);
  turnEl.hidden = false;
  play("Qc");
})();
