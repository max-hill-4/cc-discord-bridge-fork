#!/usr/bin/env -S deno run --allow-all

/**
 * One-off channel sorter — reads the persistent session-channel map and
 * repositions channels in the `claude-code` category so they're ordered by
 * JSONL mtime (newest first). `main` channel stays at the top.
 *
 * Run from the project root:
 *   deno run --allow-all scripts/sort-channels-once.ts
 */

import { listSessionChannels } from "../util/session-channel-map.ts";

async function loadEnvFile(path: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const text = await Deno.readTextFile(path);
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      let value = trimmed.substring(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key) out[key] = value;
    }
  } catch { /* ignore */ }
  return out;
}

async function discordRequest(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const url = path.startsWith("http") ? path : `https://discord.com/api/v10${path}`;
  const init: RequestInit = {
    method,
    headers: { "Authorization": `Bot ${token}`, "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) {
    const err: any = new Error(`Discord ${method} ${path} → ${res.status}: ${text.substring(0, 300)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function main() {
  const env = await loadEnvFile(`${Deno.cwd()}/.env`);
  const token = env.DISCORD_TOKEN || Deno.env.get("DISCORD_TOKEN");
  if (!token) {
    console.error("DISCORD_TOKEN missing");
    Deno.exit(1);
  }

  const guilds = await discordRequest(token, "GET", "/users/@me/guilds");
  const guildId = guilds[0].id;
  const channels: Array<{ id: string; type: number; name: string; position: number; parent_id?: string }> =
    await discordRequest(token, "GET", `/guilds/${guildId}/channels`);

  // Find the claude-code category
  const GUILD_CATEGORY = 4;
  const category = channels.find((c) => c.type === GUILD_CATEGORY && c.name === "claude-code");
  if (!category) {
    console.error("claude-code category not found");
    Deno.exit(1);
  }

  const catId = category.id;
  const siblings = channels.filter((c) => c.parent_id === catId && c.type === 0);
  console.log(`Found ${siblings.length} text channels in claude-code category`);

  // Load session-channel map: channelId → { sessionId, projectSlug, ... }
  const entries = await listSessionChannels();
  const entryByChannelId = new Map(entries.map((e) => [e.channelId, e]));
  console.log(`Persistent map has ${entries.length} entries`);

  // For each sibling, determine its sort key:
  //  - `main` channel: pinned to top
  //  - session channels: by JSONL mtime (newest first)
  //  - unknown channels: keep current position (after session channels)
  // deno-lint-ignore no-explicit-any
  async function mtimeFor(entry: any): Promise<number> {
    try {
      const stat = await Deno.stat(entry.jsonlPath ?? `~/.claude/projects/${entry.projectSlug}/${entry.sessionId}.jsonl`);
      return stat.mtime?.getTime() ?? 0;
    } catch {
      // Try the standard path
      const home = Deno.env.get("HOME") || "";
      try {
        const stat = await Deno.stat(`${home}/.claude/projects/${entry.projectSlug}/${entry.sessionId}.jsonl`);
        return stat.mtime?.getTime() ?? 0;
      } catch {
        return 0;
      }
    }
  }

  // Build (channel, mtime) tuples for session channels
  // deno-lint-ignore no-explicit-any
  const sessionTuples: Array<{ channel: any; mtime: number }> = [];
  for (const c of siblings) {
    if (c.name === "main") continue;
    const entry = entryByChannelId.get(c.id);
    if (!entry) {
      // Unknown channel — keep at end with mtime=0
      sessionTuples.push({ channel: c, mtime: 0 });
      continue;
    }
    const mtime = await mtimeFor({ projectSlug: entry.projectSlug, sessionId: entry.sessionId });
    sessionTuples.push({ channel: c, mtime });
  }

  // Sort: newest mtime first. Stable on mtime==0 (keep current position).
  sessionTuples.sort((a, b) => {
    if (a.mtime === b.mtime) return (a.channel.position ?? 0) - (b.channel.position ?? 0);
    return b.mtime - a.mtime;
  });

  const mainChannel = siblings.find((c) => c.name === "main");
  const ordered = mainChannel ? [mainChannel, ...sessionTuples.map((t) => t.channel)] : sessionTuples.map((t) => t.channel);

  const payload = ordered.map((c, i) => ({ id: c.id, position: i }));
  console.log(`Patching positions for ${payload.length} channels`);
  console.log(`Top 5 after sort:`);
  for (const p of payload.slice(0, 5)) {
    const ch = ordered.find((c) => c.id === p.id)!;
    const entry = entryByChannelId.get(ch.id);
    const mtime = entry ? sessionTuples.find((t) => t.channel.id === ch.id)?.mtime : null;
    console.log(`  pos=${p.position} ${ch.name.substring(0, 60)}${ch.name.length > 60 ? "…" : ""} mtime=${mtime ? new Date(mtime).toISOString() : "n/a"}`);
  }

  await discordRequest(token, "PATCH", `/guilds/${guildId}/channels`, payload);
  console.log("Done.");
}

if (import.meta.main) {
  await main();
}