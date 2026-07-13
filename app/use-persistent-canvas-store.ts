"use client";

import {
  createTLStore,
  getSnapshot,
  loadSnapshot,
  type TLEditorSnapshot,
  type TLStore,
} from "@tldraw/editor";
import {
  defaultAssetUtils,
  defaultBindingUtils,
  defaultShapeUtils,
} from "tldraw";
import type { TLRecord } from "@tldraw/tlschema";
import { useEffect, useState } from "react";

const DATABASE_NAME = "codex-canvas-persistence-v1";
const DATABASE_VERSION = 1;
const SNAPSHOT_STORE = "snapshots";
const SNAPSHOT_KEY = "main";
const LEGACY_DATABASE_NAME = "TLDRAW_DOCUMENT_v2codex-canvas";

type StoredSnapshot = {
  snapshot: TLEditorSnapshot;
  updatedAt: number;
};

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SNAPSHOT_STORE)) {
        request.result.createObjectStore(SNAPSHOT_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the canvas database"));
  });
}

async function readStoredSnapshot(): Promise<TLEditorSnapshot | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(SNAPSHOT_STORE, "readonly");
    const done = transactionDone(transaction);
    const row = await requestResult(
      transaction.objectStore(SNAPSHOT_STORE).get(SNAPSHOT_KEY) as IDBRequest<StoredSnapshot | undefined>,
    );
    await done;
    return row?.snapshot ?? null;
  } finally {
    database.close();
  }
}

async function writeStoredSnapshot(snapshot: TLEditorSnapshot): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(SNAPSHOT_STORE, "readwrite");
    transaction.objectStore(SNAPSHOT_STORE).put(
      { snapshot, updatedAt: Date.now() } satisfies StoredSnapshot,
      SNAPSHOT_KEY,
    );
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not migrate a canvas asset"));
    reader.readAsDataURL(blob);
  });
}

async function legacyDatabaseExists(): Promise<boolean> {
  if (!window.indexedDB.databases) return false;
  const databases = await window.indexedDB.databases();
  return databases.some((database) => database.name === LEGACY_DATABASE_NAME);
}

async function readLegacySnapshot(): Promise<TLEditorSnapshot | null> {
  if (!(await legacyDatabaseExists())) return null;

  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(LEGACY_DATABASE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the previous canvas database"));
  });

  try {
    if (!database.objectStoreNames.contains("records") || !database.objectStoreNames.contains("schema")) {
      return null;
    }

    const storeNames = ["records", "schema"];
    if (database.objectStoreNames.contains("session_state")) storeNames.push("session_state");
    const transaction = database.transaction(storeNames, "readonly");
    const done = transactionDone(transaction);
    const recordsPromise = requestResult<TLRecord[]>(transaction.objectStore("records").getAll());
    const schemaPromise = requestResult<unknown>(transaction.objectStore("schema").get("schema"));
    const sessionsPromise = storeNames.includes("session_state")
      ? requestResult<Array<{
        updatedAt?: number;
        snapshot?: TLEditorSnapshot["session"];
      }>>(transaction.objectStore("session_state").getAll())
      : Promise.resolve([]);
    const [records, schema, sessions] = await Promise.all([
      recordsPromise,
      schemaPromise,
      sessionsPromise,
    ]);
    const session = sessions
      .sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0))
      .pop()?.snapshot ?? null;

    await done;
    if (!records.length || !schema) return null;

    if (database.objectStoreNames.contains("assets")) {
      const assetRecords = records.filter((record) => (
        record.typeName === "asset" && String(record.props.src || "").startsWith("asset:")
      ));
      if (assetRecords.length) {
        const assetTransaction = database.transaction("assets", "readonly");
        const assetsDone = transactionDone(assetTransaction);
        const assets = assetTransaction.objectStore("assets");
        const blobs = await Promise.all(assetRecords.map((record) => (
          requestResult<Blob | undefined>(assets.get(record.id))
        )));
        await assetsDone;
        await Promise.all(assetRecords.map(async (record, index) => {
          const blob = blobs[index];
          if (blob) record.props = { ...record.props, src: await blobToDataUrl(blob) };
        }));
      }
    }

    return {
      document: {
        schema,
        store: Object.fromEntries(records.map((record) => [record.id, record])),
      },
      ...(session ? { session } : {}),
    } as TLEditorSnapshot;
  } finally {
    database.close();
  }
}

async function restoreSnapshot(store: TLStore): Promise<void> {
  const saved = await readStoredSnapshot();
  if (saved) {
    loadSnapshot(store, saved, { forceOverwriteSessionState: true });
    return;
  }

  const legacy = await readLegacySnapshot();
  if (!legacy) return;
  loadSnapshot(store, legacy, { forceOverwriteSessionState: true });
}

export function usePersistentCanvasStore() {
  const [store] = useState(() => createTLStore({
    shapeUtils: defaultShapeUtils,
    bindingUtils: defaultBindingUtils,
    assetUtils: defaultAssetUtils,
  }));
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void restoreSnapshot(store)
      .catch((error) => console.error("Could not restore the canvas", error))
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => { cancelled = true; };
  }, [store]);

  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let saving = Promise.resolve();

    const save = () => {
      let snapshot: TLEditorSnapshot;
      try {
        snapshot = getSnapshot(store);
      } catch {
        return;
      }
      saving = saving
        .then(() => writeStoredSnapshot(snapshot))
        .catch((error) => console.error("Could not save the canvas", error));
    };

    const stopListening = store.listen(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(save, 180);
    });

    return () => {
      stopListening();
      if (timer) clearTimeout(timer);
      save();
    };
  }, [ready, store]);

  return { ready, store };
}
