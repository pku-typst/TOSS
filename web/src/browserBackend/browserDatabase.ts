import type {
  StoredBrowserAsset,
  StoredBrowserDocument,
  StoredBrowserProject,
  StoredBrowserThumbnail,
} from "@/browserBackend/browserRecords";

export const BROWSER_DATABASE_NAME = "toss-browser-backend";
export const BROWSER_DATABASE_VERSION = 1;

export const browserStores = {
  projects: "projects",
  documents: "documents",
  assets: "assets",
  thumbnails: "thumbnails",
} as const;

let databasePromise: Promise<IDBDatabase> | null = null;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("browser_database_request_failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("browser_database_transaction_aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("browser_database_transaction_failed"));
  });
}

export function openBrowserDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(BROWSER_DATABASE_NAME, BROWSER_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const projects = database.createObjectStore(browserStores.projects, {
        keyPath: "id",
      });
      projects.createIndex("updatedAt", "updatedAt");

      const documents = database.createObjectStore(browserStores.documents, {
        keyPath: "id",
      });
      documents.createIndex("projectId", "projectId");
      documents.createIndex("projectPath", ["projectId", "path"], {
        unique: true,
      });

      const assets = database.createObjectStore(browserStores.assets, {
        keyPath: "id",
      });
      assets.createIndex("projectId", "project_id");
      assets.createIndex("projectPath", ["project_id", "path"], {
        unique: true,
      });

      database.createObjectStore(browserStores.thumbnails, {
        keyPath: "projectId",
      });
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error("browser_database_open_failed"));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error("browser_database_upgrade_blocked"));
    };
  });
  return databasePromise;
}

export async function withBrowserTransaction<T>(
  storeNames: string | string[],
  mode: IDBTransactionMode,
  operation: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  const database = await openBrowserDatabase();
  const transaction = database.transaction(storeNames, mode);
  const completion = transactionDone(transaction);
  try {
    const result = await operation(transaction);
    await completion;
    return result;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // The transaction may already have completed or aborted.
    }
    await completion.catch(() => undefined);
    throw error;
  }
}

export function getRecord<T>(store: IDBObjectStore | IDBIndex, key: IDBValidKey) {
  return requestResult(store.get(key) as IDBRequest<T | undefined>);
}

export function getAllRecords<T>(store: IDBObjectStore) {
  return requestResult(store.getAll() as IDBRequest<T[]>);
}

export function getAllByIndex<T>(
  store: IDBObjectStore,
  index: string,
  key: IDBValidKey,
) {
  return requestResult(
    store.index(index).getAll(IDBKeyRange.only(key)) as IDBRequest<T[]>,
  );
}

export function putRecord<T>(store: IDBObjectStore, value: T) {
  return requestResult(store.put(value));
}

export function deleteRecord(store: IDBObjectStore, key: IDBValidKey) {
  return requestResult(store.delete(key));
}

export type BrowserDatabaseRecord =
  | StoredBrowserProject
  | StoredBrowserDocument
  | StoredBrowserAsset
  | StoredBrowserThumbnail;
