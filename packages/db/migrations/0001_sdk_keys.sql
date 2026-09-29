CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "allowed_origins" text[] DEFAULT '{}'::text[] NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "hash_key" text;
--> statement-breakpoint
UPDATE "projects" SET "hash_key" = encode(gen_random_bytes(16), 'hex') WHERE "hash_key" IS NULL;
--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "hash_key" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_hash_key_hex" CHECK ("projects"."hash_key" ~ '^[0-9a-f]{32}$');
