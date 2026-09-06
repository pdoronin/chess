// Хранилище партий и настроек (chrome.storage.local). Всё остаётся в браузере пользователя.

function area() {
  try {
    return chrome.storage.local;
  } catch (e) {
    return null;
  }
}

export function get(keys) {
  return new Promise((resolve) => {
    const a = area();
    if (!a) return resolve({});
    try {
      a.get(keys, (v) => resolve(v || {}));
    } catch (e) {
      resolve({});
    }
  });
}

export function set(obj) {
  return new Promise((resolve) => {
    const a = area();
    if (!a) return resolve();
    try {
      a.set(obj, () => resolve());
    } catch (e) {
      resolve();
    }
  });
}

export function remove(keys) {
  return new Promise((resolve) => {
    const a = area();
    if (!a) return resolve();
    try {
      a.remove(keys, () => resolve());
    } catch (e) {
      resolve();
    }
  });
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
export async function saveGame(game, summary) {
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

export async function deleteGame(id) {
  const index = (await loadIndex()).filter((g) => g.id !== id);
  await remove(['game:' + id]);
  await set({ gameIndex: index });
  return index;
}
