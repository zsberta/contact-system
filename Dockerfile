FROM node:22-alpine AS builder
WORKDIR /app
RUN apk upgrade --no-cache openssl libssl3 libcrypto3 busybox

COPY package*.json ./
RUN npm install --include=dev
COPY public ./public
COPY src ./src
COPY scripts ./scripts
COPY index.html vite.config.ts tailwind.config.ts postcss.config.js ./
COPY tsconfig.json tsconfig.app.json tsconfig.node.json ./

RUN npm run build && npm prune --omit=dev && cp -R node_modules /tmp/prod_node_modules

FROM node:22-alpine AS runner
WORKDIR /app
RUN apk upgrade --no-cache openssl libssl3 libcrypto3 busybox && apk add --no-cache su-exec

COPY --from=builder /app/dist ./dist
RUN chmod -R a+rX /app/dist
COPY server.js package*.json ./
COPY --from=builder /tmp/prod_node_modules ./node_modules
COPY db ./db
COPY lib ./lib
COPY routes ./routes
COPY middleware ./middleware
COPY scripts ./scripts
COPY public ./public

RUN addgroup -S nodeapp && adduser -S nodeapp -G nodeapp \
    && mkdir -p /app/uploads/ai-assistant-avatars \
    && chown -R nodeapp:nodeapp /app
# Don't set USER here — docker-compose drops privileges via su-exec after
# fixing the uploads volume permissions at startup.

EXPOSE 3000
CMD ["node", "server.js"]
