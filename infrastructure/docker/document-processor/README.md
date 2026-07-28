# Isolated document processor image

Build from the repository root:

```sh
docker build -f infrastructure/docker/document-processor/Dockerfile .
```

The service accepts one authenticated request at a time on
`POST /internal/v1/process`. It must only be reachable from the worker on a
private internal network. Development Compose uses a narrow gateway published
only on `127.0.0.1:3200` because the worker runs on the host; the processor
itself remains attached only to the internal network. The runtime should be
launched with:

- a read-only root filesystem;
- `/tmp` as a size-bounded `tmpfs`;
- every Linux capability dropped;
- `no-new-privileges`;
- PID, CPU, memory and wall-clock limits;
- no public port mapping and no general outbound Internet access.

ClamAV scanning and signature updates run in separate containers so neither the
scanner nor this processor needs Internet access. Only the FreshClam updater is
attached to the update network; it writes the shared signature volume, which
the scanner mounts read-only. Use the immutable multi-architecture scanner image
`clamav/clamav:stable-debian@sha256:a73435b0fa51886e9e6dd1881656023ba9dce756e055f23981270badbb8ca3d7`
on the same private network (or expose a Unix socket), and mount its definitions
only into the scanner container. Configure ClamAV `StreamMaxLength` at least as
large as `PROCESSOR_MAX_INPUT_BYTES`; the processor still enforces its own
smaller hard limit.

Required environment:

```text
DOCUMENT_PROCESSOR_AUTH_TOKEN=<at least 32 random bytes>
CLAMAV_HOST=clamav
CLAMAV_PORT=3310
```

The service intentionally does not accept customer filenames, object-storage
credentials, URLs or output paths.

This long-lived container is suitable for the local prototype but is not the
final isolation boundary for hostile commercial traffic. Production should
launch a fresh disposable processor sandbox for each document, enforce the same
resource and network restrictions at the orchestrator, terminate the complete
process group on timeout, and destroy the sandbox and scratch volume after the
response. Restarting a shared process between jobs is not equivalent to a new
security boundary.
