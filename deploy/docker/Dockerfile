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
COPY . .
RUN pnpm exec tsc -b tsconfig.build.json
RUN pnpm --filter @saga/web build

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
