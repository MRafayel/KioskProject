CREATE TABLE "system_metadata" (
  "key" VARCHAR(100) NOT NULL,
  "value" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "system_metadata_pkey" PRIMARY KEY ("key")
);

