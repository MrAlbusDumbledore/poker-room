import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createApp, App, AppOptions } from '../src/server/app.js';

const dir = mkdtempSync(join(tmpdir(), 'poker-'));
const dbPath = join(dir, 'test.db');
const baseOpts: AppOptions = {
  dbPath,
  publicDir: join(process.cwd(), 'public'),
  registrationCode: 'friends',
  handDelayMs: 30,
  showdownDelayMs: 30,
  runoutScale: 0,
};

let app: App;
let base = '';

async function start(extra: Partial<AppOptions> = {}) {
  app = createApp({ ...baseOpts, ...extra });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

after(async () => {
  await app?.close();
});

class Client {
  cookie = '';
  ws: WebSocket | null = null;
  messages: any[] = [];
  state: any = null;
  waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];

  async api(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: this.cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie();
    if (set.length) this.cookie = set[0].split(';')[0];
    const data = await res.json();
    return { status: res.status, data };
  }

  async connect() {
    this.ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { Cookie: this.cookie } });
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      m.raw = raw.toString();
      this.messages.push(m);
      if (m.t === 'state') this.state = m.state;
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
    await new Promise((r, j) => (this.ws!.once('open', r), this.ws!.once('error', j)));
  }

  send(msg: unknown) {
    this.ws!.send(JSON.stringify(msg));
  }

  waitFor(pred: (m: any) => boolean, ms = 3000): Promise<any> {
    const found = this.messages.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Не дождались сообщения')), ms);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  /** Ждать следующее состояние, удовлетворяющее условию. */
  nextState(pred: (s: any) => boolean, ms = 3000) {
    this.messages = [];
    if (this.state && pred(this.state)) return Promise.resolve(this.state);
    return this.waitFor((m) => m.t === 'state' && pred(m.state), ms).then((m) => m.state);
  }

  close() {
    this.ws?.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Доигрывать раздачи (чек/колл за того, чей ход), пока условие не выполнится. */
async function playUntil(clients: Client[], pred: (s: any) => boolean, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = clients[0].state;
    if (s && pred(s)) return s;
    const active = s?.handInProgress ? s.hand.activePlayerId : null;
    const c = clients.find((x) => x.state?.me.userId === active);
    const legal = c?.state?.hand?.legal;
    if (c && legal && legal.playerId === active) {
      const key = `${s.handNumber}:${s.hand.street}:${s.hand.pot}:${active}`;
      c.send({ t: 'action', action: { type: legal.canCheck ? 'check' : 'call' } });
      const until = Date.now() + 1000;
      while (Date.now() < until) {
        const n = clients[0].state;
        if (`${n.handNumber}:${n.hand?.street}:${n.hand?.pot}:${n.hand?.activePlayerId}` !== key) break;
        await sleep(10);
      }
    } else await sleep(15);
  }
  throw new Error('playUntil: не дождались');
}

async function register(username: string, displayName = username) {
  const c = new Client();
  const r = await c.api('POST', '/api/register', { username, password: 'secret123', displayName, inviteCode: 'friends' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return c;
}

test('сервер: аккаунты, друзья, игра, сохранение стеков, перезапуск', async (t) => {
  await start();

  const alice = await register('alice', 'Алиса');
  const bob = await register('bob', 'Боб');
  const carol = await register('carol', 'Кэрол');
  const dave = await register('dave', 'Дэйв');

  await t.test('регистрация и вход', async () => {
    const c = new Client();
    const open = await c.api('POST', '/api/register', { username: 'xena', password: 'secret123' });
    assert.equal(open.status, 200, 'регистрация без кода приглашения');
    const meX = await c.api('GET', '/api/me');
    assert.equal(meX.data.user.balance, 1_000_000, 'стартовый баланс — 1 млн');
    assert.equal(meX.data.user.isAdmin, false, 'не первый аккаунт — не админ');
    assert.equal(
      (await c.api('POST', '/api/register', { username: 'alice', password: 'secret123', inviteCode: 'friends' })).status,
      409,
    );
    assert.equal((await c.api('POST', '/api/register', { username: 'ок', password: 'secret123', inviteCode: 'friends' })).status, 400);
    assert.equal((await c.api('POST', '/api/login', { username: 'alice', password: 'wrong' })).status, 401);
    const ok = await c.api('POST', '/api/login', { username: 'ALICE', password: 'secret123' });
    assert.equal(ok.status, 200);
    assert.equal((await c.api('GET', '/api/me')).data.user.displayName, 'Алиса');
    await c.api('POST', '/api/logout', {});
    assert.equal((await c.api('GET', '/api/me')).data.user, null);
    assert.equal((await c.api('GET', '/api/friends')).status, 401);
  });

  await t.test('защита: запросы не-JSON и WebSocket без входа отклоняются', async () => {
    const res = await fetch(base + '/api/tables', { method: 'POST', headers: { Cookie: alice.cookie }, body: 'x=1' });
    assert.equal(res.status, 415);
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    await assert.rejects(new Promise((r, j) => (ws.once('open', r), ws.once('error', j))));
  });

  await t.test('друзья', async () => {
    assert.equal((await alice.api('POST', '/api/friends/request', { username: 'bob' })).data.status, 'sent');
    const bobsView = await bob.api('GET', '/api/friends');
    assert.deepEqual(
      bobsView.data.incoming.map((u: any) => u.username),
      ['alice'],
    );
    const aliceId = bobsView.data.incoming[0].id;
    await bob.api('POST', `/api/friends/${aliceId}/accept`, {});
    assert.deepEqual(
      (await alice.api('GET', '/api/friends')).data.friends.map((u: any) => u.username),
      ['bob'],
    );
    // встречная заявка подтверждает дружбу сразу
    await alice.api('POST', '/api/friends/request', { username: 'carol' });
    assert.equal((await carol.api('POST', '/api/friends/request', { username: 'alice' })).data.status, 'accepted');
    assert.equal((await alice.api('POST', '/api/friends/request', { username: 'alice' })).status, 400);
    const found = await dave.api('GET', '/api/users/search?q=али');
    assert.deepEqual(
      found.data.users.map((u: any) => u.username),
      ['alice'],
    );
  });

  let tableId = '';

  await t.test('создание стола и лобби', async () => {
    const bad = await alice.api('POST', '/api/tables', { variant: 'PLO5', maxSeats: 9, stakeId: '10-20' });
    assert.equal(bad.status, 400, 'в Омахе 5 карт максимум 8 мест');
    const r = await alice.api('POST', '/api/tables', { name: 'Пятничный', variant: 'NLH', maxSeats: 6, stakeId: '10-20' });
    assert.equal(r.status, 200);
    tableId = r.data.table.id;
    assert.equal(r.data.table.minBuyIn, 800);
    assert.equal(r.data.table.maxBuyIn, 4000);
    assert.equal((await bob.api('GET', '/api/tables')).data.tables[0].name, 'Пятничный');
    assert.equal((await dave.api('GET', '/api/tables')).data.tables.length, 0, 'не друзья стол в лобби не видят');
  });

  await t.test('игра: каждый видит только свои карты, раздача доходит до конца', async () => {
    for (const c of [alice, bob, carol]) {
      await c.connect();
      c.send({ t: 'join', tableId });
      await c.waitFor((m) => m.t === 'state');
    }
    alice.send({ t: 'sit', seat: 0, buyIn: 1000 });
    await alice.nextState((s) => s.me.seat === 0);
    bob.send({ t: 'sit', seat: 1, buyIn: 2000 });
    carol.send({ t: 'sit', seat: 3, buyIn: 800 });
    carol.send({ t: 'sit', seat: 4, buyIn: 800 });
    await carol.waitFor((m) => m.t === 'error' && /уже сидите/.test(m.message));

    const s = await alice.nextState((st) => st.handInProgress && st.hand.players.length === 3);
    // Проверяем, что в сообщениях каждому игроку нет чужих карманных карт
    for (const c of [alice, bob, carol]) {
      const st = await c.nextState((x) => x.handInProgress);
      const mine = st.hand.players.find((p: any) => p.id === st.me.userId);
      assert.equal(mine.hole.length, 2);
      for (const p of st.hand.players) if (p.id !== st.me.userId) assert.equal(p.hole, null);
    }
    assert.ok(s.commitment, 'хэш колоды опубликован до раздачи');

    // Играем: все чекают/коллируют до конца раздачи
    await playUntil([alice, bob, carol], (x) => x.handNumber > s.handNumber || !x.handInProgress);
    const stats = (await alice.api('GET', `/api/tables/${tableId}/stats`)).data.players;
    assert.equal(stats.reduce((a: number, p: any) => a + p.net, 0), 0);
    assert.equal(stats.length, 3);
  });

  await t.test('чужой ход отклоняется', async () => {
    const st = await alice.nextState((x) => x.handInProgress && !!x.hand.activePlayerId);
    const notActive = [alice, bob, carol].find((c) => c.state.me.userId !== st.hand.activePlayerId)!;
    notActive.messages = [];
    notActive.send({ t: 'action', action: { type: 'check' } });
    await notActive.waitFor((m) => m.t === 'error' && /не ваш ход/i.test(m.message));
  });

  await t.test('баланс: бай-ин списывается, а когда встаёшь — фишки возвращаются на баланс', async () => {
    const balanceBefore = (await bob.api('GET', '/api/me')).data.user.balance;
    assert.equal(balanceBefore, 1_000_000 - 2000, 'бай-ин Боба списан с баланса');
    const stackAtTable = bob.state.seats.find((x: any) => !x.empty && x.userId === bob.state.me.userId).stack;
    bob.send({ t: 'stand' });
    // если раздача идёт, Боб уйдёт после её окончания (его карты сбросятся на его ходу)
    const away = await playUntil([bob, alice, carol], (x) => x.me.seat === null);
    assert.equal(away.me.reservedStack, null, 'стек не «замораживается»');
    const balanceAfter = (await bob.api('GET', '/api/me')).data.user.balance;
    const row = away.stats.find((r: any) => r.userId === away.me.userId);
    assert.equal(balanceAfter, balanceBefore + row.cashOut, 'всё, что было на столе, вернулось на баланс');
    assert.ok(row.cashOut > 0 && Math.abs(row.cashOut - stackAtTable) <= 2000);

    bob.messages = [];
    bob.send({ t: 'sit', seat: 5, buyIn: 5_000_000 });
    await bob.waitFor((m) => m.t === 'error' && /Не хватает фишек|Бай-ин должен быть/.test(m.message));
    bob.send({ t: 'sit', seat: 5, buyIn: 1000 });
    const back = await bob.nextState((x) => x.me.seat === 5);
    assert.equal(back.seats[5].stack, 1000);
    assert.equal(back.me.balance, balanceAfter - 1000);
    assert.equal(back.stats.reduce((a: number, r: any) => a + r.net, 0), 0, 'сумма итогов за столом = 0');
  });

  await t.test('переводы фишек друзьям', async () => {
    const aliceMe = (await alice.api('GET', '/api/me')).data.user;
    const bobMe = (await bob.api('GET', '/api/me')).data.user;
    const daveMe = (await dave.api('GET', '/api/me')).data.user;
    const r = await alice.api('POST', '/api/wallet/transfer', { to: bobMe.id, amount: 25_000 });
    assert.equal(r.status, 200);
    assert.equal(r.data.balance, aliceMe.balance - 25_000);
    assert.equal((await bob.api('GET', '/api/me')).data.user.balance, bobMe.balance + 25_000);
    assert.equal((await alice.api('POST', '/api/wallet/transfer', { to: daveMe.id, amount: 10 })).status, 400, 'не другу нельзя');
    assert.equal((await alice.api('POST', '/api/wallet/transfer', { to: bobMe.id, amount: -5 })).status, 400);
    assert.equal((await alice.api('POST', '/api/wallet/transfer', { to: bobMe.id, amount: 999_999_999 })).status, 400, 'не хватает');
    const hist = (await bob.api('GET', '/api/wallet')).data.history;
    assert.equal(hist[0].incoming, true);
    assert.equal(hist[0].amount, 25_000);
    assert.equal(hist[0].other, 'Алиса');
  });

  await t.test('админ: первый аккаунт, начисляет фишки, закрывает чужие столы', async () => {
    assert.equal((await alice.api('GET', '/api/me')).data.user.isAdmin, true, 'Алиса зарегистрировалась первой');
    assert.equal((await bob.api('GET', '/api/admin/users')).status, 403);
    const users = (await alice.api('GET', '/api/admin/users')).data.users;
    const daveRow = users.find((u: any) => u.username === 'dave');
    const g = await alice.api('POST', `/api/admin/users/${daveRow.id}/chips`, { amount: 500_000 });
    assert.equal(g.data.balance, daveRow.balance + 500_000);
    const minus = await alice.api('POST', `/api/admin/users/${daveRow.id}/chips`, { amount: -100_000_000 });
    assert.equal(minus.data.balance, 0, 'списание не уводит баланс в минус');
    // Админ закрывает стол Боба
    const { table } = (await bob.api('POST', '/api/tables', { name: 'Стол Боба', stakeId: '10-20' })).data;
    const admin = new Client();
    admin.cookie = alice.cookie;
    await admin.connect();
    admin.send({ t: 'join', tableId: table.id });
    await admin.waitFor((m) => m.t === 'state');
    admin.send({ t: 'close' });
    const closed = await admin.waitFor((m) => m.t === 'closed');
    assert.equal(closed.stats.table.status, 'closed');
    admin.close();
  });

  await t.test('предметы: кинуть в игрока за столом, все видят; в себя и слишком часто — нельзя', async () => {
    const st = alice.state;
    const bobId = bob.state.me.userId;
    for (const c of [alice, bob, carol]) c.messages = [];
    alice.send({ t: 'throw', to: bobId, item: 'tomato' });
    for (const c of [alice, bob, carol]) {
      const m = await c.waitFor((x) => x.t === 'throw');
      assert.equal(m.to, bobId);
      assert.equal(m.item, 'tomato');
      assert.equal(m.from, st.me.userId);
    }
    const withGift = await carol.nextState((x) => x.seats.some((s: any) => !s.empty && s.userId === bobId && s.gift === 'tomato'));
    assert.ok(withGift, 'помидор висит у места Боба');
    alice.send({ t: 'throw', to: bobId, item: 'beer' });
    await alice.waitFor((m) => m.t === 'error' && /часто/.test(m.message));
    alice.send({ t: 'throw', to: st.me.userId, item: 'beer' });
    await alice.waitFor((m) => m.t === 'error' && /себя/.test(m.message));
    alice.send({ t: 'throw', to: bobId, item: 'bomb' });
    await alice.waitFor((m) => m.t === 'error' && /Неизвестный предмет/.test(m.message));
  });

  await t.test('таймаут хода: авто-фолд/чек и пересадка в «отошёл»', async () => {
    await app.close();
    await start({ actionTimeOverrideMs: 150 });
    for (const c of [alice, bob, carol]) {
      await c.connect();
      c.send({ t: 'join', tableId });
      await c.waitFor((m) => m.t === 'state');
    }
    // После перезапуска все остались на своих местах с теми же стеками
    const st = await alice.nextState(() => true);
    assert.equal(st.me.seat, 0, 'Алиса снова на своём месте');
    const names = st.seats.filter((x: any) => !x.empty).map((x: any) => `${x.seat}:${x.displayName}`).sort();
    assert.deepEqual(names, ['0:Алиса', '3:Кэрол', '5:Боб']);
    const before = st.stats.reduce((a: number, r: any) => a + r.stack, 0);
    for (const c of [alice, bob, carol]) c.send({ t: 'sit_in' });
    // никто не ходит — таймер сбрасывает карты и сажает игроков в «отошёл»
    const idle = await alice.nextState((x) => !x.handInProgress && x.handNumber > st.handNumber && x.seats.some((s: any) => !s.empty && s.sittingOut), 8000);
    assert.ok(idle);
    const afterSum = idle.stats.reduce((a: number, r: any) => a + r.stack, 0);
    assert.equal(afterSum, before, 'фишки не теряются');
  });

  await t.test('служебная проверка занятости доступна только с самого сервера', async () => {
    const local = await fetch(base + '/api/internal/busy');
    assert.equal(local.status, 200);
    assert.equal(typeof (await local.json()).handsInProgress, 'number');
    const proxied = await fetch(base + '/api/internal/busy', { headers: { 'X-Forwarded-For': '8.8.8.8' } });
    assert.equal(proxied.status, 404, 'через прокси (то есть из интернета) — недоступно');
  });

  await t.test('закрытие стола: итоговая статистика', async () => {
    bob.messages = [];
    bob.send({ t: 'close' });
    await bob.waitFor((m) => m.t === 'error' && /только его создатель/.test(m.message));
    alice.send({ t: 'close' });
    const closed = await alice.waitFor((m) => m.t === 'closed', 5000);
    assert.equal(closed.stats.table.status, 'closed');
    assert.equal(closed.stats.players.reduce((a: number, p: any) => a + p.net, 0), 0);
    assert.equal((await bob.api('GET', '/api/tables')).data.tables.length, 0, 'закрытый стол пропал из лобби');
    const later = await bob.api('GET', `/api/tables/${tableId}/stats`);
    assert.equal(later.status, 200, 'статистика доступна и после закрытия');
    for (const c of [alice, bob, carol]) c.close();
  });

  await t.test('статика: главная страница отдаётся', async () => {
    const res = await fetch(base + '/some/spa/route');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Покер/);
  });
});

test('длительность раскладки', async () => {
  const { runoutDuration } = await import('../src/server/tables.js');
  assert.equal(runoutDuration(null), 0);
  // префлоп: 1200 → флоп 1200/1550/1900 → тёрн 3700 → ривер 5500 → итог 6300
  assert.equal(runoutDuration(0), 6300);
  assert.equal(runoutDuration(3), 1200 + 1800 + 800);
  assert.equal(runoutDuration(4), 1200 + 800);
});
