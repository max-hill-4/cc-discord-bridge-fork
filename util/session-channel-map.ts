/**
 * Persistent mapping: Discord channelId <-> Claude Code session UUID + project slug.
 *
 * Backs the in-memory channelSessionMap in core/handler-registry.ts so that
 * restarting the bot doesn't break the "type in a session channel to continue
 * that session" behavior. The map also tracks which project slug each session
 * belongs to, for display / re-import / future per-project categories.
 */

import { PersistenceManager } from "./persistence.ts";

export interface SessionChannelEntry {
  channelId: string;
  sessionId: string;
  projectSlug: string;
  firstPrompt: string;
  importedAt: string;
}

type SessionChannelStore = Record<string, SessionChannelEntry>;

let sessionChannelsManager: PersistenceManager<SessionChannelStore> | null = null;

export function getSessionChannelsManager(
  dataDir?: string,
): PersistenceManager<SessionChannelStore> {
  if (!sessionChannelsManager) {
    sessionChannelsManager = new PersistenceManager<SessionChannelStore>(
      "session-channels",
      { dataDir },
    );
  }
  return sessionChannelsManager;
}

let cache: SessionChannelStore | null = null;

async function loadStore(): Promise<SessionChannelStore> {
  if (cache !== null) return cache;
  cache = await getSessionChannelsManager().load({});
  return cache;
}

async function persist(): Promise<void> {
  if (cache !== null) {
    await getSessionChannelsManager().save(cache);
  }
}

/** Register a session channel. Overwrites any existing entry for channelId. */
export async function registerSessionChannel(
  channelId: string,
  entry: Omit<SessionChannelEntry, "channelId" | "importedAt"> & {
    importedAt?: string;
  },
): Promise<void> {
  const store = await loadStore();
  store[channelId] = {
    channelId,
    sessionId: entry.sessionId,
    projectSlug: entry.projectSlug,
    firstPrompt: entry.firstPrompt,
    importedAt: entry.importedAt ?? new Date().toISOString(),
  };
  await persist();
}

/** Remove a session channel mapping. */
export async function unregisterSessionChannel(
  channelId: string,
): Promise<void> {
  const store = await loadStore();
  delete store[channelId];
  await persist();
}

/** Get the session UUID bound to a Discord channel, or undefined. */
export async function getSessionIdForChannel(
  channelId: string,
): Promise<string | undefined> {
  const store = await loadStore();
  return store[channelId]?.sessionId;
}

/** Get the entry for a channel, or undefined. */
export async function getEntryForChannel(
  channelId: string,
): Promise<SessionChannelEntry | undefined> {
  const store = await loadStore();
  return store[channelId];
}

/** Find the Discord channel bound to a session UUID, or undefined. */
export async function getChannelIdForSession(
  sessionId: string,
): Promise<string | undefined> {
  const store = await loadStore();
  for (const entry of Object.values(store)) {
    if (entry.sessionId === sessionId) return entry.channelId;
  }
  return undefined;
}

/** Is this Discord channel a known session channel? */
export async function isSessionChannel(
  channelId: string,
): Promise<boolean> {
  const store = await loadStore();
  return Object.prototype.hasOwnProperty.call(store, channelId);
}

/** List all known session-channel entries. */
export async function listSessionChannels(): Promise<SessionChannelEntry[]> {
  const store = await loadStore();
  return Object.values(store);
}

/**
 * Hydrate the in-memory Map<string,string> in handler-registry from disk.
 * Returns an object suitable for iterating, plus a populate helper.
 */
export async function loadSessionChannelMapForHydration(): Promise<
  Map<string, string>
> {
  const store = await loadStore();
  const m = new Map<string, string>();
  for (const entry of Object.values(store)) {
    m.set(entry.channelId, entry.sessionId);
  }
  return m;
}