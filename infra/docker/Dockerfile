FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json yarn.lock* package-lock.json* pnpm-lock.yaml* ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/providers/package.json ./packages/providers/
COPY packages/core/package.json ./packages/core/
COPY packages/scanner/package.json ./packages/scanner/
COPY packages/strategy/package.json ./packages/strategy/
COPY packages/risk/package.json ./packages/risk/
COPY packages/execution/package.json ./packages/execution/
COPY packages/position/package.json ./packages/position/
COPY packages/performance/package.json ./packages/performance/
COPY apps/trader/package.json ./apps/trader/
RUN npm ci --ignore-scripts

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/infra ./infra

USER node
CMD ["node", "apps/trader/dist/index.js"]
