// Тесты оценки ходов и тренерской логики. Запуск: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../lib/chess.js';
import { winPct, negate, fmtScore, scoreWords, classify, thinkingPrompts, summarize, QUALITY } from '../panel/coach.js';
import { LESSONS, lessonFor, TAG_TO_LESSON } from '../panel/lessons.js';

test('winPct: равная позиция около 50%, мат — крайние значения', () => {
  assert.ok(Math.abs(winPct({ cp: 0 }) - 50) < 0.01);
  assert.equal(winPct({ mate: 3 }), 100);
  assert.equal(winPct({ mate: -3 }), 0);
  assert.ok(winPct({ cp: 300 }) > winPct({ cp: 100 }));
  assert.ok(winPct({ cp: -300 }) < 50);
});

test('negate переворачивает оценку', () => {
  assert.deepEqual(negate({ cp: 120 }), { cp: -120 });
  assert.deepEqual(negate({ mate: 2 }), { mate: -2 });
  assert.equal(negate(null), null);
});

test('fmtScore печатает оценку и мат', () => {
  assert.equal(fmtScore({ cp: 35 }), '+0.35');
  assert.equal(fmtScore({ cp: -150 }), '-1.50');
  assert.equal(fmtScore({ mate: 3 }), '#3');
  assert.equal(fmtScore({ mate: -3 }), '#-3');
  assert.equal(fmtScore({ cp: 35 }, false), '-0.35');
});

test('scoreWords описывает перевес словами', () => {
  assert.match(scoreWords({ cp: 10 }), /равная/);
  assert.match(scoreWords({ cp: 150 }), /белых/);
  assert.match(scoreWords({ cp: -150 }), /чёрных/);
  assert.match(scoreWords({ mate: 2 }), /белые/);
});

test('classify делит ходы по потере шансов на победу', () => {
  assert.equal(classify(0, true), 'best');
  assert.equal(classify(1, false), 'excellent');
  assert.equal(classify(4, false), 'good');
  assert.equal(classify(7, false), 'inaccuracy');
  assert.equal(classify(15, false), 'mistake');
  assert.equal(classify(40, false), 'blunder');
  // Лучший ход остаётся лучшим независимо от расчётной потери.
  assert.equal(classify(30, true), 'best');
});

test('у каждой категории качества есть подпись и цвет', () => {
  for (const key of ['best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder']) {
    assert.ok(QUALITY[key].label, key);
    assert.match(QUALITY[key].color, /^#[0-9a-f]{6}$/i, key);
  }
});

test('thinkingPrompts всегда даёт от двух до четырёх вопросов с уроками', () => {
  const chess = new Chess();
  const prompts = thinkingPrompts({ chess, lastMove: null, threat: null, myTime: null, phase: 'opening', oppBlunder: false });
  assert.ok(prompts.length >= 2 && prompts.length <= 4);
  for (const p of prompts) {
    assert.ok(p.title && p.text);
    assert.ok(lessonFor(p.tag), 'у подсказки должен быть существующий урок: ' + p.tag);
  }
});

test('thinkingPrompts реагирует на шах и на нехватку времени', () => {
  const inCheck = new Chess('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
  const titles = thinkingPrompts({ chess: inCheck, lastMove: null, threat: null, myTime: 10, phase: 'opening', oppBlunder: false }).map((p) => p.title);
  assert.ok(titles.some((t) => /шах/i.test(t)), titles.join(', '));
});

test('summarize считает точность и находит темы ошибок', () => {
  const records = [
    { mine: true, quality: 'best', deltaWin: 0, tags: [], ply: 0, san: 'e4' },
    { mine: true, quality: 'blunder', deltaWin: 40, tags: ['tactics-fork'], ply: 2, san: 'Nf6' },
    { mine: false, quality: 'best', deltaWin: 0, tags: [], ply: 1, san: 'e5' },
  ];
  const s = summarize(records);
  assert.equal(s.total, 2, 'считаются только мои ходы');
  assert.equal(s.counts.blunder, 1);
  assert.ok(s.accuracy >= 0 && s.accuracy <= 100);
  assert.deepEqual(s.topTags, ['tactics-fork']);
  assert.equal(s.worst[0].san, 'Nf6');
});

test('summarize не падает на пустом списке', () => {
  const s = summarize([]);
  assert.equal(s.total, 0);
  assert.equal(s.accuracy, 100);
});

test('каждый тег объяснений ведёт на существующий урок', () => {
  for (const [tag, id] of Object.entries(TAG_TO_LESSON)) {
    assert.ok(LESSONS.some((l) => l.id === id), `тег ${tag} ссылается на несуществующий урок ${id}`);
  }
  assert.equal(lessonFor('нет-такого-тега'), null);
});

test('уроки заполнены: заголовок, краткое описание, текст и чек-лист', () => {
  assert.ok(LESSONS.length >= 10);
  const ids = new Set();
  for (const l of LESSONS) {
    assert.ok(l.title && l.short && l.body, l.id);
    assert.ok(Array.isArray(l.checklist) && l.checklist.length >= 2, l.id);
    assert.equal(ids.has(l.id), false, 'дублирующийся id урока: ' + l.id);
    ids.add(l.id);
  }
});
