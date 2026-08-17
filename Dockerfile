# Claude Code Discord Bot
# Production image: Deno + Claude Agent SDK + Claude Code CLI (for session-bridging)

FROM denoland/deno:latest

# Build arguments for user UID/GID (match host user to avoid permission issues)
ARG USER_ID=1000
ARG GROUP_ID=1000

# Build-time commit SHA for version checks (set by CI / compose; do not git-init /app)
ARG GIT_COMMIT=
ENV GIT_COMMIT=${GIT_COMMIT}

# Set working directory
WORKDIR /app

# Set environment variable to indicate Docker container
ENV DOCKER_CONTAINER=true

# Install system dependencies: git, curl, ca-certs, Node.js (for claude CLI)
USER root
RUN apt-get update && \
    apt-get install -y --no-install-recommends git curl ca-certificates gnupg && \
    curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally (used for `claude --resume <session-id>` continuation)
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user with home directory (SDK may use ~/.claude)
RUN groupadd -r -g ${GROUP_ID} claude && \
    useradd -r -u ${USER_ID} -g claude -m claude

# Copy all source files (as root)
COPY . .

# Remove lockfile if present (avoid version conflicts)
RUN rm -f deno.lock

# Pre-compile Deno dependencies
RUN deno cache --no-lock index.ts

# Create data directory for persistence + workspace dir, set ownership.
# git-init /app so getGitInfo() at startup succeeds (bot runs from WORKDIR /app).
# Use -b main so the branch channel matches the existing Discord channel.
RUN mkdir -p .bot-data /app/workspace /home/claude/.claude && \
    git init -b main && git config user.email "bot@claude.local" && git config user.name "Claude Bot" && \
    cd /app/workspace && git init -b main && git config user.email "bot@claude.local" && git config user.name "Claude Bot" && \
    chown -R claude:claude /app /home/claude

# Point the bot at the in-container claude binary
ENV CLAUDE_BINARY_PATH=/usr/bin/claude

# Switch to non-root user
USER claude

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD deno eval "console.log('healthy')" || exit 1

# Default command
CMD ["deno", "run", "--allow-all", "--no-lock", "index.ts"]

# Labels for image metadata
LABEL org.opencontainers.image.source="https://github.com/zebbern/claude-code-discord"
LABEL org.opencontainers.image.description="Claude Code Discord Bot - Use Claude AI via Discord"
LABEL org.opencontainers.image.licenses="MIT"