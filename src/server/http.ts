import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { AuthError, User } from './auth.js';
import { HandError } from '../engine/hand.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  user: User | null;
  ip: string;
  cookies: Record<string, string>;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
  auth: boolean;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  const fwd = req.headers['x-forwarded-for'];
  if (trustProxy && typeof fwd === 'string') return fwd.split(',')[0].trim();
  return req.socket.remoteAddress ?? '';
}

async function readJson(req: IncomingMessage, limit = 32 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Слишком большой запрос');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Некорректный JSON');
  }
}

export function sendJson(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export class Router {
  private routes: Route[] = [];

  constructor(
    private readonly authenticate: (cookies: Record<string, string>) => User | null,
    private readonly trustProxy: boolean,
  ) {}

  add(method: string, path: string, handler: Handler, opts: { auth?: boolean } = {}) {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), handler, auth: opts.auth ?? true });
  }

  private match(method: string, pathname: string) {
    const parts = pathname.split('/').filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method || r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const ok = r.parts.every((p, i) => {
        if (p.startsWith(':')) {
          params[p.slice(1)] = decodeURIComponent(parts[i]);
          return true;
        }
        return p === parts[i];
      });
      if (ok) return { route: r, params };
    }
    return null;
  }

  /** Возвращает false, если маршрут не найден. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const m = this.match(req.method ?? 'GET', url.pathname);
    if (!m) return false;
    try {
      // Защита от CSRF: изменяющие запросы принимаем только как JSON с нашего же сайта.
      if (req.method !== 'GET') {
        const ct = req.headers['content-type'] ?? '';
        if (!ct.startsWith('application/json')) throw new HttpError(415, 'Нужен Content-Type: application/json');
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Чужой источник запроса');
      }
      const cookies = parseCookies(req.headers.cookie);
      const user = this.authenticate(cookies);
      if (m.route.auth && !user) throw new HttpError(401, 'Нужно войти в аккаунт');
      const body = req.method === 'GET' ? {} : await readJson(req);
      const ctx: Ctx = {
        req,
        res,
        params: m.params,
        query: url.searchParams,
        body,
        user,
        ip: clientIp(req, this.trustProxy),
        cookies,
      };
      const result = await m.route.handler(ctx);
      if (!res.headersSent) sendJson(res, 200, result ?? { ok: true });
    } catch (e) {
      const status = e instanceof HttpError || e instanceof AuthError ? e.status : e instanceof HandError ? 400 : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Внутренняя ошибка сервера' : (e as Error).message });
    }
    return true;
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

/** Раздача файлов интерфейса; для неизвестных путей отдаём index.html (одностраничное приложение). */
export async function serveStatic(root: string, url: URL, res: ServerResponse) {
  const base = resolve(root);
  let file = normalize(join(base, decodeURIComponent(url.pathname)));
  if (!file.startsWith(base)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(base, 'index.html');
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Не найдено');
  }
}
