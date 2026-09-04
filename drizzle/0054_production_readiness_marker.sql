-- Custom migration generated with drizzle-kit --custom.
-- Publish readiness only after every preceding schema, data, trigger and activity migration succeeds.
INSERT INTO "application_schema_version" ("singleton","version") VALUES (true,55);
