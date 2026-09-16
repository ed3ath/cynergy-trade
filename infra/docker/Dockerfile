FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/providers/package.json ./packages/providers/
COPY packages/core/package.json ./packages/core/
COPY packages/scanner/package.json ./packages/scanner/
COPY packages/strategy/package.json ./packages/strategy/
COPY packages/execution/package.json ./packages/execution/
COPY packages/position/package.json ./packages/position/
COPY apps/trader/package.json ./apps/trader/
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN for pkg in shared providers core scanner strategy execution position; do \
      pnpm exec tsc -p packages/$pkg/tsconfig.json || exit 1; \
    done && \
    pnpm exec tsc -p apps/trader/tsconfig.json

FROM base AS runner
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/infra ./infra
COPY --from=builder /app/package.json ./
COPY --from=builder /app/tsconfig.base.json ./

USER node
CMD ["node", "apps/trader/dist/index.js"]
