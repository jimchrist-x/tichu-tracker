"use strict";

/**
 * Pure-logic tests for the tracker core.
 *
 * tracker.js exports its internals when loaded as a CommonJS module, which is
 * how these tests run: no browser, no DOM, no extension host.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../tracker.js");

const reset = () => api.clearRoundData("test");

test("card code normalisation accepts DoD aliases", () => {
  assert.equal(api.normalizeCardCode("10s"), "Ts");
  assert.equal(api.normalizeCardCode("AS"), "As");
  assert.equal(api.normalizeCardCode("_dr"), "DRAGON");
  assert.equal(api.normalizeCardCode("dragon"), "DRAGON");
  assert.equal(api.normalizeCardCode("p4"), "PHOENIX");
  assert.equal(api.normalizeCardCode("mahjong"), "MAHJONG");
  assert.equal(api.normalizeCardCode("hounds"), "DOG");
  assert.equal(api.normalizeCardCode("zzz"), "UNKNOWN:zzz");
  assert.equal(api.normalizeCardCode(""), null);
});

test("single-card classification handles the special cards", () => {
  assert.deepEqual(
    api.classifyCombo(["PHOENIX"]),
    { type: "single", count: 1, rank: 1.5, phoenixSingle: true, bomb: false, dog: false }
  );
  assert.equal(api.classifyCombo(["DRAGON"]).rank, 15);
  assert.equal(api.classifyCombo(["MAHJONG"]).rank, 1);
  assert.equal(api.classifyCombo(["DOG"]).dog, true);
  assert.equal(api.classifyCombo(["9h"]).rank, 9);
});

test("pairs, triples and full houses respect the Phoenix and Mahjong rules", () => {
  assert.equal(api.classifyCombo(["Kh", "Kd"]).type, "pair");
  assert.equal(api.classifyCombo(["Kh", "PHOENIX"]).type, "pair");
  assert.equal(api.classifyCombo(["Kh", "PHOENIX"]).rank, 13);
  assert.equal(api.classifyCombo(["Kh", "Kd", "PHOENIX"]).type, "triple");
  assert.equal(api.classifyCombo(["Kh", "Kd", "Ks"]).type, "triple");
  assert.equal(api.classifyCombo(["Kh", "Kd", "9s", "9c", "9d"]).type, "full-house");
  assert.equal(api.classifyCombo(["Kh", "Kd", "Ks", "9c", "9d"]).type, "full-house");
  // A Phoenix can extend either pair of a two-pair-plus-Phoenix hand.
  assert.equal(api.classifyCombo(["Kh", "Kd", "9c", "9d", "PHOENIX"]).type, "full-house");
  // Mahjong (rank 1) may only be used in a straight.
  assert.equal(api.classifyCombo(["MAHJONG", "Kh"]), null);
  assert.equal(api.classifyCombo(["MAHJONG", "Kh", "Kd"]), null);
  assert.equal(api.classifyCombo(["MAHJONG", "Kh", "Kd", "Ks"]), null);
});

test("bombs are four of a kind or a straight flush, never with specials", () => {
  const four = api.classifyCombo(["9h", "9d", "9s", "9c"]);
  assert.equal(four.bomb, true);
  assert.equal(four.type, "bomb-four");
  assert.equal(four.rank, 9);

  const straightFlush = api.classifyCombo(["3h", "4h", "5h", "6h", "7h"]);
  assert.equal(straightFlush.bomb, true);
  assert.equal(straightFlush.type, "bomb-straight-flush");
  assert.equal(straightFlush.count, 5);

  // Phoenix and Mahjong may never join a bomb.
  assert.equal(api.classifyCombo(["9h", "9d", "9s", "PHOENIX"]), null);
  assert.equal(api.classifyCombo(["MAHJONG", "2h", "3h", "4h", "5h"]).bomb, false);
});

test("straights reject wrap-arounds and duplicate ranks and accept bridges", () => {
  assert.equal(api.classifyCombo(["2s", "3h", "4d", "5c", "6s"]).type, "straight");
  assert.equal(api.classifyCombo(["Ts", "Jh", "Qd", "Kc", "As"]).rank, 14);
  assert.equal(api.classifyCombo(["Js", "Qh", "Kd", "Ac", "2s"]), null);
  assert.equal(api.classifyCombo(["2s", "3h", "4d", "5c"]), null);
  assert.equal(api.classifyCombo(["2s", "3h", "4d", "5c", "5s"]), null);

  // Mahjong plays as a 1 and may start a straight.
  assert.equal(api.classifyCombo(["MAHJONG", "2h", "3d", "4c", "5s"]).rank, 5);
  // Phoenix may bridge a single internal gap, but never impersonate Mahjong.
  assert.equal(api.classifyCombo(["2h", "3d", "PHOENIX", "5c", "6s"]).type, "straight");
  assert.equal(api.classifyCombo(["PHOENIX", "3d", "4c", "5s", "6h"]).type, "straight");
  assert.equal(api.classifyCombo(["2h", "3d", "4c", "5s", "PHOENIX"]).type, "straight");
  // The Phoenix may stand in for an Ace, but a run can never pass it.
  const toAce = api.classifyCombo(["Ts", "Jh", "Qd", "Kc", "PHOENIX"]);
  assert.equal(toAce.type, "straight");
  assert.equal(toAce.rank, 14);
  assert.equal(api.classifyCombo(["Js", "Qh", "Kd", "Ac", "PHOENIX"]).type, "straight");
});

test("consecutive pairs are classified before and after the straight check", () => {
  const two = api.classifyCombo(["3h", "3d", "4s", "4c"]);
  assert.equal(two.type, "pair-run");
  assert.equal(two.count, 4);
  assert.equal(two.rank, 4);

  const three = api.classifyCombo(["3h", "3d", "4s", "4c", "5h", "5d"]);
  assert.equal(three.type, "pair-run");
  assert.equal(three.rank, 5);

  const bridged = api.classifyCombo(["3h", "3d", "4s", "4c", "5h", "PHOENIX"]);
  assert.equal(bridged.type, "pair-run");
  assert.equal(bridged.count, 6);

  assert.equal(api.classifyCombo(["3h", "3d", "4s", "4c", "5h", "7d"]), null);
});

test("duplicate physical cards are never treated as a pair", () => {
  assert.equal(api.classifyCombo(["9h", "9h"]), null);
  assert.equal(api.classifyCombo(["PHOENIX", "PHOENIX"]), null);
  assert.equal(api.classifyCombo([]), null);
});

test("canBeat orders combinations, bombs and the Dog correctly", () => {
  const single = api.classifyCombo(["9h"]);
  const higher = api.classifyCombo(["Th"]);
  const fourBomb = api.classifyCombo(["4h", "4d", "4s", "4c"]);
  const fiveBomb = api.classifyCombo(["3h", "4h", "5h", "6h", "7h"]);
  const sixBomb = api.classifyCombo(["3h", "4h", "5h", "6h", "7h", "8h"]);
  const dog = api.classifyCombo(["DOG"]);

  assert.equal(api.canBeat(higher, single), true);
  assert.equal(api.canBeat(single, higher), false);
  assert.equal(api.canBeat(single, single), false);
  assert.equal(api.canBeat(fourBomb, single), true);
  assert.equal(api.canBeat(single, fourBomb), false);
  assert.equal(api.canBeat(fiveBomb, fourBomb), true);
  assert.equal(api.canBeat(fourBomb, fiveBomb), false);
  assert.equal(api.canBeat(sixBomb, fiveBomb), true);
  assert.equal(api.canBeat(api.classifyCombo(["4h", "4d", "4s", "4c"]), fourBomb), false);
  assert.equal(api.canBeat(dog, single), false);
  assert.equal(api.canBeat(fourBomb, dog), false);

  // A lone Phoenix beats any single below the Dragon.
  const phoenix = api.classifyCombo(["PHOENIX"]);
  assert.equal(api.canBeat(phoenix, api.classifyCombo(["As"])), true);
  assert.equal(api.canBeat(phoenix, api.classifyCombo(["DRAGON"])), false);
});

test("the fast handCanBeatCombo path agrees with exhaustive combo search", () => {
  let seed = 20260101;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const pickCombo = () => {
    const pool = api.ALL_CARDS.slice();
    const size = 1 + Math.floor(random() * 6);
    const cards = [];
    for (let i = 0; i < size; i++) cards.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
    return api.classifyCombo(cards);
  };

  let checked = 0;
  for (let iteration = 0; iteration < 900; iteration++) {
    const current = pickCombo();
    if (!current) continue;
    const pool = api.ALL_CARDS.slice();
    const takeCard = () => pool.splice(Math.floor(random() * pool.length), 1)[0];
    const hand = new Set();
    const handSize = 6 + Math.floor(random() * 4);
    while (hand.size < handSize) hand.add(takeCard());
    const exhaustive = api.enumerateCombos(hand).some(candidate => api.canBeat(candidate, current));
    assert.equal(
      api.handCanBeatCombo(hand, current),
      exhaustive,
      `mismatch for ${api.comboLabel(current)} against ${[...hand].join(",")}`
    );
    checked++;
  }
  assert.ok(checked > 100, `expected a meaningful sample, got ${checked}`);
});

test("parseWishRank understands English and Greek wish text", () => {
  reset();
  assert.equal(api.parseWishRank("Wish: K"), "K");
  assert.equal(api.parseWishRank("wish 10"), "T");
  assert.equal(api.parseWishRank("Asked card: Q"), "Q");
  assert.equal(api.parseWishRank("A"), "A");
  assert.equal(api.parseWishRank(""), null);
});

test("declaration advice distinguishes Grand Tichu from Tichu windows", () => {
  const strongEight = ["DRAGON", "PHOENIX", "As", "Ah", "Ad", "Ks", "Kh", "Kd"];
  const grand = api.getDeclarationAdvice(strongEight, { playedCount: 0, myPlayedCount: 0, tradedOutCount: 0 });
  assert.equal(grand.stage, "grand-tichu");
  assert.match(grand.title, /Grand Tichu/);

  const weakEight = ["2s", "3h", "4d", "6c", "7s", "8p".replace("p", "h"), "9d", "Tc"];
  const weak = api.getDeclarationAdvice(weakEight, { playedCount: 0, myPlayedCount: 0, tradedOutCount: 0 });
  assert.equal(weak.stage, "grand-tichu");
  assert.match(weak.title, /DO NOT CALL/);

  const full = [...strongEight, "Qs", "Qh", "Qd", "Js", "Jh", "Jd"];
  const tichu = api.getDeclarationAdvice(full, { playedCount: 0, myPlayedCount: 0, tradedOutCount: 0 });
  assert.equal(tichu.stage, "tichu");

  const closed = api.getDeclarationAdvice(full, { playedCount: 4, myPlayedCount: 1, tradedOutCount: 0 });
  assert.equal(closed.stage, null);
  assert.match(closed.title, /closed/i);

  const trading = api.getDeclarationAdvice(strongEight, { tradingActive: true });
  assert.match(trading.title, /wait for trading/i);
});

test("hand metrics reward control cards and long structures", () => {
  const strong = api.declarationHandMetrics(["DRAGON", "PHOENIX", "As", "Ah", "Ad", "Ac", "Ks", "Kh"]);
  const weak = api.declarationHandMetrics(["2s", "3h", "4d", "6c", "7h", "8d", "9c", "Th"]);
  assert.ok(strong.score > weak.score, `${strong.score} should exceed ${weak.score}`);
  assert.ok(strong.controls.includes("Dragon"));
  assert.ok(strong.bombCount >= 1);
  assert.equal(weak.longestRun, 5);
});

test("probability context reconciles a full deal and assigns traded cards", () => {
  reset();
  const deck = api.ALL_CARDS.slice();
  // A trade keeps every hand at 14 cards: the outgoing card now sits in the
  // recipient's hand, so the ledger can still account for all 56 identities.
  api.state.inHand = new Set(deck.splice(0, 14));
  const traded = deck[0];
  api.state.tradedOut.set(traded, "L");

  const counts = { L: 14, P: 14, R: 14 };
  const context = api.buildProbabilityContext(counts);
  assert.equal(context.consistent, true, context.reason);
  assert.equal(context.accountedCount, 56);
  assert.equal(context.unknownCards.length, 41);
  assert.equal(context.slots.L, 13);
  assert.equal(context.slots.P, 14);
  assert.equal(context.slots.R, 14);
  assert.equal(context.unobservedOutOfHandCount, 0);

  assert.equal(api.cardProbability(traded, "L", context), 1);
  assert.equal(api.cardProbability(traded, "R", context), 0);
});

test("probability context pauses instead of inventing an impossible deal", () => {
  reset();
  api.state.inHand = new Set(api.ALL_CARDS.slice(0, 14));
  // 42 unknown cards but only 30 slots: identities must be out of hand, not in hands.
  const context = api.buildProbabilityContext({ L: 10, P: 10, R: 10 });
  assert.equal(context.consistent, true, context.reason);
  assert.equal(context.unobservedOutOfHandCount, 12);

  // A missing hand count makes the model unusable.
  const missing = api.buildProbabilityContext({ L: 10, P: null, R: 10 });
  assert.equal(missing.consistent, false);
  assert.match(missing.reason, /counts are unavailable/i);

  // A card cannot be both in hand and played.
  api.state.played.add([...api.state.inHand][0]);
  const conflict = api.buildProbabilityContext({ L: 10, P: 10, R: 10 });
  assert.equal(conflict.consistent, false);
  assert.match(conflict.reason, /Conflicting card states/);
});

test("sampleHiddenHands fills exactly the observed slots without duplicates", () => {
  reset();
  const deck = api.ALL_CARDS.slice();
  api.state.inHand = new Set(deck.splice(0, 14));
  const counts = { L: 14, P: 14, R: 12 };
  const context = api.buildProbabilityContext(counts);
  assert.equal(context.consistent, true, context.reason);
  const hands = api.sampleHiddenHands(context, api.makeSeededRandom(42));
  assert.ok(hands);
  const seen = new Set();
  for (const seat of ["L", "P", "R"]) {
    assert.equal(hands[seat].size, counts[seat]);
    for (const card of hands[seat]) {
      assert.equal(seen.has(card), false, `${card} dealt twice`);
      seen.add(card);
    }
  }
  assert.equal(seen.size, 40);
});

test("probabilityOfAny matches the hypergeometric distribution", () => {
  reset();
  const deck = api.ALL_CARDS.slice();
  api.state.inHand = new Set(deck.splice(0, 14));
  const context = api.buildProbabilityContext({ L: 14, P: 14, R: 14 });

  // Four Aces are among the 42 unknown cards; a 14-slot hand must hold one often.
  const aces = ["As", "Ah", "Ad", "Ac"];
  const probability = api.probabilityOfAny(aces, "L", context);
  let none = 1;
  for (let i = 0; i < 14; i++) none *= (42 - 4 - i) / (42 - i);
  assert.ok(Math.abs(probability - (1 - none)) < 1e-12);

  // A fully accounted card can never appear elsewhere.
  const mine = [...api.state.inHand][0];
  assert.equal(api.probabilityOfAny([mine], "L", context), 0);
  // An empty hand has no slots.
  assert.equal(api.cardProbability("DRAGON", "L", { ...context, slots: { ...context.slots, L: 0 } }), 0);
});

test("wilsonInterval stays inside the unit interval", () => {
  assert.equal(api.wilsonInterval(0, 0), null);
  const middle = api.wilsonInterval(50, 100);
  assert.ok(middle.lower < 0.5 && middle.upper > 0.5);
  const edge = api.wilsonInterval(24, 24);
  assert.ok(edge.upper <= 1 && edge.lower >= 0);
  assert.equal(api.percentRange(middle).includes("–"), true);
});

test("Dragon gift advice prefers the opponent with more cards, then calls", () => {
  const more = api.getDragonGiftAdvice({ L: 8, P: 5, R: 3 });
  assert.equal(more.seat, "L");
  assert.match(more.title, /Left/);

  const calls = new Map([["L", "grand"]]);
  const tied = api.getDragonGiftAdvice({ L: 6, P: 4, R: 6 }, calls);
  assert.equal(tied.seat, "R");

  const none = api.getDragonGiftAdvice({ L: 6, P: 4, R: 6 });
  assert.equal(none.seat, null);

  const unknown = api.getDragonGiftAdvice({ L: null, P: 4, R: 6 });
  assert.equal(unknown.seat, null);
  assert.match(unknown.title, /waiting/i);
});

test("opponent urgency ignores the partner and finished players", () => {
  assert.equal(api.hasOpponentNearlyOut({ L: 1, P: 5, R: 6 }), true);
  assert.equal(api.hasOpponentNearlyOut({ L: 5, P: 1, R: 6 }), false);
  assert.equal(api.hasOpponentNearlyOut({ L: 0, P: 5, R: 6 }), false);
  assert.equal(api.hasOpponentNearlyOut(null), false);
});

test("the Dog handoff only fires for a one-card Dog trick", () => {
  const dogContext = {
    tableCards: ["DOG"],
    currentCombo: api.classifyCombo(["DOG"]),
    actor: { key: "P" },
    actionText: "Partner played Dog"
  };
  const byPartner = api.resolveDogHandoffContext(dogContext, true);
  assert.equal(byPartner.dogHandoff, true);
  assert.deepEqual(byPartner.tableCards, []);

  const opponentDog = api.resolveDogHandoffContext({ ...dogContext, actor: { key: "L" } }, true);
  assert.equal(opponentDog.dogHandoff, false);

  const notOurTurn = api.resolveDogHandoffContext(dogContext, false);
  assert.equal(notOurTurn.dogHandoff, false);
});

test("manual marks resolve a stuck ledger entry without inventing evidence", () => {
  reset();
  const deck = api.ALL_CARDS.slice();
  api.state.inHand = new Set(deck.slice(0, 14));
  // A card can be left "in hand" and "unresolved" at the same time while DoD
  // rebuilds the row; that overlap must pause the model.
  api.state.unresolved.set(deck[0], "missing from hand");
  const broken = api.buildProbabilityContext({ L: 14, P: 14, R: 14 });
  assert.equal(broken.consistent, false);
  assert.match(broken.reason, /in hand and unresolved/);

  // toggleManualPlayed() performs exactly this transition.
  api.state.manualPlayed.add(deck[0]);
  api.state.played.add(deck[0]);
  api.state.inHand.delete(deck[0]);
  api.state.unresolved.delete(deck[0]);

  const context = api.buildProbabilityContext({ L: 14, P: 14, R: 14 });
  assert.equal(context.consistent, true, context.reason);
  assert.equal(context.unknownCards.length, 42);
  assert.equal(api.cardProbability(deck[0], "L", context), 0);
  assert.equal(api.cardProbability([...api.state.inHand][0], "L", context), 0);
});
