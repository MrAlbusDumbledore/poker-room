import { createHash, randomBytes, randomInt } from 'node:crypto';

/** Карта в виде строки из двух символов: ранг + масть, например "As", "Td", "7c". */
export type Card = string;
export type Suit = 'c' | 'd' | 'h' | 's';

export const RANKS = '23456789TJQKA';
export const SUITS: readonly Suit[] = ['c', 'd', 'h', 's'];

/** Числовой ранг: 2..14 (туз = 14). */
export function rankOf(card: Card): number {
  return RANKS.indexOf(card[0]) + 2;
}

export function suitOf(card: Card): Suit {
  return card[1] as Suit;
}

export function isValidCard(card: string): boolean {
  return card.length === 2 && RANKS.includes(card[0]) && (SUITS as readonly string[]).includes(card[1]);
}

/** Новая упорядоченная колода из 52 карт. */
export function newDeck(): Card[] {
  const deck: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

/** Генератор случайного целого в [min, max). По умолчанию — криптографический (CSPRNG). */
export type RandomInt = (min: number, max: number) => number;

/**
 * Тасовка Фишера–Йетса. Каждая из 52! перестановок равновероятна,
 * случайность берётся из криптографического генератора ОС.
 */
export function shuffle<T>(items: T[], rand: RandomInt = randomInt): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Перетасованная колода с «доказуемой честностью»:
 * до раздачи игрокам показывается commitment (SHA-256 от соли и порядка карт),
 * после раздачи раскрываются cards и salt — любой может пересчитать хэш
 * и убедиться, что колоду не подменяли по ходу раздачи.
 */
export interface ShuffledDeck {
  cards: Card[];
  salt: string;
  commitment: string;
}

export function commitmentFor(cards: Card[], salt: string): string {
  return createHash('sha256').update(`${salt}:${cards.join('')}`).digest('hex');
}

export function createShuffledDeck(rand?: RandomInt): ShuffledDeck {
  const cards = shuffle(newDeck(), rand);
  const salt = randomBytes(16).toString('hex');
  return { cards, salt, commitment: commitmentFor(cards, salt) };
}

export function verifyDeck(cards: Card[], salt: string, commitment: string): boolean {
  return commitmentFor(cards, salt) === commitment;
}
