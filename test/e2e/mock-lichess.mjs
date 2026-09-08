// Сквозной тест: поднимает Chromium с расширением и подставляет страницу с разметкой lichess.
// Запуск: npm run e2e  (нужен установленный Playwright: npm i -D playwright)
import { chromium } from 'playwright';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ext = new URL('../..', import.meta.url).pathname;
const profile = await mkdtemp(join(tmpdir(), 'chess-coach-e2e-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  // Путь к браузеру можно задать через CHROME_PATH, иначе берётся браузер Playwright.
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  viewport: { width: 1400, height: 900 },
});
const html = (moves, opts = {}) => `<!doctype html><html><head><meta charset="utf-8"><style>
.cg-wrap{width:480px;height:480px;position:relative;display:block;background:#b58863}
cg-container{position:absolute;width:100%;height:100%}
body{margin:0;font-family:sans-serif}</style></head>
<body data-user="player"><main class="round">
<div class="round__app">
<div class="cg-wrap orientation-black"><cg-container><cg-board></cg-board></cg-container></div>
<div class="ruser-top"><a class="user-link">opponent (1200)</a></div>
<div class="ruser-bottom"><a class="user-link">player (1250)</a></div>
<div class="rclock-bottom"><div class="time">04:48</div></div>
<div class="rcontrols"><div class="ricons"><button class="fbt resign"></button></div></div>
<div class="round__app__table"><l4x id="moves"></l4x></div>
${opts.result ? `<div class="result-wrap"><p class="result">${opts.result}</p></div>` : ''}
</div>
<div class="game__meta"><div class="header"><div class="setup">5+3 • ${opts.rated ? 'Рейтинговая' : 'Товарищеская'} • Блиц</div></div></div>
</main></body></html>`;
await ctx.route('https://lichess.org/**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html([], { rated: true }) }));
const page = await ctx.newPage();
page.on('console', m => { if (m.type()==='error') console.log('[console.error]', m.text().slice(0,300)); });
page.on('pageerror', e => console.log('[pageerror]', e.message));
const setMoves = (moves) => page.evaluate((moves) => {
  const l = document.getElementById('moves'); l.innerHTML = '';
  moves.forEach((m, i) => { if (i % 2 === 0) { const n = document.createElement('i5z'); n.textContent = (i/2+1); l.appendChild(n); } const k = document.createElement('kwdb'); k.textContent = m; if (i === moves.length-1) k.className = 'a'; l.appendChild(k); });
}, moves);
const frameOf = () => page.frames().find(f => f.url().startsWith('chrome-extension://'));
const text = async () => (await frameOf().evaluate(() => document.getElementById('view').innerText));
const click = async (sel) => frameOf().click(sel);
const wait = (ms) => page.waitForTimeout(ms);

await page.goto('https://lichess.org/testgame1234', { waitUntil: 'domcontentloaded' });
await wait(2500);
console.log('panel:', await page.$('#chess-coach-root') !== null, 'frame:', !!frameOf());
console.log('--- start (no moves) ---\n', (await text()).slice(0, 300));

const line = ['e4','e5','Qh5','Nc6','Bc4','Nf6','Qxf7#'];
for (let i = 1; i <= line.length; i++) {
  await setMoves(line.slice(0, i));
  await wait(i === line.length ? 1500 : 2600);
  console.log(`--- after ${line.slice(0,i).join(' ')} --- status: ${await page.$eval('#chess-coach-root .cc-status', e => e.textContent)}`);
  if (i === 5) {
    // включаем подсказки на ход чёрных
    console.log((await text()).slice(0, 400));
    await click('button[data-action="show-hints"]'); await wait(300);
    await click('button[data-action="dismiss-rated"]').catch(()=>{}); await wait(300);
    console.log('--- visible, level 0 ---\n', (await text()).slice(0, 1200));
    await click('button[data-level="1"]'); await wait(300);
    await click('button[data-level="3"]'); await wait(300);
    console.log('--- level 3 ---\n', (await text()).slice(0, 1800));
    console.log('arrows on board:', await page.$$eval('svg.cc-arrows line', n => n.map(l => l.getAttribute('x1')+','+l.getAttribute('y1')+'->'+l.getAttribute('x2')+','+l.getAttribute('y2')+' '+l.getAttribute('stroke'))));
    await page.screenshot({ path: join(profile, 'shot-live.png') });
  }
  if (i === 6) console.log((await text()).slice(0, 900));
}
console.log('--- game over ---\n', (await text()).slice(0, 1500));
await page.screenshot({ path: join(profile, 'shot-over.png') });
await click('button[data-action="review-current"]'); await wait(3500);
console.log('--- review ---\n', (await text()).slice(0, 1600));
await page.screenshot({ path: join(profile, 'shot-review.png') });
await frameOf().click('.mv[data-review-go="6"]'); await wait(2500);
console.log('--- review ply 6 (after Nf6) ---\n', (await text()).replace(/\n[♔♕♖♗♘♙♚♛♜♝♞♟a-h1-8]\n/g,'').slice(0, 1400));
await frameOf().click('button[data-review-go="5"]'); await wait(2500);
console.log('--- review ply 5 (before Nf6) ---\n', (await text()).split('⏭')[1].slice(0, 1200));
await page.keyboard.press('ArrowLeft'); await wait(300);
console.log('--- after ArrowLeft nav:', (await text()).split('◀')[1].split('▶')[0].trim());
await page.screenshot({ path: join(profile, 'shot-review2.png') });
await frameOf().click('.tab[data-tab="history"]'); await wait(800);
console.log('--- history ---\n', (await text()).slice(0, 600));
await frameOf().click('button[data-open-game]'); await wait(1500);
console.log('--- opened from history:', (await text()).split('◀')[1].split('▶')[0].trim());
// Удаление партии из истории: карточка целиком кликабельна, кнопка не должна открывать разбор.
await frameOf().click('.tab[data-tab="history"]'); await wait(500);
page.once('dialog', (d) => d.accept());
await frameOf().click('button[data-delete-game]'); await wait(1200);
const afterDelete = await frameOf().evaluate(() => new Promise((r) => chrome.storage.local.get(null, r)));
console.log('после удаления: индекс =', JSON.stringify(afterDelete.gameIndex), '| ключи =', Object.keys(afterDelete));

await frameOf().click('.tab[data-tab="lessons"]'); await wait(300);
console.log('--- lessons ---\n', (await text()).slice(0, 400));
await frameOf().click('.tab[data-tab="settings"]'); await wait(300);
await page.screenshot({ path: join(profile, 'shot-settings.png') });
console.log('--- settings ---\n', (await text()).slice(0, 500));
// storage check
const stored = await frameOf().evaluate(() => new Promise(r => chrome.storage.local.get(null, r)));
console.log('storage keys:', Object.keys(stored), 'index:', JSON.stringify(stored.gameIndex).slice(0, 300));
await ctx.close();
