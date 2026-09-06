// Мини-доска (SVG) для режима разбора.
import { Chess } from '../lib/chess.js';

const GLYPH = {
  w: { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
  b: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' },
};

function xy(sq, orientation) {
  const file = sq.charCodeAt(0) - 97;
  const rank = parseInt(sq[1], 10) - 1;
  return orientation === 'white' ? [file, 7 - rank] : [7 - file, rank];
}

export function boardSvg(fen, { orientation = 'white', arrows = [], lastMove = null, highlights = [] } = {}) {
  const chess = new Chess(fen);
  const cells = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const light = (x + y) % 2 === 0;
      cells.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${light ? '#f0d9b5' : '#b58863'}"/>`);
    }
  }
  const marks = [];
  if (lastMove) {
    for (const sq of lastMove) {
      const [x, y] = xy(sq, orientation);
      marks.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="rgba(155,199,0,0.45)"/>`);
    }
  }
  for (const h of highlights) {
    const [x, y] = xy(h.sq, orientation);
    marks.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${h.color}"/>`);
  }
  const pieces = [];
  for (const row of chess.board()) {
    for (const p of row) {
      if (!p) continue;
      const [x, y] = xy(p.square, orientation);
      pieces.push(
        `<text x="${x + 0.5}" y="${y + 0.5}" font-size="0.82" text-anchor="middle" dominant-baseline="central" style="font-family:'Segoe UI Symbol','DejaVu Sans','Noto Sans Symbols2','Apple Symbols',sans-serif">${GLYPH[p.color][p.type]}</text>`
      );
    }
  }
  const defs = [];
  const arr = [];
  arrows.forEach((a, i) => {
    const [x1, y1] = xy(a.from, orientation);
    const [x2, y2] = xy(a.to, orientation);
    const cx1 = x1 + 0.5, cy1 = y1 + 0.5, cx2 = x2 + 0.5, cy2 = y2 + 0.5;
    const dx = cx2 - cx1, dy = cy2 - cy1;
    const len = Math.hypot(dx, dy) || 1;
    const ex = cx2 - (dx / len) * 0.3, ey = cy2 - (dy / len) * 0.3;
    defs.push(`<marker id="mb-${i}" orient="auto" markerWidth="4" markerHeight="4" refX="2.05" refY="2" markerUnits="strokeWidth"><path d="M0,0 V4 L3,2 Z" fill="${a.color}"/></marker>`);
    arr.push(`<line x1="${cx1}" y1="${cy1}" x2="${ex}" y2="${ey}" stroke="${a.color}" stroke-width="${a.width || 0.16}" stroke-linecap="round" opacity="${a.opacity || 0.85}" marker-end="url(#mb-${i})"/>`);
  });
  const coords = [];
  for (let i = 0; i < 8; i++) {
    const file = orientation === 'white' ? String.fromCharCode(97 + i) : String.fromCharCode(104 - i);
    const rank = orientation === 'white' ? 8 - i : i + 1;
    coords.push(`<text x="${i + 0.93}" y="${7.95}" font-size="0.22" text-anchor="end" fill="#5a4630">${file}</text>`);
    coords.push(`<text x="0.06" y="${i + 0.25}" font-size="0.22" fill="#5a4630">${rank}</text>`);
  }
  return `<svg class="miniboard" viewBox="0 0 8 8" xmlns="http://www.w3.org/2000/svg"><defs>${defs.join('')}</defs>${cells.join('')}${marks.join('')}${coords.join('')}${pieces.join('')}${arr.join('')}</svg>`;
}
