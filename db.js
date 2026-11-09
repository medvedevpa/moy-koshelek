const DB_NAME = 'my-wallet-pwa-v1';
const DB_VERSION = 2;
let dbPromise;

export function openDB() {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ['wallets', 'categories', 'transactions', 'budgets']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
      for (const name of ['cloud_meta', 'cloud_pending']) {if (!db.objectStoreNames.contains(name)) db.createObjectStore(name,{keyPath:'key'});}
      const tx = req.transaction.objectStore('transactions');
      if (!tx.indexNames.contains('sourceKey')) tx.createIndex('sourceKey', 'sourceKey', { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function getAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function changed(type,id,payload,deleted=false){if(['wallets','categories','transactions','budgets'].includes(type))window.dispatchEvent(new CustomEvent('wallet-local-change',{detail:{type,id,payload,deleted}}))}
export async function save(storeName, item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(item);
    tx.oncomplete = () => {changed(storeName,item.id,item);resolve();};
    tx.onerror = () => reject(tx.error);
  });
}
export async function remove(storeName, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => {changed(storeName,id,null,true);resolve();};
    tx.onerror = () => reject(tx.error);
  });
}
export async function insertMany(storeName, items) {
  if (!items.length) return;
  const db = await openDB();
  // Batch writes; a transaction keeps records consistent.
  for (let start = 0; start < items.length; start += 1000) {
    const batch = items.slice(start, start + 1000);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const obj = tx.objectStore(storeName);
      for (const item of batch) obj.put(item);
      tx.oncomplete = () => {for(const x of batch)changed(storeName,x.id,x);resolve();};
      tx.onerror = () => reject(tx.error);
    });
  }
}
export async function replaceDatabase(data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const names = ['wallets', 'categories', 'transactions', 'budgets'];
    const tx = db.transaction(names, 'readwrite');
    for (const name of names) {
      const store = tx.objectStore(name);
      store.clear();
      for (const item of data[name]) store.put(item);
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
export function uid() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`; }
