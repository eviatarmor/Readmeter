/**
 * Bad Cloud Storage patterns, one function per rule.
 * The page and `examples/e2e/run.ts` both call these.
 */
import {
  getBytes,
  getDownloadURL,
  getMetadata,
  list,
  listAll,
  ref,
  uploadBytes,
  type FirebaseStorage,
} from "@readmeter/firebase/storage";

const IMAGE_BYTES = 1_048_577;
const UPLOAD_BYTES = 5_242_881;

async function seedPrefix(storage: FirebaseStorage, prefix: string, count: number): Promise<void> {
  const chunk = 40;
  for (let start = 0; start < count; start += chunk) {
    const jobs: Promise<unknown>[] = [];
    const end = Math.min(count, start + chunk);
    for (let i = start; i < end; i += 1) {
      jobs.push(uploadBytes(ref(storage, `${prefix}/${i}.txt`), new Uint8Array([120])));
    }
    await Promise.all(jobs);
  }
}

/** unbounded-list-page: list() with no maxResults. */
export async function unboundedStorageList(storage: FirebaseStorage): Promise<string> {
  const page = await list(ref(storage, "unused-unbounded"));
  return `listed ${page.items.length} storage objects with no maxResults`;
}

/** list-all-large-prefix: listAll of 1000 objects. */
export async function listAllLargePrefix(storage: FirebaseStorage): Promise<string> {
  await seedPrefix(storage, "bulk", 1000);
  const all = await listAll(ref(storage, "bulk"));
  return `listAll returned ${all.items.length} objects`;
}

/** download-url-per-render: five getDownloadURL calls on one object. */
export async function downloadUrlPerRender(storage: FirebaseStorage): Promise<string> {
  const file = ref(storage, "photos/hero.png");
  await uploadBytes(file, new Uint8Array([1, 2, 3]), { contentType: "image/png" });
  let last = "";
  for (let i = 0; i < 5; i += 1) last = await getDownloadURL(file);
  return `fetched a download URL ${last.startsWith("http") ? 5 : 0} times`;
}

/** redownload-without-cache-control: metadata with no max-age, then three downloads. */
export async function redownloadWithoutCache(storage: FirebaseStorage): Promise<string> {
  const file = ref(storage, "files/data.bin");
  await uploadBytes(file, new Uint8Array(100), { cacheControl: "no-cache" });
  await getMetadata(file);
  for (let i = 0; i < 3; i += 1) await getBytes(file);
  return "downloaded files/data.bin 3 times with no max-age";
}

/** original-size-images: browser getBytes of a PNG larger than 1 MiB. */
export async function originalSizeImage(storage: FirebaseStorage): Promise<string> {
  const body = new Uint8Array(IMAGE_BYTES);
  body[0] = 9;
  const file = ref(storage, "photos/photo.png");
  await uploadBytes(file, body, { contentType: "image/png" });
  const got = await getBytes(file);
  return `downloaded photo.png (${got.byteLength} bytes)`;
}

/** upload-without-resumable: uploadBytes of more than 5 MiB. */
export async function uploadWithoutResumable(storage: FirebaseStorage): Promise<string> {
  const body = new Uint8Array(UPLOAD_BYTES);
  await uploadBytes(ref(storage, "videos/clip.bin"), body);
  return `uploaded videos/clip.bin in one shot (${body.byteLength} bytes)`;
}
