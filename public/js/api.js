export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw new ApiError(data.error || 'Сервер недоступен', res.status);
  return data;
}

/**
 * Подключение к столу по WebSocket с автоматическим переподключением.
 * onState вызывается при каждом обновлении стола, onError — при ошибке хода.
 */
export class TableSocket {
  constructor(tableId, { onState, onError, onClosed, onStatus }) {
    this.tableId = tableId;
    this.handlers = { onState, onError, onClosed, onStatus };
    this.stopped = false;
    this.retry = 0;
    this.open();
  }

  open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.handlers.onStatus?.('online');
      ws.send(JSON.stringify({ t: 'join', tableId: this.tableId }));
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'state') this.handlers.onState(m.state);
      else if (m.t === 'error') {
        if (m.status === 404 || m.status === 410) {
          this.stop();
          this.handlers.onClosed?.(null, m.message);
        } else this.handlers.onError?.(m.message);
      } else if (m.t === 'closed') {
        this.stop();
        this.handlers.onClosed?.(m.stats);
      }
    };
    ws.onclose = () => {
      if (this.stopped) return;
      this.handlers.onStatus?.('offline');
      const delay = Math.min(8000, 500 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.open(), delay);
    };
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else this.handlers.onError?.('Нет связи с сервером, переподключаюсь…');
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close();
  }
}
