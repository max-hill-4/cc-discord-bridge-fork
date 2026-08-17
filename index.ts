#!/usr/bin/env -S deno run --allow-all

/**
 * Claude Code Discord Bot - Main Entry Point
 *
 * This file bootstraps the Discord bot with Claude Code integration.
 * Most command handlers are now extracted to core modules for maintainability.
 *
 * @module index
 */

import {
  createDiscordBot,
  type BotConfig,
  type InteractionContext,
  type CommandHandlers,
  type ButtonHandlers,
  type BotDependencies,
  type MessageContent,
  SessionThreadManager,
} from "./discord/index.ts";
import type { TextChannel } from "npm:discord.js@14.14.1";

import { getGitInfo } from "./git/index.ts";
import { createClaudeSender, expandableContent, sendToClaudeCode, convertToClaudeMessages, type DiscordSender, type ClaudeMessage, type SessionThreadCallbacks } from "./claude/index.ts";
import { buildQuestionMessages, parseAskUserButtonId, parseAskUserConfirmId, type AskUserQuestionInput } from "./claude/index.ts";
import { buildPermissionEmbed, parsePermissionButtonId, type PermissionRequestCallback } from "./claude/index.ts";
import { claudeCommands, enhancedClaudeCommands } from "./claude/index.ts";
import { additionalClaudeCommands } from "./claude/additional-index.ts";
import { getSessionIdForChannel, registerSessionChannel, unregisterSessionChannel, getEntryForChannel } from "./util/session-channel-map.ts";
import { startSessionFileWatcher } from "./util/session-watcher.ts";
import { extractFirstUserPrompt, readLastNMessages, projectSlugFromWorkDir } from "./util/sessions.ts";
import { sanitizeChannelName } from "./discord/utils.ts";
import { initModels } from "./claude/enhanced-client.ts";
import { advancedSettingsCommands, DEFAULT_SETTINGS, unifiedSettingsCommands, UNIFIED_DEFAULT_SETTINGS } from "./settings/index.ts";
import { gitCommands } from "./git/index.ts";
import { shellCommands } from "./shell/index.ts";
import { utilsCommands } from "./util/index.ts";
import { systemCommands } from "./system/index.ts";
import { helpCommand } from "./help/index.ts";
import { agentCommand } from "./agent/index.ts";
import { cleanupPaginationStates } from "./discord/index.ts";
import { runVersionCheck, startPeriodicUpdateCheck, BOT_VERSION } from "./util/version-check.ts";

// Core modules - now handle most of the heavy lifting
import {
  parseArgs,
  createMessageHistory,
  createBotManagers,
  setupPeriodicCleanup,
  createBotSettings,
  createAllHandlers,
  getAllCommands,
  cleanSessionId,
  createButtonHandlers,
  createAllCommandHandlers,
  type BotManagers,
  type AllHandlers,
  type MessageHistoryOps,
} from "./core/index.ts";

// Re-export for backward compatibility
export { getGitInfo, executeGitCommand } from "./git/index.ts";
export { sendToClaudeCode } from "./claude/index.ts";

// ================================
// Bot Creation
// ================================

/**
 * Create Claude Code Discord Bot with all handlers and integrations.
 */
export async function createClaudeCodeBot(config: BotConfig) {
  const { discordToken, applicationId, workDir, repoName, branchName, categoryName, defaultMentionUserId } = config;

  // Determine category name (use repository name if not specified)
  const actualCategoryName = categoryName || repoName;

  // Claude Code session management (closures needed for handler state)
  const claudeControllers = new Map<string, AbortController>();
  const DEFAULT_CONTROLLER_CHANNEL = "__default__";
  let claudeSessionId: string | undefined;

  // Sessions the bot is currently running via `claude --resume` (started by a
  // Discord message in a session channel). Used by the JSONL watcher to skip
  // mirroring writes that the bot's own stream is already sending to Discord.
  const activeBotSessions = new Set<string>();
  const isActiveBotSession = (sessionId: string): boolean => activeBotSessions.has(sessionId);

  const getClaudeController = (channelId?: string): AbortController | null => {
    const key = channelId || DEFAULT_CONTROLLER_CHANNEL;
    return claudeControllers.get(key) ?? null;
  };
  const setClaudeController = (controller: AbortController | null, channelId?: string): void => {
    const key = channelId || DEFAULT_CONTROLLER_CHANNEL;
    if (controller) claudeControllers.set(key, controller);
    else claudeControllers.delete(key);
  };
  const abortAllClaudeControllers = (): void => {
    for (const c of claudeControllers.values()) c.abort();
    claudeControllers.clear();
  };
  const hasAnyClaudeController = (): boolean => claudeControllers.size > 0;

  // Message history for navigation
  const messageHistoryOps: MessageHistoryOps = createMessageHistory(50);

  // Create all managers using bot-factory
  const managers: BotManagers = createBotManagers({
    config: {
      discordToken,
      applicationId,
      workDir,
      categoryName: actualCategoryName,
      userId: defaultMentionUserId,
    },
    crashHandlerOptions: {
      maxRetries: 3,
      retryDelay: 5000,
      enableAutoRestart: true,
      logCrashes: true,
      notifyOnCrash: true,
      // deno-lint-ignore require-await
      onCrashNotification: async (report) => {
        console.warn(`Process crash: ${report.processType} ${report.processId || ''} - ${report.error.message}`);
      },
    },
  });

  const { shellManager, worktreeBotManager, crashHandler, healthMonitor, claudeSessionManager } = managers;

  // Initialize dynamic model fetching (uses ANTHROPIC_API_KEY if available)
  initModels();

  // Setup periodic cleanup tasks
  const cleanupInterval = setupPeriodicCleanup(managers, 3600000, [
    cleanupPaginationStates,
    () => {
      void sessionThreadManager.cleanup().catch((error) => {
        console.error("Error during session thread cleanup:", error);
      });
    },
  ]);

  // Initialize bot settings
  const settingsOps = createBotSettings(defaultMentionUserId, DEFAULT_SETTINGS, UNIFIED_DEFAULT_SETTINGS);
  const currentSettings = settingsOps.getSettings();
  const botSettings = currentSettings.legacy;

  // Bot instance placeholder
  // deno-lint-ignore no-explicit-any prefer-const
  let bot: any;
  let claudeSender: ((messages: ClaudeMessage[]) => Promise<void>) | null = null;

  // Session thread manager — maps each Claude session to a dedicated Discord thread
  const sessionThreadManager = new SessionThreadManager();

  // Session thread callbacks — used by claude/command.ts for /claude-thread and /resume.
  // The callbacks are closures over `bot` (late-bound) and `sessionThreadManager`.
  const sessionThreadCallbacks: SessionThreadCallbacks = {
    async createThreadSender(prompt: string, sessionId?: string, threadName?: string) {
      const channel = bot?.getChannel() as TextChannel | null;
      if (!channel) throw new Error('Bot channel not ready');

      // If a session ID was provided, check for an existing thread to reuse
      if (sessionId) {
        const existingThread = sessionThreadManager.getThread(sessionId);
        if (existingThread) {
          if (existingThread.archived) {
            await existingThread.setArchived(false);
          }
          sessionThreadManager.recordActivity(sessionId);
          const threadSender = createClaudeSender(createChannelSenderAdapter(existingThread));
          return { sender: threadSender, threadSessionKey: sessionId, threadChannelId: existingThread.id };
        }
      }

      // Generate a placeholder key until the real SDK session ID arrives
      const placeholderKey = `pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // Create a thread in the main channel
      const thread = await sessionThreadManager.createSessionThread(channel, placeholderKey, prompt, threadName);

      // Post a summary embed in the main channel pointing to the thread
      await sendMessageContent(channel, {
        embeds: [{
          color: 0x5865F2,
          title: 'New Claude Session',
          description: `A new session thread has been created.\n\n**Prompt:** \`${prompt.substring(0, 200)}${prompt.length > 200 ? '...' : ''}\``,
          fields: [
            { name: 'Thread', value: `<#${thread.id}>`, inline: true },
          ],
          timestamp: true,
        }],
      });

      const threadSender = createClaudeSender(createChannelSenderAdapter(thread));
      return { sender: threadSender, threadSessionKey: placeholderKey, threadChannelId: thread.id };
    },

    async getThreadSender(sessionId: string) {
      const existingThread = sessionThreadManager.getThread(sessionId);
      if (!existingThread) return undefined;

      if (existingThread.archived) {
        await existingThread.setArchived(false);
      }
      sessionThreadManager.recordActivity(sessionId);
      const threadSender = createClaudeSender(createChannelSenderAdapter(existingThread));
      return { sender: threadSender, threadSessionKey: sessionId };
    },

    updateSessionId(oldKey: string, newSessionId: string) {
      sessionThreadManager.updateSessionId(oldKey, newSessionId);
    },

    getThreadChannelId(sessionId: string) {
      return sessionThreadManager.getSessionThread(sessionId)?.threadId;
    },

    findSessionByThreadId(threadId: string) {
      return sessionThreadManager.findSessionByThreadId(threadId);
    },
  };

  // Late-bound AskUserQuestion handler — set after bot is created.
  // When Claude needs clarification mid-session, this sends buttons to Discord
  // and waits for the user's click.
  // Uses an object wrapper so TypeScript doesn't narrow the closure to `never`.
  const askUserState: { handler: ((input: AskUserQuestionInput) => Promise<Record<string, string>>) | null } = { handler: null };

  // Late-bound PermissionRequest handler — set after bot is created.
  // When Claude wants to use a tool that isn't pre-approved, this shows
  // Allow/Deny buttons in Discord and returns the user's decision.
  const permReqState: { handler: PermissionRequestCallback | null } = { handler: null };

  // Create sendClaudeMessages function that uses the sender when available
  const sendClaudeMessages = async (messages: ClaudeMessage[]) => {
    if (claudeSender) {
      await claudeSender(messages);
    }
  };

  // Create onAskUser wrapper — delegates to askUserState.handler once bot is ready
  const onAskUser = async (input: AskUserQuestionInput): Promise<Record<string, string>> => {
    if (!askUserState.handler) {
      throw new Error('AskUserQuestion handler not initialized — bot not ready');
    }
    return await askUserState.handler(input);
  };

  // Create onPermissionRequest wrapper — delegates to permReqState.handler once bot is ready
  const onPermissionRequest: PermissionRequestCallback = async (toolName, toolInput) => {
    if (!permReqState.handler) {
      console.warn('[PermissionRequest] Handler not initialized — auto-denying');
      return false;
    }
    return await permReqState.handler(toolName, toolInput);
  };

  // Create all handlers using the registry (centralized handler creation)
  const allHandlers: AllHandlers = createAllHandlers(
    {
      workDir,
      repoName,
      branchName,
      categoryName: actualCategoryName,
      discordToken,
      applicationId,
      defaultMentionUserId,
      shellManager,
      worktreeBotManager,
      crashHandler,
      healthMonitor,
      claudeSessionManager,
      sendClaudeMessages,
      onAskUser,
      onPermissionRequest,
      onBotSettingsUpdate: (settings) => {
        botSettings.mentionEnabled = settings.mentionEnabled;
        botSettings.mentionUserId = settings.mentionUserId;
        if (bot) {
          bot.updateBotSettings(settings);
        }
      },
      sessionThreads: sessionThreadCallbacks,
      getBotClient: () => bot?.client,
    },
    {
      getController: getClaudeController,
      setController: setClaudeController,
      abortAllControllers: abortAllClaudeControllers,
      hasAnyController: hasAnyClaudeController,
      getSessionId: () => claudeSessionId,
      setSessionId: (sessionId) => { claudeSessionId = sessionId; },
    },
    settingsOps
  );

  // Create command handlers using the wrapper factory
  const handlers: CommandHandlers = createAllCommandHandlers({
    handlers: allHandlers,
    messageHistory: messageHistoryOps,
    getClaudeController,
    hasAnyClaudeController,
    abortAllClaudeControllers,
    getClaudeSessionId: () => claudeSessionId,
    crashHandler,
    healthMonitor,
    botSettings,
    cleanupInterval,
  });

  // Create button handlers using the button handler factory
  const buttonHandlers: ButtonHandlers = createButtonHandlers(
    {
      messageHistory: messageHistoryOps,
      handlers: allHandlers,
      getClaudeSessionId: () => claudeSessionId,
      sendClaudeMessages,
      workDir,
    },
    expandableContent
  );

  // Channel monitoring for auto-responding to bot/webhook messages
  const monitorChannelId = Deno.env.get("MONITOR_CHANNEL_ID");
  const monitorBotIds = Deno.env.get("MONITOR_BOT_IDS")?.split(",").map(s => s.trim()).filter(Boolean);

  // Create dependencies object for Discord bot
  const dependencies: BotDependencies = {
    commands: getAllCommands(),
    cleanSessionId,
    botSettings,
    onContinueSession: async (ctx) => {
      await allHandlers.claude.onContinue(ctx);
    },
    onSessionChannelMessage: async (content, channelId, message) => {
      // Lookup session entry for this channel from the persistent map.
      const entry = await getEntryForChannel(channelId);
      if (!entry) return; // not a session channel
      const sessionId = entry.sessionId;

      // Decode the project slug back to a working directory. Claude Code
      // encodes cwd by replacing `/` with `-`, so `-home-user-foo`
      // → `/home/user/foo`.
      // If the decoded path isn't a directory (e.g., ambiguous `-` in a path
      // segment), fall back to the bot's workDir — claude --resume will fail
      // to find the session, but at least we won't crash.
      const decodedPath = entry.projectSlug.replaceAll('-', '/');
      let sessionWorkDir = workDir;
      try {
        const stat = await Deno.stat(decodedPath);
        if (stat.isDirectory) sessionWorkDir = decodedPath;
      } catch { /* fall back to bot workDir */ }

      // Re-sort the claude-code category by JSONL mtime so the most recently
      // active session floats to the top. Fire-and-forget.
      void sortChannelsByMtime(bot).catch((err) => {
        console.warn('[SessionChannel] Sort failed:', err);
      });

      // Per-channel concurrency: if a Claude run is already active in this
      // channel, drop the new message with a brief note. The user can try
      // again when the current run finishes.
      const existing = getClaudeController(channelId);
      if (existing) {
        try {
          await message.reply({
            content: "⏳ A Claude run is already in progress in this channel. Wait for it to finish before sending another message.",
          });
        } catch { /* ignore */ }
        return;
      }

      // Bind the sender to the session channel (not the main bot channel).
      // deno-lint-ignore no-explicit-any
      const channelSender = createClaudeSender(createChannelSenderAdapter(message.channel as any));

      // Send a "thinking" status so the user sees immediate feedback.
      // deno-lint-ignore no-explicit-any
      let statusMsg: any = null;
      try {
        statusMsg = await message.channel.send({
          embeds: [{
            color: 0x0099ff,
            title: 'session · continuing',
            description: `Resuming session \`${sessionId.substring(0, 8)}\`...`,
            timestamp: true,
          }],
        });
      } catch { /* ignore */ }

      const controller = new AbortController();
      setClaudeController(controller, channelId);
      activeBotSessions.add(sessionId);

      try {
        const result = await sendToClaudeCode(
          sessionWorkDir,
          content,
          controller,
          sessionId,
          undefined,
          (jsonData) => {
            const claudeMessages = convertToClaudeMessages(jsonData);
            if (claudeMessages.length > 0) {
              channelSender(claudeMessages).catch(() => {});
            }
          },
          false,
          { ...allHandlers.getQueryOptions(), channelId },
        );

        // Update the in-memory map in case the SDK returned a new session ID.
        if (result.sessionId && result.sessionId !== sessionId) {
          await registerSessionChannel(channelId, {
            sessionId: result.sessionId,
            projectSlug: '', // unknown for continuation; preserved if empty
            firstPrompt: '',
          });
        }

        // Remove the "thinking" status — output has replaced it.
        if (statusMsg) {
          try {
            await statusMsg.delete();
          } catch { /* ignore */ }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        try {
          if (statusMsg) {
            await statusMsg.edit({
              embeds: [{
                color: 0xff0000,
                title: 'session · error',
                description: `\`${errMsg.substring(0, 1000)}\``,
                timestamp: true,
              }],
            });
          } else {
            await message.reply({ content: `❌ Error: ${errMsg.substring(0, 500)}` });
          }
        } catch { /* ignore */ }
      } finally {
        setClaudeController(null, channelId);
        activeBotSessions.delete(sessionId);
      }
    },
    ...(monitorChannelId && monitorBotIds?.length && {
      monitorConfig: {
        channelId: monitorChannelId,
        botIds: monitorBotIds,
        onAlertMessage: async (content: string, thread: TextChannel) => {
          const prompt = [
            "A monitoring alert notification was just received. Investigate this alert.",
            "Identify the alert, check severity, gather diagnostics, analyze the root cause, and report findings.",
            "If a config change is needed, describe what should change. If it's a transient issue, report findings.",
            "",
            "Alert content:",
            content,
          ].join("\n");

          // Create a sender bound to the alert thread, not the bot's main channel
          const threadSender = createClaudeSender(createChannelSenderAdapter(thread));

          const controller = new AbortController();
          const alertChannelId = thread.id;
          await sendToClaudeCode(
            workDir,
            prompt,
            controller,
            undefined,
            undefined,
            (jsonData) => {
              const claudeMessages = convertToClaudeMessages(jsonData);
              if (claudeMessages.length > 0) {
                threadSender(claudeMessages).catch(() => {});
              }
            },
            false,
            { channelId: alertChannelId },
          );
        },
      },
    }),
  };

  // Create Discord bot
  bot = await createDiscordBot(config, handlers, buttonHandlers, dependencies, crashHandler);

  // Filesystem watcher — when a Claude session runs on the VPS directly
  // (not via Discord), the JSONL gets appended to. Trigger a global mtime
  // sort so the most recently active session floats to the top.
  startSessionFileWatcher({
    getBot: () => bot,
    sortChannelsByMtime,
    isActiveBotSession,
    autoImportSession: (sid, slug, b) => autoImportSession(sid, slug, b),
    excludeSlugs: [projectSlugFromWorkDir(workDir)],
  });

  // Create Discord sender for Claude messages
  claudeSender = createClaudeSender(createDiscordSenderAdapter(bot));

  // Helper: resolve the target channel for the currently active session.
  // If there's an active session thread, use that; otherwise fall back to main channel.
  const getActiveSessionChannel = () => {
    // Try to find the thread for the current session
    if (claudeSessionId) {
      const thread = sessionThreadManager.getThread(claudeSessionId);
      if (thread) return thread;
    }
    // Also check for any pending (placeholder-keyed) threads
    const allThreads = sessionThreadManager.getAllSessionThreads();
    for (const meta of allThreads) {
      if (meta.sessionId.startsWith('pending_')) {
        const thread = sessionThreadManager.getThread(meta.sessionId);
        if (thread) return thread;
      }
    }
    return bot.getChannel();
  };

  // Initialize AskUserQuestion handler — sends questions to Discord, waits for button clicks
  askUserState.handler = createAskUserDiscordHandler(bot, getActiveSessionChannel);

  // Initialize PermissionRequest handler — shows Allow/Deny buttons for unapproved tools
  permReqState.handler = createPermissionRequestHandler(bot, getActiveSessionChannel);

  // Check for updates (non-blocking)
  runVersionCheck().then(async ({ updateAvailable, embed }) => {
    if (updateAvailable && embed) {
      const channel = bot.getChannel();
      if (channel) {
        const { EmbedBuilder } = await import("npm:discord.js@14.14.1");
        const discordEmbed = new EmbedBuilder()
          .setColor(embed.color)
          .setTitle(embed.title)
          .setDescription(embed.description)
          .setTimestamp();
        embed.fields.forEach(f => discordEmbed.addFields(f));
        await channel.send({ embeds: [discordEmbed] });
      }
    }
  }).catch(() => { /* version check is best-effort */ });

  // Start periodic update checks (every 12 hours)
  startPeriodicUpdateCheck(async (result) => {
    try {
      const channel = bot.getChannel();
      if (channel) {
        const { EmbedBuilder } = await import("npm:discord.js@14.14.1");
        const embed = new EmbedBuilder()
          .setColor(0xFFA500)
          .setTitle("Update Available")
          .setDescription(`A newer version is available. You are running **v${BOT_VERSION}** (\`${result.localCommit}\`).`)
          .addFields(
            { name: "Latest Commit", value: `\`${result.remoteCommit}\``, inline: true },
            {
              name: "How to Update",
              value: Deno.env.get("DOCKER_CONTAINER")
                ? "```\ndocker compose pull && docker compose up -d\n```"
                : "```\ngit pull origin main && deno task start\n```",
              inline: false
            }
          )
          .setTimestamp();
        await channel.send({ embeds: [embed] });
      }
    } catch {
      // Periodic notification is best-effort
    }
  });

  // Setup signal handlers for graceful shutdown
  setupSignalHandlers({
    managers,
    allHandlers,
    abortAllClaudeControllers,
    claudeSender,
    actualCategoryName,
    repoName,
    branchName,
    cleanupInterval,
    // deno-lint-ignore no-explicit-any
    bot: bot as any,
  });

  return bot;
}

// ================================
// Helper Functions
// ================================

/**
 * Build a Discord.js payload from a MessageContent object and send it to a channel.
 */
// deno-lint-ignore no-explicit-any
async function sendMessageContent(channel: any, content: MessageContent): Promise<void> {
  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import("npm:discord.js@14.14.1");

  // deno-lint-ignore no-explicit-any
  const payload: any = {};

  if (content.content) payload.content = content.content;

  if (content.embeds) {
    payload.embeds = content.embeds.map(e => {
      const embed = new EmbedBuilder();
      if (e.color !== undefined) embed.setColor(e.color);
      if (e.title) embed.setTitle(e.title);
      if (e.description) embed.setDescription(e.description);
      if (e.fields) e.fields.forEach(f => embed.addFields(f));
      if (e.footer) embed.setFooter(e.footer);
      if (e.timestamp) embed.setTimestamp();
      return embed;
    });
  }

  if (content.components) {
    payload.components = content.components.map(row => {
      // deno-lint-ignore no-explicit-any
      const actionRow = new ActionRowBuilder<any>();
      row.components.forEach(comp => {
        const button = new ButtonBuilder()
          .setCustomId(comp.customId)
          .setLabel(comp.label);

        switch (comp.style) {
          case 'primary': button.setStyle(ButtonStyle.Primary); break;
          case 'secondary': button.setStyle(ButtonStyle.Secondary); break;
          case 'success': button.setStyle(ButtonStyle.Success); break;
          case 'danger': button.setStyle(ButtonStyle.Danger); break;
          case 'link': button.setStyle(ButtonStyle.Link); break;
        }

        actionRow.addComponents(button);
      });
      return actionRow;
    });
  }

  await channel.send(payload);
}

/**
 * Create Discord sender adapter from bot instance.
 */
// deno-lint-ignore no-explicit-any
function createDiscordSenderAdapter(bot: any): DiscordSender {
  return {
    async sendMessage(content) {
      const channel = bot.getChannel();
      if (channel) {
        await sendMessageContent(channel, content);
      }
    }
  };
}

/**
 * Create Discord sender adapter that sends to a specific channel (e.g., a thread).
 */
// deno-lint-ignore no-explicit-any
function createChannelSenderAdapter(channel: any): DiscordSender {
  return {
    async sendMessage(content) {
      await sendMessageContent(channel, content);
    }
  };
}

/**
 * Auto-import a new CLI session (one we don't have a Discord channel for yet).
 * Reads the first user prompt from the JSONL for the channel name, creates a
 * text channel under the `claude-code` category, backfills the last 5
 * messages, pins session metadata, and registers it in the persistent map.
 *
 * Returns the new channel ID, or null if the session isn't ready yet (no
 * user prompt in the first 2KB — e.g. session just created with no input).
 */
async function autoImportSession(sessionId: string, projectSlug: string, botInstance: any): Promise<string | null> {
  const home = Deno.env.get("HOME") || "";
  const jsonlPath = `${home}/.claude/projects/${projectSlug}/${sessionId}.jsonl`;

  // Read first 64KB to extract the first user prompt. 2KB is too small for
  // sessions that start with /command output (e.g. /clear, /model) — the
  // first real prompt can be several KB in.
  let prompt = "";
  try {
    const file = await Deno.open(jsonlPath);
    try {
      const buf = new Uint8Array(64 * 1024);
      const n = await file.read(buf);
      if (n && n > 0) {
        prompt = extractFirstUserPrompt(new TextDecoder().decode(buf.subarray(0, n)));
      }
    } finally {
      file.close();
    }
  } catch { return null; } // file missing/unreadable

  // No user prompt yet — session not ready. Will be re-tried on next write.
  if (!prompt || prompt === "(unknown)") return null;

  // deno-lint-ignore no-explicit-any
  const client: any = botInstance?.client;
  if (!client) return null;
  const guild = client.guilds?.cache?.first();
  if (!guild) return null;

  // Find or create the claude-code category.
  // deno-lint-ignore no-explicit-any
  let category: any = [...guild.channels.cache.values()].find(
    // deno-lint-ignore no-explicit-any
    (c: any) => c.type === 4 && c.name === 'claude-code',
  );
  if (!category) {
    try {
      category = await guild.channels.create({ name: 'claude-code', type: 4 });
    } catch (err) {
      console.warn(`[AutoImport] Could not create category:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  // Discord caps categories at 50 children. If at the limit, evict the oldest
  // session channel (by JSONL mtime, excluding `main`) before creating a new one.
  // Count ALL children (including `main`) since Discord's limit is on total children.
  // deno-lint-ignore no-explicit-any
  const allChildren: any[] = [...guild.channels.cache.values()].filter(
    // deno-lint-ignore no-explicit-any
    (c: any) => c.parentId === category.id && c.type === 0,
  );
  // deno-lint-ignore no-explicit-any
  const siblings: any[] = allChildren.filter((c: any) => c.name !== 'main');
  if (allChildren.length >= 50) {
    let oldest: { id: string; mtime: number } | null = null;
    for (const c of siblings) {
      const entry = await getEntryForChannel(c.id);
      if (!entry) continue;
      let mtime = 0;
      try {
        const stat = await Deno.stat(`${home}/.claude/projects/${entry.projectSlug}/${entry.sessionId}.jsonl`);
        mtime = stat.mtime?.getTime() ?? 0;
      } catch { /* missing file → mtime 0 (oldest) */ }
      if (!oldest || mtime < oldest.mtime) {
        oldest = { id: c.id, mtime };
      }
    }
    if (oldest) {
      try {
        // deno-lint-ignore no-explicit-any
        const oldChan: any = guild.channels.cache.get(oldest.id);
        await oldChan?.delete('Auto-import eviction: category at 50-channel limit');
        await unregisterSessionChannel(oldest.id);
        console.log(`[AutoImport] Evicted oldest channel ${oldest.id} (mtime=${new Date(oldest.mtime).toISOString()})`);
      } catch (err) {
        console.warn(`[AutoImport] Eviction failed:`, err instanceof Error ? err.message : err);
      }
    }
  }

  const base = sanitizeChannelName(prompt).substring(0, 80) || "session";
  const shortId = sessionId.substring(0, 8);
  const channelName = `${base}-${shortId}`;

  // deno-lint-ignore no-explicit-any
  let channel: any;
  try {
    channel = await guild.channels.create({
      name: channelName,
      type: 0,
      parent: category.id,
      topic: `Session ${sessionId} · Project ${projectSlug}`,
    });
  } catch (err) {
    // deno-lint-ignore no-explicit-any
    const e: any = err;
    const detail = e?.errors ? JSON.stringify(e.errors) : (e?.message ?? String(err));
    console.warn(`[AutoImport] Could not create channel for ${shortId} (name="${channelName}"):`, detail);
    return null;
  }

  // Backfill last 5 messages so the channel isn't empty.
  try {
    const messages = await readLastNMessages(jsonlPath, 5);
    for (const m of messages) {
      const prefix = m.role === "user" ? "🧑" : "🤖";
      const body = m.text.length > 1900 ? m.text.slice(0, 1900) + "…[truncated]" : m.text;
      try {
        await channel.send({ content: `${prefix} ${body}` });
      } catch { /* ignore individual backfill failures */ }
    }
  } catch { /* ignore */ }

  // Pin session metadata.
  try {
    const pinMsg = await channel.send({
      content: `**Session UUID:** \`${sessionId}\`\n**Project:** \`${projectSlug}\`\n**Imported:** ${new Date().toISOString()} (auto)\nType a message in this channel to continue this session.`,
    });
    await pinMsg.pin();
  } catch { /* ignore */ }

  await registerSessionChannel(channel.id, {
    sessionId,
    projectSlug,
    firstPrompt: prompt,
  });

  return channel.id;
}

/**
 * Sort all channels in the claude-code category by JSONL mtime (newest first).
 * `main` is pinned at the top. Channels not in the session-channel map sink
 * to the bottom (mtime=0). Idempotent: concurrent calls produce the same
 * payload, so there's no read-modify-write race.
 */
// deno-lint-ignore no-explicit-any
async function sortChannelsByMtime(bot: any): Promise<void> {
  const client = bot?.client;
  if (!client) return;
  const guild = client.guilds?.cache?.first();
  if (!guild) return;

  // Find the claude-code category.
  // deno-lint-ignore no-explicit-any
  const category: any = [...guild.channels.cache.values()].find(
    // deno-lint-ignore no-explicit-any
    (c: any) => c.type === 4 && c.name === 'claude-code',
  );
  if (!category) return;
  const categoryId = category.id;

  // deno-lint-ignore no-explicit-any
  const siblings: any[] = [...guild.channels.cache.values()].filter(
    // deno-lint-ignore no-explicit-any
    (c: any) => c.parentId === categoryId && c.type === 0,
  );

  const home = Deno.env.get("HOME") || "";
  // deno-lint-ignore no-explicit-any
  const pinned: any[] = [];
  // deno-lint-ignore no-explicit-any
  const sessions: Array<{ channel: any; mtime: number }> = [];
  for (const c of siblings) {
    if (c.name === 'main') {
      pinned.push(c);
      continue;
    }
    const entry = await getEntryForChannel(c.id);
    if (!entry) {
      sessions.push({ channel: c, mtime: 0 });
      continue;
    }
    let mtime = 0;
    try {
      const stat = await Deno.stat(`${home}/.claude/projects/${entry.projectSlug}/${entry.sessionId}.jsonl`);
      mtime = stat.mtime?.getTime() ?? 0;
    } catch { /* missing file → mtime 0 */ }
    sessions.push({ channel: c, mtime });
  }

  // Sort by mtime desc. Stable on ties (preserve current position).
  sessions.sort((a, b) => {
    if (a.mtime === b.mtime) return (a.channel.position ?? 0) - (b.channel.position ?? 0);
    return b.mtime - a.mtime;
  });

  const ordered = [...pinned, ...sessions.map((s) => s.channel)];
  const payload = ordered.map((c, i) => ({ id: c.id, position: i }));

  try {
    const { REST, Routes } = await import("npm:discord.js@14.14.1");
    const rest = new REST({ version: '10' }).setToken(Deno.env.get("DISCORD_TOKEN") || "");
    await rest.patch(Routes.guildChannels(guild.id), { body: payload });
  } catch (err) {
    console.warn(`[Sort] Failed to patch channel positions:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Create the AskUserQuestion handler that uses the Discord channel.
 *
 * When Claude calls the AskUserQuestion tool:
 * 1. Builds embeds with option buttons for each question
 * 2. Sends them to the bot's channel (or session thread if available)
 * 3. Waits up to 5 minutes for button clicks
 * 4. Returns answers to the SDK so Claude can continue
 */
// deno-lint-ignore no-explicit-any
function createAskUserDiscordHandler(bot: any, getTargetChannel?: () => any): (input: AskUserQuestionInput) => Promise<Record<string, string>> {
  return async (input: AskUserQuestionInput): Promise<Record<string, string>> => {
    const channel = getTargetChannel?.() ?? bot.getChannel();
    if (!channel) {
      throw new Error('Discord channel not available');
    }

    const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = await import("npm:discord.js@14.14.1");
    const answers: Record<string, string> = {};

    for (let qi = 0; qi < input.questions.length; qi++) {
      const q = input.questions[qi];

      // Build embed
      const embed = new EmbedBuilder()
        .setColor(0xff9900)
        .setTitle(`Claude needs your input — ${q.header}`)
        .setDescription(q.question)
        .setFooter({ text: q.multiSelect ? 'Select option(s), then click ✅ Confirm — Claude is waiting' : 'Click an option to answer — Claude is waiting' })
        .setTimestamp();

      for (let oi = 0; oi < q.options.length; oi++) {
        embed.addFields({ name: `${oi + 1}. ${q.options[oi].label}`, value: q.options[oi].description, inline: true });
      }

      // Build buttons
      const row = new ActionRowBuilder();
      for (let oi = 0; oi < q.options.length; oi++) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`ask-user:${qi}:${oi}`)
            .setLabel(q.options[oi].label)
            .setStyle(ButtonStyle.Primary)
        );
      }

      if (q.multiSelect) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`ask-user-confirm:${qi}`)
            .setLabel('✅ Confirm')
            .setStyle(ButtonStyle.Success)
        );
      }

      // Send the question message
      const questionMsg = await channel.send({ embeds: [embed], components: [row] });

      // Collect response
      if (q.multiSelect) {
        // Multi-select: collect multiple clicks, then wait for confirm
        const selected: string[] = [];
        const collector = questionMsg.createMessageComponentCollector({
          componentType: ComponentType.Button,
        });

        await new Promise<void>((resolve, reject) => {
          // deno-lint-ignore no-explicit-any
          collector.on('collect', async (i: any) => {
            const parsed = parseAskUserButtonId(i.customId);
            if (parsed && parsed.questionIndex === qi) {
              const label = q.options[parsed.optionIndex].label;
              if (!selected.includes(label)) {
                selected.push(label);
              }
              await i.update({
                embeds: [embed.setFooter({ text: `Selected: ${selected.join(', ')} — click ✅ Confirm when done` })],
                components: [row],
              });
            } else if (parseAskUserConfirmId(i.customId)?.questionIndex === qi) {
              answers[q.question] = selected.join(', ');
              collector.stop('confirmed');
              await i.update({
                embeds: [embed.setColor(0x00ff00).setFooter({ text: `✅ Answered: ${selected.join(', ')}` })],
                components: [],
              });
              resolve();
            }
          });

          collector.on('end', (_: unknown, reason: string) => {
            if (reason !== 'confirmed') {
              reject(new Error(`Question "${q.header}" was cancelled`));
            }
          });
        });
      } else {
        // Single-select: wait for one button click
        // deno-lint-ignore no-explicit-any
        const interaction: any = await questionMsg.awaitMessageComponent({
          componentType: ComponentType.Button,
        });

        const parsed = parseAskUserButtonId(interaction.customId);
        if (parsed && parsed.questionIndex === qi) {
          const label = q.options[parsed.optionIndex].label;
          answers[q.question] = label;

          await interaction.update({
            embeds: [embed.setColor(0x00ff00).setFooter({ text: `✅ Answered: ${label}` })],
            components: [],
          });
        } else {
          throw new Error(`Unexpected button ID: ${interaction.customId}`);
        }
      }
    }

    console.log('[AskUserQuestion] Collected answers:', JSON.stringify(answers));
    return answers;
  };
}

/**
 * Create the PermissionRequest handler that uses the Discord channel.
 *
 * When Claude wants to use a tool that isn't pre-approved:
 * 1. Builds an embed showing the tool name and input preview
 * 2. Adds Allow / Deny buttons
 * 3. Sends to the bot's channel
 * 4. Waits for a button click (no timeout — user decides)
 * 5. Returns true (allow) or false (deny)
 */
// deno-lint-ignore no-explicit-any
function createPermissionRequestHandler(bot: any, getTargetChannel?: () => any): PermissionRequestCallback {
  // Simple incrementing nonce to disambiguate concurrent requests
  let nonce = 0;

  return async (toolName: string, toolInput: Record<string, unknown>): Promise<boolean> => {
    const channel = getTargetChannel?.() ?? bot.getChannel();
    if (!channel) {
      console.warn('[PermissionRequest] No channel — auto-denying');
      return false;
    }

    const reqNonce = String(++nonce);
    const embedData = buildPermissionEmbed(toolName, toolInput);

    const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = await import("npm:discord.js@14.14.1");

    const embed = new EmbedBuilder()
      .setColor(embedData.color)
      .setTitle(embedData.title)
      .setDescription(embedData.description)
      .setFooter({ text: embedData.footer.text })
      .setTimestamp();

    for (const field of embedData.fields) {
      embed.addFields({ name: field.name, value: field.value, inline: field.inline });
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`perm-req:${reqNonce}:allow`)
        .setLabel('✅ Allow')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`perm-req:${reqNonce}:deny`)
        .setLabel('❌ Deny')
        .setStyle(ButtonStyle.Danger),
    );

    const msg = await channel.send({ embeds: [embed], components: [row] });

    // Wait for exactly one button click — no timeout
    // deno-lint-ignore no-explicit-any
    const interaction: any = await msg.awaitMessageComponent({
      componentType: ComponentType.Button,
    });

    const parsed = parsePermissionButtonId(interaction.customId);
    const allowed = parsed?.allowed ?? false;

    // Update the embed to reflect the decision
    embed.setColor(allowed ? 0x00ff00 : 0xff4444)
      .setFooter({ text: allowed ? `✅ Allowed by user` : `❌ Denied by user` });

    await interaction.update({
      embeds: [embed],
      components: [], // Remove buttons after decision
    });

    console.log(`[PermissionRequest] Tool "${toolName}" — ${allowed ? 'ALLOWED' : 'DENIED'} by user`);
    return allowed;
  };
}

/**
 * Setup signal handlers for graceful shutdown.
 */
function setupSignalHandlers(ctx: {
  managers: BotManagers;
  allHandlers: AllHandlers;
  abortAllClaudeControllers: () => void;
  claudeSender: ((messages: ClaudeMessage[]) => Promise<void>) | null;
  actualCategoryName: string;
  repoName: string;
  branchName: string;
  cleanupInterval: number;
  // deno-lint-ignore no-explicit-any
  bot: any;
}) {
  const { managers, allHandlers, abortAllClaudeControllers, claudeSender, actualCategoryName, repoName, branchName, cleanupInterval, bot } = ctx;
  const { crashHandler, healthMonitor } = managers;
  const { shell: shellHandlers, git: gitHandlers } = allHandlers;

  const handleSignal = async (signal: string) => {
    console.log(`\n${signal} signal received. Stopping bot...`);

    try {
      // Stop all processes
      shellHandlers.killAllProcesses();
      gitHandlers.killAllWorktreeBots();

      // Cancel all Claude Code sessions
      abortAllClaudeControllers();

      // Send shutdown message
      if (claudeSender) {
        await claudeSender([{
          type: 'system',
          content: '',
          metadata: {
            subtype: 'shutdown',
            signal,
            categoryName: actualCategoryName,
            repoName,
            branchName
          }
        }]);
      }

      // Cleanup
      healthMonitor.stopAll();
      crashHandler.cleanup();
      cleanupPaginationStates();
      clearInterval(cleanupInterval);

      setTimeout(() => {
        bot.client.destroy();
        Deno.exit(0);
      }, 1000);
    } catch (error) {
      console.error('Error during shutdown:', error);
      Deno.exit(1);
    }
  };

  // Cross-platform signal handling
  const platform = Deno.build.os;

  try {
    Deno.addSignalListener("SIGINT", () => handleSignal("SIGINT"));

    if (platform === "windows") {
      try {
        Deno.addSignalListener("SIGBREAK", () => handleSignal("SIGBREAK"));
      } catch (winError) {
        const message = winError instanceof Error ? winError.message : String(winError);
        console.warn('Could not register SIGBREAK handler:', message);
      }
    } else {
      try {
        Deno.addSignalListener("SIGTERM", () => handleSignal("SIGTERM"));
      } catch (unixError) {
        const message = unixError instanceof Error ? unixError.message : String(unixError);
        console.warn('Could not register SIGTERM handler:', message);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('Signal handler registration error:', message);
  }
}

// ================================
// .env Auto-Load
// ================================

/**
 * Load environment variables from .env file if it exists.
 * This enables zero-config startup when .env is present.
 */
async function loadEnvFile(): Promise<void> {
  try {
    const envPath = `${Deno.cwd()}/.env`;
    const stat = await Deno.stat(envPath).catch(() => null);

    if (!stat?.isFile) return;

    const content = await Deno.readTextFile(envPath);
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Parse KEY=VALUE format — only split on the first '=' so values like
      // SECRET="a=b=c" are handled correctly
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;

      const key = trimmed.substring(0, eqIndex).trim();
      let value = trimmed.substring(eqIndex + 1).trim();

      // Remove surrounding quotes if present, handling values that contain '='
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        // Double-quoted: strip quotes and process escape sequences
        value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
        // Single-quoted: strip quotes (no escape processing, like bash)
        value = value.slice(1, -1);
      } else {
        // Unquoted: strip inline comments (e.g., VALUE # comment)
        const commentIndex = value.indexOf(' #');
        if (commentIndex !== -1) {
          value = value.substring(0, commentIndex).trim();
        }
      }

      // Only set if not already defined (env vars take precedence)
      if (!Deno.env.get(key) && key && value) {
        Deno.env.set(key, value);
      }
    }

    console.log('✓ Loaded configuration from .env file');
  } catch (error) {
    // Silently ignore .env loading errors
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Note: Could not load .env file: ${message}`);
  }
}

// ================================
// Main Execution
// ================================

if (import.meta.main) {
  try {
    // Auto-load .env file (if present)
    await loadEnvFile();

    // Get environment variables and command line arguments
    const discordToken = Deno.env.get("DISCORD_TOKEN");
    const applicationId = Deno.env.get("APPLICATION_ID");
    const envCategoryName = Deno.env.get("CATEGORY_NAME");
    const envMentionUserId = Deno.env.get("USER_ID") || Deno.env.get("DEFAULT_MENTION_USER_ID");
    const envWorkDir = Deno.env.get("WORK_DIR");

    if (!discordToken || !applicationId) {
      console.error("╔═══════════════════════════════════════════════════════════╗");
      console.error("║  Error: Missing required configuration                    ║");
      console.error("╠═══════════════════════════════════════════════════════════╣");
      console.error("║  DISCORD_TOKEN and APPLICATION_ID are required.           ║");
      console.error("║                                                           ║");
      console.error("║  Options:                                                 ║");
      console.error("║  1. Create a .env file with these variables               ║");
      console.error("║  2. Set environment variables before running              ║");
      console.error("║  3. Run setup script: ./setup.sh or .\\setup.ps1          ║");
      console.error("╚═══════════════════════════════════════════════════════════╝");
      Deno.exit(1);
    }

    // Parse command line arguments
    const args = parseArgs(Deno.args);
    const categoryName = args.category || envCategoryName;
    const defaultMentionUserId = args.userId || envMentionUserId;
    const workDir = envWorkDir || Deno.cwd();

    // Get Git information
    const gitInfo = await getGitInfo();

    // Create and start bot
    await createClaudeCodeBot({
      discordToken,
      applicationId,
      workDir,
      repoName: gitInfo.repo,
      branchName: gitInfo.branch,
      categoryName,
      defaultMentionUserId,
    });

    console.log("✓ Bot has started. Press Ctrl+C to stop.");
  } catch (error) {
    console.error("Failed to start bot:", error);
    Deno.exit(1);
  }
}
