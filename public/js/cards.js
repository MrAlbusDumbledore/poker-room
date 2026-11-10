import { h } from './dom.js';

const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const SUIT_NAME = { s: 'пики', h: 'червы', d: 'бубны', c: 'трефы' };
const RANK_NAME = { T: '10' };
const RANK_SPOKEN = { T: '10', J: 'валет', Q: 'дама', K: 'король', A: 'туз' };

/** Карта: «As» → туз пик. Ранги в привычной покерной записи: J, Q, K, A. */
export function cardEl(code, extra = '') {
  if (!code) return h('div.card.back', { class: extra, 'aria-label': 'Закрытая карта' });
  const r = code[0], s = code[1];
  return h(
    'div.card',
    { class: `${s} ${extra}`.trim(), 'aria-label': `${RANK_SPOKEN[r] ?? r} ${SUIT_NAME[s]}` },
    h('span.r', {}, RANK_NAME[r] ?? r),
    h('span.s', {}, SUIT[s]),
  );
}

export const slotEl = () => h('div.card.slot', { 'aria-hidden': 'true' });

// ---------- Подсказка «что у меня сейчас» (та же логика, что на сервере) ----------

const RANKS = '23456789TJQKA';
const NAMES = ['Старшая карта', 'Пара', 'Две пары', 'Сет', 'Стрит', 'Флеш', 'Фулл-хаус', 'Каре', 'Стрит-флеш'];
const rank = (c) => RANKS.indexOf(c[0]) + 2;

function eval5(cards) {
  const ranks = cards.map(rank).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  const uniq = [...new Set(ranks)];
  let straight = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straight = uniq[0];
    else if (uniq.join() === '14,5,4,3,2') straight = 5;
  }
  const cnt = {};
  for (const r of ranks) cnt[r] = (cnt[r] || 0) + 1;
  const groups = Object.entries(cnt).map(([r, n]) => [Number(r), n]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map((g) => g[1]).join('');
  const gr = groups.map((g) => g[0]);
  let cat, k;
  if (straight && flush) (cat = 8), (k = [straight]);
  else if (shape === '41') (cat = 7), (k = gr);
  else if (shape === '32') (cat = 6), (k = gr);
  else if (flush) (cat = 5), (k = ranks);
  else if (straight) (cat = 4), (k = [straight]);
  else if (shape === '311') (cat = 3), (k = gr);
  else if (shape === '221') (cat = 2), (k = gr);
  else if (shape === '2111') (cat = 1), (k = gr);
  else (cat = 0), (k = ranks);
  let score = cat;
  for (let i = 0; i < 5; i++) score = score * 15 + (k[i] ?? 0);
  return { score, name: cat === 8 && straight === 14 ? 'Роял-флеш' : NAMES[cat] };
}

function combos(arr, k) {
  const out = [];
  const rec = (start, pick) => {
    if (pick.length === k) return out.push(pick.slice());
    for (let i = start; i <= arr.length - (k - pick.length); i++) {
      pick.push(arr[i]);
      rec(i + 1, pick);
      pick.pop();
    }
  };
  rec(0, []);
  return out;
}

/** Название лучшей комбинации игрока на текущем столе или null до флопа. */
export function currentCombo(variant, hole, board) {
  if (!hole?.length || board.length < 3) return null;
  let cands;
  if (variant === 'PLO5') {
    cands = [];
    for (const a of combos(hole, 2)) for (const b of combos(board, 3)) cands.push([...a, ...b]);
  } else cands = combos([...hole, ...board], 5);
  let best = null;
  for (const c of cands) {
    const v = eval5(c);
    if (!best || v.score > best.score) best = v;
  }
  return best?.name ?? null;
}
