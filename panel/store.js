// Хранилище партий и настроек (chrome.storage.local). Всё остаётся в браузере пользователя.

function area() {
  try {
    return chrome.storage.local;
  } catch (e) {
    return null;
  }
}

// Последняя ошибка хранилища: панель показывает её пользователю, чтобы «партия
// не сохранилась» не выглядело как «партии не было».
export let lastError = null;

function runtimeError() {
  try {
    return chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
  } catch (e) {
    return null;
  }
}

export function get(keys) {
  return new Promise((resolve) => {
    const a = area();
    if (!a) return resolve({});
    try {
      a.get(keys, (v) => {
        const err = runtimeError();
        if (err) lastError = err;
        resolve(v || {});
      });
    } catch (e) {
      lastError = e.message;
      resolve({});
    }
  });
}

export function set(obj) {
  return new Promise((resolve) => {
    const a = area();
    if (!a) return resolve(false);
    try {
      a.set(obj, () => {
        const err = runtimeError();
        if (err) lastError = err;
        resolve(!err);
      });
    } catch (e) {
      lastError = e.message;
      resolve(false);
    }
  });
}

export function remove(keys) {
  return new Promise((resolve) => {
    const a = area();
    if (!a) return resolve(false);
    try {
      a.remove(keys, () => {
        const err = runtimeError();
        if (err) lastError = err;
        resolve(!err);
      });
    } catch (e) {
      lastError = e.message;
      resolve(false);
    }
  });
}

// Запись индекса — это чтение-изменение-запись, поэтому все операции идут
// по одной очереди: иначе две вкладки (или удаление во время автосохранения)
// затирают изменения друг друга.
let queue = Promise.resolve();
function serial(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

export async function loadIndex() {
  const v = await get(['gameIndex']);
  return Array.isArray(v.gameIndex) ? v.gameIndex : [];
}

export async function loadGame(id) {
  const v = await get(['game:' + id]);
  return v['game:' + id] || null;
}

// Сохраняет партию и обновляет индекс (краткие сведения для списка истории).
export function saveGame(game, summary) {
  return serial(() => saveGameNow(game, summary));
}

async function saveGameNow(game, summary) {
  const index = await loadIndex();
  const entry = {
    id: game.id,
    startedAt: game.startedAt,
    updatedAt: game.updatedAt,
    myColor: game.myColor,
    opponent: game.opponent,
    me: game.me,
    result: game.result,
    rated: game.rated,
    moves: game.moves.length,
    accuracy: summary.accuracy,
    mistakes: summary.counts.mistake + summary.counts.blunder,
    finished: game.finished,
  };
  const i = index.findIndex((g) => g.id === game.id);
  if (i >= 0) index[i] = entry;
  else index.unshift(entry);
  index.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  await set({ ['game:' + game.id]: game, gameIndex: index });
  return index;
}

export function deleteGame(id) {
  return serial(() => deleteGameNow(id));
}

async function deleteGameNow(id) {
  const index = (await loadIndex()).filter((g) => g.id !== id);
  await remove(['game:' + id]);
  await set({ gameIndex: index });
  return index;
}
