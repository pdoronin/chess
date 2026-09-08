// Объяснение ходов «человеческим языком»: материал, тактика, защита от угроз,
// принципы дебюта, активность фигур. Каждая причина помечена тегом урока.
import { Chess, SQUARES } from '../lib/chess.js';

export const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
export const PIECE_NAME = { p: 'пешка', n: 'конь', b: 'слон', r: 'ладья', q: 'ферзь', k: 'король' };
export const PIECE_ACC = { p: 'пешку', n: 'коня', b: 'слона', r: 'ладью', q: 'ферзя', k: 'короля' };
export const PIECE_GEN = { p: 'пешки', n: 'коня', b: 'слона', r: 'ладьи', q: 'ферзя', k: 'короля' };

export const label = (type, sq) => `${PIECE_NAME[type]} ${sq}`;
const FEM = { p: true, r: true };
export const pron = (type) => (FEM[type] ? 'она' : 'он');
export const pronDat = (type) => (FEM[type] ? 'ей' : 'ему');
export const labelAcc = (type, sq) => `${PIECE_ACC[type]} ${sq}`;
export const opp = (c) => (c === 'w' ? 'b' : 'w');

export function colorName(c) {
  return c === 'w' ? 'белые' : 'чёрные';
}

// FEN той же позиции, но с другой стороной на ходу (для поиска угроз соперника).
export function fenSwapTurn(fen) {
  const p = fen.split(' ');
  p[1] = p[1] === 'w' ? 'b' : 'w';
  p[3] = '-';
  return p.join(' ');
}

export function uciToMove(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined };
}

export function pvToSan(fen, pv, max = 6) {
  const c = new Chess(fen);
  const out = [];
  for (const u of pv.slice(0, max)) {
    try {
      const m = c.move(uciToMove(u));
      out.push(m.san);
    } catch (e) {
      break;
    }
  }
  return out;
}

export function sanOf(fen, uci) {
  try {
    return new Chess(fen).move(uciToMove(uci)).san;
  } catch (e) {
    return uci;
  }
}

// Фигуры цвета color, которые сейчас под боем и плохо защищены.
export function hangingPieces(chess, color) {
  const res = [];
  for (const sq of SQUARES) {
    const p = chess.get(sq);
    if (!p || p.color !== color || p.type === 'k') continue;
    const att = chess.attackers(sq, opp(color));
    if (!att.length) continue;
    const def = chess.attackers(sq, color);
    const minAtt = Math.min(...att.map((s) => VALUE[chess.get(s).type]));
    const undefended = def.length === 0;
    if (undefended || minAtt < VALUE[p.type]) {
      res.push({
        square: sq,
        type: p.type,
        undefended,
        loss: undefended ? VALUE[p.type] : VALUE[p.type] - minAtt,
        attackers: att,
      });
    }
  }
  return res.sort((a, b) => b.loss - a.loss);
}

// Фаза партии по количеству нефигурного материала.
export function detectPhase(chess) {
  let npm = 0;
  let queens = 0;
  for (const sq of SQUARES) {
    const p = chess.get(sq);
    if (!p || p.type === 'p' || p.type === 'k') continue;
    npm += VALUE[p.type];
    if (p.type === 'q') queens++;
  }
  const move = chess.moveNumber();
  // Порог 40 держит дебют после раннего размена ферзей (стартовые 62 минус 18).
  if (move <= 12 && npm >= 40) return 'opening';
  if (npm <= 26 || (queens === 0 && npm <= 32)) return 'endgame';
  return 'middlegame';
}

function isHomeSquare(piece, color, sq) {
  const rank = color === 'w' ? '1' : '8';
  if (sq[1] !== rank) return false;
  if (piece === 'n') return sq[0] === 'b' || sq[0] === 'g';
  if (piece === 'b') return sq[0] === 'c' || sq[0] === 'f';
  return false;
}

const DIRS = {
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
};
DIRS.q = [...DIRS.b, ...DIRS.r];

function sqAdd(sq, df, dr) {
  const f = sq.charCodeAt(0) - 97 + df;
  const r = parseInt(sq[1], 10) - 1 + dr;
  if (f < 0 || f > 7 || r < 0 || r > 7) return null;
  return String.fromCharCode(97 + f) + (r + 1);
}

// Связки и сквозные удары, которые создаёт дальнобойная фигура на поле sq.
function pinsAndSkewers(chess, sq, us) {
  const piece = chess.get(sq);
  if (!piece || !DIRS[piece.type]) return [];
  const out = [];
  for (const [df, dr] of DIRS[piece.type]) {
    let cur = sq;
    let first = null;
    while ((cur = sqAdd(cur, df, dr))) {
      const p = chess.get(cur);
      if (!p) continue;
      if (p.color === us) break;
      if (!first) {
        // Король первым по линии — это шах, а не связка. Пешка связывается как обычная фигура.
        first = { sq: cur, type: p.type };
        if (p.type === 'k') break;
        continue;
      }
      const second = { sq: cur, type: p.type };
      if (second.type === 'k' && first.type !== 'k') out.push({ kind: 'abs-pin', first, second });
      else if (VALUE[second.type] > VALUE[first.type]) out.push({ kind: 'pin', first, second });
      else if (VALUE[first.type] > VALUE[second.type] && VALUE[first.type] >= 5) out.push({ kind: 'skewer', first, second });
      break;
    }
  }
  return out;
}

function attackedEnemyPieces(chess, us) {
  const them = opp(us);
  const res = [];
  for (const sq of SQUARES) {
    const p = chess.get(sq);
    if (!p || p.color !== them || p.type === 'k') continue;
    const att = chess.attackers(sq, us);
    if (!att.length) continue;
    const def = chess.attackers(sq, them);
    const minAtt = Math.min(...att.map((s) => VALUE[chess.get(s).type]));
    res.push({ sq, type: p.type, attackers: att, undefended: def.length === 0, minAtt });
  }
  return res;
}

function fileHasPawns(chess, file, color) {
  for (let r = 1; r <= 8; r++) {
    const p = chess.get(file + r);
    if (p && p.type === 'p' && (!color || p.color === color)) return true;
  }
  return false;
}

function isPassedPawn(chess, sq, color) {
  const f = sq.charCodeAt(0) - 97;
  const r = parseInt(sq[1], 10);
  const dir = color === 'w' ? 1 : -1;
  for (let rr = r + dir; rr >= 1 && rr <= 8; rr += dir) {
    for (let ff = f - 1; ff <= f + 1; ff++) {
      if (ff < 0 || ff > 7) continue;
      const p = chess.get(String.fromCharCode(97 + ff) + rr);
      if (p && p.type === 'p' && p.color !== color) return false;
    }
  }
  return true;
}

function mobility(fen, sq, color) {
  try {
    const parts = fen.split(' ');
    parts[1] = color;
    parts[3] = '-';
    const c = new Chess(parts.join(' '));
    return c.moves({ square: sq }).length;
  } catch (e) {
    return null;
  }
}

function listPieces(items) {
  return items.map((t) => labelAcc(t.type, t.sq)).join(' и ');
}

/**
 * Объясняет ход uci в позиции chess.
 * ctx: { threat: {uci, san, mate, captured, from, to} | null, rank, gapToSecond, gapToBest, cpFromMover, mate }
 */
export function explainMove(chess, uci, ctx = {}) {
  const fen = chess.fen();
  const after = new Chess(fen);
  let mv;
  try {
    mv = after.move(uciToMove(uci));
  } catch (e) {
    return { san: uci, move: null, reasons: [], warnings: [], tags: [] };
  }
  const us = mv.color;
  const them = opp(us);
  const reasons = [];
  const warnings = [];
  const phase = detectPhase(chess);
  const add = (text, tag, weight = 1) => reasons.push({ text, tag, weight });

  // --- Форсирующие моменты ---
  if (after.isCheckmate()) {
    add('Мат — партия окончена.', 'tactics', 10);
    return { san: mv.san, move: mv, reasons, warnings, tags: ['tactics'], phase };
  }
  if (after.isCheck()) add('Шах: соперник обязан отвечать на него, а значит вы диктуете ход игры.', 'cct', 3);

  if (ctx.mate && ctx.mate > 0 && !after.isCheckmate()) add(`Начало форсированного мата в ${ctx.mate}.`, 'calculation', 9);

  // --- Материал ---
  if (mv.captured) {
    const capVal = VALUE[mv.captured];
    // При взятии на проходе снимаемая пешка стоит не на поле хода, а рядом.
    const enPassant = mv.flags.includes('e');
    const capturedSquare = enPassant ? mv.to[0] + mv.from[1] : mv.to;
    const wasDefended = chess.attackers(capturedSquare, them).length > 0;
    const myVal = VALUE[mv.piece];
    const target = labelAcc(mv.captured, capturedSquare) + (enPassant ? ' на проходе' : '');
    if (!wasDefended) add(`Берёт ${target} — ${pron(mv.captured)} без защиты, это чистый выигрыш материала.`, 'material', 6);
    else if (myVal < capVal) add(`Берёт ${target}: выгодный размен — отдаёте ${myVal}, получаете ${capVal}.`, 'material', 6);
    else if (myVal === capVal) add(`Берёт ${target} — равный размен, который упрощает позицию.`, 'material', 2);
    else add(`Берёт ${target} более ценной фигурой — это жертва: смысл в последующей тактике (см. план ниже).`, 'calculation', 5);
  }
  if (mv.flags.includes('k') || mv.flags.includes('q')) add('Рокировка: король уходит в укрытие, а ладья подключается к игре.', 'king-safety', 4);
  if (mv.promotion) add('Превращение пешки в новую фигуру.', 'endgame', 8);

  // --- Тактика после хода ---
  const attackedBefore = new Set(attackedEnemyPieces(chess, us).map((t) => t.sq));
  const attackedAfter = attackedEnemyPieces(after, us);
  // Цель считается новой, если раньше на неё не нападали ИЛИ на неё напала именно
  // сходившая фигура: второе нужно, чтобы поймать вилку, где одна из целей уже была под боем.
  const newTargets = attackedAfter.filter(
    (t) => (!attackedBefore.has(t.sq) || t.attackers.includes(mv.to)) && (t.undefended || t.minAtt < VALUE[t.type])
  );
  const byMoved = newTargets.filter((t) => t.attackers.includes(mv.to));
  const discovered = newTargets.filter((t) => !t.attackers.includes(mv.to));
  const checkAfter = after.isCheck();

  if (byMoved.length >= 2 || (checkAfter && byMoved.length >= 1)) {
    add(
      `Вилка (двойной удар): ${PIECE_NAME[mv.piece]} одновременно нападает на ${listPieces(byMoved)}${checkAfter ? ' и на короля' : ''}. Соперник не успеет спасти всё.`,
      'tactics-fork',
      7
    );
  } else if (byMoved.length === 1) {
    const t = byMoved[0];
    add(
      `Нападает на ${labelAcc(t.type, t.sq)}${t.undefended ? ` — ${pron(t.type)} без защиты` : ` менее ценной фигурой — ${pronDat(t.type)} придётся отступить`}.`,
      'tactics',
      3
    );
  }
  if (discovered.length) add(`Открытое нападение: ход освобождает линию, и теперь под ударом ${listPieces(discovered)}.`, 'tactics-fork', 6);

  for (const ps of pinsAndSkewers(after, mv.to, us)) {
    if (ps.kind === 'abs-pin') add(`Связка: ${label(ps.first.type, ps.first.sq)} прикрывает короля и не может двигаться.`, 'tactics-pin', 5);
    else if (ps.kind === 'pin') add(`Связка: ${label(ps.first.type, ps.first.sq)} прикрывает ${labelAcc(ps.second.type, ps.second.sq)} — если сдвинется, потеряете более ценную фигуру.`, 'tactics-pin', 4);
    else add(`Сквозной удар: ${label(ps.first.type, ps.first.sq)} должен отойти, и тогда откроется ${label(ps.second.type, ps.second.sq)}.`, 'tactics-pin', 5);
  }

  // --- Защита от угрозы соперника ---
  const threat = ctx.threat;
  if (threat) {
    if (threat.mate) {
      if (!(ctx.mate && ctx.mate < 0)) add(`Профилактика: снимает угрозу мата (соперник хотел ${threat.san}).`, 'prophylaxis', 8);
    } else if (threat.captured) {
      const before = hangingPieces(chess, us).find((h) => h.square === threat.to);
      const afterHang = hangingPieces(after, us);
      const stillHanging = afterHang.find((h) => h.square === (mv.from === threat.to ? mv.to : threat.to));
      if (before && !stillHanging) {
        let how = 'защищает';
        if (mv.from === threat.to) how = 'уводит из-под боя';
        else if (mv.to === threat.from) how = 'уничтожает нападающую фигуру и спасает';
        add(`Защита: ${how} ${labelAcc(before.type, before.square)}, на которую соперник хотел напасть ходом ${threat.san}.`, 'prophylaxis', 6);
      } else if (mv.captured && mv.to === threat.from) {
        add(`Убирает фигуру, которая угрожала ходом ${threat.san}.`, 'prophylaxis', 5);
      }
    }
  }

  // --- Дебют ---
  if (phase === 'opening') {
    if ((mv.piece === 'n' || mv.piece === 'b') && isHomeSquare(mv.piece, us, mv.from)) add('Развитие: фигура выходит с начального поля в игру. В дебюте каждый темп на счету.', 'opening', 2);
    if (mv.piece === 'p' && ['d4', 'e4', 'd5', 'e5'].includes(mv.to)) add('Борьба за центр: пешка занимает центральное поле и ограничивает фигуры соперника.', 'opening', 2);
    if (mv.piece === 'p' && ['c4', 'c5', 'f4', 'f5'].includes(mv.to) && !mv.captured) add('Пешечный подрыв: атакует центр соперника с фланга.', 'opening', 1);
    if (mv.piece === 'q' && chess.moveNumber() <= 6 && !mv.captured && !checkAfter) warnings.push('Ранний выход ферзя обычно опасен: его начнут гонять с темпом. Здесь движок считает, что конкретика это оправдывает.');
  }

  // --- Активность фигур ---
  if (mv.piece === 'r') {
    const file = mv.to[0];
    if (!fileHasPawns(after, file)) add('Ладья занимает открытую линию — оттуда она проникает в лагерь соперника.', 'activity', 2);
    else if (!fileHasPawns(after, file, us)) add('Ладья занимает полуоткрытую линию и давит на пешку соперника.', 'activity', 2);
    const seventh = us === 'w' ? '7' : '2';
    if (mv.to[1] === seventh) add('Ладья на предпоследней горизонтали: атакует пешки и стесняет короля.', 'activity', 3);
  }
  if (mv.piece === 'k' && phase === 'endgame' && !chess.isCheck() && !checkAfter) add('Эндшпиль: король становится боевой фигурой и идёт к центру или к пешкам.', 'endgame', 2);
  if (mv.piece === 'p' && phase !== 'opening' && isPassedPawn(after, mv.to, us)) add('Продвигает проходную пешку — её никто не может остановить пешками, это будущий ферзь.', 'pawns', 3);
  if (mv.piece === 'n' && ['c3', 'd4', 'e4', 'f5', 'c6', 'd5', 'e5', 'f6', 'c4', 'c5', 'f4', 'd3', 'e3', 'd6', 'e6', 'f3'].includes(mv.to) && phase !== 'opening' && !reasons.length)
    add('Централизация: конь в центре контролирует больше полей.', 'activity', 1);

  // --- Позиционный «тихий» ход ---
  if (!reasons.length) {
    const mobBefore = mobility(fen, mv.from, us);
    const mobAfter = mobility(after.fen(), mv.to, us);
    if (mobBefore !== null && mobAfter !== null && mobAfter > mobBefore + 2) add(`Улучшает фигуру: с поля ${mv.to} ${PIECE_NAME[mv.piece]} контролирует заметно больше полей.`, 'activity', 1);
    else add('Тихий ход: без прямой тактики, но он улучшает координацию фигур и готовит план. Посмотрите продолжение ниже, чтобы понять идею.', 'planning', 1);
  }

  // --- Оценка относительно других ходов ---
  if (ctx.rank === 0 && typeof ctx.gapToSecond === 'number' && ctx.gapToSecond >= 120) add(`Единственный сильный ход: все остальные заметно хуже (примерно на ${(ctx.gapToSecond / 100).toFixed(1)} пешки).`, 'calculation', 4);
  if (ctx.rank > 0 && typeof ctx.gapToBest === 'number' && ctx.gapToBest <= 25) add('Почти равноценная альтернатива лучшему ходу.', 'calculation', 0);

  // --- Предупреждения ---
  const hangAfter = hangingPieces(after, us).filter((h) => h.loss >= 2 && !(mv.captured && h.square === mv.to && VALUE[mv.captured] >= VALUE[mv.piece]));
  if (hangAfter.length && !after.isCheck()) warnings.push(`После хода под боем остаётся ${label(hangAfter[0].type, hangAfter[0].square)} — движок это учёл, но проверьте расчёт.`);

  reasons.sort((a, b) => b.weight - a.weight);
  return { san: mv.san, move: mv, reasons, warnings, tags: [...new Set(reasons.map((r) => r.tag))], phase };
}

// Описание угрозы соперника (что он сыграл бы, если бы ход был его).
export function explainThreat(fen, uci, score) {
  try {
    const swapped = new Chess(fenSwapTurn(fen));
    const res = explainMove(swapped, uci, { mate: score && score.mate, threat: null });
    const mv = res.move;
    return {
      uci,
      san: res.san,
      from: mv.from,
      to: mv.to,
      captured: mv.captured || null,
      mate: !!(score && score.mate && score.mate > 0),
      reasons: res.reasons.slice(0, 2),
      score,
    };
  } catch (e) {
    return null;
  }
}
