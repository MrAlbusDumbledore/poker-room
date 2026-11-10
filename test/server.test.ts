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
    assert.equal((await c.api('POST', '/api/register', { username: 'x1', password: 'secret123', inviteCode: 'wrong' })).status, 403);
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

  await t.test('игрок встал — стек сохранился; вернулся без повторной покупки', async () => {
    bob.send({ t: 'stand' });
    // если раздача идёт, Боб уйдёт после её окончания (его карты сбросятся на его ходу)
    const away = await playUntil([bob, alice, carol], (x) => x.me.seat === null);
    const reserved = away.me.reservedStack;
    assert.ok(reserved > 0);
    bob.send({ t: 'sit', seat: 5 });
    const back = await bob.nextState((x) => x.me.seat === 5);
    const seat = back.seats[5];
    assert.equal(seat.stack, reserved);
    const row = back.stats.find((r: any) => r.userId === back.me.userId);
    assert.equal(row.buyIn, 2000, 'возвращение не считается новой покупкой');
  });

  await t.test('таймаут хода: авто-фолд/чек и пересадка в «отошёл»', async () => {
    await app.close();
    await start({ actionTimeOverrideMs: 150 });
    for (const c of [alice, bob, carol]) {
      await c.connect();
      c.send({ t: 'join', tableId });
      await c.waitFor((m) => m.t === 'state');
    }
    // После перезапуска все игроки «отошли», стеки сохранены
    const st = await alice.nextState(() => true);
    assert.equal(st.me.seat, null);
    assert.ok(st.me.reservedStack > 0, 'стек восстановлен из базы после перезапуска');
    const before = st.stats.reduce((a: number, r: any) => a + r.stack, 0);
    alice.send({ t: 'sit', seat: 0 });
    bob.send({ t: 'sit', seat: 1 });
    // никто не ходит — таймер сбрасывает карты и сажает игроков в «отошёл»
    const idle = await alice.nextState((x) => !x.handInProgress && x.handNumber > st.handNumber && x.seats.some((s: any) => !s.empty && s.sittingOut), 5000);
    assert.ok(idle);
    const afterSum = idle.stats.reduce((a: number, r: any) => a + r.stack, 0);
    assert.equal(afterSum, before, 'фишки не теряются');
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
