# syntax=docker/dockerfile:1
#
# CloudPilot runtime image. One image serves every service; the entrypoint is the service
# name, so the same digest can be reused for the control plane, worker, scheduler, Telegram
# and WhatsApp. Build it on the deployment host or in the deployment pipeline; the image is
# never pulled from a registry that CloudPilot does not control, and it is built with no
 # secrets baked in — credentials arrive only through the environment at run time.
FROM node:22-alpine AS build
WORKDIR /w
RUN apk add --no-cache python3 make g++ git
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY infra ./infra
RUN pnpm build

FROM build AS prod
# Runtime dependencies only (the monorepo has exactly one: pg). Build tools stay in the
# build stage, so the runtime image never carries a compiler or a package manager.
WORKDIR /w/prod
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:22-alpine
WORKDIR /opt/cloudpilot
ENV NODE_ENV=production
RUN addgroup -g 10001 cloudpilot && adduser -D -u 10001 -G cloudpilot cloudpilot \
    && chown cloudpilot:cloudpilot /opt/cloudpilot
COPY --from=build --chown=cloudpilot:cloudpilot /w/dist ./dist
COPY --from=prod --chown=cloudpilot:cloudpilot /w/prod/node_modules ./node_modules
COPY --from=build --chown=cloudpilot:cloudpilot /w/infra ./infra
COPY --from=build --chown=cloudpilot:cloudpilot /w/package.json ./
USER cloudpilot
ENTRYPOINT ["node"]
CMD ["dist/apps/control-plane/src/server.js"]
