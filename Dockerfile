FROM node:24.2.0-bookworm-slim@sha256:b30c143a092c7dced8e17ad67a8783c03234d4844ee84c39090c9780491aaf89 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:24.2.0-bookworm-slim@sha256:b30c143a092c7dced8e17ad67a8783c03234d4844ee84c39090c9780491aaf89 AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
# Keep locked executable dependencies, but not their bundled source maps.
RUN npm ci --omit=dev \
    && find node_modules -type f -name '*.map' -delete \
    && npm cache clean --force

FROM node:24.2.0-bookworm-slim@sha256:b30c143a092c7dced8e17ad67a8783c03234d4844ee84c39090c9780491aaf89
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-dependencies /app/package.json /app/package-lock.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER 1000:1000
ENTRYPOINT ["node", "/app/dist/ingress/main.js"]
CMD ["serve"]
