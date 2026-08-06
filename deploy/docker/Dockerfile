# Saga API and worker share one image; the compose service chooses which entrypoint runs.
# Multi-stage so the runtime layer carries no build toolchain or dev dependencies.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

# ---------------------------------------------------------------------------
# deps — install once against the lockfile so layer caching survives code edits
# ---------------------------------------------------------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json      packages/shared/
COPY packages/contracts/package.json   packages/contracts/
COPY packages/database/package.json    packages/database/
COPY packages/core/package.json        packages/core/
COPY packages/shrine/package.json      packages/shrine/
COPY packages/quest/package.json       packages/quest/
COPY packages/lore/package.json        packages/lore/
COPY packages/party/package.json       packages/party/
COPY packages/agent-sdk/package.json   packages/agent-sdk/
COPY apps/server/package.json          apps/server/
COPY apps/worker/package.json          apps/worker/
COPY apps/cli/package.json             apps/cli/
COPY apps/web/package.json             apps/web/
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build — compile every workspace package
# ---------------------------------------------------------------------------
FROM deps AS build
# `bundle.mjs` stamps the CLI with the commit it was built from, and `node:22-bookworm-slim`
# ships no git — `git rev-parse` failed silently and every image served `0.1.0+local.<wall
# clock>`, which names no commit, differs on every rebuild of the same tree, and does not match
# the `0.1.0+g<sha>` that README step 6 tells the user to look for. Installed in this stage
# only; the runtime stage below is `FROM base` and never sees it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*
COPY . .
RUN pnpm exec tsc -b tsconfig.build.json
RUN pnpm --filter @saga/web build
# The client executable the API hands out at /api/cli/saga. Built here so that every deployment
# can install a CLI without a clone, and so the one it serves is the one this image was built
# from. `apps/cli/pack` is not matched by the `apps/*` workspace glob, so the runtime install
# below leaves it alone.
#
# The build id is normally read from the commit above. `SAGA_CLI_BUILD_ID` overrides it for a
# release process that names its own builds, or for a context with no `.git` in it at all.
ARG SAGA_CLI_BUILD_ID=
RUN SAGA_CLI_BUILD_ID="$SAGA_CLI_BUILD_ID" pnpm --filter @saga/cli bundle

# ---------------------------------------------------------------------------
# runtime — production dependencies plus compiled output
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json ./
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
COPY --from=build /app/db ./db
RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
  && pnpm store prune \
  && find . -name '*.map' -delete

# Never run as root.
USER node

# The API binds loopback by default; in a container it must bind the service network.
ENV SAGA_API_HOST=0.0.0.0
EXPOSE 4319

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SAGA_API_PORT||4319)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/main.js"]
