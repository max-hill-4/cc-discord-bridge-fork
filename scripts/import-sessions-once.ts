#!/usr/bin/env -S deno run --allow-all

/**
 * One-off importer — scans ~/.claude/projects/* for the last N Claude Code
 * sessions, creates a Discord text channel per session in the `claude-code`
 * category, backfills the last M messages, pins session metadata, and
 * registers each channel in the persistent session-channel map.
 *
 * Run from the project root:
 *   deno run --allow-all scripts/import-sessions-once.ts
 *
 * Env vars (read from .env):
 *   DISCORD_TOKEN
 *   CATEGORY_NAME (default: claude-code)
 *
 * Args:
 *   --limit=N     (default 50)
 *   --backfill=N  (default 5)
 */

import { scanAllSessions, readLastNMessages, projectSlugFromWorkDir, type SessionScanResult } from "../util/sessions.ts";
import { registerSessionChannel, listSessionChannels, getChannelIdForSession } from "../util/session-channel-map.ts";
import { sanitizeChannelName } from "../discord/utils.ts";

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

function parseArgs(argv: string[]): { limit: number; backfill: number } {
  let limit = 50;
  let backfill = 5;
  for (const a of argv) {
    const m = a.match(/^--([a-z]+)=(.+)$/);
    if (!m) continue;
    if (m[1] === "limit") limit = parseInt(m[2], 10);
    else if (m[1] === "backfill") backfill = parseInt(m[2], 10);
  }
  return { limit, backfill };
}

async function discordRequest(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const url = path.startsWith("http") ? path : `https://discord.com/api/v10${path}`;
  const init: RequestInit = {
    method,
    headers: {
      "Authorization": `Bot ${token}`,
      "Content-Type": "application/json",
    },
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

function buildChannelName(s: SessionScanResult): string {
  const base = sanitizeChannelName(s.prompt).substring(0, 80) || "session";
  const shortId = s.sessionId.substring(0, 8);
  return `${base}-${shortId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const env = await loadEnvFile(`${Deno.cwd()}/.env`);
  const token = env.DISCORD_TOKEN || Deno.env.get("DISCORD_TOKEN");
  const categoryName = env.CATEGORY_NAME || "claude-code";
  if (!token) {
    console.error("DISCORD_TOKEN missing from .env");
    Deno.exit(1);
  }
  const { limit, backfill } = parseArgs(Deno.args);

  // Discover the guild (bot must already be in it).
  const guilds = await discordRequest(token, "GET", "/users/@me/guilds");
  if (!guilds.length) {
    console.error("Bot is not in any guild");
    Deno.exit(1);
  }
  const guildId = guilds[0].id;
  console.log(`Using guild ${guilds[0].name} (${guildId})`);

  // Find or create the category.
  const channels: Array<{ id: string; type: number; name: string }> = await discordRequest(token, "GET", `/guilds/${guildId}/channels`);
  const GUILD_CATEGORY = 4;
  let category = channels.find((c) => c.type === GUILD_CATEGORY && c.name === categoryName);
  if (!category) {
    console.log(`Creating category "${categoryName}"...`);
    category = await discordRequest(token, "POST", `/guilds/${guildId}/channels`, {
      name: categoryName, type: GUILD_CATEGORY,
    });
  }
  const categoryId = category.id;
  console.log(`Category ${categoryName} = ${categoryId}`);

  // Scan sessions, excluding the bot's own working directory.
  const selfSlug = projectSlugFromWorkDir(Deno.cwd());
  console.log(`Scanning ~/.claude/projects/ (excluding ${selfSlug})...`);
  const allSessions = await scanAllSessions([selfSlug]);
  const sessions = allSessions.slice(0, limit);
  console.log(`Found ${allSessions.length} sessions, importing top ${sessions.length}.`);

  if (!sessions.length) {
    console.log("Nothing to import.");
    return;
  }

  let created = 0, skipped = 0, failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    try {
      // Skip if already in the persistent map and the channel still exists.
      const existingId = await getChannelIdForSession(s.sessionId);
      if (existingId) {
        try {
          await discordRequest(token, "GET", `/channels/${existingId}`);
          skipped++;
          continue;
        } catch {
          // Channel gone — fall through and recreate.
        }
      }

      const name = buildChannelName(s);
      const ch = await discordRequest(token, "POST", `/guilds/${guildId}/channels`, {
        name,
        type: 0, // GuildText
        parent_id: categoryId,
        topic: `Session ${s.sessionId} · Project ${s.projectSlug}`,
      });

      // Backfill.
      if (backfill > 0) {
        const msgs = await readLastNMessages(s.jsonlPath, backfill);
        for (const m of msgs) {
          const prefix = m.role === "user" ? "🧑" : "🤖";
          const body = m.text.length > 1900 ? m.text.slice(0, 1900) + "…[truncated]" : m.text;
          try {
            await discordRequest(token, "POST", `/channels/${ch.id}/messages`, { content: `${prefix} ${body}` });
          } catch (err) {
            errors.push(`backfill ${s.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      // Pin metadata.
      try {
        const pin = await discordRequest(token, "POST", `/channels/${ch.id}/messages`, {
          content: `**Session UUID:** \`${s.sessionId}\`\n**Project:** \`${s.projectSlug}\`\n**Imported:** ${new Date().toISOString()}\nType a message in this channel to continue this session.`,
        });
        await discordRequest(token, "PUT", `/channels/${ch.id}/pins/${pin.id}`);
      } catch (err) {
        errors.push(`pin ${s.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Register in persistent map.
      await registerSessionChannel(ch.id, {
        sessionId: s.sessionId,
        projectSlug: s.projectSlug,
        firstPrompt: s.prompt,
      });

      created++;
      if (created % 10 === 0) {
        console.log(`  ...created ${created}/${sessions.length}, sleeping 500ms to dodge rate limits`);
        await sleep(500);
      }
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`create ${s.sessionId}: ${msg}`);
      // If we hit a rate limit (429), sleep and retry this one.
      if (err && typeof err === "object" && "status" in err && err.status === 429) {
        console.log(`  rate-limited, sleeping 3s and retrying`);
        await sleep(3000);
        i--; // retry
        failed--; // undo the failed count
      }
    }
  }

  const total = (await listSessionChannels()).length;
  console.log("");
  console.log("=== import summary ===");
  console.log(`Scanned: ${allSessions.length} sessions`);
  console.log(`Created: ${created} new channels in ${categoryName}`);
  console.log(`Skipped: ${skipped} (already imported)`);
  console.log(`Failed:  ${failed}`);
  console.log(`Total session channels in map: ${total}`);
  if (errors.length > 0) {
    console.log("");
    console.log(`Errors (${Math.min(errors.length, 10)} shown):`);
    for (const e of errors.slice(0, 10)) console.log(`  - ${e}`);
  }
}

if (import.meta.main) {
  await main();
}