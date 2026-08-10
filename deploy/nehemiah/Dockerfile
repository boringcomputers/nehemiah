FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS build
WORKDIR /app
COPY package.json package-lock.json turbo.json ./
COPY apps/nehemiah/package.json apps/nehemiah/package.json
COPY packages/typescript-config packages/typescript-config
COPY packages/prettier-config packages/prettier-config
RUN npm ci --workspace @nehemiah/nehemiah --include-workspace-root
COPY apps/nehemiah apps/nehemiah
RUN npm run build -w @nehemiah/nehemiah
# The build needs TypeScript/test tooling, but the long-running control plane
# must not inherit the monorepo's development dependency graph.
RUN npm prune --omit=dev --workspace @nehemiah/nehemiah --include-workspace-root

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/nehemiah/package.json ./package.json
COPY --from=build /app/apps/nehemiah/dist ./dist
COPY --from=build /app/apps/nehemiah/src/db/migrations ./dist/db/migrations
USER node
EXPOSE 8081
CMD ["node", "dist/main.js"]
