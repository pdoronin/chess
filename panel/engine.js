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
    this.worker = new Worker(url);
    this.worker.onmessage = (e) => this._line(String(e.data));
    this.worker.onerror = (e) => this.onError && this.onError(e);
    this.ready = new Promise((r) => (this._readyResolve = r));
    this.current = null;
    this.queue = Promise.resolve();
    this.latest = 0;
    this.multipv = 1;
    this.send('uci');
  }

  send(cmd) {
    this.worker.postMessage(cmd);
  }

  _line(line) {
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
      await this.ready;
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
