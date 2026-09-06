// Контент-скрипт: читает ходы партии со страницы lichess, показывает панель тренера
// (iframe расширения) и рисует стрелки на доске.
(() => {
  if (window.__chessCoachLoaded) return;
  window.__chessCoachLoaded = true;

  const EXT_ORIGIN = new URL(chrome.runtime.getURL('/')).origin;
  const PANEL_URL = chrome.runtime.getURL('panel/panel.html');
  const FIGURINES = { '♘': 'N', '♗': 'B', '♖': 'R', '♕': 'Q', '♔': 'K', '♞': 'N', '♝': 'B', '♜': 'R', '♛': 'Q', '♚': 'K' };

  const cleanSan = (t) =>
    t
      .replace(/[♘♗♖♕♔♞♝♜♛♚]/g, (c) => FIGURINES[c])
      .replace(/[!?]+/g, '')
      .replace(/\s+/g, '')
      .trim();

  // ---------- Чтение состояния партии ----------

  function pageKind() {
    if (document.querySelector('main.puzzle')) return null;
    if (document.querySelector('.round__app')) return 'round';
    if (document.querySelector('.tview2')) return 'analyse';
    return null;
  }

  function readGame() {
    const kind = pageKind();
    if (!kind) return null;

    let nodes = [];
    let activeIdx = -1;
    if (kind === 'round') {
      // Широкая раскладка: <l4x><kwdb class="a">; узкая (col1): <app><z7yx class="a1t">.
      nodes = [...document.querySelectorAll('l4x kwdb, .col1-moves z7yx')];
      activeIdx = nodes.findIndex((n) => n.classList.contains('a') || n.classList.contains('a1t'));
    } else {
      nodes = [...document.querySelectorAll('.tview2 move')].filter(
        (m) => !m.classList.contains('empty') && !m.closest('lines, line, interrupt')
      );
      activeIdx = nodes.findIndex((n) => n.classList.contains('active'));
    }
    const upto = activeIdx >= 0 ? activeIdx + 1 : nodes.length;
    const moves = nodes.slice(0, upto).map((n) => cleanSan((n.querySelector('san') || n).textContent));

    const wrap = document.querySelector('.cg-wrap');
    const orientation = wrap && wrap.classList.contains('orientation-black') ? 'black' : 'white';

    let myColor = null;
    let rated = false;
    let gameOver = false;
    let myTime = null;
    let gameId = null;
    let players = null;
    let resultText = null;
    if (kind === 'round') {
      const m = location.pathname.match(/^\/([A-Za-z0-9]{8})(?:[A-Za-z0-9]{4})?(?:\/(white|black))?\/?$/);
      gameId = m ? m[1] : null;
      const nameOf = (sel) => {
        const el = document.querySelector(sel + ' .user-link, ' + sel + ' .text');
        return el ? el.textContent.trim().replace(/\s+/g, ' ') : null;
      };
      players = { top: nameOf('.ruser-top'), bottom: nameOf('.ruser-bottom') };
      const res = document.querySelector('.round__app .result-wrap, .game__meta .status');
      resultText = res ? res.textContent.trim().replace(/\s+/g, ' ') : null;
      const me = (document.body.dataset.user || '').toLowerCase();
      const bottom = document.querySelector('.ruser-bottom');
      const isPlayer =
        (!!me && !!bottom && bottom.textContent.toLowerCase().includes(me)) ||
        !!document.querySelector('.rcontrols .ricons, .rcontrols button.resign, .rcontrols .fbt.resign');
      if (isPlayer) myColor = orientation;
      const meta = document.querySelector('.game__meta');
      rated = !!meta && /рейтинг|rated/i.test(meta.textContent);
      gameOver = !!document.querySelector('.round__app .result-wrap, .game__meta .status');
      const clock = document.querySelector('.rclock-bottom .time');
      if (clock) myTime = parseClock(clock.textContent);
    }

    return { kind, moves, total: nodes.length, viewing: upto, orientation, myColor, rated, gameOver, myTime, gameId, players, resultText };
  }

  function parseClock(text) {
    const m = text.replace(/\s/g, '').match(/(\d+):(\d+)(?:[.:](\d+))?/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  // ---------- Панель ----------

  let root, iframe, statusEl, panelReady = false, collapsed = false, lastKey = null, lastPayload = null;

  function ensurePanel() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'chess-coach-root';
    root.innerHTML = `
      <div class="cc-head">
        <span class="cc-title">♞ Тренер</span>
        <span class="cc-status"></span>
        <button class="cc-btn cc-zoom-out" title="Уменьшить панель">A−</button>
        <button class="cc-btn cc-zoom-in" title="Увеличить панель">A+</button>
        <button class="cc-btn cc-min" title="Свернуть">–</button>
      </div>
      <iframe class="cc-frame" allow="" title="Шахматный тренер"></iframe>`;
    document.body.appendChild(root);
    iframe = root.querySelector('iframe');
    iframe.src = PANEL_URL;
    statusEl = root.querySelector('.cc-status');

    try {
      const saved = JSON.parse(localStorage.getItem('chess-coach-pos') || 'null');
      if (saved && typeof saved.x === 'number') {
        root.style.left = Math.max(0, Math.min(window.innerWidth - 120, saved.x)) + 'px';
        root.style.top = Math.max(0, Math.min(window.innerHeight - 60, saved.y)) + 'px';
        root.style.right = 'auto';
      }
    } catch (e) { /* ignore */ }

    root.querySelector('.cc-zoom-out').addEventListener('click', () => setScale(scale - 0.1));
    root.querySelector('.cc-zoom-in').addEventListener('click', () => setScale(scale + 0.1));
    applyScale();

    root.querySelector('.cc-min').addEventListener('click', () => {
      collapsed = !collapsed;
      root.classList.toggle('cc-collapsed', collapsed);
      root.querySelector('.cc-min').textContent = collapsed ? '+' : '–';
      applyScale();
    });

    // Перетаскивание за заголовок
    const head = root.querySelector('.cc-head');
    let drag = null;
    head.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const r = root.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      root.classList.add('cc-dragging');
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const x = e.clientX - drag.dx;
      const y = e.clientY - drag.dy;
      root.style.left = x + 'px';
      root.style.top = y + 'px';
      root.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      drag = null;
      root.classList.remove('cc-dragging');
      const r = root.getBoundingClientRect();
      try { localStorage.setItem('chess-coach-pos', JSON.stringify({ x: r.left, y: r.top })); } catch (e) { /* ignore */ }
    });
  }

  // Масштаб панели: ширина контейнера и zoom содержимого iframe
  let scale = 1;
  try {
    const s = parseFloat(localStorage.getItem('chess-coach-scale'));
    if (s >= 0.6 && s <= 2) scale = s;
  } catch (e) { /* ignore */ }

  function setScale(v) {
    scale = Math.round(Math.max(0.6, Math.min(2, v)) * 10) / 10;
    try { localStorage.setItem('chess-coach-scale', String(scale)); } catch (e) { /* ignore */ }
    applyScale();
  }

  function applyScale() {
    if (!root) return;
    root.style.width = collapsed ? '' : Math.round(360 * scale) + 'px';
    iframe.style.height = Math.round(560 * scale) + 'px';
    postToPanel({ type: 'scale', scale });
  }

  function postToPanel(msg) {
    if (!iframe || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage(msg, EXT_ORIGIN);
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== EXT_ORIGIN || !iframe || e.source !== iframe.contentWindow) return;
    const msg = e.data || {};
    if (msg.type === 'ready') {
      panelReady = true;
      postToPanel({ type: 'scale', scale });
      if (lastPayload) postToPanel({ type: 'game', ...lastPayload });
    } else if (msg.type === 'arrows') {
      drawArrows(msg.shapes || []);
    } else if (msg.type === 'status') {
      if (statusEl) statusEl.textContent = msg.text || '';
    }
  });

  // ---------- Стрелки на доске ----------

  function squareToXY(sq, orientation) {
    const file = sq.charCodeAt(0) - 97;
    const rank = parseInt(sq[1], 10) - 1;
    return orientation === 'white' ? [file + 0.5, 7 - rank + 0.5] : [7 - file + 0.5, rank + 0.5];
  }

  function drawArrows(shapes) {
    const wrap = document.querySelector('.cg-wrap');
    if (!wrap) return;
    const host = wrap.querySelector('cg-container') || wrap;
    let svg = host.querySelector('svg.cc-arrows');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'cc-arrows');
      svg.setAttribute('viewBox', '0 0 8 8');
      host.appendChild(svg);
    }
    const orientation = wrap.classList.contains('orientation-black') ? 'black' : 'white';
    const defs = [];
    const body = [];
    shapes.forEach((s, i) => {
      const id = 'cc-arrow-' + i;
      const [x1, y1] = squareToXY(s.from, orientation);
      const [x2, y2] = squareToXY(s.to, orientation);
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const shrink = 0.34;
      const ex = x2 - ux * shrink, ey = y2 - uy * shrink;
      const w = s.width || 0.16;
      defs.push(
        `<marker id="${id}" orient="auto" markerWidth="4" markerHeight="4" refX="2.05" refY="2" markerUnits="strokeWidth"><path d="M0,0 V4 L3,2 Z" fill="${s.color}"/></marker>`
      );
      body.push(
        `<line x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}" stroke="${s.color}" stroke-width="${w}" stroke-linecap="round" opacity="${s.opacity || 0.85}" marker-end="url(#${id})"/>`
      );
    });
    svg.innerHTML = `<defs>${defs.join('')}</defs>${body.join('')}`;
  }

  // ---------- Наблюдение за страницей ----------

  let timer = null;
  function scheduleRead() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      tick();
    }, 150);
  }

  function tick() {
    const game = readGame();
    if (!game) {
      if (root) root.style.display = 'none';
      return;
    }
    ensurePanel();
    root.style.display = '';
    const key = JSON.stringify([game.moves, game.viewing, game.total, game.orientation, game.myColor, game.gameOver, game.rated, game.gameId, game.resultText]);
    const timeChanged = lastPayload && lastPayload.myTime !== game.myTime;
    if (key === lastKey && !timeChanged) return;
    const positionChanged = key !== lastKey;
    lastKey = key;
    lastPayload = game;
    if (panelReady) postToPanel({ type: 'game', ...game, positionChanged });
    if (positionChanged) drawArrows([]);
  }

  const observer = new MutationObserver(scheduleRead);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
  tick();
})();
