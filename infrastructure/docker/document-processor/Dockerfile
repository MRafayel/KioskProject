FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build

WORKDIR /workspace
RUN corepack enable

COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY services/document-processor/package.json services/document-processor/package.json
RUN pnpm install --frozen-lockfile \
  --filter @printing-kiosk/document-processor...

COPY services/document-processor services/document-processor
RUN pnpm --filter @printing-kiosk/document-processor build \
  && pnpm --filter @printing-kiosk/document-processor --prod deploy --legacy /opt/document-processor

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates poppler-utils qpdf tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 processor \
  && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin processor \
  && install -d -o 10001 -g 10001 -m 0700 /tmp/document-processor

WORKDIR /app
COPY --from=build --chown=0:0 /opt/document-processor/ ./

ENV NODE_ENV=production \
  HOME=/nonexistent \
  TMPDIR=/tmp/document-processor \
  PROCESSOR_HOST=0.0.0.0 \
  PROCESSOR_PORT=3200 \
  PROCESSOR_SCRATCH_DIR=/tmp/document-processor

USER 10001:10001
EXPOSE 3200

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3200/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
