import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CashTable } from '../src/engine/table.js';
import { createShuffledDeck, verifyDeck } from '../src/engine/cards.js';
import { defaultBuyIn, STAKES } from '../src/engine/stakes.js';

function table(maxSeats = 6) {
  return new CashTable({ variant: 'NLH', maxSeats, smallBlind: 10, bigBlind: 20, minBuyIn: 400, maxBuyIn: 4000 });
}

test('уровни блайндов', () => {
  assert.deepEqual(
    STAKES.map((s) => s.label),
    ['10/20', '25/50', '50/100', '100/200', '200/500'],
  );
  assert.deepEqual(defaultBuyIn(20), { minBuyIn: 800, maxBuyIn: 4000 });
});

test('бай-ин в пределах лимитов', () => {
  const t = table();
  assert.throws(() => t.sit('a', 0, 100), /от 400 до 4000/);
  t.sit('a', 0, 1000);
  assert.throws(() => t.sit('b', 0, 1000), /занято/);
  assert.throws(() => t.sit('a', 1, 1000), /уже сидите/);
});

test('игрок встал и вернулся — стек сохранился, повторно платить не нужно', () => {
  const t = table();
  t.sit('a', 0, 1000);
  t.sit('b', 1, 1000);
  t.startHand();
  t.act(t.hand!.activePlayerId!, { type: 'fold' });
  const aStack = t.seats[0]!.stack;
  t.leave('a');
  assert.equal(t.seats[0], null);
  assert.equal(t.reserved.get('a'), aStack);
  t.sit('a', 3); // без суммы — возвращается со своим стеком
  assert.equal(t.seats[3]!.stack, aStack);
  const row = t.stats().find((r) => r.userId === 'a')!;
  assert.equal(row.buyIn, 1000, 'возвращение не считается новой покупкой');
});

test('уход посреди раздачи: карты сбрасываются, стек сохраняется после раздачи', () => {
  const t = table();
  t.sit('a', 0, 1000);
  t.sit('b', 1, 1000);
  t.sit('c', 2, 1000);
  t.startHand(); // баттон 0: a ходит первым
  t.act('a', { type: 'call' });
  t.leave('a'); // ещё в раздаче
  assert.ok(t.seats[0]!.leaveAfterHand);
  t.act('b', { type: 'call' });
  t.act('c', { type: 'check' });
  // на флопе ход дойдёт до a — его карты автоматически сброшены
  while (t.handInProgress) {
    const l = t.hand!.getLegalActions()!;
    t.act(l.playerId, { type: l.canCheck ? 'check' : 'call' });
  }
  assert.equal(t.seats[0], null);
  assert.equal(t.reserved.get('a'), 980);
});

test('ушедший игрок, уже сбросивший карты, уносит правильный стек', () => {
  const t = table();
  t.sit('a', 0, 1000);
  t.sit('b', 1, 1000);
  t.sit('c', 2, 1000);
  t.startHand(); // b — малый блайнд
  t.act('a', { type: 'call' });
  t.act('b', { type: 'fold' });
  t.leave('b');
  assert.equal(t.reserved.get('b'), 990);
});

test('баттон двигается по кругу', () => {
  const t = table();
  t.sit('a', 0, 1000);
  t.sit('b', 2, 1000);
  t.sit('c', 4, 1000);
  const buttons: number[] = [];
  for (let i = 0; i < 4; i++) {
    t.startHand();
    buttons.push(t.buttonSeat!);
    while (t.handInProgress) t.act(t.hand!.activePlayerId!, { type: 'fold' });
  }
  assert.deepEqual(buttons, [0, 2, 4, 0]);
});

test('докупка: только между раздачами и не выше максимума', () => {
  const t = table();
  t.sit('a', 0, 1000);
  t.sit('b', 1, 1000);
  assert.throws(() => t.addChips('a', 3500), /не может превышать 4000/);
  t.startHand();
  assert.throws(() => t.addChips('a', 100), /после окончания/);
  while (t.handInProgress) t.act(t.hand!.activePlayerId!, { type: 'fold' });
  t.addChips('a', 100);
  assert.equal(t.stats().find((r) => r.userId === 'a')!.buyIn, 1100);
});

test('честность колоды: хэш до раздачи, колода раскрывается после', () => {
  const t = table();
  t.sit('a', 0, 1000);
  t.sit('b', 1, 1000);
  const deck = createShuffledDeck();
  t.startHand(deck);
  assert.equal(t.currentCommitment, deck.commitment);
  while (t.handInProgress) t.act(t.hand!.activePlayerId!, { type: 'fold' });
  const r = t.lastRevealedDeck!;
  assert.ok(verifyDeck(r.cards, r.salt, deck.commitment));
});

test('длинная сессия: статистика сходится в ноль, проигравшие докупаются', () => {
  const t = table();
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  ids.forEach((id, i) => t.sit(id, i, 400 + i * 300));
  let rnd = 7;
  const r = (n: number) => {
    rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
    return rnd % n;
  };
  for (let hand = 0; hand < 500; hand++) {
    // иногда кто-то встаёт и возвращается
    if (r(20) === 0) {
      const id = ids[r(6)];
      if (t.seatOf(id) >= 0) t.leave(id);
    }
    for (const id of ids) {
      if (t.seatOf(id) < 0) {
        const free = t.seats.findIndex((s) => !s);
        if (r(3) === 0 && free >= 0) t.sit(id, free, t.reserved.get(id) ? undefined : 1000);
        continue;
      }
      const s = t.seats[t.seatOf(id)]!;
      if (s.stack === 0) {
        t.addChips(id, 1000);
        t.sitIn(id);
      }
    }
    if (!t.canStartHand()) continue;
    t.startHand();
    while (t.handInProgress) {
      const l = t.hand!.getLegalActions()!;
      const roll = r(8);
      if (roll === 0) t.act(l.playerId, { type: 'fold' });
      else if (roll === 1 && l.canRaise) t.act(l.playerId, { type: 'raise', amount: l.minRaiseTo });
      else if (roll === 2) t.act(l.playerId, { type: 'allin' });
      else t.act(l.playerId, { type: l.canCheck ? 'check' : 'call' });
    }
  }
  const stats = t.close();
  assert.equal(stats.reduce((s, x) => s + x.net, 0), 0, 'сумма выигрышей и проигрышей = 0');
  assert.ok(stats.every((x) => x.stack >= 0));
  assert.throws(() => t.sit('z', 0, 1000), /закрыт/);
});

test('восстановление после перезапуска: игроки на своих местах, ушедшие — со сохранённым стеком', () => {
  const cfg = { variant: 'NLH' as const, maxSeats: 6, smallBlind: 10, bigBlind: 20, minBuyIn: 400, maxBuyIn: 4000 };
  const t = CashTable.restore(
    cfg,
    [
      { userId: 'a', buyIn: 1000, stack: 1200, handsPlayed: 5, seat: 2, sittingOut: false },
      { userId: 'b', buyIn: 1000, stack: 800, handsPlayed: 5, seat: 4, sittingOut: true },
      { userId: 'c', buyIn: 1000, stack: 1000, handsPlayed: 3, seat: null },
      { userId: 'd', buyIn: 500, stack: 0, handsPlayed: 2, seat: 1 },
    ],
    10,
  );
  assert.equal(t.seats[2]!.userId, 'a');
  assert.equal(t.seats[2]!.stack, 1200);
  assert.equal(t.seats[4]!.sittingOut, true);
  assert.equal(t.reserved.get('c'), 1000);
  assert.equal(t.seats[1], null, 'игрок без фишек не занимает место');
  assert.equal(t.handNumber, 10);
  assert.equal(t.stats().reduce((s, r) => s + r.net, 0), 1200 + 800 + 1000 + 0 - 3500);
});
