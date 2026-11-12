# Isolated coding runner

`DockerSandboxRunner` is an execution primitive for generated code and focused tests. It is not yet connected to the GitHub engineering executor or the 48-hour project pipeline.

## Runtime requirements

- Dedicated Linux worker with a **rootless Docker daemon**. Rootful or unrecognized daemon configurations are rejected before a workspace is created.
- A pre-pulled sandbox image referenced by immutable digest, for example `registry.example/transactra-sandbox@sha256:<64-hex-digest>`.
- Set `TRANSACTRA_SANDBOX_IMAGE` to that digest. The runner uses `--pull=never`; it never downloads images at execution time.
- The image must contain the language runtime and any dependencies needed by the command. The container has no network, so it cannot fetch packages during execution.

## Isolation controls

The runner first checks `docker info --format '{{json .SecurityOptions}}'` and requires the explicit `name=rootless` security option. This is mandatory: the container command uses UID/GID `0:0`, which rootless Docker maps to the unprivileged host identity that owns the daemon; it is not a non-root UID inside the container namespace. Rootful and unknown daemon modes fail closed before a workspace is created. After preflight, the runner creates a private ephemeral host workspace and mounts only that workspace at `/workspace`. It starts a container with a read-only root filesystem, no network, all Linux capabilities dropped, no-new-privileges, PID/memory/CPU limits, a bounded tmpfs, a wall-clock timeout and a combined stdout/stderr output cap. It validates relative file paths and rejects traversal, absolute paths, symlinks and oversized file sets.

Containers share the host kernel and are not a VM boundary. Do not run hostile third-party code on a shared host, expose the Docker socket to agents, mount host credentials, or use privileged containers. Use a dedicated worker and consider microVM isolation for stronger multi-tenant threat boundaries.

## Integration boundary

The current runner accepts an explicit file map and command. It does not clone repositories, resolve dependencies, install packages, or push code. The GitHub engineering pipeline must be wired to a trusted dependency-preparation stage and real sandbox execution before any generated code is treated as validated.
