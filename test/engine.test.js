"use strict";

/**
 * Tests for the 2.0 inference layer: structural combo generation, minimum-play
 * planning, pass evidence, combo-presence probabilities, the Monte Carlo
 * playout and the structured recommendation.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../src/core.js");
const prob = require("../src/probability.js");
const api = require("../tracker.js");

function randomDeckHand(seed) {
  let value = seed;
  const random = () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
  const pool = core.ALL_CARDS.slice();
  const hand = new Set();
  while (hand.size < 14) hand.add(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  return hand;
}

function fullDeal(seed) {
  let value = seed;
  const random = () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
  const pool = core.ALL_CARDS.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return {
    ME: pool.slice(0, 14),
    L: pool.slice(14, 28),
    P: pool.slice(28, 42),
    R: pool.slice(42, 56)
  };
}

function contextFor(hand, counts = { L: 14, P: 14, R: 14 }, passConstraints = []) {
  return prob.buildProbabilityContext(counts, {
    inHand: new Set(hand),
    played: new Set(),
    unresolved: new Map(),
    tradedOut: new Map()
  }, { passConstraints });
}

test("structural combo generation covers every exhaustive combination type", () => {
  let checked = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const hand = randomDeckHand(seed);
    const signature = combo => `${combo.type}:${combo.count}:${combo.rank}`;
    const exhaustive = new Set(core.enumerateCombos(hand).map(signature));
    const generated = new Set(core.generateCombos(hand).map(signature));
    for (const key of exhaustive) {
      assert.equal(generated.has(key), true, `missing ${key} for ${[...hand].join(",")}`);
      checked++;
    }
    for (const combo of core.generateCombos(hand)) {
      assert.equal(core.classifyCombo(combo.cards)?.type, combo.type);
    }
  }
  assert.ok(checked > 500);
});

test("handPlan finds the minimum number of plays and covers every card", () => {
  const hand = ["2s", "3h", "4d", "5c", "6s", "9h", "9d", "DRAGON"];
  const plan = core.handPlan(hand);
  assert.equal(plan.exact, true);
  assert.equal(plan.plays, 3);
  const flattened = plan.groups.flatMap(group => group.cards);
  assert.deepEqual([...flattened].sort(), [...hand].sort());
  assert.equal(new Set(flattened).size, hand.length);

  const pairRun = core.handPlan(["3h", "3d", "4s", "4c", "5h", "5d"]);
  assert.equal(pairRun.plays, 1);
  assert.equal(pairRun.groups[0].type, "pair-run");

  const fullHouse = core.handPlan(["Kh", "Kd", "Ks", "9c", "9d", "2s", "3h", "4d"]);
  assert.equal(fullHouse.plays, 4); // full house + three singles
});

test("pass constraints are hard evidence and raise the hold-trick probability", () => {
  const deck = core.ALL_CARDS.slice();
  const hand = deck.slice(0, 14);
  const candidate = core.classifyCombo(["As"]);
  const open = contextFor(hand);
  const before = prob.evaluateComboThreat(candidate, open);

  const constraints = [
    { seat: "L", combo: candidate },
    { seat: "R", combo: candidate }
  ];
  const constrained = contextFor(hand, { L: 14, P: 14, R: 14 }, constraints);
  const worldData = prob.worldsFor(constrained);
  assert.equal(worldData.constrained, true);
  const after = prob.evaluateComboThreat(candidate, constrained);

  assert.ok(after.probability > before.probability);
  assert.equal(after.probability, 1);
  assert.equal(prob.worldsSatisfyPasses(worldData.worlds[0], constraints), true);
});

test("combo presence detects bombs without matching lone Dragon or Phoenix", () => {
  assert.equal(prob.comboTypeAvailable(new Set(["9h", "9d", "9s", "9c"]), "bomb"), true);
  assert.equal(prob.comboTypeAvailable(new Set(["3h", "4h", "5h", "6h", "7h"]), "bomb"), true);
  assert.equal(prob.comboTypeAvailable(new Set(["DRAGON"]), "bomb"), false);
  assert.equal(prob.comboTypeAvailable(new Set(["PHOENIX"]), "bomb"), false);
  assert.equal(prob.comboTypeAvailable(new Set(["2s", "3h", "4d", "5c", "6s"]), "straight"), true);
  assert.equal(prob.comboTypeAvailable(new Set(["2s", "3h", "4d", "5c", "6s"]), "fullHouse"), false);
  assert.equal(prob.comboTypeAvailable(new Set(["Kh", "Kd", "9c", "9d", "9s"]), "fullHouse"), true);
  assert.equal(prob.comboTypeAvailable(new Set(["Kh", "Kd"]), "pair"), true);
  assert.equal(prob.comboTypeAvailable(new Set(["Kh", "PHOENIX"]), "pair"), true);
});

test("comboPresence reports probabilities and intervals for every seat", () => {
  const hand = core.ALL_CARDS.slice(0, 14);
  const context = contextFor(hand);
  const presence = prob.comboPresence(context, { samples: 64 });
  assert.equal(presence.samples, 64);
  for (const seat of ["L", "P", "R"]) {
    for (const kind of prob.PRESENCE_KINDS) {
      const entry = presence.seats[seat][kind];
      assert.ok(entry.probability >= 0 && entry.probability <= 1);
      assert.ok(entry.interval.lower <= entry.probability + 1e-9);
      assert.ok(entry.interval.upper >= entry.probability - 1e-9);
    }
  }
  assert.ok(presence.seats.L.straight.probability > presence.seats.L.bomb.probability);
});

test("simulateOne always returns a complete finish order", () => {
  for (let seed = 1; seed <= 24; seed++) {
    const deal = fullDeal(seed);
    const order = prob.simulateOne(deal.ME, { L: deal.L, P: deal.P, R: deal.R }, core.TURN_ORDER[seed % 4]);
    assert.equal(order.length, 4);
    assert.deepEqual([...order].sort(), ["L", "ME", "P", "R"]);
  }
});

test("simulated Tichu odds separate a monster hand from a weak hand", () => {
  const strong = ["DRAGON", "PHOENIX", "As", "Ah", "Ad", "Ac", "Ks", "Kh", "Kd", "Kc", "Qs", "Qh", "Qd", "Qc"];
  const weak = ["2s", "3h", "4d", "5c", "6s", "7h", "8d", "9c", "Ts", "Jh", "2d", "3c", "4s", "5h"];
  const strongResult = prob.simulateRound({ hand: strong, mode: "tichu", samples: 48 });
  const weakResult = prob.simulateRound({ hand: weak, mode: "tichu", samples: 48 });
  assert.ok(strongResult.first > weakResult.first + 0.4, `${strongResult.first} vs ${weakResult.first}`);
  assert.ok(strongResult.teamFirst >= strongResult.first);
  assert.ok(weakResult.teamFirst >= weakResult.first);
  assert.equal(strongResult.positions.ME.reduce((sum, value) => sum + value, 0), strongResult.samples);
});

test("simulation is deterministic for a seed and supports the Grand Tichu deal", () => {
  const hand = ["DRAGON", "PHOENIX", "As", "Ah", "Ad", "Ac", "Ks", "Kh"];
  const first = prob.simulateRound({ hand, mode: "grand", samples: 32, seed: 4242 });
  const second = prob.simulateRound({ hand, mode: "grand", samples: 32, seed: 4242 });
  assert.equal(first.first, second.first);
  assert.equal(first.samples, 32);
  assert.ok(first.first >= 0 && first.first <= 1);
});

test("recognition of a partner's winning play recommends a pass", () => {
  const hand = ["Kh", "9d", "7s", "5c", "3h"];
  const context = contextFor(hand, { L: 10, P: 10, R: 10 });
  const recommendation = prob.getRecommendation({
    hand,
    tableCards: ["Qc"],
    currentCombo: core.classifyCombo(["Qc"]),
    actor: { key: "P" },
    counts: { L: 10, P: 10, R: 10 },
    isOurTurn: true,
    context,
    plan: core.handPlan(hand)
  });
  assert.equal(recommendation.action, "PASS");
  assert.match(recommendation.title, /partner/i);
});

test("a wish is honoured when a legal wished reply exists", () => {
  const hand = ["Kh", "9d", "7s", "5c", "3h"];
  const context = contextFor(hand, { L: 10, P: 10, R: 10 });
  const recommendation = prob.getRecommendation({
    hand,
    tableCards: ["Qc"],
    currentCombo: core.classifyCombo(["Qc"]),
    actor: { key: "L" },
    counts: { L: 10, P: 10, R: 10 },
    isOurTurn: true,
    wishRank: "K",
    context,
    plan: core.handPlan(hand)
  });
  assert.equal(recommendation.action, "PLAY");
  assert.deepEqual(recommendation.cards, ["Kh"]);
});

test("no legal reply recommends a pass instead of inventing a play", () => {
  const hand = ["2s", "3h", "4d"];
  const context = contextFor(hand, { L: 10, P: 10, R: 10 });
  const recommendation = prob.getRecommendation({
    hand,
    tableCards: ["DRAGON"],
    currentCombo: core.classifyCombo(["DRAGON"]),
    actor: { key: "L" },
    counts: { L: 10, P: 10, R: 10 },
    isOurTurn: true,
    context,
    plan: core.handPlan(hand)
  });
  assert.equal(recommendation.action, "PASS");
});

test("the Dog handoff produces a fresh-lead recommendation", () => {
  const hand = ["Kh", "9d", "7s"];
  const recommendation = prob.getRecommendation({
    hand,
    tableCards: [],
    currentCombo: null,
    actor: { key: "P" },
    counts: { L: 10, P: 10, R: 10 },
    isOurTurn: true,
    context: null,
    plan: core.handPlan(hand),
    dogHandoff: true
  });
  assert.equal(recommendation.action, "LEAD");
  assert.match(recommendation.title, /Dog/i);
});

test("simulated declaration odds can override the hand-index fallback", () => {
  const hand = ["DRAGON", "PHOENIX", "As", "Ah", "Ad", "Ac", "Ks", "Kh"];
  const call = prob.getDeclarationAdvice(hand, {
    playedCount: 0, myPlayedCount: 0, tradedOutCount: 0,
    simulation: { first: 0.71, samples: 50, teamFirst: 0.8 }
  });
  assert.equal(call.stage, "grand-tichu");
  assert.match(call.title, /CALL CANDIDATE/);
  assert.equal(call.simulated, true);

  const pass = prob.getDeclarationAdvice(hand, {
    playedCount: 0, myPlayedCount: 0, tradedOutCount: 0,
    simulation: { first: 0.18, samples: 50, teamFirst: 0.3 }
  });
  assert.match(pass.title, /DO NOT CALL/);
});

test("wish parsing no longer turns an unrelated number into a wish", () => {
  assert.equal(core.parseWishRank("Round 12"), null);
  assert.equal(core.parseWishRank("Wish: Q"), "Q");
  assert.equal(core.parseWishRank("Asked card: 10"), "T");
  assert.equal(core.parseWishRank("K"), "K");
});

test("the compatibility API still exposes the state-driven helpers", () => {
  api.clearRoundData("compat");
  api.state.inHand = new Set(core.ALL_CARDS.slice(0, 14));
  const context = api.buildProbabilityContext({ L: 14, P: 14, R: 14 });
  assert.equal(context.consistent, true);
  assert.equal(context.unknownCards.length, 42);
  assert.equal(api.cardProbability("DRAGON", "L", context), 1 / 3);
  assert.ok(api.percentRange(api.wilsonInterval(3, 10)).includes("–"));
});

test("straights that exclude Mahjong are still generated", () => {
  const hand = new Set(["MAHJONG", "2s", "3h", "4d", "5c", "6s"]);
  const generated = core.generateCombos(hand);
  const ranks = generated.filter(combo => combo.type === "straight").map(combo => combo.rank);
  assert.ok(ranks.includes(5)); // Mahjong 1-2-3-4-5
  assert.ok(ranks.includes(6)); // 2-3-4-5-6 without Mahjong
  const plan = core.handPlan(hand);
  assert.ok(plan.plays <= 2);
});

test("pass evidence also adjusts per-card ownership estimates", () => {
  const hand = core.ALL_CARDS.slice(0, 14);
  const ace = core.classifyCombo(["As"]);
  const constraints = [
    { seat: "L", combo: ace },
    { seat: "R", combo: ace }
  ];
  const context = contextFor(hand, { L: 14, P: 14, R: 14 }, constraints);
  // L and R passed on an Ace, so neither may hold Dragon or Phoenix.
  assert.equal(prob.cardProbability("DRAGON", "L", context), 0);
  assert.equal(prob.cardProbability("PHOENIX", "R", context), 0);
  assert.equal(prob.probabilityOfAny(["DRAGON", "PHOENIX"], "L", context), 0);
});

test("traded cards are fixed in the simulated Tichu deal", () => {
  const deck = core.ALL_CARDS.slice();
  const hand = deck.slice(0, 14);
  const traded = deck[20];
  const context = prob.buildProbabilityContext({ L: 14, P: 14, R: 14 }, {
    inHand: new Set(hand),
    played: new Set(),
    unresolved: new Map(),
    tradedOut: new Map([[traded, "L"]])
  });
  const deals = prob.buildDeals({ hand, context, mode: "tichu", samples: 8 }, core.makeSeededRandom(7));
  assert.equal(deals.length, 8);
  for (const deal of deals) {
    assert.equal(deal.opponents.L.includes(traded), true);
    assert.equal(new Set(deal.opponents.L).size, 14);
    assert.equal(deal.opponents.L.includes(traded), true);
  }
});

test("the Grand Tichu window gets a decision card, not a play recommendation", () => {
  const recommendation = prob.getRecommendation({
    hand: ["DRAGON", "PHOENIX", "As", "Ah", "Ad", "Ac", "Ks", "Kh"],
    tableCards: [],
    currentCombo: null,
    actor: null,
    counts: { L: 14, P: 14, R: 14 },
    isOurTurn: true,
    context: null,
    plan: null,
    declarationAdvice: {
      stage: "grand-tichu",
      probability: 0.71,
      score: 88,
      tone: "good",
      title: "Grand Tichu: CALL CANDIDATE · 71%",
      details: "Simulated."
    }
  });
  assert.equal(recommendation.action, "DECIDE");
  assert.match(recommendation.headline, /71%/);
  assert.equal(recommendation.cards.length, 0);
  assert.ok(recommendation.chips.some(chip => chip.label === "Finish 1st"));
});

test("a low single is answered with a single, not a bomb", () => {
  const hand = ["DRAGON", "PHOENIX", "As", "Ah", "Ad", "Ac", "Ks", "Kh", "Kd", "Kc", "Qs", "Qh", "Qd", "Qc"];
  const context = contextFor(hand, { L: 13, P: 14, R: 14 });
  const recommendation = prob.getRecommendation({
    hand,
    tableCards: ["9s"],
    currentCombo: core.classifyCombo(["9s"]),
    actor: { key: "L" },
    counts: { L: 13, P: 14, R: 14 },
    isOurTurn: true,
    wishRank: "Q",
    context,
    plan: core.handPlan(hand)
  });
  assert.equal(recommendation.action, "PLAY");
  assert.equal(recommendation.combo.bomb, false);
  assert.equal(recommendation.cards.length, 1);
  assert.equal(recommendation.cards[0][0], "Q");
});

test("the lead scorer feeds a nearly-out partner with the Dog", () => {
  const hand = ["DOG", "2s", "3h", "4d", "5c", "6s", "7h"];
  const dog = { ...core.classifyCombo(["DOG"]), cards: ["DOG"] };
  const straightCards = ["2s", "3h", "4d", "5c", "6s"];
  const straight = { ...core.classifyCombo(straightCards), cards: straightCards };
  const plan = core.handPlan(hand);
  const dogScore = prob.scoreLeadCandidate(dog, hand, plan, { P: 1 });
  const straightScore = prob.scoreLeadCandidate(straight, hand, plan, { P: 1 });
  assert.ok(dogScore > straightScore, `${dogScore} should beat ${straightScore}`);
  // With a long partner hand, the Dog is not automatically the best lead.
  const normalDog = prob.scoreLeadCandidate(dog, hand, plan, { P: 10 });
  assert.ok(normalDog < dogScore);
});

test("a Dog lead is recommended when the partner is nearly out", () => {
  const hand = ["DOG", "2s", "3h", "4d", "5c", "6s", "7h"];
  const context = contextFor(hand, { L: 10, P: 1, R: 10 });
  const recommendation = prob.getRecommendation({
    hand,
    tableCards: [],
    currentCombo: null,
    actor: null,
    counts: { L: 10, P: 1, R: 10 },
    isOurTurn: true,
    context,
    plan: core.handPlan(hand)
  });
  assert.equal(recommendation.action, "LEAD");
  assert.deepEqual(recommendation.cards, ["DOG"]);
  assert.match(recommendation.reason, /partner/i);
});
