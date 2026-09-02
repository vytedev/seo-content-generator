FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS development

WORKDIR /app

ARG DEV_UID=1000
ARG DEV_GID=1000

RUN apt-get update \
  && apt-get install -y --no-install-recommends procps \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci && chown -R "${DEV_UID}:${DEV_GID}" /app/node_modules

COPY --chown=${DEV_UID}:${DEV_GID} . .

ENV NODE_ENV=development
ENV HOME=/tmp

EXPOSE 3000 3110

USER ${DEV_UID}:${DEV_GID}

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
