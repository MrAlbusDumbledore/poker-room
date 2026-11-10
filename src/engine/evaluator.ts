import { Card, rankOf, suitOf } from './cards.js';

export const CATEGORY_NAMES = [
  'Старшая карта',
  'Пара',
  'Две пары',
  'Сет',
  'Стрит',
  'Флеш',
  'Фулл-хаус',
  'Каре',
  'Стрит-флеш',
] as const;

export interface HandValue {
  /** Чем больше, тем сильнее рука. Равные score — ничья. */
  score: number;
  /** 0 — старшая карта … 8 — стрит-флеш. */
  category: number;
  name: string;
  /** Пять карт, составивших комбинацию. */
  cards: Card[];
}

/** Оценка ровно пяти карт. */
export function evaluate5(cards: Card[]): HandValue {
  if (cards.length !== 5) throw new Error('evaluate5 ждёт ровно 5 карт');
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]));

  const unique = [...new Set(ranks)];
  let straightHigh = 0;
  if (unique.length === 5) {
    if (unique[0] - unique[4] === 4) straightHigh = unique[0];
    else if (unique.join(',') === '14,5,4,3,2') straightHigh = 5; // «колесо» A-2-3-4-5
  }

  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  // Группы: сначала по размеру группы, затем по рангу
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map((g) => g[1]).join('');
  const groupRanks = groups.map((g) => g[0]);

  let category: number;
  let kickers: number[];
  if (straightHigh && flush) {
    category = 8;
    kickers = [straightHigh];
  } else if (shape === '41') {
    category = 7;
    kickers = groupRanks;
  } else if (shape === '32') {
    category = 6;
    kickers = groupRanks;
  } else if (flush) {
    category = 5;
    kickers = ranks;
  } else if (straightHigh) {
    category = 4;
    kickers = [straightHigh];
  } else if (shape === '311') {
    category = 3;
    kickers = groupRanks;
  } else if (shape === '221') {
    category = 2;
    kickers = groupRanks;
  } else if (shape === '2111') {
    category = 1;
    kickers = groupRanks;
  } else {
    category = 0;
    kickers = ranks;
  }

  let score = category;
  for (let i = 0; i < 5; i++) score = score * 15 + (kickers[i] ?? 0);

  const name = category === 8 && straightHigh === 14 ? 'Роял-флеш' : CATEGORY_NAMES[category];
  return { score, category, name, cards: cards.slice() };
}

export function combinations<T>(items: T[], k: number): T[][] {
  const out: T[][] = [];
  const pick: T[] = [];
  const rec = (start: number) => {
    if (pick.length === k) {
      out.push(pick.slice());
      return;
    }
    for (let i = start; i <= items.length - (k - pick.length); i++) {
      pick.push(items[i]);
      rec(i + 1);
      pick.pop();
    }
  };
  rec(0);
  return out;
}

function bestOf(candidates: Card[][]): HandValue {
  let best: HandValue | null = null;
  for (const c of candidates) {
    const v = evaluate5(c);
    if (!best || v.score > best.score) best = v;
  }
  if (!best) throw new Error('Недостаточно карт для комбинации');
  return best;
}

/** Холдем: лучшие 5 из любых карт руки и стола. */
export function bestHoldem(hole: Card[], board: Card[]): HandValue {
  return bestOf(combinations([...hole, ...board], 5));
}

/** Омаха: строго 2 карты с руки и 3 со стола. */
export function bestOmaha(hole: Card[], board: Card[]): HandValue {
  const out: Card[][] = [];
  for (const h of combinations(hole, 2)) for (const b of combinations(board, 3)) out.push([...h, ...b]);
  return bestOf(out);
}
