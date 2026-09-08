// Собирает dist/chess-coach-<версия>.zip — архив для раздачи или загрузки в Chrome Web Store.
// Запуск: npm run zip
import { mkdir, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// В архив входит только то, что нужно браузеру.
const INCLUDE = ['manifest.json', 'content', 'panel', 'engine', 'lib', 'icons', 'README.md', 'LICENSE'];

const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const out = join(root, 'dist', `chess-coach-${manifest.version}.zip`);

await rm(join(root, 'dist'), { recursive: true, force: true });
await mkdir(join(root, 'dist'), { recursive: true });
await run('zip', ['-r', '-q', out, ...INCLUDE], { cwd: root });

const { stdout } = await run('du', ['-h', out]);
console.log('Готово:', stdout.trim());
console.log('Этот архив можно распаковать и загрузить через chrome://extensions → «Загрузить распакованное расширение».');
