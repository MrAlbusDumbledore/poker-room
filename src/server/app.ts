import { createServer, Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  AuthError,
  checkCredentials,
  checkRateLimit,
  clearFailures,
  createSession,
  createUser,
  deleteSession,
  recordFailure,
  searchUsers,
  SESSION_COOKIE,
  SESSION_DAYS,
  User,
  userBySession,
  validateRegistration,
} from './auth.js';
import { openDb, DB } from './db.js';
import { acceptFriend, listFriends, removeFriend, requestFriend } from './friends.js';
import { HttpError, parseCookies, Router, sendJson, serveStatic, Ctx } from './http.js';
import { TableCommand, TableManager, Subscriber, summary } from './tables.js';
import { STAKES } from '../engine/stakes.js';
import { VARIANT_NAMES } from '../engine/hand.js';

export interface AppOptions {
  dbPath: string;
  publicDir: string;
  /** Если задан, регистрация возможна только с этим кодом приглашения. */
  registrationCode?: string;
  /** Ставить флаг Secure на cookie (когда сайт работает по HTTPS). */
  secureCookies?: boolean;
  /** Сервер стоит за прокси (nginx и т.п.) — брать IP из X-Forwarded-For. */
  trustProxy?: boolean;
  handDelayMs?: number;
  showdownDelayMs?: number;
  actionTimeOverrideMs?: number;
  /** Множитель паузы на раскладку стола после олл-ина (по умолчанию 1). */
  runoutScale?: number;
}

export interface App {
  server: Server;
  db: DB;
  tables: TableManager;
  close(): Promise<void>;
}

export function createApp(opts: AppOptions): App {
  const db = openDb(opts.dbPath);
  const tables = new TableManager(db, {
    handDelayMs: opts.handDelayMs ?? 2000,
    showdownDelayMs: opts.showdownDelayMs ?? 5000,
    actionTimeOverrideMs: opts.actionTimeOverrideMs,
    runoutScale: opts.runoutScale ?? 1,
  });
  const auth = (cookies: Record<string, string>) => userBySession(db, cookies[SESSION_COOKIE]);
  const router = new Router(auth, !!opts.trustProxy);

  const setSessionCookie = (ctx: Ctx, token: string | null) => {
    const parts = [
      `${SESSION_COOKIE}=${token ?? ''}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${token ? SESSION_DAYS * 86400 : 0}`,
    ];
    if (opts.secureCookies) parts.push('Secure');
    ctx.res.setHeader('Set-Cookie', parts.join('; '));
  };
  const me = (ctx: Ctx) => ctx.user as User;

  // ---------- Аккаунт ----------

  router.add(
    'POST',
    '/api/register',
    async (ctx) => {
      if (opts.registrationCode && ctx.body.inviteCode !== opts.registrationCode) {
        throw new AuthError('Неверный код приглашения', 403);
      }
      const v = validateRegistration(ctx.body.username, ctx.body.password, ctx.body.displayName);
      const user = await createUser(db, v.username, v.password, v.displayName);
      setSessionCookie(ctx, createSession(db, user.id));
      return { user };
    },
    { auth: false },
  );

  router.add(
    'POST',
    '/api/login',
    async (ctx) => {
      const username = String(ctx.body.username ?? '');
      const key = `${ctx.ip}|${username.toLowerCase()}`;
      checkRateLimit(key);
      try {
        const user = await checkCredentials(db, username, String(ctx.body.password ?? ''));
        clearFailures(key);
        setSessionCookie(ctx, createSession(db, user.id));
        return { user };
      } catch (e) {
        recordFailure(key);
        throw e;
      }
    },
    { auth: false },
  );

  router.add(
    'POST',
    '/api/logout',
    (ctx) => {
      deleteSession(db, ctx.cookies[SESSION_COOKIE]);
      setSessionCookie(ctx, null);
    },
    { auth: false },
  );

  router.add('GET', '/api/me', (ctx) => ({ user: ctx.user }), { auth: false });

  router.add(
    'GET',
    '/api/config',
    () => ({
      inviteRequired: !!opts.registrationCode,
      stakes: STAKES,
      variants: Object.entries(VARIANT_NAMES).map(([id, name]) => ({ id, name })),
    }),
    { auth: false },
  );

  // ---------- Друзья ----------

  router.add('GET', '/api/users/search', (ctx) => {
    const q = (ctx.query.get('q') ?? '').trim();
    return { users: q.length >= 2 ? searchUsers(db, q, me(ctx).id) : [] };
  });
  router.add('GET', '/api/friends', (ctx) => listFriends(db, me(ctx).id));
  router.add('POST', '/api/friends/request', (ctx) => ({ status: requestFriend(db, me(ctx).id, String(ctx.body.username ?? '')) }));
  router.add('POST', '/api/friends/:id/accept', (ctx) => acceptFriend(db, me(ctx).id, ctx.params.id));
  router.add('POST', '/api/friends/:id/remove', (ctx) => removeFriend(db, me(ctx).id, ctx.params.id));

  // ---------- Столы ----------

  router.add('GET', '/api/tables', (ctx) => ({ tables: tables.lobby(me(ctx).id) }));
  router.add('POST', '/api/tables', (ctx) => ({ table: summary(tables.create(me(ctx), ctx.body)) }));
  router.add('GET', '/api/tables/:id/stats', (ctx) => tables.stats(ctx.params.id));

  // Служебная проверка для автообновления: доступна только с самого сервера, не через интернет.
  router.add(
    'GET',
    '/api/internal/busy',
    (ctx) => {
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ctx.req.socket.remoteAddress ?? '');
      if (!local || ctx.req.headers['x-forwarded-for']) throw new HttpError(404, 'Не найдено');
      return { handsInProgress: tables.activeHands() };
    },
    { auth: false },
  );

  // ---------- HTTP-сервер ----------

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (url.pathname.startsWith('/api/')) {
      if (!(await router.handle(req, res, url))) sendJson(res, 404, { error: 'Не найдено' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    await serveStatic(opts.publicDir, url, res);
  });

  // ---------- WebSocket: игра в реальном времени ----------

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const origin = req.headers.origin;
    const user = userBySession(db, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    const sameOrigin = !origin || new URL(origin).host === req.headers.host;
    if (url.pathname !== '/ws' || !user || !sameOrigin) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, user));
  });

  function onConnection(ws: WebSocket, user: User) {
    let tableId: string | null = null;
    const sub: Subscriber = {
      userId: user.id,
      send: (msg) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
    };
    const fail = (e: unknown) => {
      const status = (e as { status?: number }).status;
      if (!(e instanceof AuthError) && !(e instanceof HttpError) && !(e as Error).message) console.error(e);
      sub.send({ t: 'error', message: (e as Error).message || 'Ошибка', status });
    };

    // Пинг раз в 25 секунд, чтобы мобильные сети и прокси не рвали тихое соединение.
    let alive = true;
    ws.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 25_000);

    ws.on('message', (raw) => {
      let msg: { t?: string; tableId?: string } & Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return fail(new Error('Некорректное сообщение'));
      }
      try {
        if (msg.t === 'join') {
          if (tableId) tables.unsubscribe(tableId, sub);
          tableId = null;
          tables.subscribe(String(msg.tableId), sub);
          tableId = String(msg.tableId);
        } else if (msg.t === 'leave_view') {
          if (tableId) tables.unsubscribe(tableId, sub);
          tableId = null;
        } else if (msg.t === 'ping') {
          sub.send({ t: 'pong' });
        } else {
          if (!tableId) throw new Error('Сначала откройте стол');
          tables.command(tableId, user, msg as unknown as TableCommand);
        }
      } catch (e) {
        fail(e);
      }
    });

    ws.on('close', () => {
      clearInterval(ping);
      if (tableId) tables.unsubscribe(tableId, sub);
    });
  }

  return {
    server,
    db,
    tables,
    async close() {
      tables.shutdown();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
    },
  };
}
