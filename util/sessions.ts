/**
 * Session JSONL utilities — read Claude Code session files from
 * ~/.claude/projects/<slug>/*.jsonl. Each filename is a session UUID.
 *
 * Used by:
 *  - core/button-handlers.ts: recent-session picker (UI)
 *  - claude/import-command.ts: bulk import of sessions into Discord channels
 */

export interface RecentSession {
  id: string;
  prompt: string;
  timestamp: Date;
}

/**
 * Build the project slug that Claude Code uses for the project directory.
 * e.g. "/home/user/foo" -> "-home-user-foo"
 */
export function projectSlugFromWorkDir(workDir: string): string {
  return workDir
    .replace(/^[A-Za-z]:/, (m) => m[0].toUpperCase())
    .replace(/[\\/]/g, '-')
    .replace(/^-/, '');
}

/**
 * Read recent sessions from ~/.claude/projects/<slug>/.
 * Returns sessions sorted by mtime, most recent first.
 * Reads only the first 2048 bytes of each JSONL to extract the first user prompt.
 */
export async function readRecentSessions(
  workDir: string,
): Promise<RecentSession[]> {
  try {
    const slug = projectSlugFromWorkDir(workDir);
    const homeDir = Deno.env.get('USERPROFILE') || Deno.env.get('HOME') || '';
    const projectDir = `${homeDir}/.claude/projects/${slug}`;

    const entries: RecentSession[] = [];

    for await (const entry of Deno.readDir(projectDir)) {
      if (!entry.name.endsWith('.jsonl') || entry.isDirectory) continue;

      const sessionId = entry.name.replace('.jsonl', '');
      const filePath = `${projectDir}/${entry.name}`;
      const stat = await Deno.stat(filePath);

      let prompt = '(unknown)';
      try {
        const file = await Deno.open(filePath);
        const buf = new Uint8Array(2048);
        const bytesRead = await file.read(buf);
        file.close();
        if (bytesRead && bytesRead > 0) {
          const text = new TextDecoder().decode(buf.subarray(0, bytesRead));
          prompt = extractFirstUserPrompt(text);
        }
      } catch { /* skip unreadable files */ }

      entries.push({
        id: sessionId,
        prompt,
        timestamp: stat.mtime ?? new Date(0),
      });
    }

    entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return entries;
  } catch {
    return [];
  }
}

/**
 * Parse the first user-message text out of a chunk of JSONL.
 * Skips meta events and content that starts with `<` (tool envelopes, system tags).
 */
export function extractFirstUserPrompt(text: string): string {
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type !== 'user') continue;
      if (obj.isMeta) continue;
      const content = obj.message?.content;
      let textStr: string | undefined;
      if (Array.isArray(content)) {
        const textBlock = content.find((b: { type: string }) => b.type === 'text');
        if (textBlock) textStr = textBlock.text;
      } else if (typeof content === 'string') {
        textStr = content;
      }
      if (textStr && !textStr.startsWith('<')) return textStr;
    } catch { /* skip malformed lines */ }
  }
  return '(unknown)';
}

export interface SessionMessage {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Read the last N user/assistant text messages from a session JSONL.
 * Streams the file from the end backwards (chunked) to avoid loading
 * multi-MB files fully into memory.
 *
 * Filter:
 *  - type == 'user' or 'assistant'
 *  - message.role matches type
 *  - content is a string (not a tool-call envelope array)
 *  - skip isMeta
 *  - skip content starting with '<' (system/tool tags)
 */
export async function readLastNMessages(
  jsonPath: string,
  n: number,
): Promise<SessionMessage[]> {
  try {
    const stat = await Deno.stat(jsonPath);
    const fileSize = stat.size;
    if (fileSize === 0) return [];

    const chunkSize = 32_768;
    const file = await Deno.open(jsonPath, { read: true });
    try {
      const collected: SessionMessage[] = [];
      let pos = fileSize;
      let leftover = '';

      while (pos > 0 && collected.length < n) {
        const readLen = Math.min(chunkSize, pos);
        pos -= readLen;
        const buf = new Uint8Array(readLen);
        const nread = await file.read(buf);
        if (!nread || nread === 0) break;

        const chunkStr = new TextDecoder().decode(buf.subarray(0, nread));
        const combined = chunkStr + leftover;
        const lines = combined.split('\n');
        // First element is partial (its start is in an earlier chunk we haven't
        // read yet) — keep it for the next iteration, unless we're at the file
        // start.
        if (pos > 0) {
          leftover = lines.shift() ?? '';
        } else {
          leftover = '';
        }

        // Process lines oldest-first within this chunk but we want newest first
        // overall, so iterate in reverse.
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i];
          if (!line || !line.trim()) continue;
          const msg = parseSessionMessage(line);
          if (msg) {
            collected.push(msg);
            if (collected.length >= n) break;
          }
        }
      }

      // We collected newest-first; reverse so oldest is first for display.
      collected.reverse();
      return collected.slice(-n);
    } finally {
      file.close();
    }
  } catch {
    return [];
  }
}

function parseSessionMessage(line: string): SessionMessage | null {
  try {
    const obj = JSON.parse(line);
    if (obj.isMeta) return null;
    if (obj.type !== 'user' && obj.type !== 'assistant') return null;
    const role = obj.message?.role;
    if (role !== 'user' && role !== 'assistant') return null;
    const content = obj.message?.content;
    let textStr: string | undefined;
    if (Array.isArray(content)) {
      const textBlock = content.find((b: { type: string }) => b.type === 'text');
      if (textBlock) textStr = textBlock.text;
    } else if (typeof content === 'string') {
      textStr = content;
    }
    if (!textStr || textStr.startsWith('<')) return null;
    return { role, text: textStr };
  } catch {
    return null;
  }
}

/**
 * Scan all projects under ~/.claude/projects/ and return a flat list of
 * (projectSlug, sessionId, prompt, mtime) tuples sorted by mtime desc.
 * Excludes any project whose slug matches `excludeSlugs`.
 */
export interface SessionScanResult {
  projectSlug: string;
  sessionId: string;
  prompt: string;
  jsonlPath: string;
  timestamp: Date;
}

export async function scanAllSessions(
  excludeSlugs: string[] = [],
): Promise<SessionScanResult[]> {
  const homeDir = Deno.env.get('USERPROFILE') || Deno.env.get('HOME') || '';
  const projectsDir = `${homeDir}/.claude/projects`;
  const excludeSet = new Set(excludeSlugs);
  const out: SessionScanResult[] = [];

  try {
    for await (const projectEntry of Deno.readDir(projectsDir)) {
      if (!projectEntry.isDirectory) continue;
      if (excludeSet.has(projectEntry.name)) continue;

      const projectDir = `${projectsDir}/${projectEntry.name}`;
      for await (const entry of Deno.readDir(projectDir)) {
        if (!entry.name.endsWith('.jsonl') || entry.isDirectory) continue;

        const sessionId = entry.name.replace('.jsonl', '');
        const filePath = `${projectDir}/${entry.name}`;
        const stat = await Deno.stat(filePath);

        let prompt = '(unknown)';
        try {
          const file = await Deno.open(filePath);
          const buf = new Uint8Array(2048);
          const bytesRead = await file.read(buf);
          file.close();
          if (bytesRead && bytesRead > 0) {
            const text = new TextDecoder().decode(buf.subarray(0, bytesRead));
            prompt = extractFirstUserPrompt(text);
          }
        } catch { /* skip */ }

        out.push({
          projectSlug: projectEntry.name,
          sessionId,
          prompt,
          jsonlPath: filePath,
          timestamp: stat.mtime ?? new Date(0),
        });
      }
    }
  } catch { /* projects dir missing — return empty */ }

  out.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return out;
}