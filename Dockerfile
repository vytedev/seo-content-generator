FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS development

WORKDIR /app

COPY package*.json ./
RUN npm ci && chown -R node:node /app/node_modules

COPY --chown=node:node . .

ENV NODE_ENV=development

EXPOSE 3000 3100

USER node

CMD ["npm", "run", "dev:host"]

FROM node:22-bookworm-slim AS production

WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node --from=build /app/dist ./dist

EXPOSE 3000

USER node

CMD ["npm", "start"]
