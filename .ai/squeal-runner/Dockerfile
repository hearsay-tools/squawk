# syntax=docker/dockerfile:1
# Squawk-owned Agent37 workspace template (`squawk-runner`) for Squeal remote runs.
# Keeps Ubuntu 26.04 + non-root `node` (uid=1000) + Git 2.53 + build tools + tini,
# and bakes Google Chrome Stable + pinned agent-browser outside `/home/node`
# (Agent37 mounts the instance's persistent disk over `/home/node` at runtime).
FROM ubuntu:26.04

ARG AGENT_BROWSER_VERSION=0.39.4

USER root

ENV DEBIAN_FRONTEND=noninteractive

# Base toolchain needed by Squeal, Squawk unit tests, test-env-up.sh, and headless Chrome.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl gnupg git sudo tini \
    build-essential python3 python3-venv file \
    jq ripgrep rsync unzip zip xz-utils \
    procps lsof iproute2 \
    fonts-liberation fonts-dejavu-core fonts-noto-core \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Non-root `node` user (uid=1000) unlocked for SSH pubkey auth, with passwordless sudo
# so remote.setup can install/upgrade system dependencies when needed.
RUN if id -u ubuntu >/dev/null 2>&1; then userdel -r ubuntu; fi \
  && if getent group 1000 >/dev/null 2>&1; then groupdel "$(getent group 1000 | cut -d: -f1)"; fi \
  && groupadd --gid 1000 node \
  && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash node \
  && usermod -p '*' node \
  && echo "node ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/99-node-nopasswd \
  && chmod 0440 /etc/sudoers.d/99-node-nopasswd

# Google Chrome Stable + all Linux shared libraries, baked under /usr (never /home/node).
RUN install -d -m 0755 /usr/share/keyrings \
  && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/* \
  && google-chrome --version

# Pinned agent-browser binary in /usr/local/bin (matches .ai/scripts/test-env.inputs.json).
RUN curl -fsSL --retry 3 --connect-timeout 30 --max-time 300 \
    -o /usr/local/bin/agent-browser \
    "https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/agent-browser-linux-x64" \
  && chmod 0755 /usr/local/bin/agent-browser \
  && agent-browser --version | grep -F "${AGENT_BROWSER_VERSION}"

# Verify headless Chrome launches as `node` with an empty HOME (matching Agent37 runtime).
RUN su -s /bin/bash node -c 'set -eu; \
  H=$(mktemp -d /tmp/squawk-chrome-check.XXXXXX); \
  trap "rm -rf \"$H\"" EXIT; \
  OUT=$(HOME="$H" XDG_CACHE_HOME="$H/.cache" TMPDIR=/tmp \
    agent-browser --args --no-sandbox --session build-probe open about:blank --json); \
  HOME="$H" XDG_CACHE_HOME="$H/.cache" TMPDIR=/tmp \
    agent-browser --args --no-sandbox --session build-probe close --json >/dev/null 2>&1 || true; \
  printf "%s\n" "$OUT" | jq -e ".success == true" >/dev/null'

ENV HOME=/home/node
ENV PATH=/home/node/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /home/node

USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
