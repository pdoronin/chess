// Обёртка над Stockfish (UCI) в Web Worker.
// Гарантирует, что одновременно идёт только один поиск, а новый запрос прерывает предыдущий.

function parseInfo(line) {
  const t = line.split(/\s+/);
  if (t.includes('lowerbound') || t.includes('upperbound')) return null;
  const info = { depth: 0, multipv: 1, score: null, pv: [] };
  for (let i = 1; i < t.length; i++) {
    const k = t[i];
    if (k === 'depth') info.depth = parseInt(t[++i], 10);
    else if (k === 'multipv') info.multipv = parseInt(t[++i], 10);
    else if (k === 'score') {
      const kind = t[++i];
      const v = parseInt(t[++i], 10);
      info.score = kind === 'mate' ? { mate: v } : { cp: v };
    } else if (k === 'pv') {
      info.pv = t.slice(i + 1);
      break;
    }
  }
  if (!info.score || !info.pv.length) return null;
  return info;
}

export class Engine {
  constructor(url) {
    this.log = [];
    this.worker = null;
    this.pending = [];
    this.ready = new Promise((r) => (this._readyResolve = r));
    this.current = null;
    this.queue = Promise.resolve();
    this.latest = 0;
    this.multipv = 1;
    this._boot(url).catch((e) => {
      this.worker = null;
      this.onError && this.onError(e);
    });
  }

  // Worker создаётся из Blob: lichess отдаёт Cross-Origin-Embedder-Policy,
  // и прямой запрос скрипта воркера из iframe расширения блокируется
  // (net::ERR_BLOCKED_BY_RESPONSE). Путь к .wasm передаём через hash.
  async _boot(url) {
    const jsUrl = new URL(url, import.meta.url).href;
    const wasmUrl = jsUrl.replace(/\.js$/i, '.wasm');
    const res = await fetch(jsUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status} при загрузке ${jsUrl}`);
    const blob = new Blob([await res.text()], { type: 'text/javascript' });
    const worker = new Worker(URL.createObjectURL(blob) + '#' + encodeURIComponent(wasmUrl));
    worker.onmessage = (e) => this._line(String(e.data));
    worker.onerror = (e) => this.onError && this.onError(e);
    worker.onmessageerror = (e) => this.onError && this.onError(e);
    this.worker = worker;
    worker.postMessage('uci');
    const pending = this.pending; this.pending = [];
    for (const cmd of pending) worker.postMessage(cmd);
  }

  send(cmd) {
    if (this.worker) this.worker.postMessage(cmd);
    else this.pending.push(cmd);
  }

  _line(line) {
    if (!line.startsWith('info ') && !line.startsWith('bestmove')) {
      this.log.push(line);
      if (this.log.length > 20) this.log.shift();
    }
    if (line === 'uciok') {
      this.send('setoption name UCI_AnalyseMode value true');
      this.send('isready');
      return;
    }
    if (line === 'readyok') {
      this._readyResolve();
      return;
    }
    const cur = this.current;
    if (!cur) return;
    if (line.startsWith('info ')) {
      const info = parseInfo(line);
      if (!info) return;
      cur.lines[info.multipv - 1] = info;
      if (cur.onInfo && !cur.aborted) cur.onInfo(cur.lines.filter(Boolean));
      return;
    }
    if (line.startsWith('bestmove')) {
      this.current = null;
      cur.resolve({ lines: cur.lines.filter(Boolean), aborted: cur.aborted });
    }
  }

  // Возвращает промис с результатом { lines, aborted } или null, если запрос устарел.
  analyze(fen, { movetime = 1200, multipv = 3, onInfo = null } = {}) {
    const token = ++this.latest;
    if (this.current && !this.current.aborted) {
      this.current.aborted = true;
      this.send('stop');
    }
    const run = async () => {
      if (token !== this.latest) return null;
      // Ждать готовности воркера можно секунды (компиляция WASM), за это время
      // позиция успевает смениться, поэтому проверяем актуальность ещё раз.
      await this.ready;
      if (token !== this.latest) return null;
      return new Promise((resolve) => {
        this.current = { lines: [], onInfo, resolve, aborted: false };
        if (multipv !== this.multipv) {
          this.send(`setoption name MultiPV value ${multipv}`);
          this.multipv = multipv;
        }
        this.send(`position fen ${fen}`);
        this.send(`go movetime ${movetime}`);
      });
    };
    // Один и тот же обработчик на успех и на ошибку: очередь не должна обрываться,
    // если предыдущий поиск завершился исключением.
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  stop() {
    this.latest++;
    if (this.current && !this.current.aborted) {
      this.current.aborted = true;
      this.send('stop');
    }
  }
}
