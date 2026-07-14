# Docker Desktop audit

Date: 2026-07-12  
Machine: Apple silicon macOS  
Docker Desktop: 4.81.0  
Docker client: 29.6.1  
Docker Compose: 5.2.0

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

The current blocker is therefore the unaccepted Docker Desktop license/setup,
not the project Compose file. The Compose file passes docker compose config.

## Required user action

1. Open Docker Desktop from Applications.
2. Read and accept Docker Desktop's terms if you agree to them. Codex cannot
   accept legal terms on your behalf.
3. If prompted about Rosetta, choose Continue without Rosetta. This project
   uses native arm64 PostgreSQL, Redis, and MinIO images.
4. Wait until Docker reports that the engine is running.
5. In Docker Desktop settings, enable/install CLI tools for the system PATH if
   desired.

The repository's scripts/docker.mjs also finds the CLI inside Docker.app, so
project commands do not depend on a global docker symlink.

Verify after accepting:

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
