(() => {
"use strict";

/**
 * Tichu Tracker 2.0 — hidden-hand model, Monte Carlo playout and advisors.
 *
 * The ledger is passed in explicitly. "Known" means the tracker actually saw
 * the card in your hand, on the board, or in a committed outgoing trade; the
 * model never reads an opponent's hidden hand.
 */

const Core = (typeof require === "function" && typeof module !== "undefined")
  ? require("./core.js")
  : globalThis.TichuTrackerCore;
const {
  ALL_CARDS, CARD_SET, STANDARD_CARDS, SUITS, ASC_RANKS,
  SEAT_KEYS, TURN_ORDER, PARTNER_OF, OPPONENTS_OF, ACTIVE_OPPONENTS,
  cardRank, standardRank, rankNameFromValue, displayCard, displayCards,
  classifyCombo, canBeat, comboLabel, generateCombos, handPlan, handCanBeatCombo, findBeatingStraightFlush,
  wilsonInterval, percent, percentRange, makeSeededRandom, hashText
} = Core;

const DEFAULT_WORLDS = 160;
const MAX_WORLDS = 320;

function normalizeUnresolved(unresolved) {
  if (unresolved instanceof Map) return unresolved;
  if (Array.isArray(unresolved)) return new Map(unresolved.map(card => [card, "unresolved"]));
  return new Map();
}

function normalizeMap(map) {
  if (map instanceof Map) return map;
  if (Array.isArray(map)) return new Map(map);
  return new Map();
}

/**
 * Reconcile the visible ledger with the three opponent hand counts.
 *
 * Cards that cannot fit in any hand are kept in an explicit out-of-hand bucket
 * instead of being forced into an opponent's hand (common when tracking starts
 * mid-hand). Conflicting states pause estimates; they never silently invent a
 * distribution.
 */
function buildProbabilityContext(counts, ledger = {}, options = {}) {
  const inHand = new Set(ledger.inHand || []);
  const played = new Set(ledger.played || []);
  const unresolved = normalizeUnresolved(ledger.unresolved);
  const tradedOut = normalizeMap(ledger.tradedOut);
  const passConstraints = Array.isArray(options.passConstraints)
    ? options.passConstraints
    : (Array.isArray(ledger.passConstraints) ? ledger.passConstraints : []);

  const knownBySeat = new Map();
  for (const key of [...SEAT_KEYS, "L", "P", "R"]) knownBySeat.set(key, new Set());
  for (const [card, target] of tradedOut.entries()) {
    if (!CARD_SET.has(card) || !knownBySeat.has(target)) continue;
    if (inHand.has(card) || played.has(card) || unresolved.has(card)) continue;
    knownBySeat.get(target).add(card);
  }

  const knownOwner = new Map();
  for (const [seat, cards] of knownBySeat.entries()) {
    for (const card of cards) {
      if (knownOwner.has(card)) continue;
      knownOwner.set(card, seat);
    }
  }

  const unresolvedCards = new Set(
    [...unresolved.keys()].filter(card => !inHand.has(card) && !played.has(card) && !knownOwner.has(card))
  );
  const unknownCards = ALL_CARDS.filter(card =>
    !inHand.has(card) && !played.has(card) && !unresolvedCards.has(card) && !knownOwner.has(card)
  );

  const slots = {};
  let slotsKnown = true;
  for (const seat of ["L", "P", "R"]) {
    const observed = counts ? counts[seat] : null;
    if (!Number.isFinite(observed) || observed < 0) {
      slots[seat] = null;
      slotsKnown = false;
      continue;
    }
    const remainingSlots = observed - knownBySeat.get(seat).size;
    slots[seat] = remainingSlots;
    if (remainingSlots < 0) slotsKnown = false;
  }
  const slotTotal = ["L", "P", "R"].reduce(
    (sum, seat) => sum + (Number.isFinite(slots[seat]) ? slots[seat] : 0), 0
  );

  const unobservedOutOfHandCount = slotsKnown && slotTotal <= unknownCards.length
    ? unknownCards.length - slotTotal
    : null;

  const overlaps = [];
  for (const card of played) {
    if (inHand.has(card)) overlaps.push(`${card}: played and in hand`);
    if (unresolved.has(card)) overlaps.push(`${card}: played and unresolved`);
  }
  for (const card of inHand) {
    if (unresolved.has(card)) overlaps.push(`${card}: in hand and unresolved`);
    if (knownOwner.has(card)) overlaps.push(`${card}: in hand and assigned to ${knownOwner.get(card)}`);
  }

  const consistent = slotsKnown && overlaps.length === 0 && unresolvedCards.size === 0 && slotTotal <= unknownCards.length;
  let reason = "";
  if (overlaps.length) reason = `Conflicting card states: ${overlaps.slice(0, 2).join("; ")}`;
  else if (unresolvedCards.size) reason = `${unresolvedCards.size} card(s) have unresolved ownership while DoD updates the hand/board.`;
  else if (!slotsKnown) reason = "One or more opponent card counts are unavailable or inconsistent.";
  else if (slotTotal > unknownCards.length) reason = `Unseen-card mismatch: ${unknownCards.length} unknown cards but ${slotTotal} unassigned hand slots.`;

  const accounted = new Set([
    ...inHand, ...played, ...unresolvedCards, ...knownOwner.keys(), ...unknownCards
  ]);
  const missingCards = ALL_CARDS.filter(card => !accounted.has(card));
  const duplicateCount = inHand.size + played.size + unresolvedCards.size + knownOwner.size
    + unknownCards.length - accounted.size;
  if (!reason && (missingCards.length || duplicateCount)) {
    reason = `Deck ledger incomplete: ${missingCards.length} unaccounted, ${duplicateCount} overlapping card entries.`;
  }

  const constraintSignature = passConstraints
    .map(item => `${item.seat}:${item.combo ? `${item.combo.type}/${item.combo.count}/${item.combo.rank}` : ""}`)
    .sort()
    .join(",");

  return {
    counts: counts || {},
    inHand, played, unresolvedCards, knownBySeat, knownOwner,
    unknownCards: unknownCards.slice(), slots,
    unobservedOutOfHandCount,
    consistent: consistent && missingCards.length === 0 && duplicateCount === 0,
    reason, accountedCount: accounted.size, missingCards, duplicateCount,
    passConstraints: passConstraints.slice(),
    constraintSignature,
    mySeat: "ME",
    signature: [
      [...inHand].sort().join(","),
      [...played].sort().join(","),
      [...unresolvedCards].sort().join(","),
      [...knownOwner.entries()].sort().map(([card, seat]) => `${card}:${seat}`).join(","),
      unknownCards.slice().sort().join(","),
      ["L", "P", "R"].map(seat => `${seat}:${slots[seat]}`).join(","),
      `out:${unobservedOutOfHandCount}`,
      `pass:${constraintSignature}`
    ].join("|")
  };
}

const ownershipCache = new Map();
const OWNERSHIP_CACHE_LIMIT = 4;

function sampledOwnership(context) {
  if (!context || !context.consistent) return null;
  const worldData = worldsFor(context);
  if (!worldData || !worldData.worlds.length) return null;
  const key = `${context.signature}@${worldData.samples}`;
  if (ownershipCache.has(key)) return ownershipCache.get(key);
  const distribution = new Map();
  for (const world of worldData.worlds) {
    for (const seat of ["L", "P", "R"]) {
      for (const card of world[seat]) {
        if (!distribution.has(card)) distribution.set(card, { L: 0, P: 0, R: 0 });
        distribution.get(card)[seat]++;
      }
    }
  }
  for (const entry of distribution.values()) {
    entry.L /= worldData.samples;
    entry.P /= worldData.samples;
    entry.R /= worldData.samples;
  }
  if (ownershipCache.size >= OWNERSHIP_CACHE_LIMIT) ownershipCache.delete(ownershipCache.keys().next().value);
  ownershipCache.set(key, distribution);
  return distribution;
}

function sampledAnyProbability(cards, seat, context) {
  const worldData = worldsFor(context);
  if (!worldData || !worldData.worlds.length) return null;
  let hits = 0;
  for (const world of worldData.worlds) {
    if (cards.some(card => world[seat].has(card))) hits++;
  }
  return hits / worldData.samples;
}

function cardProbability(card, seat, context) {
  if (!context) return null;
  const { knownOwner, unknownCards, slots, inHand, played, unresolvedCards } = context;
  if (inHand && inHand.has(card)) return 0;
  if (played && played.has(card)) return 0;
  if (unresolvedCards && unresolvedCards.has(card)) return null;
  const owner = knownOwner.get(card);
  if (owner) return owner === seat ? 1 : 0;
  if (!unknownCards.includes(card)) return 0;
  if (!context.consistent) return null;
  // Pass evidence changes the joint distribution; use the same sampled worlds
  // as the Odds tab instead of an unconditional hypergeometric marginal.
  if ((context.passConstraints && context.passConstraints.length) || context.unobservedOutOfHandCount > 0) {
    const sampled = sampledOwnership(context);
    if (sampled && sampled.has(card)) return sampled.get(card)[seat];
  }
  const availableSlots = slots[seat];
  if (!Number.isFinite(availableSlots) || !unknownCards.length) return null;
  return Math.max(0, Math.min(1, availableSlots / unknownCards.length));
}

function probabilityOfAny(cards, seat, context) {
  if (!context) return null;
  const { knownBySeat, knownOwner, unknownCards, slots, inHand, played, unresolvedCards } = context;
  if (!knownBySeat.has(seat)) return null;
  if (cards.some(card => knownBySeat.get(seat).has(card))) return 1;
  if (cards.some(card => unresolvedCards.has(card))) return null;
  if (cards.every(card => inHand.has(card) || played.has(card) || knownOwner.has(card) || !unknownCards.includes(card))) {
    return 0;
  }
  if (!context.consistent) return null;
  const unknownTargets = cards.filter(card => unknownCards.includes(card) && !knownOwner.has(card));
  const handSlots = slots[seat];
  if (!Number.isFinite(handSlots) || !unknownCards.length) return null;
  if (handSlots <= 0 || unknownTargets.length === 0) return 0;
  if ((context.passConstraints && context.passConstraints.length) || context.unobservedOutOfHandCount > 0) {
    const sampled = sampledAnyProbability(unknownTargets, seat, context);
    if (sampled !== null) return sampled;
  }
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

function probabilityAtLeastOneAbove(rank, seat, context) {
  const threshold = typeof rank === "string"
    ? (rank === "T" ? 10 : (ASC_RANKS.indexOf(rank) >= 0 ? ASC_RANKS.indexOf(rank) + 2 : Number(rank)))
    : Number(rank);
  if (!Number.isFinite(threshold)) return null;
  const targets = ALL_CARDS.filter(card => cardRank(card) > threshold);
  return probabilityOfAny(targets, seat, context);
}

/**
 * A pass is hard evidence: if a seat could not beat the combination that was
 * on the table when they passed, they cannot beat it with a subset of that
 * hand later either. Rejection sampling keeps only worlds that agree.
 */
function worldsSatisfyPasses(hands, passConstraints) {
  for (const constraint of passConstraints) {
    if (!constraint || !constraint.combo) continue;
    const hand = hands[constraint.seat];
    if (!hand) continue;
    if (handCanBeatCombo(hand, constraint.combo)) return false;
  }
  return true;
}

function sampleHiddenHands(context, random = Math.random) {
  if (!context || !context.consistent) return null;
  const slotTotal = ["L", "P", "R"].reduce(
    (sum, seat) => sum + context.slots[seat], 0
  );
  if (slotTotal > context.unknownCards.length) return null;
  const shuffled = context.unknownCards.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const hands = {};
  let cursor = 0;
  for (const seat of ["L", "P", "R"]) {
    hands[seat] = new Set(context.knownBySeat.get(seat));
    const slotCount = context.slots[seat];
    for (let i = 0; i < slotCount; i++) hands[seat].add(shuffled[cursor++]);
    if (hands[seat].size !== context.counts[seat]) return null;
  }
  if (cursor !== slotTotal) return null;
  return hands;
}

const worldCache = new Map();
const WORLD_CACHE_LIMIT = 8;

function worldsFor(context, requested = DEFAULT_WORLDS) {
  if (!context || !context.consistent) return null;
  const samples = Math.max(24, Math.min(MAX_WORLDS, requested | 0));
  const cacheKey = `${context.signature}@${samples}`;
  if (worldCache.has(cacheKey)) return worldCache.get(cacheKey);

  const constraints = context.passConstraints || [];
  const random = makeSeededRandom(hashText(cacheKey));
  const accepted = [];
  let attempts = 0;
  const maxAttempts = samples * (constraints.length ? 14 : 1) + 120;
  while (accepted.length < samples && attempts < maxAttempts) {
    attempts++;
    const hands = sampleHiddenHands(context, random);
    if (!hands) return null;
    if (constraints.length && !worldsSatisfyPasses(hands, constraints)) continue;
    accepted.push(hands);
  }

  let constrained = constraints.length > 0;
  let worlds = accepted;
  if (worlds.length < Math.min(24, samples)) {
    // With too few accepted worlds the percentile estimates become noise.
    // Fall back to the unconstrained deal and say so in the UI.
    constrained = false;
    worlds = [];
    while (worlds.length < samples) {
      const hands = sampleHiddenHands(context, random);
      if (!hands) return null;
      worlds.push(hands);
    }
  }

  const result = {
    worlds,
    samples: worlds.length,
    attempts,
    acceptance: attempts ? accepted.length / attempts : 0,
    constrained
  };
  if (worldCache.size >= WORLD_CACHE_LIMIT) worldCache.delete(worldCache.keys().next().value);
  worldCache.set(cacheKey, result);
  return result;
}

const threatCache = new Map();
const THREAT_CACHE_LIMIT = 80;

function comboSignature(combo) {
  return `${combo.type}:${combo.count}:${combo.rank}:${combo.bomb ? 1 : 0}:${combo.dog ? 1 : 0}`;
}

/**
 * Team-aware threat estimate.
 *  probability      = P(no opponent can beat the play)  <- what keeps the trick
 *  cleanProbability = P(nobody, including the partner, can beat it)
 *  partnerBeat      = P(the partner can beat it)        <- often good news
 */
function evaluateComboThreat(candidate, context, options = {}) {
  if (!candidate || !context || !context.consistent) return null;
  const worldData = worldsFor(context, options.samples || DEFAULT_WORLDS);
  if (!worldData || !worldData.worlds.length) return null;
  const cacheKey = `${context.signature}|${comboSignature(candidate)}|${worldData.samples}`;
  if (threatCache.has(cacheKey)) return threatCache.get(cacheKey);

  const hits = { L: 0, P: 0, R: 0 };
  let opponentHits = 0;
  let cleanHits = 0;
  for (const hands of worldData.worlds) {
    let partner = false;
    let opponent = false;
    for (const seat of ["L", "P", "R"]) {
      if (!hands[seat] || hands[seat].size === 0) continue;
      if (handCanBeatCombo(hands[seat], candidate)) {
        hits[seat]++;
        if (seat === "P") partner = true;
        else opponent = true;
      }
    }
    if (opponent) opponentHits++;
    if (opponent || partner) cleanHits++;
  }

  const samples = worldData.samples;
  const seatEstimates = {};
  for (const seat of ["L", "P", "R"]) {
    seatEstimates[seat] = {
      probability: hits[seat] / samples,
      samples,
      interval: wilsonInterval(hits[seat], samples)
    };
  }
  const estimate = {
    probability: 1 - opponentHits / samples,
    cleanProbability: 1 - cleanHits / samples,
    partnerBeat: hits.P / samples,
    samples,
    interval: wilsonInterval(samples - opponentHits, samples),
    cleanInterval: wilsonInterval(samples - cleanHits, samples),
    seatEstimates,
    constrained: worldData.constrained,
    acceptance: worldData.acceptance
  };
  if (threatCache.size >= THREAT_CACHE_LIMIT) threatCache.delete(threatCache.keys().next().value);
  threatCache.set(cacheKey, estimate);
  return estimate;
}

function estimateSeatsCanBeat(candidate, context, options = {}) {
  const estimate = evaluateComboThreat(candidate, context, options);
  return estimate ? estimate.seatEstimates : null;
}

function estimateNoResponseProbability(candidate, context, options = {}) {
  return evaluateComboThreat(candidate, context, options);
}

const PRESENCE_KINDS = ["bomb", "fullHouse", "straight", "pairRun", "triple", "pair", "high"];
const PRESENCE_LABELS = {
  bomb: "Bomb",
  fullHouse: "Full house",
  straight: "Straight",
  pairRun: "Pair run",
  triple: "Triple",
  pair: "Pair",
  high: "K or higher"
};
const PRESENCE_PROBES = {
  // A low synthetic combination turns handCanBeatCombo into a "contains at
  // least one" detector while reusing the tested rules engine. Bombs need a
  // dedicated check: a rank-1 single probe would also match Dragon/Phoenix.
  fullHouse: { type: "full-house", count: 5, rank: 1, bomb: false },
  straight: { type: "straight", count: 5, rank: 4, bomb: false },
  pairRun: { type: "pair-run", count: 4, rank: 1, bomb: false },
  triple: { type: "triple", count: 3, rank: 1, bomb: false },
  pair: { type: "pair", count: 2, rank: 1, bomb: false },
  high: { type: "single", count: 1, rank: 12, bomb: false }
};

const presenceCache = new Map();
const PRESENCE_CACHE_LIMIT = 8;

/**
 * Probability that each opponent's current hand contains at least one example
 * of each useful combination. This answers questions such as "how likely is
 * Left to hold a bomb or a full house right now?".
 */
function comboPresence(context, options = {}) {
  if (!context || !context.consistent) return null;
  const worldData = worldsFor(context, options.samples || DEFAULT_WORLDS);
  if (!worldData || !worldData.worlds.length) return null;
  const cacheKey = `${context.signature}|presence|${worldData.samples}`;
  if (presenceCache.has(cacheKey)) return presenceCache.get(cacheKey);

  const seats = {};
  for (const seat of ["L", "P", "R"]) {
    seats[seat] = {};
    for (const kind of PRESENCE_KINDS) {
      seats[seat][kind] = { hits: 0, probability: null, interval: null };
    }
  }
  for (const hands of worldData.worlds) {
    for (const seat of ["L", "P", "R"]) {
      const hand = hands[seat];
      if (!hand || !hand.size) continue;
      for (const kind of PRESENCE_KINDS) {
        if (comboTypeAvailable(hand, kind)) seats[seat][kind].hits++;
      }
    }
  }
  for (const seat of ["L", "P", "R"]) {
    for (const kind of PRESENCE_KINDS) {
      const entry = seats[seat][kind];
      entry.probability = entry.hits / worldData.samples;
      entry.interval = wilsonInterval(entry.hits, worldData.samples);
    }
  }
  const result = {
    seats,
    kinds: PRESENCE_KINDS,
    labels: PRESENCE_LABELS,
    samples: worldData.samples,
    constrained: worldData.constrained,
    acceptance: worldData.acceptance
  };
  if (presenceCache.size >= PRESENCE_CACHE_LIMIT) presenceCache.delete(presenceCache.keys().next().value);
  presenceCache.set(cacheKey, result);
  return result;
}

function handContainsBomb(hand) {
  const rankCounts = new Map();
  for (const card of hand) {
    if (card.length !== 2 || !/[2-9TJQKA]/.test(card[0])) continue;
    const rank = standardRank(card);
    rankCounts.set(rank, (rankCounts.get(rank) || 0) + 1);
    if (rankCounts.get(rank) === 4) return true;
  }
  return findBeatingStraightFlush([...hand], { type: "single", count: 1, rank: 1, bomb: false });
}

function comboTypeAvailable(hand, type) {
  if (type === "bomb") return handContainsBomb(hand);
  const probe = PRESENCE_PROBES[type];
  return probe ? handCanBeatCombo(hand, probe) : false;
}

// ---------------------------------------------------------------------------
// Monte Carlo playout
// ---------------------------------------------------------------------------

function removeCards(hand, cards) {
  for (const card of cards) {
    const index = hand.indexOf(card);
    if (index >= 0) hand.splice(index, 1);
  }
}

function nextActiveSeat(hands, fromSeat, includeSelf = false) {
  const start = TURN_ORDER.indexOf(fromSeat);
  for (let step = includeSelf ? 0 : 1; step <= 4; step++) {
    const seat = TURN_ORDER[(start + step) % 4];
    if (hands[seat] && hands[seat].length > 0) return seat;
  }
  return null;
}

function makeHandIndex(hand) {
  const rankMap = new Map();
  let phoenix = false;
  let dragon = false;
  let mahjong = false;
  for (const card of hand) {
    if (card === "PHOENIX") { phoenix = true; continue; }
    if (card === "DRAGON") { dragon = true; continue; }
    if (card === "MAHJONG") { mahjong = true; continue; }
    if (card.length === 2 && ASC_RANKS.includes(card[0]) && !card[0].match(/[^2-9TJQKA]/)) {
      const rank = standardRank(card);
      if (!rankMap.has(rank)) rankMap.set(rank, []);
      rankMap.get(rank).push(card);
    }
  }
  return { rankMap, ranks: [...rankMap.keys()].sort((a, b) => a - b), phoenix, dragon, mahjong };
}

function makeSingle(card) {
  return {
    type: "single",
    count: 1,
    // The Phoenix is 1.5 when led as a single and 0.5 above the previous
    // single when following. canBeat() handles the "following" case, so the
    // stored lead value must stay at 1.5 rather than 14.5.
    rank: card === "PHOENIX" ? 1.5 : cardRank(card),
    phoenixSingle: card === "PHOENIX",
    dog: card === "DOG",
    bomb: false,
    cards: [card]
  };
}

function generateRepliesForType(hand, current) {
  if (!current || current.dog) return [];
  const out = [];
  const { rankMap, ranks, phoenix } = makeHandIndex(hand);

  const add = (cards, type, count, rank, bomb = false) => {
    const combo = { type, count, rank, bomb, cards };
    if (canBeat(combo, current)) out.push(combo);
  };

  if (current.type === "single") {
    for (const card of hand) {
      const combo = makeSingle(card);
      if (canBeat(combo, current)) out.push(combo);
    }
  } else if (current.type === "pair") {
    for (const rank of ranks) {
      const group = rankMap.get(rank);
      if (group.length >= 2) add(group.slice(0, 2), "pair", 2, rank);
      if (phoenix && group.length >= 1) add([group[0], "PHOENIX"], "pair", 2, rank);
    }
  } else if (current.type === "triple") {
    for (const rank of ranks) {
      const group = rankMap.get(rank);
      if (group.length >= 3) add(group.slice(0, 3), "triple", 3, rank);
      if (phoenix && group.length >= 2) add([group[0], group[1], "PHOENIX"], "triple", 3, rank);
    }
  } else if (current.type === "full-house") {
    const triples = [];
    for (const rank of ranks) {
      const group = rankMap.get(rank);
      if (rank <= current.rank) continue;
      if (group.length >= 3) triples.push({ rank, cards: group.slice(0, 3), phoenixUsed: false });
      if (phoenix && group.length === 2) triples.push({ rank, cards: [group[0], group[1], "PHOENIX"], phoenixUsed: true });
    }
    for (const triple of triples) {
      for (const rank of ranks) {
        if (rank === triple.rank) continue;
        const group = rankMap.get(rank);
        if (group.length >= 2) add([...triple.cards, ...group.slice(0, 2)], "full-house", 5, triple.rank);
        else if (phoenix && !triple.phoenixUsed && group.length === 1) add([...triple.cards, group[0], "PHOENIX"], "full-house", 5, triple.rank);
      }
    }
  } else if (current.type === "straight") {
    const length = current.count;
    for (let high = Math.max(length, current.rank + 1); high <= 14; high++) {
      const low = high - length + 1;
      if (low < 1) continue;
      const cards = [];
      let missing = 0;
      let missingRank = null;
      for (let rank = low; rank <= high; rank++) {
        if (rank === 1) {
          if (hand.includes("MAHJONG")) cards.push("MAHJONG");
          else { missing++; missingRank = 1; }
        } else {
          const group = rankMap.get(rank);
          if (group && group.length) cards.push(group[0]);
          else { missing++; missingRank = rank; }
        }
      }
      if (missing === 0) add(cards, "straight", length, high);
      else if (missing === 1 && phoenix && missingRank !== 1) add([...cards, "PHOENIX"], "straight", length, high);
    }
  } else if (current.type === "pair-run") {
    const pairs = current.count / 2;
    for (let high = Math.max(pairs + 1, current.rank + 1); high <= 14; high++) {
      const low = high - pairs + 1;
      const cards = [];
      let missing = 0;
      for (let rank = low; rank <= high; rank++) {
        const group = rankMap.get(rank) || [];
        if (group.length >= 2) cards.push(group[0], group[1]);
        else if (group.length === 1) { cards.push(group[0]); missing++; }
        else missing += 2;
      }
      if (missing === 0) add(cards, "pair-run", current.count, high);
      else if (missing === 1 && phoenix) add([...cards, "PHOENIX"], "pair-run", current.count, high);
    }
  }

  // Bombs can always overtake a non-bomb, and a higher bomb can overtake a bomb.
  if (current.type !== "bomb-straight-flush") {
    for (const rank of ranks) {
      const group = rankMap.get(rank);
      if (group.length === 4) add(group.slice(0, 4), "bomb-four", 4, rank, true);
    }
  }
  for (const cards of straightFlushRuns(hand)) {
    const combo = classifyCombo(cards);
    if (combo && combo.bomb && canBeat(combo, current)) out.push({ ...combo, cards: cards.slice() });
  }
  return out;
}

function straightFlushRuns(hand) {
  const bySuit = new Map(SUITS.map(suit => [suit.id, new Map()]));
  for (const card of hand) {
    if (card.length !== 2 || !SUITS.some(suit => suit.id === card[1])) continue;
    const rank = standardRank(card);
    if (rank) bySuit.get(card[1]).set(rank, card);
  }
  const runs = [];
  for (const rankMap of bySuit.values()) {
    let run = [];
    for (let rank = 2; rank <= 14; rank++) {
      const card = rankMap.get(rank);
      if (card) run.push(card);
      else run = [];
      if (run.length >= 5) runs.push(run.slice());
    }
  }
  return runs;
}

function leadCandidateGroups(hand) {
  const { rankMap, ranks, phoenix } = makeHandIndex(hand);
  const groups = [];
  const add = cards => {
    const combo = classifyCombo(cards);
    if (combo) groups.push({ ...combo, cards: cards.slice() });
  };

  // Longest straights: all top-length windows (and one shorter) with no gaps.
  const maxLen = Math.min(8, hand.length);
  for (let length = maxLen; length >= 5; length--) {
    let found = 0;
    for (let low = 1; low + length - 1 <= 14; low++) {
      const high = low + length - 1;
      if (low === 1 && !hand.includes("MAHJONG")) continue;
      const cards = [];
      let missing = 0;
      for (let rank = low; rank <= high; rank++) {
        if (rank === 1) { cards.push("MAHJONG"); continue; }
        const group = rankMap.get(rank);
        if (group && group.length) cards.push(group[0]);
        else missing++;
      }
      if (missing === 0) { add(cards); found++; if (found >= 3) break; }
      else if (missing === 1 && phoenix) { add([...cards, "PHOENIX"]); found++; if (found >= 3) break; }
    }
    if (found) break;
  }

  // Longest pair runs.
  for (let pairs = Math.min(5, Math.floor(hand.length / 2)); pairs >= 2; pairs--) {
    let found = false;
    for (let low = 2; low + pairs - 1 <= 14; low++) {
      const high = low + pairs - 1;
      const cards = [];
      let missing = 0;
      for (let rank = low; rank <= high; rank++) {
        const group = rankMap.get(rank) || [];
        if (group.length >= 2) cards.push(group[0], group[1]);
        else if (group.length === 1) { cards.push(group[0]); missing++; }
        else missing += 2;
      }
      if (missing === 0) { add(cards); found = true; break; }
      if (missing === 1 && phoenix) { add([...cards, "PHOENIX"]); found = true; break; }
    }
    if (found) break;
  }

  // Best full house.
  let triple = null;
  for (const rank of ranks) {
    const group = rankMap.get(rank);
    if (group.length >= 3) { triple = { rank, cards: group.slice(0, 3), used: false }; }
  }
  if (!triple && phoenix) {
    for (const rank of ranks) {
      const group = rankMap.get(rank);
      if (group.length === 2) { triple = { rank, cards: [group[0], group[1], "PHOENIX"], used: true }; break; }
    }
  }
  if (triple) {
    for (const rank of ranks) {
      if (rank === triple.rank) continue;
      const group = rankMap.get(rank);
      if (group.length >= 2) { add([...triple.cards, ...group.slice(0, 2)]); break; }
      if (phoenix && !triple.used && group.length === 1) { add([...triple.cards, group[0], "PHOENIX"]); break; }
    }
  }

  for (const rank of ranks) {
    const group = rankMap.get(rank);
    if (group.length >= 3) add(group.slice(0, 3));
    if (group.length >= 2) add(group.slice(0, 2));
  }
  for (const card of hand) groups.push(makeSingle(card));

  // Bombs are only worth leading when the hand is nearly gone.
  if (hand.length <= 6) {
    for (const rank of ranks) {
      const group = rankMap.get(rank);
      if (group.length === 4) add(group.slice(0, 4));
    }
    for (const cards of straightFlushRuns(hand)) add(cards);
  }
  return groups;
}

function leadCost(combo) {
  let cost = 0;
  for (const card of combo.cards) {
    if (card === "DRAGON") cost += 9;
    else if (card === "PHOENIX") cost += 6;
    else if (card === "MAHJONG") cost += 1;
    else if (card === "DOG") cost += 3;
    else if (card[0] === "A") cost += 2;
    else if (card[0] === "K") cost += 1;
  }
  return cost;
}

function chooseSimulationLead(hands, seat) {
  const hand = hands[seat];
  if (!hand.length) return null;
  if (hand.length === 1) return makeSingle(hand[0]);

  const partner = PARTNER_OF[seat];
  if (hand.includes("DOG") && hands[partner] && hands[partner].length > 0 && hands[partner].length <= 2) {
    return makeSingle("DOG");
  }

  let best = null;
  let bestScore = -Infinity;
  for (const combo of leadCandidateGroups(hand)) {
    if (combo.dog && !(hand.length === 1)) continue;
    let score = combo.count * 10 - combo.rank * 0.25 - leadCost(combo);
    if (combo.bomb) score -= hand.length <= 4 ? 0 : 25;
    if (score > bestScore) { best = combo; bestScore = score; }
  }
  return best || makeSingle(hand[0]);
}

function chooseSimulationReply(hands, seat, current, owner) {
  const hand = hands[seat];
  const replies = generateRepliesForType(hand, current);
  if (!replies.length) return null;
  const partnerOwner = owner === PARTNER_OF[seat];
  if (partnerOwner) {
    // Going out immediately is worth taking the lead from the partner.
    return replies.find(combo => combo.cards.length === hand.length) || null;
  }

  const opponents = OPPONENTS_OF[seat].filter(other => hands[other] && hands[other].length > 0);
  const minOpponent = opponents.length
    ? Math.min(...opponents.map(other => hands[other].length))
    : 0;
  const urgent = minOpponent <= 2;

  let best = null;
  let bestCost = Infinity;
  let bestBomb = null;
  let bestBombCost = Infinity;
  for (const combo of replies) {
    const cost = combo.rank * 0.2 + leadCost(combo);
    if (combo.bomb) {
      if (cost < bestBombCost) { bestBomb = combo; bestBombCost = cost; }
    } else if (cost < bestCost) {
      best = combo;
      bestCost = cost;
    }
  }
  if (best) {
    // Do not spend a top control card on a low single while the hand is long.
    if (current.type === "single" && current.rank < 12 && hand.length > 6 && leadCost(best) >= 6 && !urgent) {
      return null;
    }
    return best;
  }
  if (!bestBomb) return null;
  if (urgent || current.bomb || hand.length <= 5) return bestBomb;
  return null;
}

function simulateOne(myHand, opponents, startSeat) {
  const hands = {
    ME: myHand.slice(),
    L: opponents.L.slice(),
    P: opponents.P.slice(),
    R: opponents.R.slice()
  };
  const finished = [];
  let current = null;
  let owner = null;
  let lastPlay = null;
  let passes = 0;
  let turn = startSeat;
  let guard = 0;

  const endTrick = () => {
    let lead = null;
    if (lastPlay && lastPlay.dog) {
      const partner = PARTNER_OF[owner];
      lead = hands[partner] && hands[partner].length ? partner : nextActiveSeat(hands, owner);
    } else if (lastPlay && lastPlay.type === "single" && lastPlay.cards.includes("DRAGON")) {
      const options = OPPONENTS_OF[owner].filter(other => hands[other] && hands[other].length > 0);
      options.sort((a, b) => hands[b].length - hands[a].length);
      lead = options[0] || nextActiveSeat(hands, owner);
    } else {
      lead = hands[owner] && hands[owner].length ? owner : nextActiveSeat(hands, owner);
    }
    current = null;
    owner = null;
    lastPlay = null;
    passes = 0;
    if (lead) turn = lead;
    return lead;
  };

  while (guard++ < 500) {
    if (!hands[turn] || hands[turn].length === 0) {
      const next = nextActiveSeat(hands, turn);
      if (!next) break;
      turn = next;
      continue;
    }
    if (finished.length >= 3) break;

    if (!current) {
      const lead = chooseSimulationLead(hands, turn);
      if (!lead) break;
      removeCards(hands[turn], lead.cards);
      current = lead;
      owner = turn;
      lastPlay = lead;
      passes = 0;
      if (hands[turn].length === 0) finished.push(turn);
      if (lead.dog) {
        endTrick();
        continue;
      }
      const next = nextActiveSeat(hands, turn);
      if (!next) break;
      turn = next;
      continue;
    }

    const reply = chooseSimulationReply(hands, turn, current, owner);
    if (reply) {
      removeCards(hands[turn], reply.cards);
      current = reply;
      owner = turn;
      lastPlay = reply;
      passes = 0;
      if (hands[turn].length === 0) finished.push(turn);
      const next = nextActiveSeat(hands, turn);
      if (!next) break;
      turn = next;
      continue;
    }

    passes++;
    const active = TURN_ORDER.filter(seat => hands[seat] && hands[seat].length > 0);
    const ownerActive = owner && hands[owner] && hands[owner].length > 0;
    const needed = ownerActive ? active.length - 1 : active.length;
    if (passes >= Math.max(1, needed)) {
      if (!endTrick()) break;
      continue;
    }
    const next = nextActiveSeat(hands, turn);
    if (!next) break;
    turn = next;
  }

  for (const seat of TURN_ORDER) {
    if (!finished.includes(seat)) finished.push(seat);
  }
  return finished;
}

function shuffleInPlace(cards, random) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function knownSeatCards(context) {
  const known = { L: new Set(), P: new Set(), R: new Set() };
  if (!context || !context.knownBySeat) return known;
  for (const seat of ["L", "P", "R"]) {
    const cards = context.knownBySeat.get(seat);
    if (cards) for (const card of cards) known[seat].add(card);
  }
  return known;
}

function buildDeals(options, random) {
  const { hand, context, mode } = options;
  const deals = [];
  const samples = options.samples || 64;
  const known = knownSeatCards(context);
  const fixed = new Set([...known.L, ...known.P, ...known.R]);
  const pool = ALL_CARDS.filter(card => !hand.includes(card) && !fixed.has(card));

  if (mode === "grand") {
    for (let sample = 0; sample < samples; sample++) {
      const shuffled = shuffleInPlace(pool.slice(), random);
      const mine = [...hand, ...shuffled.slice(0, 6)];
      const opponents = { L: [...known.L], P: [...known.P], R: [...known.R] };
      let cursor = 6;
      for (const seat of ["L", "P", "R"]) {
        while (opponents[seat].length < 14 && cursor < shuffled.length) opponents[seat].push(shuffled[cursor++]);
      }
      deals.push({ myHand: mine, opponents });
    }
    return deals;
  }

  if (mode === "tichu") {
    for (let sample = 0; sample < samples; sample++) {
      const shuffled = shuffleInPlace(pool.slice(), random);
      const opponents = { L: [...known.L], P: [...known.P], R: [...known.R] };
      let cursor = 0;
      for (const seat of ["L", "P", "R"]) {
        while (opponents[seat].length < 14 && cursor < shuffled.length) opponents[seat].push(shuffled[cursor++]);
      }
      deals.push({ myHand: hand.slice(), opponents });
    }
    return deals;
  }

  // Mid-hand: sample opponents from the reconciled ledger.
  const worldData = worldsFor(context, Math.max(48, Math.min(200, samples * 2)));
  if (!worldData) return [];
  for (let sample = 0; sample < samples; sample++) {
    const world = worldData.worlds[sample % worldData.worlds.length];
    deals.push({
      myHand: hand.slice(),
      opponents: {
        L: [...world.L],
        P: [...world.P],
        R: [...world.R]
      }
    });
  }
  return deals;
}

function randomStartSeat(hand, opponents, context, random) {
  if (hand.includes("MAHJONG")) return "ME";
  if (context && context.knownOwner && context.knownOwner.get("MAHJONG")) {
    return context.knownOwner.get("MAHJONG");
  }
  for (const seat of ["L", "P", "R"]) {
    if (opponents[seat] && opponents[seat].includes("MAHJONG")) return seat;
  }
  return TURN_ORDER[Math.floor(random() * 4)];
}

const simulationCache = new Map();
const SIMULATION_CACHE_LIMIT = 8;
function resolveDogHandoffContext(actionContext, isOurTurn, ledger = {}) {
  const context = actionContext || { tableCards: [], currentCombo: null, actor: null, actionText: "" };
  const oneCardDog = context.currentCombo && context.currentCombo.dog &&
    Array.isArray(context.tableCards) && context.tableCards.length === 1 && context.tableCards[0] === "DOG";
  if (!oneCardDog) return { ...context, dogHandoff: false };

  const actorKey = context.actor && context.actor.key;
  // The Dog ends the trick immediately and gives the next lead to the Dog
  // player's partner. Prefer explicit actor evidence; if actor parsing fails,
  // use local history to avoid mistaking our own recently played Dog for a
  // teammate handoff.
  const tradedOut = ledger.tradedOut instanceof Map ? ledger.tradedOut : new Map();
  const everInHand = ledger.everInHand instanceof Set ? ledger.everInHand : new Set();
  const knownDogTradeTarget = tradedOut.get("DOG") || null;
  const likelyOurOwnDog = everInHand.has("DOG") && !knownDogTradeTarget;
  const knownOpponentDog = knownDogTradeTarget === "L" || knownDogTradeTarget === "R";
  if (isOurTurn && actorKey === "P") {
    return { ...context, tableCards: [], currentCombo: null, dogHandoff: true };
  }
  if (isOurTurn && actorKey == null && !likelyOurOwnDog && !knownOpponentDog) {
    return { ...context, tableCards: [], currentCombo: null, dogHandoff: true };
  }
  return { ...context, dogHandoff: false };
}

function clearProbabilityCaches() {
  worldCache.clear();
  threatCache.clear();
  presenceCache.clear();
  simulationCache.clear();
  ownershipCache.clear();
}

/**
 * Estimate finish probabilities with a heuristic playout:
 *  - opponents' hands are sampled from the reconciled ledger;
 *  - every seat follows a deterministic "shed long combinations, keep control
 *    cards, feed a nearly-out partner" policy;
 *  - Dragon/Dog/Phoenix/bombs are modelled, Mahjong wishes are not.
 *
 * The result is an approximation of strength, not a solved game. It is most
 * useful for comparing candidate Tichu calls and for spotting when a hand is
 * much stronger or weaker than the table.
 */
function simulateRound(options = {}) {
  const hand = [...new Set(options.hand || [])].filter(card => CARD_SET.has(card));
  const mode = options.mode || "mid";
  const samples = Math.max(16, Math.min(160, options.samples || 64));
  if (!hand.length) return null;
  const seed = options.seed !== undefined
    ? options.seed
    : hashText(`${mode}|${hand.slice().sort().join(",")}|${options.context ? options.context.signature : ""}|${samples}`);
  const cacheKey = `${seed}|${samples}|${mode}|${hand.slice().sort().join(",")}`;
  if (simulationCache.has(cacheKey)) return simulationCache.get(cacheKey);

  const random = makeSeededRandom(seed);
  const deals = buildDeals({ ...options, hand, mode, samples }, random);
  if (!deals.length) return null;

  const firstCounts = { ME: 0, L: 0, P: 0, R: 0 };
  const positionCounts = { ME: [0, 0, 0, 0], L: [0, 0, 0, 0], P: [0, 0, 0, 0], R: [0, 0, 0, 0] };
  let doubleWins = 0;
  for (const deal of deals) {
    const startSeat = randomStartSeat(deal.myHand, deal.opponents, options.context, random);
    const order = simulateOne(deal.myHand, deal.opponents, startSeat);
    firstCounts[order[0]]++;
    if ((order[0] === "ME" && order[1] === "P") || (order[0] === "P" && order[1] === "ME")) doubleWins++;
    for (const seat of TURN_ORDER) {
      const position = order.indexOf(seat);
      if (position >= 0) positionCounts[seat][position]++;
    }
  }

  const total = deals.length;
  const result = {
    mode,
    samples: total,
    first: firstCounts.ME / total,
    partnerFirst: firstCounts.P / total,
    teamFirst: (firstCounts.ME + firstCounts.P) / total,
    doubleWin: doubleWins / total,
    meLast: positionCounts.ME[3] / total,
    expectedPosition: [0, 1, 2, 3].reduce((sum, index) => sum + (index + 1) * positionCounts.ME[index], 0) / total,
    positions: positionCounts,
    interval: wilsonInterval(firstCounts.ME, total),
    teamInterval: wilsonInterval(firstCounts.ME + firstCounts.P, total),
    finishOrderCounts: firstCounts
  };
  if (simulationCache.size >= SIMULATION_CACHE_LIMIT) simulationCache.delete(simulationCache.keys().next().value);
  simulationCache.set(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// Advisor heuristics
// ---------------------------------------------------------------------------

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
    if (card.length === 2 && ASC_RANKS.includes(card[0]) && /[2-9TJQKA]/.test(card[0])) {
      allRanks.set(card[0], (allRanks.get(card[0]) || 0) + 1);
    }
  }
  for (const card of candidate.cards) {
    if (card.length === 2 && allRanks.get(card[0]) >= 2) {
      const stillSameRank = [...remaining].filter(other => other[0] === card[0]).length;
      if (stillSameRank === 1 && candidate.count === 1) penalty += 2.2;
    }
  }
  return penalty;
}

function scoreLeadCandidate(candidate, hand, plan, counts) {
  const specialCost = candidate.cards.reduce((sum, card) => sum + getPointPenalty(card), 0);
  const groupPenalty = breaksUsefulGroup(candidate, hand);
  let score = candidate.count * 6 - specialCost - groupPenalty - Math.max(0, candidate.rank) * 0.025;
  if (candidate.bomb) score -= 12;
  if (candidate.dog) score += 2;
  if (candidate.dog && counts && Number.isFinite(counts.P) && counts.P > 0 && counts.P <= 2) score += counts.P <= 1 ? 40 : 20;
  if (candidate.dog && counts && counts.P === 0) score -= 10;
  if (plan && plan.groups) {
    const key = candidate.cards.slice().sort().join(",");
    if (plan.groups.some(group => group.cards.slice().sort().join(",") === key)) score += 2.5;
  }
  return score;
}

function scoreReplyCandidate(candidate, current, hand, opponentNearlyOut) {
  const specialCost = candidate.cards.reduce((sum, card) => sum + getPointPenalty(card), 0);
  const bombCost = candidate.bomb ? 12 : 0;
  const groupPenalty = breaksUsefulGroup(candidate, hand);
  const controlBonus = opponentNearlyOut ? 18 : 0;
  return candidate.count * 5 + controlBonus - specialCost - bombCost - groupPenalty - candidate.rank * 0.08;
}

function chooseWithThreat(candidates, heuristicScore, context, limit = 4) {
  if (!candidates.length) return null;
  const finalists = candidates.slice().sort((a, b) => heuristicScore(b) - heuristicScore(a)).slice(0, limit);
  let chosen = null;
  let chosenScore = -Infinity;
  for (const candidate of finalists) {
    const baseline = heuristicScore(candidate);
    const threat = evaluateComboThreat(candidate, context);
    candidate._trackerThreat = threat;
    // Team-aware: only opponents beating the play costs us the trick. A
    // partner who can beat it is not a threat.
    const adjustment = threat && !candidate.dog ? (threat.probability - 0.5) * 12 : 0;
    const score = baseline + adjustment;
    if (score > chosenScore) {
      chosen = candidate;
      chosenScore = score;
    }
  }
  return chosen;
}

function hasOpponentNearlyOut(counts) {
  return ACTIVE_OPPONENTS.some(key => Number.isFinite(counts && counts[key]) && counts[key] === 1);
}

function candidateContainsWish(candidate, wishRank) {
  return Boolean(wishRank && candidate.cards.some(card =>
    card.length === 2 && card[0] === wishRank
  ));
}

function confidenceLabel(context, threat) {
  if (!context || !context.consistent) return "low — incomplete card ledger";
  if (!threat || threat.samples < 24) return "low — insufficient simulation data";
  if (threat.constrained) return "moderate — uniform deal plus pass evidence";
  return "moderate — uniform-deal model";
}

/**
 * Structured recommendation used by the compact HUD.
 * Returns the action, the cards, a one-line reason, chips and expandable detail.
 */
function getRecommendation(input = {}) {
  const {
    hand = [], tableCards = [], currentCombo = null, actor = null, counts = {},
    isOurTurn = false, tradingActive = false, wishRank = null, context = null,
    plan = null, dogHandoff = false, presence = null, declarationAdvice = null
  } = input;

  const wait = (action, title, reason, details, tone = "neutral") => ({
    action, title, reason, details, tone, cards: [], combo: null, chips: []
  });

  if (tradingActive) {
    return wait(
      "WAIT",
      "Trade phase",
      "Finish the exchange first.",
      "Trade selections are provisional until DoD completes the exchange. The recommendation resumes as soon as the hand is stable.",
      "neutral"
    );
  }

  if (declarationAdvice && declarationAdvice.stage === "grand-tichu") {
    const chips = [];
    if (Number.isFinite(declarationAdvice.probability)) {
      chips.push({
        label: "Finish 1st",
        value: percent(declarationAdvice.probability),
        title: "Simulated chance to finish first from these eight cards plus a random six-card completion.",
        tone: declarationAdvice.probability >= 0.55 ? "good" : declarationAdvice.probability >= 0.45 ? "warn" : "neutral"
      });
    }
    chips.push({
      label: "Hand index",
      value: `${declarationAdvice.score}/100`,
      title: "Heuristic strength index used as a fallback when simulation is unavailable."
    });
    return {
      action: "DECIDE",
      headline: Number.isFinite(declarationAdvice.probability)
        ? `${percent(declarationAdvice.probability)} to finish first`
        : `Hand index ${declarationAdvice.score}/100`,
      title: declarationAdvice.title,
      reason: "Grand Tichu is decided now, before the remaining six cards are dealt.",
      details: declarationAdvice.details,
      tone: declarationAdvice.tone || "neutral",
      cards: [],
      combo: null,
      chips
    };
  }
  if (!isOurTurn) {
    return {
      ...wait(
        "WAIT",
        "Waiting for your turn",
        "Tracking continues in the background.",
        "Probabilities update as public cards appear. Advice is heuristic, not perfect-information play.",
        "neutral"
      ),
      chips: buildDefaultChips(plan, presence)
    };
  }
  if (dogHandoff) {
    return wait(
      "LEAD",
      "Lead after the Dog",
      "Your partner handed you the lead.",
      "The Dog ended the previous trick and transferred the lead to you. Choose a fresh lead; there is nothing to beat.",
      "good"
    );
  }
  if (!hand.length) {
    return wait("WAIT", "No hand detected", "Waiting for a stable deal.", "Check whether DoD finished dealing or whether the hand selector changed.", "warn");
  }

  const opponentNearlyOut = hasOpponentNearlyOut(counts);
  const candidates = generateCombos(new Set(hand))
    .map(combo => combo.phoenixSingle && currentCombo && currentCombo.type === "single"
      ? { ...combo, rank: currentCombo.rank + 0.5 }
      : combo);

  if (!tableCards.length) {
    let leads = candidates.slice();
    const wishLeads = wishRank ? leads.filter(candidate => candidateContainsWish(candidate, wishRank)) : [];
    const satisfyingWish = wishLeads.length > 0;
    if (satisfyingWish) leads = wishLeads;
    if (!leads.length) {
      return wait("WAIT", "No legal lead found", "The visible hand did not produce a combination.", "This usually means the board is mid-animation.", "warn");
    }
    const chosen = chooseWithThreat(leads, candidate => scoreLeadCandidate(candidate, hand, plan, counts), context);
    const threat = chosen && !chosen.dog ? chosen._trackerThreat : null;
    const chips = buildChips({ threat, plan, presence, counts });
    const wishText = satisfyingWish
      ? ` It also satisfies the ${rankNameFromValue(ASC_RANKS.indexOf(wishRank) + 2)} wish.`
      : "";
    const alternatives = leads
      .filter(item => item !== chosen)
      .slice(0, 2)
      .map(item => displayCards(item.cards))
      .join("; ");
    const details = [
      threat ? `Sampled estimate: ${percent(threat.probability)} of deals had no opponent able to beat this lead.` : "Threat estimate unavailable because the ledger does not reconcile.",
      threat && threat.partnerBeat > 0.05 ? `Your partner can also beat it in ${percent(threat.partnerBeat)} of deals.` : "",
      `The play sheds ${chosen.count} card${chosen.count === 1 ? "" : "s"} and is part of a ${plan ? plan.plays : "?"}-play plan.`,
      alternatives ? `Alternatives: ${alternatives}.` : "",
      `Confidence: ${confidenceLabel(context, threat)}.`
    ].filter(Boolean).join(" ");
    return {
      action: "LEAD",
      title: `Lead ${displayCards(chosen.cards)}`,
      reason: `${comboLabel(chosen)}.${chosen.dog ? " The Dog hands the lead to your partner." : ""}${wishText}`,
      details,
      tone: threat && threat.probability < 0.25 ? "warn" : "good",
      cards: chosen.cards,
      combo: chosen,
      chips
    };
  }

  if (!currentCombo) {
    return wait(
      "WAIT",
      "Unclear table play",
      `Detected ${displayCards(tableCards)}, but the combination is not recognised.`,
      "The tracker will not guess a legal reply while DoD may still be animating the board.",
      "warn"
    );
  }

  const partnerWinning = actor && actor.key === "P";
  let replies = candidates
    .filter(candidate => canBeat(candidate, currentCombo))
    .map(candidate => candidate.phoenixSingle && currentCombo.type === "single"
      ? { ...candidate, rank: currentCombo.rank + 0.5 }
      : candidate);
  const wishReplies = wishRank ? replies.filter(candidate => candidateContainsWish(candidate, wishRank)) : [];
  const satisfyingWish = wishReplies.length > 0;
  if (satisfyingWish) replies = wishReplies;

  if (partnerWinning && !satisfyingWish) {
    return {
      action: "PASS",
      title: "Pass — partner is winning",
      reason: "Your partner holds the trick; there is no reason to take it away.",
      details: "Passing preserves the team lead. Overtake only if you can go out this turn or the partner's position is at risk.",
      tone: "good",
      cards: [],
      combo: null,
      chips: buildChips({ threat: null, plan, presence, counts })
    };
  }

  if (!replies.length) {
    return {
      action: "PASS",
      title: `Pass — nothing beats ${comboLabel(currentCombo)}`,
      reason: `No matching higher combination or bomb was found for ${displayCards(tableCards)}.`,
      details: "Passing is free. The tracker re-evaluates as soon as the board changes.",
      tone: "neutral",
      cards: [],
      combo: null,
      chips: buildChips({ threat: null, plan, presence, counts })
    };
  }

  // Bombs are a scarce resource. Do not spend one on a trick that an ordinary
  // reply can win; only widen the pool when there is no normal reply, the
  // table play is already a bomb, or an opponent is one card from going out.
  const nonBombReplies = replies.filter(candidate => !candidate.bomb);
  const allowBomb = currentCombo.bomb || opponentNearlyOut || nonBombReplies.length === 0;
  const replyPool = allowBomb ? replies : nonBombReplies;
  const chosen = chooseWithThreat(
    replyPool,
    candidate => scoreReplyCandidate(candidate, currentCombo, hand, opponentNearlyOut),
    context
  );
  const threat = chosen && chosen._trackerThreat;
  const alternatives = replies.filter(item => item !== chosen).slice(0, 2).map(item => displayCards(item.cards)).join("; ");
  const reason = satisfyingWish
    ? `Beats ${comboLabel(currentCombo)} and satisfies the ${rankNameFromValue(ASC_RANKS.indexOf(wishRank) + 2)} wish.`
    : chosen.bomb
      ? `Bomb used to take control${opponentNearlyOut ? " while an opponent is nearly out" : ""}.`
      : `Cheapest beating play against ${comboLabel(currentCombo)}.`;
  const details = [
    threat ? `Sampled estimate: ${percent(threat.probability)} of deals had no opponent able to beat this reply.` : "Threat estimate unavailable while the ledger is inconsistent.",
    threat && threat.partnerBeat > 0.05 ? `Your partner can also beat it in ${percent(threat.partnerBeat)} of deals.` : "",
    opponentNearlyOut ? "An opponent is down to one card, so control is weighted more heavily." : "",
    alternatives ? `Alternatives: ${alternatives}.` : "",
    `Confidence: ${confidenceLabel(context, threat)}.`
  ].filter(Boolean).join(" ");
  return {
    action: "PLAY",
    title: `Play ${displayCards(chosen.cards)}`,
    reason,
    details,
    tone: chosen.bomb ? "warn" : (threat && threat.probability < 0.25 ? "warn" : "good"),
    cards: chosen.cards,
    combo: chosen,
    chips: buildChips({ threat, plan, presence, counts })
  };
}

function buildChips({ threat, plan, presence, counts }) {
  const chips = [];
  if (plan) {
    chips.push({
      label: "Plan",
      value: `${plan.plays} play${plan.plays === 1 ? "" : "s"}`,
      title: plan.exact
        ? "Minimum number of legal plays needed to empty this hand."
        : "Greedy estimate of the number of plays needed (search budget reached)."
    });
  }
  if (threat) {
    chips.push({
      label: "Hold trick",
      value: percent(threat.probability),
      title: `Probability that neither opponent can beat this play (${threat.samples} sampled deals).`,
      tone: threat.probability < 0.35 ? "warn" : "good"
    });
  }
  if (presence) {
    const bomb = Math.max(presence.seats.L.bomb.probability, presence.seats.R.bomb.probability);
    chips.push({
      label: "Opp bomb",
      value: percent(bomb),
      title: "Chance that at least one opponent currently holds a bomb.",
      tone: bomb > 0.35 ? "warn" : "neutral"
    });
  }
  return chips.slice(0, 3);
}

function buildDefaultChips(plan, presence) {
  const chips = [];
  if (plan) chips.push({ label: "Plan", value: `${plan.plays} plays`, title: "Minimum plays to empty your hand." });
  if (presence) {
    const bomb = Math.max(presence.seats.L.bomb.probability, presence.seats.R.bomb.probability);
    chips.push({ label: "Opp bomb", value: percent(bomb), title: "Chance at least one opponent holds a bomb." });
  }
  return chips;
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
    else if (card.length === 2 && /[2-9TJQKA]/.test(card[0])) {
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
  const aceCount = hand.filter(card => card[0] === "A" && card.length === 2).length;
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
  const simulation = context.simulation || null;

  const unavailable = (title, details, tone = "neutral") => ({
    stage: null, score: null, tone, title, details, probability: null, simulated: false
  });
  if (tradingActive) {
    return unavailable(
      "Wait for trading to finish",
      "The hand is changing during the exchange; wait for a stable 8-card or 14-card hand before evaluating a call.",
      "warn"
    );
  }

  let stage;
  if (handCount === 8 && playedCount === 0 && tradedOutCount === 0) stage = "grand-tichu";
  else if (handCount === 14 && myPlayedCount === 0) stage = "tichu";
  else if (myPlayedCount > 0) {
    return unavailable("Declaration window closed", "Tichu must be called before your first play.");
  } else {
    return unavailable(
      "Declaration window not open",
      "Grand Tichu is evaluated on the initial eight cards; Tichu on all 14 before your first play."
    );
  }

  const metrics = declarationHandMetrics(cards);
  const grand = stage === "grand-tichu";
  const label = grand ? "Grand Tichu" : "Tichu";
  const probability = simulation ? simulation.first : null;

  // The simulation is a stronger signal than the hand index because it also
  // accounts for the partner and the sampled opponents. Fall back to the index
  // when the playout is unavailable.
  const callThreshold = grand ? 0.55 : 0.53;
  const borderlineThreshold = grand ? 0.45 : 0.43;
  let action;
  let tone;
  if (Number.isFinite(probability)) {
    if (probability >= callThreshold) { action = "CALL CANDIDATE"; tone = "good"; }
    else if (probability >= borderlineThreshold) { action = "BORDERLINE — lean pass"; tone = "warn"; }
    else { action = "DO NOT CALL"; tone = "neutral"; }
  } else {
    const callScore = grand ? 68 : 65;
    const borderlineScore = grand ? 55 : 52;
    if (metrics.score >= callScore) { action = "CALL CANDIDATE"; tone = "good"; }
    else if (metrics.score >= borderlineScore) { action = "BORDERLINE — lean pass"; tone = "warn"; }
    else { action = "DO NOT CALL"; tone = "neutral"; }
  }

  const controlLabels = metrics.controls.filter(name => name !== "Ace");
  if (metrics.aceCount) controlLabels.push(`${metrics.aceCount} Ace${metrics.aceCount === 1 ? "" : "s"}`);
  const controls = controlLabels.length ? controlLabels.join(", ") : "no Dragon, Phoenix, or Ace";
  const structure = [
    metrics.pairedRanks ? `${metrics.pairedRanks} paired rank${metrics.pairedRanks === 1 ? "" : "s"}` : "no pairs",
    metrics.longestRun >= 5 ? `rank run of ${metrics.longestRun}` : null,
    metrics.weakLooseCards ? `${metrics.weakLooseCards} weak low card${metrics.weakLooseCards === 1 ? "" : "s"}` : null
  ].filter(Boolean).join("; ");
  const oddsText = Number.isFinite(probability)
    ? `Simulated chance to finish first: ${percent(probability)} (${simulation.samples} playouts). `
    : `Hand index ${metrics.score}/100. `;
  const timing = grand
    ? "Grand Tichu is +200 if you finish first and −200 otherwise."
    : "Tichu is +100 if you finish first and −100 otherwise.";
  return {
    stage,
    score: metrics.score,
    probability,
    simulated: Number.isFinite(probability),
    tone,
    title: `${label}: ${action}${Number.isFinite(probability) ? ` · ${percent(probability)}` : ` · index ${metrics.score}/100`}`,
    details: `${oddsText}Control: ${controls}. Structure: ${structure}. ${timing} The playout uses a heuristic policy, so treat the number as a strength estimate.`,
    metrics
  };
}

function getDragonGiftAdvice(counts, calledSeats = new Map()) {
  const leftCount = counts && counts.L;
  const rightCount = counts && counts.R;
  const unavailable = (title, details, tone = "neutral") => ({ seat: null, tone, title, details });
  if (!Number.isFinite(leftCount) || !Number.isFinite(rightCount) || leftCount < 0 || rightCount < 0) {
    return unavailable(
      "Dragon gift: waiting for both counts",
      "The adviser needs reliable Left and Right remaining-card counts and will not guess one."
    );
  }
  if (leftCount === 0 && rightCount === 0) {
    return unavailable("Dragon gift: no active opponents", "Both opponent counts are zero; the round may be ending.", "warn");
  }

  if (leftCount !== rightCount) {
    const seat = leftCount > rightCount ? "L" : "R";
    const label = seat === "L" ? "Left" : "Right";
    const chosenCount = seat === "L" ? leftCount : rightCount;
    const otherCount = seat === "L" ? rightCount : leftCount;
    const callType = calledSeats && calledSeats.get ? calledSeats.get(seat) : null;
    return {
      seat,
      tone: "good",
      title: `Dragon gift: ${label}`,
      details: `${label} has ${chosenCount} cards vs ${otherCount}. Give the trick to the opponent who is furthest from going out.${callType ? ` They have an observed ${callType === "grand" ? "Grand Tichu" : "Tichu"} call — a warning, but card count is the primary rule of thumb.` : ""}`
    };
  }

  const leftCalled = Boolean(calledSeats && calledSeats.has && calledSeats.has("L"));
  const rightCalled = Boolean(calledSeats && calledSeats.has && calledSeats.has("R"));
  if (leftCalled !== rightCalled) {
    const seat = leftCalled ? "R" : "L";
    const label = seat === "L" ? "Left" : "Right";
    return {
      seat,
      tone: "warn",
      title: `Dragon gift: lean ${label}`,
      details: `Both opponents have ${leftCount} cards. A Tichu call was observed for ${leftCalled ? "Left" : "Right"}, so the heuristic leans to the other opponent.`
    };
  }
  return unavailable(
    "Dragon gift: no clear favourite",
    `Both opponents have ${leftCount} cards. Either recipient is reasonable; captured-point totals are not available.`
  );
}

const PROBABILITY_API = {
  DEFAULT_WORLDS, MAX_WORLDS, PRESENCE_KINDS, PRESENCE_LABELS, PRESENCE_PROBES,
  buildProbabilityContext, cardProbability, probabilityOfAny, probabilityAtLeastOneAbove,
  worldsSatisfyPasses, sampleHiddenHands, worldsFor,
  evaluateComboThreat, estimateSeatsCanBeat, estimateNoResponseProbability,
  comboPresence, comboTypeAvailable,
  simulateRound, simulateOne, chooseSimulationLead, chooseSimulationReply,
  buildDeals, knownSeatCards,
  getPointPenalty, breaksUsefulGroup, scoreLeadCandidate, scoreReplyCandidate,
  hasOpponentNearlyOut, candidateContainsWish, confidenceLabel,
  getRecommendation, buildChips, buildDefaultChips,
  declarationHandMetrics, getDeclarationAdvice, getDragonGiftAdvice,
  resolveDogHandoffContext, clearProbabilityCaches
};

if (typeof module !== "undefined" && module.exports) module.exports = PROBABILITY_API;
if (typeof globalThis !== "undefined") globalThis.TichuTrackerProbability = PROBABILITY_API;

})();
