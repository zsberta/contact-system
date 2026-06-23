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
RUN apk upgrade --no-cache openssl libssl3 libcrypto3 busybox

COPY --from=builder /app/dist ./dist
RUN chmod -R a+rX /app/dist
COPY server.js package*.json ./
COPY --from=builder /tmp/prod_node_modules ./node_modules
COPY db ./db
COPY lib ./lib
COPY routes ./routes
COPY middleware ./middleware

RUN addgroup -S nodeapp && adduser -S nodeapp -G nodeapp && chown -R nodeapp:nodeapp /app
USER nodeapp

EXPOSE 3000
CMD ["node", "server.js"]
