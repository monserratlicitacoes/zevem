FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY angular.json tsconfig*.json ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM nginx:stable-alpine
COPY deploy/frontend.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/apple-green/browser/ /usr/share/nginx/html/
