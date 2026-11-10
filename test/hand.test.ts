import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hand, HandError, Variant } from '../src/engine/hand.js';
import { riggedDeck } from './helpers.js';
import { newDeck, shuffle } from '../src/engine/cards.js';

function three(stacks = [1000, 1000, 1000], variant: Variant = 'NLH', deck = newDeck(), sb = 10, bb = 20) {
  // Места 0,1,2 = a,b,c. Баттон a → b малый блайнд, c большой, первым ходит a.
  return new Hand(
    [
      { id: 'a', seat: 0, stack: stacks[0] },
      { id: 'b', seat: 1, stack: stacks[1] },
      { id: 'c', seat: 2, stack: stacks[2] },
    ],
    { variant, smallBlind: sb, bigBlind: bb, buttonSeat: 0, deck },
  );
}

function checkDown(h: Hand) {
  while (!h.isComplete) {
    const l = h.getLegalActions()!;
    h.act(l.playerId, { type: l.canCheck ? 'check' : 'call' });
  }
}

test('все сбросили — большой блайнд забирает банк', () => {
  const h = three();
  assert.equal(h.activePlayerId, 'a');
  h.act('a', { type: 'fold' });
  h.act('b', { type: 'fold' });
  assert.ok(h.isComplete);
  assert.deepEqual(h.result!.net, { a: 0, b: -10, c: 10 });
  assert.equal(h.result!.showdown, false);
});

test('опцион большого блайнда после лимпов', () => {
  const h = three();
  h.act('a', { type: 'call' });
  h.act('b', { type: 'call' });
  assert.equal(h.activePlayerId, 'c');
  const l = h.getLegalActions()!;
  assert.ok(l.canCheck && l.canRaise);
  h.act('c', { type: 'check' });
  assert.equal(h.street, 'flop');
  assert.equal(h.board.length, 3);
  assert.equal(h.activePlayerId, 'b', 'на флопе первым ходит малый блайнд');
});

test('нельзя ходить не в свою очередь', () => {
  const h = three();
  assert.throws(() => h.act('b', { type: 'call' }), HandError);
});

test('минимальный рейз в безлимитном холдеме', () => {
  const h = three();
  assert.throws(() => h.act('a', { type: 'raise', amount: 39 }), /от 40/);
  h.act('a', { type: 'raise', amount: 60 }); // рейз на 40
  const l = h.getLegalActions()!;
  assert.equal(l.minRaiseTo, 100, 'следующий рейз — минимум ещё на 40');
  assert.equal(l.maxRaiseTo, 1000);
});

test('пот-лимит: максимальный рейз', () => {
  const h = three([1000, 1000, 1000], 'PLO5');
  const l = h.getLegalActions()!;
  assert.equal(l.maxRaiseTo, 70, 'при блайндах 10/20 первый рейз в банк — до 70');
  h.act('a', { type: 'raise', amount: 70 });
  // банк 100, малому блайнду колл 60 → рейз до 70 + 100 + 60 = 230
  assert.equal(h.getLegalActions()!.maxRaiseTo, 230);
  assert.throws(() => h.act('b', { type: 'raise', amount: 231 }));
  assert.equal(h.players[0].hole.length, 5, 'в Омахе по 5 карт');
});

test('пот-лимит: ставка на флопе не больше банка', () => {
  const h = three([1000, 1000, 1000], 'PLO5');
  checkDownStreet(h);
  assert.equal(h.street, 'flop');
  assert.equal(h.getLegalActions()!.maxRaiseTo, 60);
});

function checkDownStreet(h: Hand) {
  const s = h.street;
  while (h.street === s && !h.isComplete) {
    const l = h.getLegalActions()!;
    h.act(l.playerId, { type: l.canCheck ? 'check' : 'call' });
  }
}

test('хедз-ап: баттон ставит малый блайнд и ходит первым до флопа, последним после', () => {
  const h = new Hand(
    [
      { id: 'a', seat: 0, stack: 500 },
      { id: 'b', seat: 3, stack: 500 },
    ],
    { variant: 'NLH', smallBlind: 10, bigBlind: 20, buttonSeat: 0, deck: newDeck() },
  );
  assert.equal(h.players[0].committed, 10);
  assert.equal(h.players[1].committed, 20);
  assert.equal(h.activePlayerId, 'a');
  h.act('a', { type: 'call' });
  h.act('b', { type: 'check' });
  assert.equal(h.activePlayerId, 'b');
});

test('сайд-поты при олл-инах с разными стеками', () => {
  // порядок раздачи: b, c, a
  const deck = riggedDeck(
    [
      ['Ks', 'Kh'],
      ['Qs', 'Qh'],
      ['As', 'Ah'],
    ],
    ['2c', '7d', '9h', 'Jc', '3s'],
  );
  const h = three([100, 300, 500], 'NLH', deck);
  h.act('a', { type: 'allin' });
  h.act('b', { type: 'allin' });
  assert.equal(h.getLegalActions()!.canRaise, false, 'поднимать не против кого');
  h.act('c', { type: 'allin' });
  assert.ok(h.isComplete);
  const r = h.result!;
  assert.equal(r.pots.length, 2);
  assert.deepEqual(
    r.pots.map((p) => [p.amount, p.winners]),
    [
      [300, ['a']],
      [400, ['b']],
    ],
  );
  assert.deepEqual(r.net, { a: 200, b: 100, c: -300 });
  assert.equal(r.hands.a.name, 'Пара');
});

test('делёж банка: лишняя фишка — первому слева от баттона', () => {
  const deck = riggedDeck(
    [
      ['2c', '3d'],
      ['4c', '5d'],
      ['2d', '3c'],
    ],
    ['As', 'Ks', 'Qs', 'Js', 'Ts'],
  );
  const h = three([1000, 1000, 1000], 'NLH', deck, 5, 10);
  h.act('a', { type: 'call' });
  h.act('b', { type: 'fold' });
  checkDown(h);
  const pot = h.result!.pots[0];
  assert.equal(pot.amount, 25);
  assert.deepEqual(pot.shares, { c: 13, a: 12 });
});

test('неполный олл-ин не переоткрывает торговлю', () => {
  const h = three([1000, 1000, 130]);
  h.act('a', { type: 'raise', amount: 100 });
  h.act('b', { type: 'call' });
  h.act('c', { type: 'allin' }); // 130 — это допрейз всего на 30
  const l = h.getLegalActions()!;
  assert.equal(l.playerId, 'a');
  assert.equal(l.canRaise, false);
  assert.equal(l.callAmount, 30);
});

test('полный олл-ин переоткрывает торговлю', () => {
  const h = three([1000, 1000, 300]);
  h.act('a', { type: 'raise', amount: 100 });
  h.act('b', { type: 'call' });
  h.act('c', { type: 'allin' }); // 300 — рейз на 200
  assert.equal(h.getLegalActions()!.canRaise, true);
});

test('скрытые карты: игрок видит только свои', () => {
  const h = three();
  const view = h.viewFor('a');
  assert.ok(view.players.find((p) => p.id === 'a')!.hole);
  assert.equal(view.players.find((p) => p.id === 'b')!.hole, null);
  assert.equal(view.legal?.playerId, 'a');
  assert.equal(h.viewFor('b').legal, null);
});

test('случайная симуляция: фишки не теряются и раздачи всегда завершаются', () => {
  let rnd = 12345;
  const r = (n: number) => {
    rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
    return rnd % n;
  };
  for (let i = 0; i < 3000; i++) {
    const variant: Variant = i % 2 ? 'NLH' : 'PLO5';
    const n = 2 + r(5);
    const seats = Array.from({ length: n }, (_, k) => ({ id: 'p' + k, seat: k * 1, stack: 1 + r(3000) }));
    const total = seats.reduce((s, x) => s + x.stack, 0);
    const h = new Hand(seats, {
      variant,
      smallBlind: 10,
      bigBlind: 20,
      buttonSeat: seats[r(n)].seat,
      deck: shuffle(newDeck()),
    });
    let guard = 0;
    while (!h.isComplete) {
      assert.ok(guard++ < 500, 'раздача зациклилась');
      const l = h.getLegalActions()!;
      const roll = r(10);
      if (roll === 0) h.act(l.playerId, { type: 'fold' });
      else if (roll < 3 && l.canRaise) {
        const amt = l.minRaiseTo + r(l.maxRaiseTo - l.minRaiseTo + 1);
        h.act(l.playerId, { type: l.isBet ? 'bet' : 'raise', amount: amt });
      } else if (roll === 3) h.act(l.playerId, { type: 'allin' });
      else h.act(l.playerId, { type: l.canCheck ? 'check' : 'call' });
    }
    const after = h.players.reduce((s, p) => s + p.stack, 0);
    assert.equal(after, total, `потеряны фишки в раздаче ${i}`);
    assert.equal(Object.values(h.result!.net).reduce((a, b) => a + b, 0), 0);
    assert.ok(h.players.every((p) => p.stack >= 0));
  }
});
