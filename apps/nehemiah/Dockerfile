# syntax=docker/dockerfile:1
#
# Control plane (apps/nehemiah) image for Cloudflare Containers. The build
# context is the repository root so the npm workspace lockfile resolves; see
# docs/cloudflare.md. The runtime is Debian-based because the lockfile pins the
# glibc build of @node-rs/argon2.
#
# Migrations are not run here: the deploy workflow applies them with the
# migration role before the new image rolls out.

FROM node:24.19.0-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
COPY apps/nehemiah/package.json apps/nehemiah/
COPY apps/web/package.json apps/web/
COPY packages ./packages
RUN npm ci --workspace @nehemiah/nehemiah --no-audit --no-fund
COPY apps/nehemiah ./apps/nehemiah
RUN npm run build --workspace @nehemiah/nehemiah

FROM node:24.19.0-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS runtime-deps
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
COPY apps/nehemiah/package.json apps/nehemiah/
COPY apps/web/package.json apps/web/
COPY packages ./packages
RUN npm ci --workspace @nehemiah/nehemiah --omit=dev --no-audit --no-fund \
	&& npm cache clean --force

FROM node:24.19.0-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
ENV NODE_ENV=production
WORKDIR /srv/nehemiah
COPY --from=runtime-deps /src ./
COPY --from=build /src/apps/nehemiah/dist ./apps/nehemiah/dist
COPY apps/nehemiah/src/db/migrations ./apps/nehemiah/src/db/migrations
USER node
EXPOSE 8081
CMD ["node", "apps/nehemiah/dist/main.js"]
