# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --system llmup \
    && useradd --system --gid llmup --create-home --home-dir /home/llmup llmup

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force
COPY --from=build --chown=llmup:llmup /app/dist ./dist
COPY --chown=llmup:llmup data ./data

USER llmup
ENTRYPOINT ["node", "dist/bin.js"]
CMD ["recommend", "--json"]
