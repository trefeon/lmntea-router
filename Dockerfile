# syntax=docker/dockerfile:1
# P0: Hono + Bun/Node multi-stage — dist <80MB, HEALTHCHECK on /health
FROM node:22-alpine AS builder
WORKDIR /app
RUN npm i -g pnpm@10.33.0
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsup.config.ts biome.json vitest.config.ts ./
COPY src ./src
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
USER app
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3000/health | grep -q '"status":"ok"' || exit 1
CMD ["node", "dist/index.js"]
