/**
 * Bad Realtime Database patterns, one function per rule.
 * The page and `examples/e2e/run.ts` both call these.
 */
import {
  child,
  equalTo,
  get,
  limitToLast,
  onValue,
  orderByChild,
  query,
  ref,
  set,
  update,
  type Database,
} from "@readmeter/firebase/database";

const MIB = 1_048_576;
const LIST_BYTES = 102_400;

function waitUntil(ready: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (ready()) {
        resolve();
        return;
      }
      if (Date.now() - start > 20_000) {
        reject(new Error(`timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

/** listen-on-root: a top-level get of 1 MiB. */
export async function listenOnRoot(db: Database): Promise<string> {
  const archive = ref(db, "archive");
  await set(archive, "a".repeat(MIB));
  const snap = await get(archive);
  const bytes = JSON.stringify(snap.val()).length;
  return `root-level get downloaded ${bytes} bytes`;
}

/** download-whole-list: 500 children and no limit. */
export async function downloadWholeList(db: Database): Promise<string> {
  const posts: Record<string, { n: number }> = {};
  for (let i = 0; i < 500; i += 1) posts[`c${i}`] = { n: i };
  const location = ref(db, "posts");
  await set(location, posts);
  const snap = await get(location);
  return `unlimited list read ${snap.size} posts`;
}

/** value-listener-on-list: ten full-list snapshots of at least 100 KB. */
export async function valueListenerOnList(db: Database): Promise<string> {
  const list = ref(db, "chats/lobby/messages");
  const body = "b".repeat(LIST_BYTES);
  await set(list, { body });
  let hits = 0;
  const unsub = onValue(list, () => {
    hits += 1;
  });
  try {
    await waitUntil(() => hits >= 1, "initial list snapshot");
    for (let i = 0; i < 10; i += 1) {
      const before = hits;
      await set(child(list, "body"), `${body}${i}`);
      await waitUntil(() => hits > before, `list update ${i}`);
    }
  } finally {
    unsub();
  }
  return `value listener saw ${hits} snapshots`;
}

/** rtdb-write-hotspot: twenty updates of one path. */
export async function writeHotspot(db: Database): Promise<string> {
  const counter = ref(db, "counters/online");
  for (let i = 0; i < 20; i += 1) await update(counter, { n: i });
  return "wrote counters/online 20 times";
}

/** duplicate-listeners: three open listeners on one path. */
export async function duplicateListeners(db: Database): Promise<string> {
  const board = ref(db, "boards/live");
  const unsubs = [onValue(board, () => undefined), onValue(board, () => undefined), onValue(board, () => undefined)];
  try {
    return "opened 3 listeners on boards/live";
  } finally {
    for (const unsub of unsubs) unsub();
  }
}

/**
 * unindexed-query stays planned: the missing-index warning arrives later on the
 * listen response and is not attached to query() or the snapshot. Emulator
 * rules declare .indexOn for "n" so this limited query is allowed to finish.
 */
export async function unindexedQuery(db: Database): Promise<string> {
  const limited = query(ref(db, "posts"), orderByChild("n"), limitToLast(25), equalTo(1));
  const snap = await get(limited);
  return `planned unindexed-query read ${snap.size} posts; no_index is not on the snapshot`;
}
