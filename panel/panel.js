// Главный скрипт панели: связывает движок, объяснения, обучение, разбор и историю партий.
import { Chess } from '../lib/chess.js';
import { Engine } from './engine.js';
import { explainMove, explainThreat, fenSwapTurn, pvToSan, uciToMove, sanOf, detectPhase } from './explain.js';
import { winPct, negate, fmtScore, scoreWords, QUALITY, classify, thinkingPrompts, ideaHint, pieceHint, summarize } from './coach.js';
import { LESSONS, lessonFor } from './lessons.js';
import { boardSvg } from './board.js';
import * as store from './store.js';

const PARENT_ORIGIN = 'https://lichess.org';
const DEFAULT_SETTINGS = {
  visibleStyle: 'teacher', // teacher | assistant — как показывать подсказки в видимом режиме
  startInvisible: true, // каждая новая партия начинается в невидимом режиме
  movetime: 1500,
  multipv: 3,
  arrows: true,
  threats: true,
  altArrows: false,
  reviewAnalyze: true,
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  readLessons: {},
  tab: 'game',
  // текущая партия на странице
  game: null,
  error: null,
  key: null,
  moves: [],
  viewingAll: true,
  chess: null,
  fen: null,
  lines: [],
  depth: 0,
  done: false,
  threat: null,
  reveal: 0,
  records: [],
  pending: null,
  reqId: 0,
  visible: false, // видимый режим для текущей партии
  ratedDismissed: false,
  engineError: null,
  openLesson: null,
  // сохранение
  gameData: null,
  saveTimer: null,
  index: [],
  // разбор
  review: null, // { game, ply, lines, depth, done, reqId }
};

const view = document.getElementById('view');
const engine = new Engine('../engine/stockfish-18-lite-single.js');
engine.onError = async (e) => {
  state.engineError = 'Не удалось запустить Stockfish. Собираю диагностику…';
  render();
  state.engineError = await diagnoseEngine(e);
  render();
};

// Подробности о причине сбоя движка: доступность файлов, поддержка WebAssembly, вывод worker.
async function diagnoseEngine(err) {
  const lines = ['Не удалось запустить Stockfish.'];
  lines.push('Ошибка: ' + ((err && (err.message || err.type)) || '(без сообщения)') + (err && err.filename ? ` в ${err.filename}:${err.lineno}` : ''));
  for (const f of ['engine/stockfish-18-lite-single.js', 'engine/stockfish-18-lite-single.wasm']) {
    try {
      const r = await fetch(chrome.runtime.getURL(f));
      const b = await r.arrayBuffer();
      lines.push(`${f}: HTTP ${r.status}, ${b.byteLength} байт`);
    } catch (e2) {
      lines.push(`${f}: не читается (${e2.message})`);
    }
  }
  lines.push('WebAssembly: ' + (typeof WebAssembly === 'object' ? 'поддерживается' : 'НЕТ'));
  try {
    const simd = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
    lines.push('WASM SIMD: ' + (simd ? 'да' : 'НЕТ (нужен более новый Chrome)'));
  } catch (e3) {
    lines.push('WASM SIMD: проверка не удалась');
  }
  if (engine.log && engine.log.length) lines.push('Вывод движка: ' + engine.log.slice(-5).join(' | '));
  lines.push('Браузер: ' + navigator.userAgent);
  return lines.join('\n');
}

// ---------- Обмен с контент-скриптом ----------

function post(msg) {
  window.parent.postMessage(msg, PARENT_ORIGIN);
}

window.addEventListener('message', (e) => {
  if (e.origin !== PARENT_ORIGIN || e.source !== window.parent) return;
  const msg = e.data || {};
  if (msg.type === 'game') onGame(msg);
  else if (msg.type === 'scale') document.documentElement.style.zoom = String(msg.scale || 1);
});

// ---------- Текущая партия ----------

function buildChess(moves) {
  const c = new Chess();
  for (const san of moves) c.move(san);
  return c;
}

const liveBusy = () => !!(state.game && state.game.kind === 'round' && state.game.myColor && state.chess && !state.chess.isGameOver() && !state.game.gameOver);

async function onGame(msg) {
  const prevGame = state.game;
  state.game = msg;
  let chess;
  try {
    chess = buildChess(msg.moves);
  } catch (e) {
    state.error = 'Не удалось разобрать ходы партии (возможно, это вариант или партия из произвольной позиции).';
    state.key = null;
    render();
    return;
  }
  state.error = null;

  // Новая партия на странице
  const newGame = !prevGame || prevGame.gameId !== msg.gameId || (msg.moves.length === 0 && state.moves.length > 0);
  if (newGame) {
    state.records = [];
    state.key = null;
    state.pending = null;
    state.visible = !state.settings.startInvisible;
    state.ratedDismissed = false;
    state.gameData = null;
    if (msg.kind === 'round' && msg.gameId && msg.myColor) await restoreGame(msg);
  }

  const newKey = msg.moves.join(' ');
  if (newKey === state.key) {
    updateGameData(msg);
    render();
    return;
  }

  // Готовим разбор только что сделанного хода.
  const prev = state.key !== null ? { key: state.key, moves: state.moves, fen: state.fen, lines: state.lines, viewingAll: state.viewingAll } : null;
  state.pending = null;
  if (prev && prev.lines.length && prev.viewingAll && msg.viewing === msg.total && msg.moves.length === prev.moves.length + 1 && prev.key === msg.moves.slice(0, -1).join(' ')) {
    const before = new Chess(prev.fen);
    const mover = before.turn();
    let playedUci = null;
    try {
      const m = before.move(msg.moves[msg.moves.length - 1]);
      playedUci = m.from + m.to + (m.promotion || '');
    } catch (e) {
      playedUci = null;
    }
    if (playedUci) {
      state.pending = {
        ply: prev.moves.length,
        mover,
        mine: !!msg.myColor && mover === msg.myColor[0],
        playedSan: msg.moves[msg.moves.length - 1],
        playedUci,
        fenBefore: prev.fen,
        linesBefore: prev.lines,
      };
    }
  }

  state.key = newKey;
  state.moves = msg.moves;
  state.viewingAll = msg.viewing === msg.total;
  state.chess = chess;
  state.fen = chess.fen();
  state.lines = [];
  state.depth = 0;
  state.done = false;
  state.threat = null;
  state.reveal = state.settings.visibleStyle === 'assistant' ? 3 : 0;

  if (chess.isGameOver()) {
    engine.stop();
    finalizePending(true);
    updateGameData(msg);
    render();
    return;
  }
  startAnalysis();
  updateGameData(msg);
  render();
}

function startAnalysis() {
  const reqId = ++state.reqId;
  const fen = state.fen;
  const { movetime, multipv, threats } = state.settings;
  engine
    .analyze(fen, {
      movetime,
      multipv,
      onInfo: (lines) => {
        if (reqId !== state.reqId) return;
        state.lines = lines;
        state.depth = lines[0].depth;
        if (state.pending && state.depth >= 10) finalizePending(false);
        render();
      },
    })
    .then((res) => {
      if (!res || reqId !== state.reqId) return;
      if (res.lines.length) state.lines = res.lines;
      state.done = true;
      finalizePending(false);
      render();
      if (threats && !state.chess.isCheck() && state.lines.length) {
        engine.analyze(fenSwapTurn(fen), { movetime: Math.max(300, Math.round(movetime * 0.4)), multipv: 1 }).then((tr) => {
          if (!tr || reqId !== state.reqId || !tr.lines.length) return;
          state.threat = explainThreat(fen, tr.lines[0].pv[0], tr.lines[0].score);
          render();
        });
      }
    });
}

// Оценка сыгранного хода после того, как проанализирована новая позиция.
function finalizePending(terminal) {
  const p = state.pending;
  if (!p) return;
  const best = p.linesBefore[0];
  if (!best) {
    state.pending = null;
    return;
  }
  let evalAfter;
  if (terminal) {
    evalAfter = state.chess.isCheckmate() ? { mate: 1 } : { cp: 0 };
  } else {
    if (!state.lines.length) return;
    evalAfter = negate(state.lines[0].score);
  }
  const evalBefore = best.score;
  const deltaWin = Math.max(0, winPct(evalBefore) - winPct(evalAfter));
  const bestUci = best.pv[0];
  const isBest = p.playedUci === bestUci || deltaWin < 0.5;
  const quality = classify(deltaWin, isBest);

  const before = new Chess(p.fenBefore);
  let punish = null;
  let threatCtx = null;
  if (!terminal && state.lines.length && (quality === 'inaccuracy' || quality === 'mistake' || quality === 'blunder')) {
    const pu = state.lines[0].pv[0];
    const ex = explainMove(state.chess, pu, { rank: 0, mate: state.lines[0].score.mate });
    punish = { san: ex.san, uci: pu, reasons: ex.reasons.slice(0, 2), tags: ex.tags };
    // Наказание часто и есть та угроза, которую лучший ход должен был снять.
    threatCtx = explainThreat(p.fenBefore, pu, state.lines[0].score);
  }
  const bestEx = explainMove(before, bestUci, { rank: 0, mate: best.score.mate, threat: threatCtx });
  const playedEx = explainMove(before, p.playedUci, { rank: 1 });
  const tags = [...new Set([...(punish ? punish.tags : []), ...bestEx.tags])].slice(0, 3);

  const record = {
    ply: p.ply,
    mine: p.mine,
    mover: p.mover,
    san: p.playedSan,
    uci: p.playedUci,
    quality,
    deltaWin,
    bestSan: bestEx.san,
    bestUci,
    bestPv: best.pv.slice(0, 8),
    bestReasons: bestEx.reasons.slice(0, 3),
    playedReasons: playedEx.reasons.slice(0, 2),
    punish,
    threat: threatCtx ? { uci: threatCtx.uci, san: threatCtx.san, from: threatCtx.from, to: threatCtx.to, captured: threatCtx.captured, mate: threatCtx.mate } : null,
    tags,
    evalBefore,
    evalAfter,
    depth: best.depth,
    moveNumber: Math.floor(p.ply / 2) + 1,
  };
  const idx = state.records.findIndex((r) => r.ply === p.ply);
  if (idx >= 0) state.records[idx] = record;
  else state.records.push(record);
  state.records = state.records.filter((r) => r.ply <= p.ply).sort((a, b) => a.ply - b.ply);
  state.pending = null;
  scheduleSave();
}

// ---------- Сохранение партий ----------

async function restoreGame(msg) {
  const saved = await store.loadGame(msg.gameId);
  if (saved && saved.moves.length <= msg.moves.length && msg.moves.slice(0, saved.moves.length).join(' ') === saved.moves.join(' ')) {
    state.gameData = saved;
    state.records = saved.records || [];
    if (saved.visibleFrom !== null && saved.visibleFrom !== undefined) state.visible = true;
  }
}

function updateGameData(msg) {
  if (msg.kind !== 'round' || !msg.gameId || !msg.myColor) return;
  if (!state.gameData || state.gameData.id !== msg.gameId) {
    state.gameData = {
      id: msg.gameId,
      url: 'https://lichess.org/' + msg.gameId,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      myColor: msg.myColor,
      rated: msg.rated,
      me: msg.players ? msg.players.bottom : null,
      opponent: msg.players ? msg.players.top : null,
      result: null,
      moves: [],
      records: [],
      visibleFrom: null,
      finished: false,
    };
  }
  const g = state.gameData;
  if (msg.viewing === msg.total && msg.moves.length >= g.moves.length) g.moves = msg.moves.slice();
  g.records = state.records;
  g.rated = msg.rated;
  if (msg.players) {
    g.me = msg.players.bottom || g.me;
    g.opponent = msg.players.top || g.opponent;
  }
  if (msg.resultText) g.result = msg.resultText;
  const over = msg.gameOver || (state.chess && state.chess.isGameOver());
  if (over) g.finished = true;
  g.updatedAt = Date.now();
  scheduleSave();
}

function scheduleSave() {
  if (!state.gameData || state.gameData.moves.length < 2) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(async () => {
    const g = state.gameData;
    if (!g) return;
    state.index = await store.saveGame(g, summarize(g.records));
  }, 800);
}

// ---------- Разбор партии ----------

function openReview(game, ply) {
  state.review = { game, ply: Math.max(0, Math.min(ply, game.moves.length)), lines: [], depth: 0, done: false, reqId: 0 };
  state.tab = 'review';
  reviewGoto(state.review.ply);
}

function reviewFen(game, ply) {
  const c = new Chess();
  for (const san of game.moves.slice(0, ply)) c.move(san);
  return c;
}

function reviewGoto(ply) {
  const r = state.review;
  if (!r) return;
  r.ply = Math.max(0, Math.min(ply, r.game.moves.length));
  r.lines = [];
  r.depth = 0;
  r.done = false;
  r.reqId++;
  render();
  if (!state.settings.reviewAnalyze || liveBusy()) return;
  const reqId = r.reqId;
  let chess;
  try {
    chess = reviewFen(r.game, r.ply);
  } catch (e) {
    return;
  }
  if (chess.isGameOver()) return;
  engine
    .analyze(chess.fen(), {
      movetime: state.settings.movetime,
      multipv: state.settings.multipv,
      onInfo: (lines) => {
        if (!state.review || reqId !== state.review.reqId) return;
        r.lines = lines;
        r.depth = lines[0].depth;
        render();
      },
    })
    .then((res) => {
      if (!res || !state.review || reqId !== state.review.reqId) return;
      if (res.lines.length) r.lines = res.lines;
      r.done = true;
      render();
    });
}

// ---------- Отрисовка ----------

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function lessonChip(tag) {
  const l = lessonFor(tag);
  if (!l) return '';
  return `<span class="tagchip" data-lesson="${l.id}" title="${esc(l.short)}">урок ${esc(l.title.split('.')[0])}</span>`;
}

function candidatesHtml(chess, fen, lines, threat, max) {
  lines = lines.slice(0, max);
  if (!lines.length) return '<div class="muted"><span class="spinner"></span>Движок думает…</div>';
  const scores = lines.map((l) => (typeof l.score.mate === 'number' ? (l.score.mate > 0 ? 10000 - l.score.mate : -10000 - l.score.mate) : l.score.cp));
  return lines
    .map((line, i) => {
      const ctx = {
        rank: i,
        mate: line.score.mate,
        threat,
        gapToSecond: i === 0 && scores.length > 1 ? scores[0] - scores[1] : null,
        gapToBest: i > 0 ? scores[0] - scores[i] : null,
      };
      const ex = explainMove(chess, line.pv[0], ctx);
      const pv = pvToSan(fen, line.pv, 7).join(' ');
      return `<div class="cand">
        <div class="head"><span class="san">${esc(ex.san)}</span><span class="score">${fmtScore(line.score, chess.turn() === 'w')}</span><span class="muted small">глубина ${line.depth}</span></div>
        <ul>${ex.reasons.slice(0, 3).map((r) => `<li>${esc(r.text)}${lessonChip(r.tag)}</li>`).join('')}</ul>
        ${ex.warnings.map((w) => `<div class="warn-text">⚠ ${esc(w)}</div>`).join('')}
        <div class="pv">План: ${esc(pv)}</div>
      </div>`;
    })
    .join('');
}

function threatHtml() {
  const t = state.threat;
  if (!state.settings.threats) return '';
  if (!t) return `<div class="card"><h3>Что задумал соперник</h3><div class="muted small"><span class="spinner"></span>Ищу угрозы…</div></div>`;
  const serious = t.mate || (t.captured && t.reasons.length);
  return `<div class="card ${t.mate ? 'danger' : ''}"><h3>Что задумал соперник <span class="sub">если бы ход был его</span></h3>
    <div><b>${esc(t.san)}</b>${serious ? '' : ' <span class="muted small">— серьёзной угрозы нет</span>'}</div>
    <ul class="small" style="margin:4px 0 0;padding-left:18px">${t.reasons.map((r) => `<li>${esc(r.text)}${lessonChip(r.tag)}</li>`).join('')}</ul>
  </div>`;
}

function feedbackHtml(rec, title) {
  const q = QUALITY[rec.quality];
  const good = rec.quality === 'best' || rec.quality === 'excellent' || rec.quality === 'good';
  let html = `<div class="card feedback"><h3>${esc(title)}</h3>
    <div><span class="played">${rec.moveNumber}.${rec.mover === 'b' ? '..' : ''} ${esc(rec.san)}</span>
    <span class="badge" style="background:${q.color}">${q.icon} ${q.label}</span>
    <span class="muted small">${rec.deltaWin >= 1 ? `−${rec.deltaWin.toFixed(0)}% к шансам` : ''}</span></div>`;
  if (good) {
    html += `<ul>${rec.playedReasons.map((r) => `<li>${esc(r.text)}${lessonChip(r.tag)}</li>`).join('')}</ul>`;
    if (rec.quality !== 'best') html += `<div class="better small muted">Сильнее было <b>${esc(rec.bestSan)}</b>: ${esc(rec.bestReasons[0] ? rec.bestReasons[0].text : '')}</div>`;
  } else {
    if (rec.punish) html += `<div class="better">Теперь соперник может <b>${esc(rec.punish.san)}</b>:<ul>${rec.punish.reasons.map((r) => `<li>${esc(r.text)}${lessonChip(r.tag)}</li>`).join('')}</ul></div>`;
    html += `<div class="better">Лучше было <b>${esc(rec.bestSan)}</b>:<ul>${rec.bestReasons.map((r) => `<li>${esc(r.text)}${lessonChip(r.tag)}</li>`).join('')}</ul></div>`;
    const l = lessonFor(rec.tags[0]);
    if (l) html += `<div class="small" style="margin-top:6px">📘 Урок по теме: <span class="tagchip" data-lesson="${l.id}">${esc(l.title)}</span></div>`;
  }
  return html + '</div>';
}

function dotsHtml(records, gameForReview) {
  const mine = records.filter((r) => r.mine);
  if (!mine.length) return '';
  return `<div class="card"><h3>Ваши ходы в этой партии</h3><div class="dots">${mine
    .map((r) => `<span class="dot" data-review-ply="${r.ply}" style="background:${QUALITY[r.quality].color}" title="${r.moveNumber}. ${esc(r.san)} — ${QUALITY[r.quality].label}"></span>`)
    .join('')}</div>${gameForReview ? '<div class="small muted" style="margin-top:4px">Нажмите на точку, чтобы открыть разбор этого хода.</div>' : ''}</div>`;
}

function summaryHtml(records) {
  const s = summarize(records);
  if (!s.total) return `<div class="card summary"><h3>Партия окончена</h3><div class="muted">Нет данных по вашим ходам: партия шла без тренера. Полный разбор с движком доступен по кнопке.</div>
    <div style="margin-top:8px"><button class="btn primary" data-action="review-current">Открыть разбор партии</button></div>
  </div>`;
  const c = s.counts;
  const lessons = s.topTags.map((t) => lessonFor(t)).filter(Boolean);
  const key = s.worst.filter((r) => r.deltaWin >= 5);
  return `<div class="card summary"><h3>Итоги партии</h3>
    <div class="stat"><span>Точность ваших ходов</span><span class="acc">${s.accuracy}%</span></div>
    <div class="stat"><span>Лучших / хороших</span><span>${c.best + c.excellent} / ${c.good}</span></div>
    <div class="stat"><span>Неточностей / ошибок / грубых</span><span>${c.inaccuracy} / ${c.mistake} / ${c.blunder}</span></div>
    ${key.length ? `<div style="margin-top:6px"><b>Ключевые моменты:</b><ul style="margin:4px 0;padding-left:18px">${key
      .map((r) => `<li><a href="#" data-review-ply="${r.ply}">${r.moveNumber}.${r.mover === 'b' ? '..' : ''} ${esc(r.san)}</a> (${QUALITY[r.quality].label.toLowerCase()}) — лучше ${esc(r.bestSan)}${r.bestReasons[0] ? ': ' + esc(r.bestReasons[0].text) : ''}</li>`)
      .join('')}</ul></div>` : '<div class="muted small" style="margin-top:6px">Серьёзных ошибок не было — отличная партия!</div>'}
    ${lessons.length ? `<div style="margin-top:6px"><b>Что изучить:</b> ${lessons.map((l) => `<span class="tagchip" data-lesson="${l.id}">${esc(l.title)}</span>`).join(' ')}</div>` : ''}
    <div style="margin-top:8px"><button class="btn primary" data-action="review-current">Открыть разбор партии</button></div>
  </div>`;
}

function lastMoveInfo() {
  if (!state.moves.length) return null;
  const c = new Chess();
  let m = null;
  for (const san of state.moves) m = c.move(san);
  return m ? { san: m.san, captured: m.captured, check: c.isCheck() } : null;
}

function renderGame() {
  const g = state.game;
  if (state.engineError) return `<div class="card danger"><pre class="diag">${esc(state.engineError)}</pre><button class="btn" data-action="reload-panel">Перезапустить панель</button> <span class="small">Скопируйте текст выше и пришлите его для исправления.</span></div>`;
  if (!g) return `<div class="card"><span class="spinner"></span>Жду партию на странице lichess…</div>`;
  if (state.error) return `<div class="card warn">${esc(state.error)}</div>`;
  const chess = state.chess;
  if (!chess) return '';

  const over = chess.isGameOver() || g.gameOver;
  const playing = g.kind === 'round' && !!g.myColor;
  let html = '';

  // Невидимый режим во время партии
  if (playing && !over && !state.visible) {
    const analyzed = state.records.filter((r) => r.mine).length;
    html += `<div class="card"><h3>Невидимый режим</h3>
      <div class="small">Вы играете сами. Партия анализируется в фоне: после окончания вы получите разбор каждого хода, а история сохранится.</div>
      <div class="small muted" style="margin-top:4px">Ваших ходов проанализировано: ${analyzed} · ход ${chess.moveNumber()}</div>
      <div style="margin-top:8px"><button class="btn primary" data-action="show-hints">Включить подсказки с этого хода</button></div>
    </div>`;
    html += `<div class="card small muted">Совет: перед каждым ходом всё равно проходите три вопроса — шахи, взятия, угрозы ${lessonChip('cct')}. Так вы тренируете мышление, а разбор после партии покажет, где оно дало сбой.</div>`;
    return html;
  }

  if (g.rated && !state.ratedDismissed && !over) {
    html += `<div class="card warn small">Это рейтинговая партия. Использование подсказок движка в рейтинговых партиях нарушает правила lichess и ведёт к бану. Для обучения с подсказками играйте нерейтинговые партии, а рейтинговые разбирайте после окончания. <button class="btn small" data-action="dismiss-rated">Понятно</button></div>`;
  }

  if (playing && !over) {
    html += `<div class="card small" style="display:flex;justify-content:space-between;align-items:center"><span>Подсказки включены${state.gameData && state.gameData.visibleFrom !== null ? ` с хода ${Math.floor(state.gameData.visibleFrom / 2) + 1}` : ''}</span><button class="btn small" data-action="hide-hints">Скрыть</button></div>`;
  }

  const turn = chess.turn();
  const myTurn = g.myColor ? g.myColor[0] === turn : null;
  const top = state.lines[0];
  const scoreWhite = top ? (turn === 'w' ? top.score : negate(top.score)) : null;
  const who = over ? 'Партия окончена' : myTurn === true ? 'Ваш ход' : myTurn === false ? 'Ход соперника' : `Ход ${turn === 'w' ? 'белых' : 'чёрных'}`;
  const pct = scoreWhite ? winPct(scoreWhite) : 50;

  if (over) html += summaryHtml(state.records);

  html += `<div class="card"><div class="turn"><span class="who">${who}</span><span class="eval">${scoreWhite ? fmtScore(scoreWhite) : '…'}</span></div>
    <div class="evalbar"><div style="width:${pct}%"></div></div>
    <div class="status">${scoreWhite ? esc(scoreWords(scoreWhite)) + ' · ' : ''}${over ? 'партия окончена' : state.done ? 'глубина ' + state.depth : `<span class="spinner"></span>считаю… глубина ${state.depth}`}</div></div>`;

  const lastRec = state.records[state.records.length - 1];
  const lastMyRec = [...state.records].reverse().find((r) => r.mine);
  const teacher = state.settings.visibleStyle === 'teacher';
  const showForMe = myTurn !== false;

  if (!chess.isGameOver()) {
    if (showForMe) {
      const lastMove = lastMoveInfo();
      const oppBlunder = lastRec && !lastRec.mine && (lastRec.quality === 'mistake' || lastRec.quality === 'blunder');
      if (teacher) {
        const prompts = thinkingPrompts({ chess, lastMove, threat: state.threat, myTime: g.myTime, phase: detectPhase(chess), oppBlunder });
        html += `<div class="card"><h3>Модель мышления <span class="sub">сначала подумайте сами</span></h3>${prompts
          .map((p) => `<div class="prompt"><b>${esc(p.title)}</b>${esc(p.text)} ${lessonChip(p.tag)}</div>`)
          .join('')}</div>`;

        const ex = top ? explainMove(chess, top.pv[0], { rank: 0, mate: top.score.mate, threat: state.threat }) : null;
        html += `<div class="card"><h3>Подсказка <span class="sub">открывайте постепенно</span></h3>
          <div class="hintbar">
            ${[['1', 'Идея'], ['2', 'Какой фигурой'], ['3', 'Ход']]
              .map(([lvl, label]) => {
                const n = parseInt(lvl, 10);
                const done = state.reveal >= n;
                const next = state.reveal === n - 1;
                return `<button class="btn ${done ? 'done' : next ? 'next' : ''}" data-action="reveal" data-level="${lvl}" ${!top || done ? 'disabled' : ''}>${done ? '✓ ' : ''}${lvl}. ${label}</button>`;
              })
              .join('')}
          </div>
          ${state.reveal >= 1 && ex ? `<div class="prompt"><b>Идея</b>${esc(ideaHint(ex, state.threat, chess))}</div>` : ''}
          ${state.reveal >= 2 && ex ? `<div class="prompt"><b>Фигура</b>${esc(pieceHint(ex))}${state.reveal < 3 ? ' <span class="muted">Куда именно — откроет шаг «3. Ход».</span>' : ''}</div>` : ''}
          ${state.reveal >= 3 ? candidatesHtml(chess, state.fen, state.lines, state.threat, state.settings.multipv) : ''}
        </div>`;
        if (state.reveal >= 1) html += threatHtml();
      } else {
        html += `<div class="card"><h3>Лучшие ходы</h3>${candidatesHtml(chess, state.fen, state.lines, state.threat, state.settings.multipv)}</div>`;
        html += threatHtml();
      }
      if (oppBlunder) html += feedbackHtml(lastRec, teacher ? 'Соперник ошибся — найдите наказание' : 'Соперник ошибся');
    } else {
      html += `<div class="card"><h3>Соперник думает</h3><div class="small">Пока ждёте, спросите себя: чего он хочет? Какой его ход был бы для вас самым неприятным? ${lessonChip('prophylaxis')}</div>
        ${top ? `<div class="small muted" style="margin-top:4px">Движок ожидает: <b>${esc(sanOf(state.fen, top.pv[0]))}</b></div>` : ''}</div>`;
    }
  }

  if (lastMyRec) html += feedbackHtml(lastMyRec, 'Разбор вашего последнего хода');
  html += dotsHtml(state.records, true);
  return html;
}

function evalGraphSvg(game, ply) {
  const recs = (game.records || []).slice().sort((a, b) => a.ply - b.ply);
  if (recs.length < 2) return '';
  const n = game.moves.length;
  const pts = recs.map((r) => {
    const sw = r.mover === 'w' ? r.evalAfter : negate(r.evalAfter);
    const p = winPct(sw);
    return [((r.ply + 1) / n) * 100, 100 - p];
  });
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const marks = recs
    .filter((r) => r.mine && (r.quality === 'mistake' || r.quality === 'blunder'))
    .map((r) => {
      const sw = r.mover === 'w' ? r.evalAfter : negate(r.evalAfter);
      return `<circle cx="${(((r.ply + 1) / n) * 100).toFixed(1)}" cy="${(100 - winPct(sw)).toFixed(1)}" r="3" fill="${QUALITY[r.quality].color}"/>`;
    })
    .join('');
  const x = ((ply / n) * 100).toFixed(1);
  return `<svg class="evalgraph" viewBox="0 0 100 100" preserveAspectRatio="none"><rect x="0" y="0" width="100" height="100" fill="#444"/><path d="${path} L100,100 L0,100 Z" fill="#eee"/><line x1="0" y1="50" x2="100" y2="50" stroke="#999" stroke-width="0.5"/><line x1="${x}" y1="0" x2="${x}" y2="100" stroke="#2f6f3e" stroke-width="1"/>${marks}</svg>`;
}

function renderReview() {
  const r = state.review;
  if (!r) {
    const g = state.gameData;
    return `<div class="card"><h3>Разбор партии</h3><div class="small">Здесь можно пройти по любой партии ход за ходом: увидеть оценку, лучший ход и объяснение.</div>
      ${g && g.moves.length ? `<div style="margin-top:8px"><button class="btn primary" data-action="review-current">Разобрать текущую партию</button></div>` : ''}
      <div style="margin-top:8px"><button class="btn" data-tab-go="history">Открыть историю партий</button></div></div>`;
  }
  const g = r.game;
  let chess;
  try {
    chess = reviewFen(g, r.ply);
  } catch (e) {
    return `<div class="card danger">Не удалось воспроизвести ходы партии.</div>`;
  }
  const fen = chess.fen();
  const rec = (g.records || []).find((x) => x.ply === r.ply);
  const prevRec = (g.records || []).find((x) => x.ply === r.ply - 1);
  const orientation = g.myColor || 'white';
  const arrows = [];
  let lastMove = null;
  if (r.ply > 0) {
    const c2 = reviewFen(g, r.ply - 1);
    const m = c2.move(g.moves[r.ply - 1]);
    lastMove = [m.from, m.to];
  }
  if (rec) {
    arrows.push({ ...uciToMove(rec.uci), color: rec.quality === 'best' || rec.quality === 'excellent' || rec.quality === 'good' ? '#1a7f37' : QUALITY[rec.quality].color });
    if (rec.uci !== rec.bestUci) arrows.push({ ...uciToMove(rec.bestUci), color: '#1565c0', opacity: 0.6, width: 0.12 });
  } else if (r.lines[0]) {
    arrows.push({ ...uciToMove(r.lines[0].pv[0]), color: '#1565c0', opacity: 0.6, width: 0.12 });
  }

  const turn = chess.turn();
  const liveScore = r.lines[0] ? (turn === 'w' ? r.lines[0].score : negate(r.lines[0].score)) : null;
  const storedScore = rec ? (rec.mover === 'w' ? rec.evalBefore : negate(rec.evalBefore)) : prevRec ? (prevRec.mover === 'w' ? prevRec.evalAfter : negate(prevRec.evalAfter)) : null;
  const scoreWhite = liveScore || storedScore;

  let html = `<div class="card review-head">
    <div class="small"><b>${esc(g.me || 'Вы')}</b> (${g.myColor === 'white' ? 'белые' : 'чёрные'}) — <b>${esc(g.opponent || 'соперник')}</b>${g.result ? ` · ${esc(g.result)}` : ''} · <a href="${esc(g.url)}" target="_blank" rel="noopener">lichess</a></div>
    ${boardSvg(fen, { orientation, arrows, lastMove })}
    <div class="nav">
      <button class="btn" data-review-go="0" title="В начало">⏮</button>
      <button class="btn" data-review-go="${r.ply - 1}" title="Назад (←)">◀</button>
      <span class="plyinfo">${r.ply === 0 ? 'Начало' : `${Math.floor((r.ply - 1) / 2) + 1}.${(r.ply - 1) % 2 ? '..' : ''} ${esc(g.moves[r.ply - 1])}`} <span class="muted">/ ${g.moves.length}</span></span>
      <button class="btn" data-review-go="${r.ply + 1}" title="Вперёд (→)">▶</button>
      <button class="btn" data-review-go="${g.moves.length}" title="В конец">⏭</button>
    </div>
    ${evalGraphSvg(g, r.ply)}
    <div class="turn"><span class="who">Ход ${turn === 'w' ? 'белых' : 'чёрных'}${g.myColor && g.myColor[0] === turn ? ' (ваш)' : ''}</span><span class="eval">${scoreWhite ? fmtScore(scoreWhite) : '…'}</span></div>
    <div class="status">${scoreWhite ? esc(scoreWords(scoreWhite)) : ''}${liveBusy() ? ' · движок занят текущей партией' : r.done ? ' · глубина ' + r.depth : state.settings.reviewAnalyze && !chess.isGameOver() ? ` · <span class="spinner"></span>считаю…` : ''}</div>
  </div>`;

  if (rec) {
    html += feedbackHtml(rec, rec.mine ? 'Ваш ход в этой позиции' : 'Ход соперника в этой позиции');
    if (rec.bestPv && rec.bestPv.length) html += `<div class="card small"><b>Линия движка во время партии:</b> ${esc(pvToSan(fen, rec.bestPv, 8).join(' '))}</div>`;
  }
  if (!chess.isGameOver() && (r.lines.length || (state.settings.reviewAnalyze && !liveBusy()))) {
    html += `<div class="card"><h3>Анализ позиции <span class="sub">лучшие ходы и почему</span></h3>${candidatesHtml(chess, fen, r.lines, rec ? rec.threat || null : null, state.settings.multipv)}</div>`;
  }
  if (chess.isGameOver()) html += `<div class="card">${chess.isCheckmate() ? 'Мат.' : 'Партия окончена.'}</div>`;

  // список ходов
  const cells = [];
  for (let i = 0; i < g.moves.length; i++) {
    const rr = (g.records || []).find((x) => x.ply === i);
    const col = rr ? QUALITY[rr.quality].color : '#999';
    const mark = rr && (rr.quality === 'inaccuracy' || rr.quality === 'mistake' || rr.quality === 'blunder') ? QUALITY[rr.quality].icon : '';
    cells.push(`${i % 2 === 0 ? `<span class="num">${i / 2 + 1}.</span>` : ''}<span class="mv ${i + 1 === r.ply ? 'cur' : ''}" data-review-go="${i + 1}" style="border-bottom:2px solid ${col}">${esc(g.moves[i])}${mark}</span>`);
  }
  html += `<div class="card movelist">${cells.join(' ')}</div>`;
  html += summaryHtml(g.records || []).replace(/<div style="margin-top:8px"><button class="btn primary" data-action="review-current">[^<]*<\/button><\/div>/, '');
  return html;
}

function renderHistory() {
  const list = state.index;
  let html = `<div class="card small muted">Все ваши партии на lichess, сыгранные с включённым расширением, сохраняются в браузере. Нажмите на партию, чтобы открыть разбор.</div>`;
  if (!list.length) return html + `<div class="card">Пока нет сохранённых партий. Сыграйте партию на lichess — она появится здесь.</div>`;
  html += list
    .map((e) => {
      const d = new Date(e.startedAt || e.updatedAt);
      const date = `${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
      return `<div class="card hist" data-open-game="${esc(e.id)}">
        <div class="lt"><b>${e.myColor === 'white' ? '⬜' : '⬛'} ${esc(e.opponent || 'соперник')}</b><span class="muted small">${date}</span></div>
        <div class="small">${e.result ? esc(e.result) : e.finished ? 'завершена' : 'в процессе'} · ${e.moves} ходов · точность ${e.accuracy != null ? e.accuracy + '%' : '—'} · ошибок ${e.mistakes || 0}${e.rated ? ' · рейтинговая' : ''}</div>
        <div style="margin-top:4px"><button class="btn small" data-open-game="${esc(e.id)}">Разбор</button> <button class="btn small" data-delete-game="${esc(e.id)}">Удалить</button></div>
      </div>`;
    })
    .join('');
  return html;
}

function renderLessons() {
  const s = summarize(state.records);
  const rec = s.topTags.map((t) => lessonFor(t)).filter(Boolean)[0];
  let html = `<div class="card small muted">Курс из 13 уроков: модели мышления, которые применяют сильные игроки. Читайте по одному уроку в день и применяйте чек-лист в партиях. Подсказки и разбор ходов ссылаются на эти уроки.</div>`;
  if (rec) html += `<div class="card"><b>Рекомендация по вашим ошибкам:</b> <span class="tagchip" data-lesson="${rec.id}">${esc(rec.title)}</span></div>`;
  html += LESSONS.map(
    (l) => `<div class="card lesson ${state.openLesson === l.id ? 'open' : ''} ${state.readLessons[l.id] ? 'read' : ''}" data-lesson-card="${l.id}">
      <div class="lt"><b>${esc(l.title)}</b><input type="checkbox" title="Изучено" data-read="${l.id}" ${state.readLessons[l.id] ? 'checked' : ''}></div>
      <div class="small muted">${esc(l.short)}</div>
      <div class="body">${l.body}<b class="small">Чек-лист:</b><ul class="check small">${l.checklist.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>
    </div>`
  ).join('');
  return html;
}

function renderSettings() {
  const s = state.settings;
  return `<div class="card settings">
    <label><span>Новая партия начинается в невидимом режиме</span><input type="checkbox" data-set="startInvisible" ${s.startInvisible ? 'checked' : ''}></label>
    <label><span>Стиль подсказок</span><select data-set="visibleStyle"><option value="teacher" ${s.visibleStyle === 'teacher' ? 'selected' : ''}>Учитель (постепенно)</option><option value="assistant" ${s.visibleStyle === 'assistant' ? 'selected' : ''}>Помощник (сразу)</option></select></label>
    <label><span>Время на анализ: <b>${(s.movetime / 1000).toFixed(1)} с</b></span><input type="range" min="500" max="5000" step="250" value="${s.movetime}" data-set="movetime"></label>
    <label><span>Количество вариантов</span><select data-set="multipv">${[1, 2, 3, 4].map((n) => `<option value="${n}" ${s.multipv === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <label><span>Искать угрозы соперника</span><input type="checkbox" data-set="threats" ${s.threats ? 'checked' : ''}></label>
    <label><span>Стрелки на доске lichess</span><input type="checkbox" data-set="arrows" ${s.arrows ? 'checked' : ''}></label>
    <label><span>Стрелки для альтернатив</span><input type="checkbox" data-set="altArrows" ${s.altArrows ? 'checked' : ''}></label>
    <label><span>Анализировать позиции в разборе</span><input type="checkbox" data-set="reviewAnalyze" ${s.reviewAnalyze ? 'checked' : ''}></label>
  </div>
  <div class="card small muted">Движок: Stockfish 18 lite, работает локально в браузере; партии и настройки хранятся только в вашем браузере, ничего не отправляется в интернет. Расширение предназначено для обучения: используйте подсказки в нерейтинговых партиях, а рейтинговые разбирайте после окончания.</div>`;
}

function render() {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.tab));
  const scroll = view.scrollTop;
  if (state.tab === 'game') view.innerHTML = renderGame();
  else if (state.tab === 'review') view.innerHTML = renderReview();
  else if (state.tab === 'history') view.innerHTML = renderHistory();
  else if (state.tab === 'lessons') view.innerHTML = renderLessons();
  else view.innerHTML = renderSettings();
  view.scrollTop = scroll;
  sendArrows();
  sendStatus();
}

function hintsHidden() {
  const g = state.game;
  return !!(g && g.kind === 'round' && g.myColor && !state.visible && state.chess && !state.chess.isGameOver() && !g.gameOver);
}

function sendStatus() {
  if (hintsHidden()) return post({ type: 'status', text: 'невидимый режим' });
  if (state.chess && (state.chess.isGameOver() || (state.game && state.game.gameOver))) return post({ type: 'status', text: 'партия окончена' });
  const top = state.lines[0];
  if (!state.chess || !top) return post({ type: 'status', text: state.game ? 'думаю…' : '' });
  const sw = state.chess.turn() === 'w' ? top.score : negate(top.score);
  post({ type: 'status', text: `${fmtScore(sw)} · глубина ${state.depth}` });
}

function sendArrows() {
  const shapes = [];
  const g = state.game;
  if (g && state.settings.arrows && state.chess && !state.chess.isGameOver() && !hintsHidden() && state.tab === 'game') {
    const turn = state.chess.turn();
    const myTurn = g.myColor ? g.myColor[0] === turn : null;
    const lines = state.lines;
    if (myTurn === false) {
      if (lines[0]) shapes.push({ ...uciToMove(lines[0].pv[0]), color: '#c62828', opacity: 0.7 });
    } else {
      if (state.reveal >= 3 && lines[0]) shapes.push({ ...uciToMove(lines[0].pv[0]), color: '#15781B' });
      if (state.reveal >= 3 && state.settings.altArrows) lines.slice(1, 3).forEach((l) => shapes.push({ ...uciToMove(l.pv[0]), color: '#1565c0', opacity: 0.5, width: 0.12 }));
      if (state.reveal >= 1 && state.threat && state.settings.threats && (state.threat.mate || state.threat.captured)) shapes.push({ from: state.threat.from, to: state.threat.to, color: '#c62828', opacity: 0.6, width: 0.12 });
    }
  }
  post({ type: 'arrows', shapes });
}

// ---------- События ----------

document.querySelector('.tabs').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (!t) return;
  state.tab = t.dataset.tab;
  if (state.tab === 'history') store.loadIndex().then((i) => { state.index = i; render(); });
  render();
});

async function openGameById(id) {
  const g = await store.loadGame(id);
  if (!g) return;
  const firstBad = (g.records || []).find((r) => r.mine && (r.quality === 'mistake' || r.quality === 'blunder'));
  openReview(g, firstBad ? firstBad.ply : 0);
}

view.addEventListener('click', async (e) => {
  const chip = e.target.closest('[data-lesson]');
  if (chip) {
    state.tab = 'lessons';
    state.openLesson = chip.dataset.lesson;
    render();
    const el = view.querySelector(`[data-lesson-card="${state.openLesson}"]`);
    if (el) el.scrollIntoView({ block: 'start' });
    return;
  }
  const go = e.target.closest('[data-review-go]');
  if (go) {
    reviewGoto(parseInt(go.dataset.reviewGo, 10));
    return;
  }
  const rp = e.target.closest('[data-review-ply]');
  if (rp) {
    e.preventDefault();
    if (state.gameData) openReview(state.gameData, parseInt(rp.dataset.reviewPly, 10));
    return;
  }
  const og = e.target.closest('[data-open-game]');
  if (og) {
    await openGameById(og.dataset.openGame);
    return;
  }
  const dg = e.target.closest('[data-delete-game]');
  if (dg) {
    if (confirm('Удалить эту партию из истории?')) {
      state.index = await store.deleteGame(dg.dataset.deleteGame);
      render();
    }
    return;
  }
  const tg = e.target.closest('[data-tab-go]');
  if (tg) {
    state.tab = tg.dataset.tabGo;
    if (state.tab === 'history') state.index = await store.loadIndex();
    render();
    return;
  }
  const btn = e.target.closest('[data-action]');
  if (btn) {
    const a = btn.dataset.action;
    if (a === 'reveal') state.reveal = Math.max(state.reveal, parseInt(btn.dataset.level, 10));
    else if (a === 'dismiss-rated') state.ratedDismissed = true;
    else if (a === 'show-hints') {
      state.visible = true;
      if (state.gameData && state.gameData.visibleFrom === null) {
        state.gameData.visibleFrom = state.moves.length;
        scheduleSave();
      }
    } else if (a === 'hide-hints') state.visible = false;
    else if (a === 'review-current') {
      if (state.gameData) openReview(state.gameData, state.moves.length ? Math.max(0, state.game.viewing) : 0);
      return;
    }
    render();
    return;
  }
  if (e.target.matches('[data-read]')) {
    state.readLessons[e.target.dataset.read] = e.target.checked;
    store.set({ readLessons: state.readLessons });
    e.stopPropagation();
    render();
    return;
  }
  const card = e.target.closest('[data-lesson-card]');
  if (card) {
    state.openLesson = state.openLesson === card.dataset.lessonCard ? null : card.dataset.lessonCard;
    render();
  }
});

view.addEventListener('change', (e) => {
  const key = e.target.dataset.set;
  if (!key) return;
  const s = state.settings;
  if (e.target.type === 'checkbox') s[key] = e.target.checked;
  else if (key === 'movetime' || key === 'multipv') s[key] = parseInt(e.target.value, 10);
  else s[key] = e.target.value;
  store.set({ settings: s });
  if (key === 'visibleStyle') state.reveal = s.visibleStyle === 'assistant' ? 3 : 0;
  if ((key === 'movetime' || key === 'multipv' || key === 'threats') && state.chess && !state.chess.isGameOver() && liveBusy()) {
    state.lines = [];
    state.done = false;
    state.threat = null;
    startAnalysis();
  }
  render();
});
view.addEventListener('input', (e) => {
  if (e.target.dataset.set === 'movetime') {
    const b = e.target.closest('label').querySelector('b');
    if (b) b.textContent = (parseInt(e.target.value, 10) / 1000).toFixed(1) + ' с';
  }
});
document.addEventListener('keydown', (e) => {
  if (state.tab !== 'review' || !state.review) return;
  if (e.key === 'ArrowLeft') reviewGoto(state.review.ply - 1);
  else if (e.key === 'ArrowRight') reviewGoto(state.review.ply + 1);
  else if (e.key === 'Home') reviewGoto(0);
  else if (e.key === 'End') reviewGoto(state.review.game.moves.length);
  else return;
  e.preventDefault();
});

// ---------- Запуск ----------

store.get(['settings', 'readLessons']).then(async (v) => {
  if (v.settings) state.settings = { ...DEFAULT_SETTINGS, ...v.settings };
  if (v.readLessons) state.readLessons = v.readLessons;
  state.reveal = state.settings.visibleStyle === 'assistant' ? 3 : 0;
  state.index = await store.loadIndex();
  render();
  post({ type: 'ready' });
});
