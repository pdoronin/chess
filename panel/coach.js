// «Тренерская» логика: оценка качества сыгранных ходов, модели мышления перед ходом,
// подсказки-намёки и итоги партии.
import { hangingPieces, detectPhase, label, PIECE_NAME, VALUE, opp } from './explain.js';

// Оценка (в сантипешках с точки зрения ходящего) -> вероятность выигрыша 0..100.
export function winPct(score) {
  if (!score) return 50;
  if (typeof score.mate === 'number') return score.mate > 0 ? 100 : 0;
  const cp = Math.max(-1500, Math.min(1500, score.cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

export function negate(score) {
  if (!score) return null;
  if (typeof score.mate === 'number') return { mate: -score.mate };
  return { cp: -score.cp };
}

export function fmtScore(score, povWhite = true) {
  if (!score) return '…';
  const s = povWhite ? score : negate(score);
  if (typeof s.mate === 'number') return s.mate > 0 ? `#${s.mate}` : `#-${-s.mate}`;
  const v = s.cp / 100;
  return (v > 0 ? '+' : '') + v.toFixed(2);
}

export function scoreWords(scoreWhite) {
  if (!scoreWhite) return '';
  if (typeof scoreWhite.mate === 'number') return scoreWhite.mate > 0 ? 'белые ставят мат' : 'чёрные ставят мат';
  const cp = scoreWhite.cp;
  const a = Math.abs(cp);
  const side = cp > 0 ? 'у белых' : 'у чёрных';
  if (a < 30) return 'позиция равная';
  if (a < 90) return `небольшой перевес ${side}`;
  if (a < 200) return `заметный перевес ${side}`;
  if (a < 500) return `решающий перевес ${side}`;
  return `${side} выигранная позиция`;
}

export const QUALITY = {
  best: { label: 'Лучший ход', icon: '★', color: '#1a7f37' },
  excellent: { label: 'Отличный ход', icon: '✓', color: '#1a7f37' },
  good: { label: 'Хороший ход', icon: '✓', color: '#4c9a2a' },
  inaccuracy: { label: 'Неточность', icon: '?!', color: '#c98a00' },
  mistake: { label: 'Ошибка', icon: '?', color: '#e0721f' },
  blunder: { label: 'Грубая ошибка', icon: '??', color: '#c62828' },
};

export function classify(deltaWin, isBest) {
  if (isBest) return 'best';
  if (deltaWin < 2) return 'excellent';
  if (deltaWin < 5) return 'good';
  if (deltaWin < 10) return 'inaccuracy';
  if (deltaWin < 20) return 'mistake';
  return 'blunder';
}

// Вопросы «модели мышления» под конкретную позицию. Возвращает 2–4 пункта.
export function thinkingPrompts({ chess, lastMove, threat, myTime, phase, oppBlunder }) {
  const us = chess.turn();
  const prompts = [];
  const hang = hangingPieces(chess, us);
  const enemyHang = hangingPieces(chess, opp(us));

  if (chess.isCheck()) {
    prompts.push({
      title: 'Вы под шахом',
      text: 'Три способа: уйти королём, закрыться, побить шахующую фигуру. Выберите тот, который не портит позицию и не оставляет короля в опасности.',
      tag: 'king-safety',
    });
  }

  if (lastMove) {
    if (lastMove.captured) {
      prompts.push({
        title: 'Соперник побил',
        text: `Что можно отбить? Считайте размен по ценности фигур (пешка 1, конь и слон 3, ладья 5, ферзь 9). После взятия проверьте, не открылась ли линия на вашего короля.`,
        tag: 'material',
      });
    } else {
      prompts.push({
        title: 'Что изменилось?',
        text: `Последний ход соперника: ${lastMove.san}. Какие поля он теперь атакует? Что ослабил и какую линию открыл? Что он хочет сделать следующим ходом?`,
        tag: 'prophylaxis',
      });
    }
  }

  if (hang.length) {
    prompts.push({
      title: `Под боем: ${hang.length === 1 ? 'одна ваша фигура' : hang.length + ' ваших фигур'}`,
      text: 'Найдите их и решите: увести, защитить, побить нападающего или создать более сильную встречную угрозу. Смотреть подсказку рано — сначала найдите сами.',
      tag: 'cct',
    });
  }

  if (enemyHang.length) {
    prompts.push({
      title: 'У соперника есть плохо защищённые фигуры',
      text: 'Проверьте каждое взятие: что вы получаете и что отдаёте? Даже если сразу взять нельзя, можно напасть дважды.',
      tag: 'material',
    });
  }

  if (threat && threat.mate) {
    prompts.push({ title: 'Опасность!', text: 'У соперника есть матовая угроза. Сначала найдите её, потом ищите защиту — лучше защиту с темпом.', tag: 'king-safety' });
  } else if (threat && threat.captured && VALUE[threat.captured] >= 3) {
    prompts.push({ title: 'У соперника есть угроза', text: 'Если бы ход был его, он выиграл бы материал. Найдите угрозу и решите, нужно ли на неё реагировать или у вас есть более сильный ход.', tag: 'prophylaxis' });
  }

  if (oppBlunder) {
    prompts.push({ title: 'Соперник только что ошибся', text: 'Движок считает последний ход соперника слабым. Ищите тактику: шахи, взятия, угрозы — где-то есть наказание.', tag: 'cct' });
  }

  if (phase === 'opening') {
    prompts.push({ title: 'Дебютный чек-лист', text: 'Центр занят? Лёгкие фигуры развиты? Король рокирован? Ладьи соединены? Не двигайте одну фигуру дважды без причины.', tag: 'opening' });
  } else if (phase === 'endgame') {
    prompts.push({ title: 'Эндшпиль', text: 'Король — активная фигура: ведите его к центру или к пешкам. Создавайте проходные и считайте темпы до превращения.', tag: 'endgame' });
  } else {
    prompts.push({ title: 'Найдите план', text: 'Какая ваша фигура самая плохая? Какую линию можно открыть? Где слабые пешки соперника? Улучшайте худшую фигуру.', tag: 'planning' });
  }

  if (typeof myTime === 'number' && myTime < 30) {
    prompts.push({ title: 'Мало времени', text: 'Играйте простые надёжные ходы: без резких жертв, держите фигуры защищёнными, избегайте сложных размен.', tag: 'time' });
  }

  prompts.push({ title: 'Шахи → взятия → угрозы', text: 'Перед ходом переберите все форсированные ходы за себя и за соперника. Только потом выбирайте «тихий» ход.', tag: 'cct' });

  return prompts.slice(0, 4);
}

// Намёк первого уровня: идея, без конкретного хода.
export function ideaHint(explained, threat, chess) {
  const tags = explained.tags;
  const r = explained.reasons[0];
  if (tags.includes('tactics-fork')) return 'Ищите двойной удар: одна ваша фигура может напасть сразу на две цели.';
  if (tags.includes('tactics-pin')) return 'Ищите связку или сквозной удар по линии.';
  if (r && r.tag === 'material') return 'В позиции есть выигрыш материала. Проверьте все взятия и незащищённые фигуры соперника.';
  if (tags.includes('prophylaxis')) return 'Сначала защита: у соперника есть угроза, лучший ход её нейтрализует.';
  if (tags.includes('cct') && explained.move && explained.move.san.includes('+')) return 'Есть сильный форсирующий ход. Начните перебор с шахов.';
  if (tags.includes('king-safety')) return 'Подумайте о безопасности короля.';
  if (tags.includes('opening')) return 'Следуйте принципам дебюта: центр, развитие, рокировка.';
  if (tags.includes('activity')) return 'Улучшите положение фигуры: ладьи на открытые линии, кони в центр.';
  if (tags.includes('endgame')) return 'Эндшпильная идея: активность короля или продвижение проходной.';
  if (tags.includes('pawns')) return 'Ключ в пешечной структуре: проходная пешка или подрыв.';
  return 'Тихий ход: улучшайте худшую фигуру и не создавайте слабостей.';
}

export function pieceHint(explained) {
  const mv = explained.move;
  if (!mv) return '';
  return `Ходить нужно фигурой: ${PIECE_NAME[mv.piece]} с поля ${mv.from}.`;
}

// Урок дня по накопленным ошибкам.
export function summarize(records) {
  const mine = records.filter((r) => r.mine);
  const counts = {};
  for (const q of Object.keys(QUALITY)) counts[q] = 0;
  mine.forEach((r) => counts[r.quality]++);
  const tagCount = {};
  mine
    .filter((r) => r.quality === 'mistake' || r.quality === 'blunder' || r.quality === 'inaccuracy')
    .forEach((r) => (r.tags || []).forEach((t) => (tagCount[t] = (tagCount[t] || 0) + 1)));
  const topTags = Object.entries(tagCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t);
  const avgLoss = mine.length ? mine.reduce((s, r) => s + r.deltaWin, 0) / mine.length : 0;
  const accuracy = Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * avgLoss) - 3.1669));
  const worst = [...mine].sort((a, b) => b.deltaWin - a.deltaWin).slice(0, 3);
  return { counts, topTags, accuracy: Math.round(accuracy), worst, total: mine.length };
}
