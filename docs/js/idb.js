// A tiny key-value store in IndexedDB, shared by the app and its service worker
// (a service worker can't read localStorage).
const DB_NAME = 'lightmoon';
const STORE = 'kv';
let opening = null;

function open() {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      opening = null;
      reject(request.error);
    };
  });
  return opening;
}

async function run(mode, action) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = action(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
  });
}

export const idbGet = key => run('readonly', store => store.get(key));
export const idbSet = (key, value) => run('readwrite', store => store.put(value, key));
