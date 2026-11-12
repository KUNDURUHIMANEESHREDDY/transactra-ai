# syntax=docker/dockerfile:1
#
# The CloudPilot sandbox image: a self-contained workspace with the toolchain CloudPilot's
# verification presets need. Build it, then pin it by digest and pre-pull it on the worker
# host. The runner passes --pull=never, so it never downloads an image at execution time,
# and it starts the container with no network, a read-only root filesystem and every Linux
# capability dropped: everything the code needs must be inside this image.
FROM node:22-alpine
RUN apk add --no-cache git openssh-client dumb-init
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
USER node
WORKDIR /workspace
LABEL org.opencontainers.image.title="cloudpilot-sandbox"
# Verification runs as this user by default; the runner mounts only /workspace.
CMD ["node", "--version"]
