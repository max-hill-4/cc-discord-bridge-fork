/**
 * /import-sessions — scan ~/.claude/projects/* for existing Claude Code
 * sessions, create a Discord text channel per session, backfill the last
 * few user/assistant messages, pin the session UUID + project slug, and
 * register each channel in the persistent session-channel map so plain
 * messages typed in those channels continue the original session.
 *
 * By default excludes the bot's own working directory (so we don't import
 * this build session's JSONL noise). Pass deps.excludeSlugs to override.
 */

import { SlashCommandBuilder } from "npm:discord.js@14.14.1";
import type { Client, Guild, TextChannel } from "npm:discord.js@14.14.1";
import { sanitizeChannelName } from "../discord/utils.ts";
import {
  scanAllSessions,
  readLastNMessages,
  projectSlugFromWorkDir,
  type SessionScanResult,
} from "../util/sessions.ts";
import {
  registerSessionChannel,
  listSessionChannels,
  getChannelIdForSession,
} from "../util/session-channel-map.ts";

export const importSessionCommands = [
  new SlashCommandBuilder()
    .setName("import-sessions")
    .setDescription("Import recent Claude Code sessions as Discord channels")
    .addIntegerOption((option) =>
      option
        .setName("limit")
        .setDescription("Number of recent sessions to import (default 50)")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(200),
    )
    .addIntegerOption((option) =>
      option
        .setName("backfill")
        .setDescription("Messages to backfill per channel (default 5)")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(50),
    ),
];

export interface ImportSessionHandlerDeps {
  /** Late-bound Discord client — the bot is created after handlers. */
  getBotClient?: () => Client | undefined;
  /** Category name to create channels under. */
  categoryName: string;
  /** Project slugs to exclude (defaults to the bot's own working directory). */
  excludeSlugs?: string[];
  /** Bot's working directory — used to compute the default exclude slug. */
  workDir?: string;
}

export function createImportSessionHandlers(deps: ImportSessionHandlerDeps) {
  return {
    // deno-lint-ignore no-explicit-any
    async onImportSessions(ctx: any, limit: number, backfill: number): Promise<void> {
      const client = deps.getBotClient?.();
      if (!client) {
        await ctx.editReply({
          embeds: [{
            color: 0xff0000,
            title: "import-sessions · error",
            description: "Bot client is not ready yet. Try again in a moment.",
            timestamp: true,
          }],
        });
        return;
      }

      const guild = client.guilds.cache.first() as Guild | undefined;
      if (!guild) {
        await ctx.editReply({
          embeds: [{
            color: 0xff0000,
            title: "import-sessions · error",
            description: "Bot is not in any server.",
            timestamp: true,
          }],
        });
        return;
      }

      // Resolve the category (create if missing — same name as main channel's category)
      // deno-lint-ignore no-explicit-any
      let category: any = guild.channels.cache.find(
        // deno-lint-ignore no-explicit-any
        (c: any) =>
          c.type === 4 /* GuildCategory */ && c.name === deps.categoryName,
      );
      if (!category) {
        try {
          category = await guild.channels.create({
            name: deps.categoryName,
            type: 4,
          });
        } catch (err) {
          await ctx.editReply({
            embeds: [{
              color: 0xff0000,
              title: "import-sessions · error",
              description: `Could not create category: ${err instanceof Error ? err.message : String(err)}`,
              timestamp: true,
            }],
          });
          return;
        }
      }

      await ctx.editReply({
        embeds: [{
          color: 0x0099ff,
          title: "import-sessions · scanning",
          description: `Scanning ~/.claude/projects/ for sessions (limit ${limit}, backfill ${backfill})...`,
          timestamp: true,
        }],
      });

      // Default exclude: the bot's own working directory (so we don't import
      // this build session's JSONL noise). Can be overridden via deps.excludeSlugs.
      const defaultExclude = deps.workDir ? [projectSlugFromWorkDir(deps.workDir)] : [];
      const excludeSlugs = deps.excludeSlugs?.length
        ? deps.excludeSlugs
        : defaultExclude;

      const allSessions = await scanAllSessions(excludeSlugs);
      const sessions = allSessions.slice(0, limit);

      if (sessions.length === 0) {
        await ctx.editReply({
          embeds: [{
            color: 0xffaa00,
            title: "import-sessions · nothing found",
            description: "No sessions found in ~/.claude/projects/.",
            timestamp: true,
          }],
        });
        return;
      }

      let created = 0;
      let skipped = 0;
      let failed = 0;
      const errors: string[] = [];

      for (let i = 0; i < sessions.length; i++) {
        const session = sessions[i];
        try {
          // Skip if this session already has a channel
          const existingChannelId = await getChannelIdForSession(session.sessionId);
          if (existingChannelId) {
            // Verify the channel still exists
            // deno-lint-ignore no-explicit-any
            const existing: any = client.channels.cache.get(existingChannelId);
            if (existing) {
              skipped++;
              continue;
            }
          }

          const channelName = buildChannelName(session);
          // deno-lint-ignore no-explicit-any
          const channel: TextChannel = await guild.channels.create({
            name: channelName,
            type: 0 /* GuildText */,
            parent: category.id,
            topic: `Session ${session.sessionId} · Project ${session.projectSlug}`,
          });

          // Backfill last N messages
          if (backfill > 0) {
            const messages = await readLastNMessages(session.jsonlPath, backfill);
            for (const m of messages) {
              const prefix = m.role === "user" ? "🧑" : "🤖";
              const body = m.text.length > 1900 ? m.text.slice(0, 1900) + "…[truncated]" : m.text;
              try {
                await channel.send({ content: `${prefix} ${body}` });
              } catch (err) {
                errors.push(`backfill ${session.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }

          // Pin session metadata
          try {
            const pinMsg = await channel.send({
              content: `**Session UUID:** \`${session.sessionId}\`\n**Project:** \`${session.projectSlug}\`\n**Imported:** ${new Date().toISOString()}\nType a message in this channel to continue this session.`,
            });
            await pinMsg.pin();
          } catch (err) {
            errors.push(`pin ${session.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
          }

          // Register in the persistent map so plain messages resume this session
          await registerSessionChannel(channel.id, {
            sessionId: session.sessionId,
            projectSlug: session.projectSlug,
            firstPrompt: session.prompt,
          });

          created++;
          // Light rate-limit pacing — Discord allows ~50 channel creates/sec but
          // bursty creation sometimes hits 429. A tiny delay keeps us under.
          if (created % 10 === 0) await sleep(500);
        } catch (err) {
          failed++;
          errors.push(`create ${session.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const totalChannels = (await listSessionChannels()).length;
      const summaryLines = [
        `**Scanned:** ${allSessions.length} sessions across all projects`,
        `**Imported:** ${created} new channels in \`${deps.categoryName}\``,
        `**Skipped:** ${skipped} (already imported)`,
        `**Failed:** ${failed}`,
        `**Total session channels:** ${totalChannels}`,
        "",
        "Type a plain message in any session channel to continue that session.",
      ];
      if (errors.length > 0) {
        summaryLines.push("", `**Errors (${Math.min(errors.length, 5)} shown):`);
        for (const e of errors.slice(0, 5)) summaryLines.push(`• ${e}`);
      }

      await ctx.editReply({
        embeds: [{
          color: 0x00ff00,
          title: "import-sessions · done",
          description: summaryLines.join("\n"),
          timestamp: true,
        }],
      });
    },
  };
}

function buildChannelName(session: SessionScanResult): string {
  // First prompt → slug, append short uuid prefix for uniqueness.
  const base = sanitizeChannelName(session.prompt).substring(0, 80) || "session";
  const shortId = session.sessionId.substring(0, 8);
  return `${base}-${shortId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}