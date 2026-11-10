import { Card, newDeck, ShuffledDeck, commitmentFor } from '../src/engine/cards.js';

/**
 * Собирает колоду так, чтобы игроки получили нужные карты.
 * holes — карты игроков в порядке раздачи (первым — малый блайнд / слева от баттона).
 */
export function riggedDeck(holes: Card[][], board: Card[]): Card[] {
  const used = new Set([...holes.flat(), ...board]);
  const filler = newDeck().filter((c) => !used.has(c));
  const deck: Card[] = [];
  const n = holes[0].length;
  for (let r = 0; r < n; r++) for (const h of holes) deck.push(h[r]);
  deck.push(filler.pop()!, board[0], board[1], board[2], filler.pop()!, board[3], filler.pop()!, board[4]);
  return [...deck, ...filler];
}

export function asShuffled(cards: Card[]): ShuffledDeck {
  const salt = 'test';
  return { cards, salt, commitment: commitmentFor(cards, salt) };
}

/** Детерминированный ГСЧ для воспроизводимых симуляций. */
export function seeded(seed: number) {
  let s = seed >>> 0;
  return (min: number, max: number) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return min + (s % (max - min));
  };
}
