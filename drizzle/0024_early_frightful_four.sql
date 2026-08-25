UPDATE "revision_finding_audits"
SET "location_json" = to_jsonb("location")
WHERE "location_json" IS NULL;--> statement-breakpoint
UPDATE "revision_finding_audits"
SET "manifest_hash" = encode(digest(
  concat_ws(':', "operation_id", "ordinal"::text, "finding_id"::text),
  'sha256'
), 'hex')
WHERE "manifest_hash" IS NULL;--> statement-breakpoint
ALTER TABLE "revision_finding_audits" ALTER COLUMN "location_json" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "revision_finding_audits" ALTER COLUMN "manifest_hash" SET NOT NULL;