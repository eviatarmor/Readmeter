CREATE TABLE "events_daily" (
	"project_id" text NOT NULL,
	"day" date NOT NULL,
	"provider" text NOT NULL,
	"service" text NOT NULL,
	"op" text NOT NULL,
	"template" text NOT NULL,
	"callsite" text DEFAULT '' NOT NULL,
	"callsite_label" text,
	"events" bigint DEFAULT 0 NOT NULL,
	"items" bigint DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"cached" bigint DEFAULT 0 NOT NULL,
	"errors" bigint DEFAULT 0 NOT NULL,
	"units" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events_rollup_state" (
	"project_id" text PRIMARY KEY NOT NULL,
	"rolled_event_id" bigint DEFAULT 0 NOT NULL,
	"rolled_until" date DEFAULT '1970-01-01' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events_daily" ADD CONSTRAINT "events_daily_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events_rollup_state" ADD CONSTRAINT "events_rollup_state_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "events_daily_key" ON "events_daily" USING btree ("project_id","day","provider","service","op","template","callsite");--> statement-breakpoint
CREATE INDEX "events_batch_idx" ON "events" USING btree ("batch_id");