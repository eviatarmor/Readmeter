/**
 * Bad Firestore patterns, one function per rule. The page and `examples/e2e/run.ts` both call these.
 * Document ids match the Cloud Functions example: posts `p0`..`p299`, users `u0`..`u49`.
 */
import { flush } from "@readmeter/firebase";
import {
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  where,
  writeBatch,
  type DocumentReference,
  type Firestore,
  type Query,
} from "@readmeter/firebase/firestore";

export const POSTS = 300;
export const USERS = 50;

export function postId(index: number): string {
  return `p${index}`;
}

export function userId(index: number): string {
  return `u${index}`;
}

/** fanout-writes starts at 100 writes in one commit. Seed stays under that. */
const SEED_CHUNK = 99;

interface SeedDoc {
  ref: DocumentReference;
  data: Record<string, unknown>;
}

async function commitAll(db: Firestore, items: SeedDoc[]): Promise<void> {
  for (let start = 0; start < items.length; start += SEED_CHUNK) {
    const batch = writeBatch(db);
    for (const item of items.slice(start, start + SEED_CHUNK)) batch.set(item.ref, item.data);
    await batch.commit();
  }
}

export async function seedData(db: Firestore): Promise<string> {
  const items: SeedDoc[] = [];
  for (let i = 0; i < POSTS; i += 1) {
    items.push({
      ref: doc(db, "posts", postId(i)),
      data: { title: "post", createdAt: i, kind: "post" },
    });
  }
  for (let i = 0; i < USERS; i += 1) {
    items.push({
      ref: doc(db, "users", userId(i)),
      data: { name: `user${i}`, createdAt: i },
    });
  }
  await commitAll(db, items);
  await flush();
  return `seeded ${POSTS} posts, ${USERS} users`;
}

/** firebase.firestore/unbounded-list (local, min 100 docs, no limit). */
export async function unboundedList(db: Firestore): Promise<string> {
  const snap = await getDocs(collection(db, "posts"));
  const n = snap.docs.length;
  await flush();
  return `unbounded list read ${n} posts`;
}

/**
 * firebase.firestore/offset-pagination.
 * The modular web SDK has no `offset()`. The shape reader already records
 * `_query.offset`, so the button sets that field and runs a normal limited
 * query. The Cloud Functions example calls the real admin `offset(200)`.
 */
export async function offsetPagination(db: Firestore): Promise<string> {
  const q = query(collection(db, "posts"), orderBy("createdAt"), limit(20));
  const internal = (q as Query & { _query?: { offset?: number } })._query;
  if (!internal) throw new Error("web query has no _query; cannot record offset");
  internal.offset = 200;
  const snap = await getDocs(q);
  const n = snap.docs.length;
  await flush();
  return `offset pagination returned ${n} posts`;
}

/** firebase.firestore/missing-cursor: limit(20), then 40, then 60. */
export async function loadMore(db: Firestore): Promise<string> {
  const posts = collection(db, "posts");
  for (const n of [20, 40, 60]) {
    await getDocs(query(posts, orderBy("createdAt"), limit(n)));
  }
  await flush();
  return "load more grew limit() across 3 pages";
}

/** firebase.firestore/count-via-fetch: only `snapshot.size` is read. */
export async function countViaFetch(db: Firestore): Promise<string> {
  const snap = await getDocs(query(collection(db, "posts"), limit(50)));
  const n = snap.size;
  await flush();
  return `count via fetch saw size ${n}`;
}

/** firebase.firestore/get-then-listen. */
export async function getThenListen(db: Firestore): Promise<string> {
  const posts = query(collection(db, "posts"), orderBy("createdAt"), limit(20));
  await getDocs(posts);
  const unsub = onSnapshot(posts, () => undefined);
  unsub();
  await flush();
  return "get then listen";
}

/** firebase.firestore/listener-per-item. The rule fires at 25 open doc listeners. */
export async function listenerPerItem(db: Firestore): Promise<string> {
  const unsubs: Array<() => void> = [];
  for (let i = 0; i < 30; i += 1) {
    unsubs.push(onSnapshot(doc(db, "users", userId(i)), () => undefined));
  }
  for (const unsub of unsubs) unsub();
  await flush();
  return "opened 30 document listeners";
}

/** One search query. The same line runs for every keystroke. */
export async function searchOnce(db: Firestore, term: string): Promise<void> {
  await getDocs(query(collection(db, "users"), where("name", ">=", term), limit(8)));
}

/** firebase.firestore/query-per-keystroke (4 distinct values inside 3s). */
export async function searchPerKeystroke(db: Firestore): Promise<string> {
  for (const term of ["a", "ab", "abc", "abcd"]) await searchOnce(db, term);
  await flush();
  return "searched 4 prefixes";
}

/** One draft write. The same line runs for every keystroke. */
export async function saveDraft(db: Firestore, body: string): Promise<void> {
  await setDoc(doc(db, "drafts", "d1"), { body });
}

/** firebase.firestore/write-per-keystroke (5 writes inside 5s). */
export async function writePerKeystroke(db: Firestore): Promise<string> {
  for (const ch of ["a", "b", "c", "d", "e"]) await saveDraft(db, ch);
  await flush();
  return "wrote the draft 5 times";
}

/** firebase.firestore/tiny-batches (10 commits of 1 write inside 2s). */
export async function tinyBatches(db: Firestore): Promise<string> {
  for (let i = 0; i < 10; i += 1) {
    const batch = writeBatch(db);
    batch.set(doc(db, "outbox", `t${i}`), { n: i });
    await batch.commit();
  }
  await flush();
  return "committed 10 tiny batches";
}
