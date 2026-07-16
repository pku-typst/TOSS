import { useMemo, useSyncExternalStore } from "react";
import {
  aiAccountSettingsStorageKey,
  loadAiAccountSettings,
  saveAiAccountSettings,
  type AiAccountSettings
} from "@/features/ai/accountSettingsStore";
import {
  aiConnectionStorageKey,
  loadStoredAiConnections,
  saveStoredAiConnections,
  type StoredAiConnections
} from "@/features/ai/connectionStore";

export type AiAccountConfiguration = {
  connections: StoredAiConnections;
  settings: AiAccountSettings;
};

type AiAccountConfigurationStore = {
  getSnapshot: () => AiAccountConfiguration;
  subscribe: (listener: () => void) => () => void;
  setConnections: (connections: StoredAiConnections) => void;
  setSettings: (settings: AiAccountSettings) => void;
};

const stores = new Map<string, AiAccountConfigurationStore>();

function configurationStoreKey(accountId: string | null, applicationOrigin: string) {
  return `${applicationOrigin}\n${accountId ?? "<anonymous>"}`;
}

function loadConfiguration(
  accountId: string | null,
  applicationOrigin: string,
  storage: Storage
): AiAccountConfiguration {
  try {
    return {
      connections: loadStoredAiConnections(accountId, applicationOrigin, storage),
      settings: loadAiAccountSettings(accountId, storage)
    };
  } catch {
    return {
      connections: { schema: 1, connections: [] },
      settings: loadAiAccountSettings(null, storage)
    };
  }
}

function createConfigurationStore(
  accountId: string | null,
  applicationOrigin: string
): AiAccountConfigurationStore {
  const storage = window.localStorage;
  let snapshot = loadConfiguration(accountId, applicationOrigin, storage);
  const listeners = new Set<() => void>();
  const connectionKey = accountId ? aiConnectionStorageKey(accountId) : null;
  const settingsKey = accountId ? aiAccountSettingsStorageKey(accountId) : null;

  const emit = () => {
    for (const listener of listeners) listener();
  };
  const reload = () => {
    snapshot = loadConfiguration(accountId, applicationOrigin, storage);
    emit();
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== storage) return;
    if (event.key !== connectionKey && event.key !== settingsKey) return;
    reload();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (listeners.size === 0) window.addEventListener("storage", handleStorage);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) window.removeEventListener("storage", handleStorage);
      };
    },
    setConnections(connections) {
      saveStoredAiConnections(accountId, connections, storage);
      snapshot = { ...snapshot, connections };
      emit();
    },
    setSettings(settings) {
      saveAiAccountSettings(accountId, settings, storage);
      snapshot = { ...snapshot, settings };
      emit();
    }
  };
}

function accountConfigurationStore(
  accountId: string | null,
  applicationOrigin: string
) {
  const key = configurationStoreKey(accountId, applicationOrigin);
  const existing = stores.get(key);
  if (existing) return existing;
  const created = createConfigurationStore(accountId, applicationOrigin);
  stores.set(key, created);
  return created;
}

export function useAiAccountConfiguration(
  accountId: string | null,
  applicationOrigin: string
) {
  const store = useMemo(
    () => accountConfigurationStore(accountId, applicationOrigin),
    [accountId, applicationOrigin]
  );
  const configuration = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );
  return {
    configuration,
    setConnections: store.setConnections,
    setSettings: store.setSettings
  };
}
