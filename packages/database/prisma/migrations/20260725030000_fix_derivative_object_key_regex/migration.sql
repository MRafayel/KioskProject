-- PostgreSQL's POSIX regular-expression implementation rejects repetition
-- upper bounds greater than RE_DUP_MAX (255). The object_key column already
-- has a VARCHAR(512) limit, so validate its length separately and use `+` for
-- the allowed-character expression.
ALTER TABLE "file_derivatives"
  DROP CONSTRAINT "file_derivatives_object_key_check";

ALTER TABLE "file_derivatives"
  ADD CONSTRAINT "file_derivatives_object_key_check"
  CHECK (
    char_length("object_key") BETWEEN 1 AND 512
    AND "object_key" !~ '(^/|(^|/)\.\.(/|$)|//)'
    AND "object_key" ~ '^[A-Za-z0-9._/-]+$'
    AND split_part("object_key", '/', 4) = "file_id"::text
    AND (
      (
        "type" = 'ORIGINAL'
        AND "object_key" ~ '^quarantine/v1/[0-9a-f-]{36}/[0-9a-f-]{36}/[A-Za-z0-9_-]{16,128}$'
      )
      OR
      (
        "type" = 'NORMALIZED_PDF'
        AND split_part("object_key", '/', 5) = ('r' || "processing_revision"::text)
        AND "object_key" ~ '^normalized/v1/[0-9a-f-]{36}/[0-9a-f-]{36}/r[1-9][0-9]*/g[1-9][0-9]*/document\.pdf$'
      )
      OR (
        "type" = 'PAGE_PREVIEW'
        AND split_part("object_key", '/', 5) = ('r' || "processing_revision"::text)
        AND "object_key" ~ '^previews/v1/[0-9a-f-]{36}/[0-9a-f-]{36}/r[1-9][0-9]*/g[1-9][0-9]*/page-[1-9][0-9]*\.webp$'
        AND split_part("object_key", '/', 7) = ('page-' || "page_number"::text || '.webp')
      )
    )
  );
