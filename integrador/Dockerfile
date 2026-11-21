FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json server.js ./
COPY src ./src
RUN mkdir /data && chown node:node /data
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
