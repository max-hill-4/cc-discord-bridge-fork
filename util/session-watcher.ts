/**
 * Filesystem watcher for the Claude Code projects directory (recursive).
 *
 * Two responsibilities, both triggered by JSONL writes and coalesced by a
 * single global debounce:
 *
 * 1. Global mtime sort — reorders channels in the claude-code category by
 *    JSONL mtime (newest first). Idempotent: concurrent triggers produce the
 *    same payload, so no race.
 *
 * 2. Live mirror — for each modified session with a bound Discord channel,
 *    read the new JSONL bytes and send user/assistant text messages to the
 *    channel. Sessions the bot is actively running (via /claude or a session
 *    channel message) are skipped so we don't double-post the bot's own
 *    streamed output.
 *
 * Byte offsets per session are tracked in memory. On bot startup, offsets for
 * all mapped sessions are initialized to current file size, so only writes
 * after startup get mirrored. If the bot restarts mid-session, messages
 * written during the downtime are lost (acceptable).
 */

import { getEntryForChannel, getChannelIdForSession, listSessionChannels } from "./session-channel-map.ts";

export interface SessionWatcherDeps {
  /** Late-bound bot instance — used to fetch the guild and channel cache. */
  // deno-lint-ignore no-explicit-any
  getBot: () => any;
  /** Global sort: order all channels in the claude-code category by JSONL mtime. */
  // deno-lint-ignore no-explicit-any
  sortChannelsByMtime: (bot: any) => Promise<void>;
  /** Is the bot currently running `claude --resume` for this session? */
  isActiveBotSession: (sessionId: string) => boolean;
  /** Auto-import a new session (not yet in the channel map) as a Discord channel. Returns channelId or null. */
  autoImportSession?: (sessionId: string, projectSlug: string, bot: any) => Promise<string | null>;
  /** Project slugs to exclude from auto-import (e.g. this build session's noise). */
  excludeSlugs?: string[];
  /** Optional: directory to watch. Defaults to ~/.claude/projects. */
  projectsDir?: string;
  /** Debounce window for coalescing bursts of writes (ms). Default 2000. */
  debounceMs?: number;
}

export function startSessionFileWatcher(deps: SessionWatcherDeps): void {
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "";
  const projectsDir = deps.projectsDir ?? `${home}/.claude/projects`;
  const debounceMs = deps.debounceMs ?? 2000;

  // Per-session byte offset: where we last read up to. Initialized to current
  // file size for all mapped sessions at startup so only new writes get mirrored.
  const offsets = new Map<string, number>();

  // Sessions modified since the last debounce fire — we process all of them
  // when the debounce fires. Map value is the project slug (extracted from the
  // event path) so auto-import can be called for unmapped sessions.
  const modifiedSessions = new Map<string, string>();

  const excludeSet = new Set(deps.excludeSlugs ?? []);

  let sortTimer: ReturnType<typeof setTimeout> | null = null;

  // Initialize offsets for all mapped sessions to current file size. Old
  // messages are already in Discord from the import backfill — we don't want
  // to re-mirror them.
  (async () => {
    try {
      const entries = await listSessionChannels();
      for (const entry of entries) {
        const path = `${home}/.claude/projects/${entry.projectSlug}/${entry.sessionId}.jsonl`;
        try {
          const stat = await Deno.stat(path);
          offsets.set(entry.sessionId, stat.size);
        } catch { /* file missing — skip */ }
      }
      console.log(`[SessionWatcher] Initialized offsets for ${offsets.size} sessions`);
    } catch (err) {
      console.warn(`[SessionWatcher] Offset init failed:`, err instanceof Error ? err.message : err);
    }
  })();

  const flush = async () => {
    sortTimer = null;
    const toProcess = [...modifiedSessions.entries()];
    modifiedSessions.clear();
    if (toProcess.length === 0) return;
    console.log(`[SessionWatcher] flush: ${toProcess.length} sessions modified: ${toProcess.map(([s]) => s.substring(0, 8)).join(",")}`);

    // 1. Global mtime sort.
    try {
      const bot = deps.getBot();
      if (bot?.client) {
        await deps.sortChannelsByMtime(bot);
        console.log(`[SessionWatcher] sort done`);
      }
    } catch (err) {
      console.warn(`[SessionWatcher] Sort failed:`, err instanceof Error ? err.message : err);
    }

    // 2. Mirror new messages for each modified session.
    for (const [sessionId, projectSlug] of toProcess) {
      try {
        const mirrored = await mirrorSession(sessionId, projectSlug);
        if (mirrored > 0) {
          console.log(`[SessionWatcher] mirrored ${mirrored} message(s) for ${sessionId.substring(0, 8)}`);
        }
      } catch (err) {
        console.warn(
          `[SessionWatcher] Mirror failed for ${sessionId.substring(0, 8)}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  };

  const mirrorSession = async (sessionId: string, projectSlug: string): Promise<number> => {
    // If the bot is actively running this session, skip mirroring (the bot's
    // own stream handles Discord) but still update the offset so we don't
    // mirror these messages later when the bot finishes.
    if (deps.isActiveBotSession(sessionId)) {
      const path = await findJsonlPath(sessionId);
      if (path) {
        try {
          const stat = await Deno.stat(path);
          offsets.set(sessionId, stat.size);
        } catch { /* ignore */ }
      }
      return 0;
    }

    let channelId = await getChannelIdForSession(sessionId);

    // Unmapped session — try auto-import. Skip excluded slugs (e.g. this
    // build session's own JSONL). If auto-import succeeds, set offset to
    // current file size so backfilled messages aren't re-mirrored.
    if (!channelId && deps.autoImportSession && !excludeSet.has(projectSlug)) {
      try {
        const bot = deps.getBot();
        const importedId = await deps.autoImportSession(sessionId, projectSlug, bot);
        if (importedId) {
          channelId = importedId;
          const path = `${home}/.claude/projects/${projectSlug}/${sessionId}.jsonl`;
          try {
            const stat = await Deno.stat(path);
            offsets.set(sessionId, stat.size);
          } catch { /* ignore */ }
          console.log(`[SessionWatcher] auto-imported ${sessionId.substring(0, 8)} → channel ${importedId}`);
          // Backfill was already sent by autoImportSession; don't re-mirror.
          return 0;
        }
      } catch (err) {
        console.warn(
          `[SessionWatcher] Auto-import failed for ${sessionId.substring(0, 8)}:`,
          err instanceof Error ? err.message : err,
        );
        return 0;
      }
    }

    if (!channelId) return 0; // not a session channel and not auto-importable — skip

    const entry = await getEntryForChannel(channelId);
    if (!entry) return 0;
    const path = `${home}/.claude/projects/${entry.projectSlug}/${sessionId}.jsonl`;

    let stat;
    try {
      stat = await Deno.stat(path);
    } catch { return 0; } // file missing — nothing to mirror

    const offset = offsets.get(sessionId);
    if (offset === undefined) {
      // First time seeing this session — set offset to current size, skip
      // this event to avoid re-mirroring old content.
      offsets.set(sessionId, stat.size);
      return 0;
    }

    if (stat.size < offset) {
      // File shrank (rotated/truncated) — reset offset to current size.
      offsets.set(sessionId, stat.size);
      return 0;
    }
    if (stat.size === offset) return 0; // no new data

    // Read new bytes from offset to end.
    const newBytes = new Uint8Array(stat.size - offset);
    let file;
    try {
      file = await Deno.open(path, { read: true });
      await file.seek(offset, Deno.SeekMode.Start);
      const n = await file.read(newBytes);
      if (n !== newBytes.length) {
        // Short read — file changed under us. Reset offset to current size
        // and skip this event; next fire will pick up the rest.
        offsets.set(sessionId, stat.size);
        return 0;
      }
    } finally {
      if (file) file.close();
    }

    const text = new TextDecoder().decode(newBytes);
    const lines = text.split("\n");

    // Update offset to current file size now that we've read the new bytes.
    offsets.set(sessionId, stat.size);

    let mirrored = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: any;
      try { obj = JSON.parse(trimmed); } catch { continue; }
      const msg = await extractMirrorText(obj);
      if (!msg) continue;
      try {
        await sendToDiscord(channelId, msg.prefix, msg.text);
        mirrored++;
      } catch (err) {
        console.warn(
          `[SessionWatcher] Discord send failed for ${sessionId.substring(0, 8)}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return mirrored;
  };

  // Find the JSONL path for a session by scanning project directories. Used
  // only for the active-bot-session offset update, where we don't have the
  // channel entry yet (defensive).
  const findJsonlPath = async (sessionId: string): Promise<string | null> => {
    try {
      for await (const projectEntry of Deno.readDir(projectsDir)) {
        if (!projectEntry.isDirectory) continue;
        const path = `${projectsDir}/${projectEntry.name}/${sessionId}.jsonl`;
        try {
          await Deno.stat(path);
          return path;
        } catch { /* not in this project */ }
      }
    } catch { /* ignore */ }
    return null;
  };

  console.log(`[SessionWatcher] Watching ${projectsDir} for JSONL changes (debounce ${debounceMs}ms)`);

  (async () => {
    try {
      // deno-lint-ignore no-explicit-any
      const watcher: any = Deno.watchFs(projectsDir, { recursive: true });
      for await (const event of watcher) {
        if (event.kind !== "modify" && event.kind !== "create") continue;
        for (const p of event.paths) {
          if (!p.endsWith(".jsonl")) continue;
          const filename = p.split("/").pop()?.split("\\").pop() ?? "";
          const sessionId = filename.replace(".jsonl", "");
          if (!sessionId || sessionId.length < 8) continue;
          // Extract project slug from path: .../projects/<slug>/<sessionId>.jsonl
          const parts = p.replace(/\\/g, "/").split("/");
          const slug = parts[parts.length - 2] ?? "";
          modifiedSessions.set(sessionId, slug);
        }
        if (modifiedSessions.size === 0) continue;
        if (sortTimer) clearTimeout(sortTimer);
        sortTimer = setTimeout(flush, debounceMs);
      }
    } catch (err) {
      console.error(
        `[SessionWatcher] Fatal error watching ${projectsDir}:`,
        err instanceof Error ? err.message : err,
      );
    }
  })();
}

/** Extract a user/assistant text message from a JSONL line for mirroring. */
// deno-lint-ignore no-explicit-any
async function extractMirrorText(obj: any): Promise<{ prefix: string; text: string } | null> {
  const role = obj.type;
  if (role !== "user" && role !== "assistant") return null;
  if (obj.isMeta) return null;
  const content = obj.message?.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    // Concatenate text blocks; skip tool_use / tool_result / image blocks.
    for (const item of content) {
      if (item && typeof item === "object" && item.type === "text" && typeof item.text === "string") {
        text += item.text;
      }
    }
  }
  text = text.trim();
  if (!text) return null;
  // Skip system-reminder and meta wrappers (start with <).
  if (text.startsWith("<")) return null;
  const prefix = role === "user" ? "🧑" : "🤖";
  return { prefix, text };
}

// Cached REST instance for Discord sends.
let cachedRest: any = null;
async function getRest(): Promise<any> {
  if (cachedRest) return cachedRest;
  const { REST } = await import("npm:discord.js@14.14.1");
  cachedRest = new REST({ version: "10" }).setToken(Deno.env.get("DISCORD_TOKEN") || "");
  return cachedRest;
}

async function sendToDiscord(channelId: string, prefix: string, text: string): Promise<void> {
  // Embeds render markdown (code blocks, bold, lists) the same way the bot's
  // own discord-sender.ts output does. Plain content messages render markdown
  // too but lack the colored bar / title — using embeds keeps the mirror
  // visually consistent with the bot's responses.
  const isUser = prefix === "🧑";
  const title = isUser ? "User" : "Assistant";
  const color = isUser ? 0x3498db : 0x2ecc71; // blue for user, green for assistant
  const truncated = text.length > 1900 ? text.slice(0, 1900) + "…[truncated]" : text;
  const rest = await getRest();
  await rest.post(`/channels/${channelId}/messages`, {
    body: {
      embeds: [{
        color,
        title,
        description: truncated,
        timestamp: new Date().toISOString(),
      }],
    },
  });
}