FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY *.js ./
RUN mkdir /data && chown node:node /data
USER node
CMD ["node", "server.js"]
