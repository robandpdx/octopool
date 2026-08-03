FROM node:26-slim AS build
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .
RUN pnpm build:gcp

FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/dist/gcp/server.mjs ./dist/gcp/server.mjs

CMD ["node", "dist/gcp/server.mjs"]
