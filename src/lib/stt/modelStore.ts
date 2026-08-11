const DB_NAME = "enclave-ai-models";
const DB_VERSION = 1;
const STORE_NAME = "models";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getCachedModel(url: string): Promise<ArrayBuffer | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(url);
    request.onsuccess = () => resolve((request.result as ArrayBuffer) ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function putCachedModel(url: string, data: ArrayBuffer): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(data, url);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export interface ModelFetchProgress {
  loadedBytes: number;
  totalBytes: number | null;
}

/**
 * Fetches ggml model weights and caches the raw bytes in IndexedDB so it's a
 * one-time download (plan.md §4.5). Not bundled in the repo — see .gitignore.
 */
export async function loadModel(
  url: string,
  onProgress?: (progress: ModelFetchProgress) => void
): Promise<ArrayBuffer> {
  const cached = await getCachedModel(url);
  if (cached) {
    onProgress?.({ loadedBytes: cached.byteLength, totalBytes: cached.byteLength });
    return cached;
  }

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch model: ${response.status} ${response.statusText}`);
  }

  const totalBytes = Number(response.headers.get("content-length")) || null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loadedBytes += value.length;
    onProgress?.({ loadedBytes, totalBytes });
  }

  const data = new Uint8Array(loadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }

  await putCachedModel(url, data.buffer);
  return data.buffer;
}
