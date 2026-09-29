CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "batches_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"schema" integer NOT NULL,
	"sdk_name" text NOT NULL,
	"sdk_version" text NOT NULL,
	"session" text NOT NULL,
	"events" integer NOT NULL,
	"findings" integer NOT NULL,
	"dropped_events" bigint DEFAULT 0 NOT NULL,
	"dropped_findings" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" text NOT NULL,
	"batch_id" bigint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"session" text NOT NULL,
	"provider" text NOT NULL,
	"service" text NOT NULL,
	"op" text NOT NULL,
	"op_detail" jsonb,
	"template" text NOT NULL,
	"target_key" text NOT NULL,
	"id_shape" text,
	"collection_group" boolean DEFAULT false NOT NULL,
	"query" jsonb,
	"fingerprint" text,
	"base_key" text,
	"items" bigint DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"from_cache" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"duration_us" bigint,
	"call_id" text NOT NULL,
	"callsite" text,
	"listener" text,
	"mount" text,
	"platform" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"dev" boolean DEFAULT false NOT NULL,
	"units" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "findings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" text NOT NULL,
	"rule" text NOT NULL,
	"severity" text NOT NULL,
	"source" text NOT NULL,
	"provider" text NOT NULL,
	"service" text NOT NULL,
	"template" text NOT NULL,
	"session" text NOT NULL,
	"callsite" text DEFAULT '' NOT NULL,
	"message" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"wasted" jsonb NOT NULL,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_idx" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "batches_project_received_idx" ON "batches" USING btree ("project_id","received_at");--> statement-breakpoint
CREATE INDEX "events_project_ts_idx" ON "events" USING btree ("project_id","ts");--> statement-breakpoint
CREATE INDEX "events_project_template_idx" ON "events" USING btree ("project_id","template");--> statement-breakpoint
CREATE INDEX "events_project_callsite_idx" ON "events" USING btree ("project_id","callsite");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_dedupe_idx" ON "findings" USING btree ("project_id","rule","session","callsite","template");--> statement-breakpoint
CREATE INDEX "findings_project_last_seen_idx" ON "findings" USING btree ("project_id","last_seen");--> statement-breakpoint
CREATE INDEX "findings_project_rule_idx" ON "findings" USING btree ("project_id","rule");--> statement-breakpoint
CREATE INDEX "projects_org_idx" ON "projects" USING btree ("org_id");