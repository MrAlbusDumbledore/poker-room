import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate5, bestHoldem, bestOmaha } from '../src/engine/evaluator.js';
import { createShuffledDeck, newDeck, verifyDeck, shuffle } from '../src/engine/cards.js';

const v = (s: string) => evaluate5(s.split(' '));

test('категории комбинаций', () => {
  assert.equal(v('As Ks Qs Js Ts').name, 'Роял-флеш');
  assert.equal(v('9h 8h 7h 6h 5h').name, 'Стрит-флеш');
  assert.equal(v('Ac Ad Ah As 2c').name, 'Каре');
  assert.equal(v('Kc Kd Kh 2s 2c').name, 'Фулл-хаус');
  assert.equal(v('Ac 9c 7c 4c 2c').name, 'Флеш');
  assert.equal(v('Ac 2d 3h 4s 5c').name, 'Стрит');
  assert.equal(v('7c 7d 7h Ks 2c').name, 'Сет');
  assert.equal(v('7c 7d Kh Ks 2c').name, 'Две пары');
  assert.equal(v('7c 7d Ah Ks 2c').name, 'Пара');
  assert.equal(v('Ac Jd 9h 6s 2c').name, 'Старшая карта');
});

test('порядок силы и кикеры', () => {
  assert.ok(v('9h 8h 7h 6h 5h').score > v('Ac Ad Ah As 2c').score);
  assert.ok(v('2c 3d 4h 5s 6c').score > v('Ac 2d 3h 4s 5c').score, 'колесо — самый младший стрит');
  assert.ok(v('Ac Ad Kh 7s 2c').score > v('Ac Ad Qh Js Tc').score, 'кикер решает');
  assert.ok(v('Kc Kd 2h 2s Ac').score > v('Qc Qd Jh Js Ac').score);
  assert.equal(v('Ac Ad Kh 7s 2c').score, v('Ah As Kd 7c 2d').score, 'одинаковые руки — ничья');
});

test('холдем: лучшие 5 из 7', () => {
  const r = bestHoldem(['As', 'Kd'], ['Qs', 'Js', 'Ts', '2s', '3c']);
  assert.equal(r.name, 'Флеш');
  assert.equal(bestHoldem(['2c', '3d'], ['As', 'Ks', 'Qs', 'Js', 'Ts']).name, 'Роял-флеш', 'игра бордом');
});

test('омаха: строго 2 с руки и 3 со стола', () => {
  // Четыре черви на руке и одна на столе — это НЕ флеш
  assert.notEqual(bestOmaha(['Ah', 'Kh', 'Qh', 'Jh', '2c'], ['Th', '3c', '5d', '8s', '9d']).name, 'Флеш');
  // Четыре пики на столе и одна на руке — тоже НЕ флеш
  assert.notEqual(bestOmaha(['As', 'Kd', 'Qc', '2h', '3h'], ['5s', '7s', '9s', 'Js', 'Kh']).name, 'Флеш');
  // Две пики на руке + три на столе — флеш
  assert.equal(bestOmaha(['As', 'Ks', 'Qc', '2h', '3h'], ['5s', '7s', '9s', 'Jd', 'Kh']).name, 'Флеш');
  // Каре на столе в Омахе не играет: на столе можно взять только 3 карты
  assert.equal(bestOmaha(['2c', '3d', '4h', '6s', '8c'], ['Ac', 'Ad', 'Ah', 'As', 'Kd']).name, 'Сет');
});

test('колода: 52 разные карты и проверка хэша', () => {
  const d = createShuffledDeck();
  assert.equal(new Set(d.cards).size, 52);
  assert.ok(verifyDeck(d.cards, d.salt, d.commitment));
  const swapped = d.cards.slice();
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  assert.ok(!verifyDeck(swapped, d.salt, d.commitment), 'подмена карт ломает хэш');
});

test('тасовка равномерная (первая карта колоды)', () => {
  const N = 52_000;
  const counts = new Map<string, number>();
  const base = newDeck();
  for (let i = 0; i < N; i++) {
    const c = shuffle(base)[0];
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  // хи-квадрат с 51 степенью свободы; порог 100 соответствует p ≈ 0.00005
  const expected = N / 52;
  let chi = 0;
  for (const c of base) chi += ((counts.get(c) ?? 0) - expected) ** 2 / expected;
  assert.ok(chi < 100, `хи-квадрат слишком большой: ${chi.toFixed(1)}`);
});
