// Тесты объяснений ходов. Запуск: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../lib/chess.js';
import { explainMove, explainThreat, hangingPieces, detectPhase, fenSwapTurn, pvToSan, sanOf, uciToMove } from '../panel/explain.js';

const texts = (res) => res.reasons.map((r) => r.text).join(' | ');
const tags = (res) => res.tags;

test('uciToMove разбирает ход и превращение', () => {
  assert.deepEqual(uciToMove('e2e4'), { from: 'e2', to: 'e4', promotion: undefined });
  assert.deepEqual(uciToMove('e7e8q'), { from: 'e7', to: 'e8', promotion: 'q' });
});

test('fenSwapTurn меняет сторону и сбрасывает поле взятия на проходе', () => {
  const fen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
  const swapped = fenSwapTurn(fen).split(' ');
  assert.equal(swapped[1], 'b');
  assert.equal(swapped[3], '-');
});

test('мат распознаётся и объяснение на нём останавливается', () => {
  const c = new Chess('rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2');
  const res = explainMove(c, 'd8h4');
  assert.equal(res.san, 'Qh4#');
  assert.equal(res.reasons.length, 1);
  assert.match(res.reasons[0].text, /Мат/);
});

test('взятие незащищённой фигуры объясняется как выигрыш материала', () => {
  // Чёрный конь на e5 без защиты, белый конь на f3 может забрать.
  const c = new Chess('rnbqkbnr/pppp1ppp/8/4p3/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 0 2');
  const res = explainMove(c, 'f3e5');
  assert.match(texts(res), /без защиты/);
  assert.ok(tags(res).includes('material'));
});

test('вилка конём распознаётся как двойной удар', () => {
  // Nc7+ одновременно шахует короля e8 и нападает на ладью a8.
  const c = new Chess('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1');
  const res = explainMove(c, 'b5c7');
  assert.match(texts(res), /Вилка/);
  assert.ok(tags(res).includes('tactics-fork'), texts(res));
});

test('связка по линии распознаётся', () => {
  // Bg5 связывает коня f6 против ферзя d8 (поле e7 свободно).
  const c = new Chess('rnbqkb1r/pppp1ppp/5n2/4p3/4P3/3P4/PPP2PPP/RNBQKBNR w KQkq - 0 3');
  const res = explainMove(c, 'c1g5');
  assert.match(texts(res), /Связка/);
  assert.ok(tags(res).includes('tactics-pin'));
});

test('рокировка объясняется через безопасность короля', () => {
  const c = new Chess('rnbqkbnr/pppp1ppp/8/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4');
  const res = explainMove(c, 'e1g1');
  assert.match(texts(res), /Рокировка/);
  assert.ok(tags(res).includes('king-safety'));
});

test('hangingPieces находит фигуру под боем и не считает защищённую', () => {
  // Чёрный конь c6 под боем слона b5 и защищён пешкой b7.
  const defended = new Chess('r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 5 3');
  assert.equal(hangingPieces(defended, 'b').some((h) => h.square === 'c6'), false);
  // Тот же конь без пешек b7 и d7: становится незащищённым.
  const hanging = new Chess('4k3/8/2n5/1B6/8/8/8/4K3 b - - 0 1');
  const h = hangingPieces(hanging, 'b').find((x) => x.square === 'c6');
  assert.ok(h, 'конь c6 должен считаться висящим');
  assert.equal(h.undefended, true);
});

test('detectPhase различает дебют, миттельшпиль и эндшпиль', () => {
  assert.equal(detectPhase(new Chess()), 'opening');
  assert.equal(detectPhase(new Chess('8/5k2/8/8/3K4/8/4P3/8 w - - 0 1')), 'endgame');
  assert.equal(detectPhase(new Chess('r2q1rk1/pp3ppp/2n5/3p4/3P4/2N5/PP2QPPP/R4RK1 w - - 0 15')), 'middlegame');
});

test('проходная пешка в эндшпиле упоминается в объяснении', () => {
  const c = new Chess('8/5k2/8/8/3K4/8/4P3/8 w - - 0 1');
  const res = explainMove(c, 'e2e4');
  assert.match(texts(res), /проходную/);
});

test('explainThreat описывает ход соперника из позиции, где ход не его', () => {
  // Ход белых, но угроза считается за чёрных: Nxe4 забирает пешку e4.
  const fen = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 4 4';
  const threat = explainThreat(fen, 'f6e4', { cp: 120 });
  assert.equal(threat.san, 'Nxe4');
  assert.equal(threat.captured, 'p');
  assert.equal(threat.from, 'f6');
});

test('explainThreat возвращает null, если ход невозможен', () => {
  assert.equal(explainThreat(new Chess().fen(), 'a1a8', { cp: 0 }), null);
});

test('pvToSan переводит линию движка в запись ходов и не падает на мусоре', () => {
  const fen = new Chess().fen();
  assert.deepEqual(pvToSan(fen, ['e2e4', 'e7e5', 'g1f3'], 3), ['e4', 'e5', 'Nf3']);
  assert.deepEqual(pvToSan(fen, ['e2e4', 'a1a8'], 3), ['e4']);
  assert.equal(sanOf(fen, 'zzzz'), 'zzzz');
});

test('объяснение невозможного хода не выбрасывает исключение', () => {
  const res = explainMove(new Chess(), 'a1a8');
  assert.equal(res.reasons.length, 0);
  assert.deepEqual(res.tags, []);
});
