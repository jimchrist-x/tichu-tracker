(() => {
"use strict";

/**
 * Tichu Tracker 2.0 — pure card, combination and planning core.
 *
 * This file contains no DOM access and no shared mutable game state. Every
 * function takes explicit inputs, which keeps the rules engine unit-testable
 * and makes the browser layer responsible only for reading the board.
 */

const RANKS = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];
const ASC_RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUITS = [
  { id: "s", symbol: "♠", cssClass: "tt-suit-s" },
  { id: "h", symbol: "♥", cssClass: "tt-suit-h" },
  { id: "d", symbol: "♦", cssClass: "tt-suit-d" },
  { id: "c", symbol: "♣", cssClass: "tt-suit-c" }
];

const SPECIAL_DEFS = [
  { key: "DRAGON", label: "Dragon", short: "Dragon", aliases: ["d", "dr", "dragon", "drag", "_dr"] },
  // DoD can expose the Phoenix as P4 when it is used as a four in a straight.
  { key: "PHOENIX", label: "Phoenix", short: "Phoenix", aliases: ["p", "ph", "phoenix", "phx", "_ph", "p4"] },
  { key: "DOG", label: "Dog", short: "Dog", aliases: ["dg", "dog", "dogs", "sk", "hounds", "_dg"] },
  { key: "MAHJONG", label: "Mahjong (1)", short: "Mahjong", aliases: ["1", "mj", "mahjong", "mah jong", "sparrow", "ma", "_1"] }
];
const SPECIAL_KEYS = SPECIAL_DEFS.map(item => item.key);
const STANDARD_CARDS = [];
for (const rank of ASC_RANKS) {
  for (const suit of SUITS) STANDARD_CARDS.push(`${rank}${suit.id}`);
}
const ALL_CARDS = [...STANDARD_CARDS, ...SPECIAL_KEYS];
const CARD_SET = new Set(ALL_CARDS);

const SEAT_DEFS = [
  { key: "L", label: "Left", short: "L" },
  { key: "P", label: "Partner", short: "P" },
  { key: "R", label: "Right", short: "R" },
  { key: "ME", label: "You", short: "You" }
];
const SEAT_KEYS = ["ME", "L", "P", "R"];
// On-screen clockwise order: bottom (you) -> left -> top (partner) -> right.
const TURN_ORDER = ["ME", "L", "P", "R"];
const PARTNER_OF = { ME: "P", P: "ME", L: "R", R: "L" };
const OPPONENTS_OF = { ME: ["L", "R"], P: ["L", "R"], L: ["ME", "P"], R: ["ME", "P"] };
const ACTIVE_OPPONENTS = ["L", "R"];
const ACTIVE_PLAYERS = ["L", "P", "R"];

function isStandardCard(code) {
  if (!code || code.length !== 2) return false;
  return RANKS.includes(code[0]) && SUITS.some(suit => suit.id === code[1]);
}

function resolveSpecialKey(rawCode, onUnmapped) {
  if (!rawCode) return null;
  let normalized = rawCode.trim().toLowerCase().replace(/\s+/g, " ");
  normalized = normalized.replace(/^_/, "");
  for (const spec of SPECIAL_DEFS) {
    if (spec.aliases.includes(normalized) || spec.aliases.includes(`_${normalized}`)) return spec.key;
  }
  // Phoenix is occasionally rendered as P followed by its chosen straight value (e.g. P4).
  if (/^p(?:h)?\d+$/.test(normalized) || normalized.startsWith("phoenix")) return "PHOENIX";
  if (normalized.startsWith("dr")) return "DRAGON";
  if (normalized.startsWith("do") || normalized.startsWith("dg")) return "DOG";
  if (normalized === "1" || normalized.startsWith("mah") || normalized.startsWith("sparrow")) return "MAHJONG";
  if (onUnmapped) onUnmapped(rawCode);
  return null;
}

function normalizeCardCode(rawCode, onUnmapped) {
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
  return resolveSpecialKey(raw, onUnmapped) || `UNKNOWN:${raw}`;
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
  return (cards || []).map(displayCard).join(" + ");
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

function comboLabel(combo) {
  if (!combo) return "";
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
    case "full-house": return `Full house (${rankLabel}s full)`;
    case "straight": return `${combo.count}-card straight to ${rankLabel}`;
    case "pair-run": return `${combo.count / 2} consecutive pairs to ${rankLabel}`;
    case "bomb-four": return `Bomb: four ${rankLabel}s`;
    case "bomb-straight-flush": return `Bomb: ${combo.count}-card straight flush to ${rankLabel}`;
    default: return combo.type;
  }
}

function actionLooksLikePlay(text) {
  // \b is ASCII-only, so it never matched Greek action verbs. Match the verb
  // stems directly instead.
  return /played|plays|playing|έπαιξε|έπαιξαν|έπαιξ|παίζει|παιζει/i.test(String(text || ""));
}

function actionLooksLikeDogPlay(text) {
  return /dog|dogs|hound|σκύλ|σκυλ/i.test(String(text || ""));
}

function actionLooksLikePass(text) {
  if (!text) return false;
  if (actionLooksLikeDogPlay(text)) return false;
  return /passed|passes|passing|πάσο|πασο|περνάει|περναει|περνά|περνα|πέρασε|περασε/i.test(String(text));
}

function actionLooksLikeTichuCall(text) {
  const value = String(text || "").toLocaleLowerCase();
  const namesTichu = /\b(?:grand\s+)?tichu\b|γκραντ\s*τίτσου|γκραντ\s*τιτσου|τίτσου|τιτσου/i.test(value);
  const declares = /\b(?:call(?:ed|s)?|declar(?:e|ed|es|ing)|announc(?:e|ed|es|ing))\b|δήλωσ|δηλωσ|ανακοίνωσ|ανακοινωσ|κάλεσ|καλεσ/i.test(value);
  return namesTichu && declares;
}

function parseWishRank(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  // Only accept a bare rank ("K", "10") or a rank that follows wish language.
  // The old fallback grabbed the last number anywhere, so "Round 12" became a
  // wish for a 2.
  const bare = value.match(/^(10|[2-9AKQJT])$/i);
  if (bare) return bare[1] === "10" ? "T" : bare[1].toUpperCase();
  const contextual = value.match(/(?:wish(?:ed)?|asked|ζήτησε|ζητησε|ζητά|ζητα)[\s\S]*?\b(10|[2-9]|[AKQJT])\b/i);
  if (contextual) return contextual[1] === "10" ? "T" : contextual[1].toUpperCase();
  return null;
}

// ---------------------------------------------------------------------------
// Structural combination generation
// ---------------------------------------------------------------------------

/**
 * Generate legal combinations from a hand without enumerating all 2^n subsets.
 * One representative per (type, count, rank) is enough for advice; duplicate
 * suit permutations would only add noise. The function is verified against the
 * exhaustive enumerator in the test suite.
 */
function generateCombos(hand) {
  const cards = [...hand].filter(card => CARD_SET.has(card));
  const out = [];
  const seen = new Set();
  const push = list => {
    const unique = [...new Set(list)];
    if (unique.length !== list.length) return;
    const combo = classifyCombo(unique);
    if (!combo) return;
    const key = unique.slice().sort().join(",");
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...combo, cards: unique, key });
  };

  const rankMap = new Map();
  let phoenix = null;
  let mahjong = null;
  for (const card of cards) {
    if (card === "PHOENIX") { phoenix = card; continue; }
    if (card === "MAHJONG") { mahjong = card; continue; }
    if (!isStandardCard(card)) continue;
    const rank = standardRank(card);
    if (!rankMap.has(rank)) rankMap.set(rank, []);
    rankMap.get(rank).push(card);
  }
  const ranks = [...rankMap.keys()].sort((a, b) => a - b);

  for (const card of cards) push([card]);

  // Pairs / triples / four-of-a-kind, including a single Phoenix wildcard.
  for (const rank of ranks) {
    const group = rankMap.get(rank);
    if (group.length >= 2) push(group.slice(0, 2));
    if (group.length >= 3) push(group.slice(0, 3));
    if (group.length === 4) push(group.slice(0, 4));
    if (phoenix && group.length >= 1) push([group[0], phoenix]);
    if (phoenix && group.length >= 2) push([group[0], group[1], phoenix]);
  }

  // Full houses: a triple plus a different pair. A Phoenix may complete either
  // part, but never both (there is only one).
  const tripleParts = [];
  for (const rank of ranks) {
    const group = rankMap.get(rank);
    if (group.length >= 3) tripleParts.push({ rank, cards: group.slice(0, 3), usedPhoenix: false });
    else if (phoenix && group.length === 2) tripleParts.push({ rank, cards: [group[0], group[1], phoenix], usedPhoenix: true });
  }
  for (const triple of tripleParts) {
    for (const rank of ranks) {
      if (rank === triple.rank) continue;
      const group = rankMap.get(rank);
      if (group.length >= 2) push([...triple.cards, ...group.slice(0, 2)]);
      else if (phoenix && !triple.usedPhoenix && group.length === 1) push([...triple.cards, group[0], phoenix]);
    }
  }

  // Straights: every legal window of length 5..14, with at most one gap filled
  // by Phoenix. Mahjong can only occupy rank 1.
  const maxStraight = Math.min(14, cards.length);
  for (let length = 5; length <= maxStraight; length++) {
    for (let low = 1; low + length - 1 <= 14; low++) {
      const high = low + length - 1;
      if (low === 1 && !mahjong) continue;
      const chosen = [];
      let missing = 0;
      let missingRank = null;
      for (let rank = low; rank <= high; rank++) {
        if (rank === 1) { chosen.push(mahjong); continue; }
        const group = rankMap.get(rank);
        if (group && group.length) chosen.push(group[0]);
        else { missing++; missingRank = rank; }
      }
      if (missing === 0) push(chosen);
      else if (missing === 1 && phoenix && missingRank !== 1) push([...chosen, phoenix]);
    }
  }

  // Consecutive pairs (at least two adjacent ranks), Phoenix may fill one card.
  for (let pairs = 2; pairs <= Math.min(7, Math.floor(cards.length / 2)); pairs++) {
    for (let low = 2; low + pairs - 1 <= 14; low++) {
      const high = low + pairs - 1;
      const chosen = [];
      let missing = 0;
      for (let rank = low; rank <= high; rank++) {
        const group = rankMap.get(rank) || [];
        if (group.length >= 2) chosen.push(group[0], group[1]);
        else if (group.length === 1) { chosen.push(group[0]); missing++; }
        else missing += 2;
      }
      if (missing === 0) push(chosen);
      else if (missing === 1 && phoenix) push([...chosen, phoenix]);
    }
  }

  // Straight-flush bombs: every consecutive same-suit run of length >= 5.
  for (const suit of SUITS) {
    let run = [];
    for (let rank = 2; rank <= 14; rank++) {
      const card = rankMap.get(rank) ? rankMap.get(rank).find(item => item[1] === suit.id) : null;
      if (card) run.push(card);
      else run = [];
      if (run.length >= 5) {
        // Every tail of the run is a legal (shorter) straight flush.
        for (let start = 0; start <= run.length - 5; start++) push(run.slice(start));
      }
    }
  }

  return out;
}

const PLAN_CACHE_LIMIT = 24;
const planCache = new Map();

/**
 * Minimal-play decomposition of a hand. Primary objective: fewest plays to go
 * out. Tie-break: avoid spending bombs and high control cards. A bounded DFS
 * makes the result exact for normal 14-card hands; a greedy fallback keeps the
 * HUD responsive in pathological states.
 */
function handPlan(hand) {
  const cards = [...new Set(hand || [])].filter(card => CARD_SET.has(card)).sort();
  const cacheKey = cards.join(",");
  if (planCache.has(cacheKey)) return planCache.get(cacheKey);

  const count = cards.length;
  if (!count) {
    const empty = { plays: 0, groups: [], exact: true, bombs: 0, singles: 0, handSize: 0 };
    planCache.set(cacheKey, empty);
    return empty;
  }

  const combos = generateCombos(new Set(cards));
  const indexOf = new Map(cards.map((card, index) => [card, index]));
  const byLowest = new Map();
  for (const combo of combos) {
    let mask = 0;
    let lowest = 99;
    for (const card of combo.cards) {
      const index = indexOf.get(card);
      if (index === undefined) { mask = -1; break; }
      mask |= (1 << index);
      if (index < lowest) lowest = index;
    }
    if (mask < 0 || lowest === 99) continue;
    if (!byLowest.has(lowest)) byLowest.set(lowest, []);
    byLowest.get(lowest).push({ combo, mask });
  }

  const fullMask = (1 << count) - 1;
  const memo = new Map();
  memo.set(0, { plays: 0, cost: 0, choice: null });
  let budget = 60000;
  let exhausted = false;

  function solve(mask) {
    if (memo.has(mask)) return memo.get(mask);
    if (--budget <= 0) { exhausted = true; return null; }
    // Lowest remaining card must be covered by the next group.
    const lowest = Math.log2(mask & -mask) | 0;
    const options = byLowest.get(lowest) || [];
    let best = null;
    for (const option of options) {
      if ((option.mask & mask) !== option.mask) continue;
      const rest = solve(mask & ~option.mask);
      if (!rest) continue;
      const groupCost = (option.combo.bomb ? 2 : 0)
        + (option.combo.type === "single" && option.combo.rank >= 13 ? 0.5 : 0);
      const candidate = {
        plays: 1 + rest.plays,
        cost: groupCost + rest.cost,
        choice: option
      };
      if (!best || candidate.plays < best.plays || (candidate.plays === best.plays && candidate.cost < best.cost)) {
        best = candidate;
      }
    }
    if (best) memo.set(mask, best);
    return best || null;
  }

  let result = solve(fullMask);
  let exact = true;
  if (!result || exhausted) {
    exact = false;
    // Greedy fallback: repeatedly take the largest legal group that contains
    // the lowest remaining card.
    let mask = fullMask;
    const groups = [];
    while (mask) {
      const lowest = Math.log2(mask & -mask) | 0;
      const options = (byLowest.get(lowest) || []).filter(option => (option.mask & mask) === option.mask);
      options.sort((a, b) => b.combo.count - a.combo.count || a.combo.rank - b.combo.rank);
      const pick = options[0];
      if (!pick) break;
      groups.push(pick.combo);
      mask &= ~pick.mask;
    }
    result = { plays: groups.length, cost: 0, choice: null };
    const plan = {
      plays: groups.length,
      groups,
      exact: false,
      bombs: groups.filter(group => group.bomb).length,
      singles: groups.filter(group => group.type === "single").length,
      handSize: count
    };
    rememberPlan(cacheKey, plan);
    return plan;
  }

  const groups = [];
  let mask = fullMask;
  while (mask) {
    const node = memo.get(mask);
    if (!node || !node.choice) break;
    groups.push(node.choice.combo);
    mask &= ~node.choice.mask;
  }
  const plan = {
    plays: result.plays,
    groups,
    exact,
    bombs: groups.filter(group => group.bomb).length,
    singles: groups.filter(group => group.type === "single").length,
    handSize: count
  };
  rememberPlan(cacheKey, plan);
  return plan;
}

function enumerateCombos(hand) {
  // Exact 2^n enumerator. The browser HUD uses generateCombos() for speed;
  // this remains the reference implementation used by tests.
  const cards = [...new Set(hand || [])].filter(card => CARD_SET.has(card));
  const out = [];
  if (!cards.length) return out;
  if (cards.length > 16) {
    for (const card of cards) {
      const combo = classifyCombo([card]);
      if (combo) out.push({ ...combo, cards: [card] });
    }
    return out;
  }
  const totalMasks = 1 << cards.length;
  for (let mask = 1; mask < totalMasks; mask++) {
    const selection = [];
    for (let index = 0; index < cards.length; index++) {
      if (mask & (1 << index)) selection.push(cards[index]);
    }
    const combo = classifyCombo(selection);
    if (combo) out.push({ ...combo, cards: selection });
  }
  return out;
}

function rememberPlan(cacheKey, plan) {
  if (planCache.size >= PLAN_CACHE_LIMIT) {
    const first = planCache.keys().next().value;
    planCache.delete(first);
  }
  planCache.set(cacheKey, plan);
}

// ---------------------------------------------------------------------------
// Fast "can this hand beat X?" search used by the probability model
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Statistical helpers
// ---------------------------------------------------------------------------

function wilsonInterval(hits, samples, z = 1.96) {
  if (!Number.isFinite(hits) || !Number.isFinite(samples) || samples <= 0) return null;
  const p = Math.max(0, Math.min(1, hits / samples));
  const z2 = z * z;
  const denominator = 1 + z2 / samples;
  const center = (p + z2 / (2 * samples)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) / samples) + (z2 / (4 * samples * samples))) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function percent(probability) {
  return probability === null || probability === undefined || !Number.isFinite(probability)
    ? "—"
    : `${Math.round(probability * 100)}%`;
}

function percentRange(interval) {
  return interval ? `${percent(interval.lower)}–${percent(interval.upper)}` : "—";
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

const CORE_API = {
  RANKS, ASC_RANKS, SUITS, SPECIAL_DEFS, SPECIAL_KEYS, STANDARD_CARDS, ALL_CARDS, CARD_SET,
  SEAT_DEFS, SEAT_KEYS, TURN_ORDER, PARTNER_OF, OPPONENTS_OF, ACTIVE_OPPONENTS, ACTIVE_PLAYERS,
  isStandardCard, resolveSpecialKey, normalizeCardCode, cardRank, standardRank,
  rankNameFromValue, displayCard, displayCards, classifyStraight, classifyCombo, canBeat,
  comboLabel, actionLooksLikePlay, actionLooksLikeDogPlay, actionLooksLikePass,
  actionLooksLikeTichuCall, parseWishRank, generateCombos, enumerateCombos, handPlan,
  findBeatingStraightFlush, handCanBeatCombo, wilsonInterval, percent, percentRange,
  makeSeededRandom, hashText
};

if (typeof module !== "undefined" && module.exports) module.exports = CORE_API;
if (typeof globalThis !== "undefined") globalThis.TichuTrackerCore = CORE_API;

})();
