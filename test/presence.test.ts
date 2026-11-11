import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/server/db.js';
import { createUser } from '../src/server/auth.js';
import { TableManager } from '../src/server/tables.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('отключившийся игрок пересаживается в «отошёл» перед следующей раздачей', async () => {
  const db = openDb(':memory:');
  const m = new TableManager(db, { handDelayMs: 20, showdownDelayMs: 20, runoutScale: 0, awayAfterMs: 100 });
  const a = await createUser(db, 'anna', 'secret123', 'Анна');
  const b = await createUser(db, 'boris', 'secret123', 'Борис');
  const row = m.create(a, { variant: 'NLH', maxSeats: 6, stakeId: '10-20' });
  let last: any = null;
  const subA = { userId: a.id, send: (msg: any) => msg.t === 'state' && (last = msg.state) };
  const subB = { userId: b.id, send: () => {} };
  m.subscribe(row.id, subA);
  m.subscribe(row.id, subB);
  m.command(row.id, a, { t: 'sit', seat: 0, buyIn: 1000 });
  m.command(row.id, b, { t: 'sit', seat: 1, buyIn: 1000 });
  for (let i = 0; i < 50 && !last?.handInProgress; i++) await sleep(10);
  assert.ok(last.handInProgress, 'раздача началась');

  // Борис отключается; доигрываем раздачу фолдом
  m.unsubscribe(row.id, subB);
  await sleep(150);
  const active = last.hand.activePlayerId;
  m.command(row.id, active === a.id ? a : b, { t: 'action', action: { type: 'fold' } });
  await sleep(100);

  const boris = last.seats.find((s: any) => !s.empty && s.userId === b.id);
  assert.equal(boris.sittingOut, true, 'Борис отсажен в «отошёл»');
  assert.equal(last.handInProgress, false, 'с одним игроком раздача не начинается');
  m.shutdown();
  db.close();
});
