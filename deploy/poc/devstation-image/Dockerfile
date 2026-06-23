# =============================================================================
# deploy/poc/devstation-image/Dockerfile — lean POC devstation image.
#
# "Similar to the devstations we have now" (code-server IDE + Claude Code + the
# same Hybrid/AI-only credential model) but LIGHT: it layers only the Claude Code
# CLI on top of codercom/code-server, whose base layers are already cached on the
# POC node — so the incremental pull is small and fast (the 1.6GB fleet image
# claude-code-dev:aks-v2 cannot pull onto the small Azure Local worker).
#
# Auth: code-server's own entrypoint reads PASSWORD (the per-seat -env Secret
# supplies it). Claude Code reads CLAUDE_CODE_OAUTH_TOKEN (Hybrid) or
# ANTHROPIC_API_KEY (AI-only) from the env — both injected via envFrom the same
# -env Secret the Seat Manager writes. We do NOT override the entrypoint, so
# code-server starts exactly as upstream; `claude` is on PATH for the terminal.
# =============================================================================
FROM codercom/code-server:latest

USER root

# Node 20 + the Claude Code CLI. (code-server bundles its own node at a private
# path; we install a system node so `npm`/`claude` are on PATH for the coder user.)
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g @anthropic-ai/claude-code \
 && npm cache clean --force \
 && apt-get purge -y gnupg \
 && apt-get autoremove -y \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# Extension-policy entrypoint: installs the seat's CODE_SERVER_EXTENSIONS (from
# Open VSX) on boot, then execs the upstream code-server entrypoint. Args still
# come from the Deployment ("$@"), so --bind-addr + PASSWORD behave as before.
COPY entrypoint.sh /usr/local/bin/vosj-entrypoint.sh
RUN chmod +x /usr/local/bin/vosj-entrypoint.sh

# Back to the unprivileged code-server user.
USER coder
ENTRYPOINT ["/usr/local/bin/vosj-entrypoint.sh"]
