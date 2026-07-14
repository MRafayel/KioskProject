# Docker Desktop audit

- Date: 2026-07-13
- Machine: Apple silicon macOS
- Docker Desktop: 4.81.0
- Docker client: 29.6.1
- Docker Compose: 5.2.0

## Findings

Docker Desktop is installed correctly under /Applications/Docker.app, but its
CLI was not installed on the normal shell PATH.

The first Desktop process was unhealthy:

- com.docker.backend services held approximately 61,460 open descriptors;
- most sampled descriptors were repeated docker-proxy.sock Unix sockets;
- the backend log repeatedly reported socket: too many open files;
- the Linux engine did not respond to its health ping.

A forced Desktop stop released the leaked descriptors. On the clean restart:

1. Docker attempted to install Rosetta and macOS returned a Virtualization
   framework error.
2. Docker continued without Rosetta and successfully started its arm64 Linux
   VM.
3. The setup flow then sent POST /license/reject.
4. Docker Desktop shut down cleanly and removed ~/.docker/run/docker.sock.

The shutdown was caused by the unaccepted Docker Desktop license/setup, not the
project Compose file. The Compose file passed docker compose config throughout.

## Resolution verified

The owner completed Docker Desktop's setup on 2026-07-13. Runtime checks then
confirmed:

- the Docker 29.6.1 engine responds normally;
- the native arm64 hello-world image runs successfully without Rosetta;
- PostgreSQL 17, Redis 7, and MinIO start and report healthy;
- all service ports bind to 127.0.0.1 only;
- the baseline Prisma migration and seed complete successfully;
- the API readiness endpoint reaches PostgreSQL, Redis, and MinIO.

The repository's scripts/docker.mjs also finds the CLI inside Docker.app, so
project commands do not depend on a global docker symlink.

Repeat the project checks with:

```bash
docker version
docker compose version
docker run --rm hello-world
pnpm infra:up
pnpm infra:status
pnpm db:migrate
pnpm db:seed
```

If the descriptor leak returns after license acceptance, use Docker Desktop's
normal Restart action and collect diagnostics before considering any data
reset. Do not use Reset to factory defaults without first reviewing whether
local Docker volumes contain valuable data.
