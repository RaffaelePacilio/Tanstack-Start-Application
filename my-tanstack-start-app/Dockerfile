# ---- deps ----
FROM node:20-alpine AS deps
WORKDIR /app

# pnpm
RUN corepack enable

# Copia solo i manifest per massimizzare la cache
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---- build ----
FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build (genera .output/)
RUN pnpm build

# ---- run ----
FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production

# Se usi runtime env, spesso serve anche HOST
ENV HOST=0.0.0.0
# Porta standard (ma può essere diversa: vedi note sotto)
ENV PORT=3000

# Copio solo l'output runtime
COPY --from=build /app/.output ./.output

# Se la tua app ha bisogno di file statici extra non inclusi in .output,
# valuta di copiare anche /public (spesso Nitro li incorpora in output/public).
# COPY --from=build /app/public ./public

EXPOSE 3000

# Nitro node-server entrypoint
CMD ["node", ".output/server/index.mjs"]