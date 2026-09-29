CREATE TABLE "cost_daily" (
	"project_id" text NOT NULL,
	"day" date NOT NULL,
	"service" text NOT NULL,
	"sku" text NOT NULL,
	"usage_amount" numeric NOT NULL,
	"usage_unit" text NOT NULL,
	"cost_micros" bigint NOT NULL,
	"credits_micros" bigint DEFAULT 0 NOT NULL,
	"currency" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gcp_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"gcp_project_id" text NOT NULL,
	"client_email" text NOT NULL,
	"key_ciphertext" text NOT NULL,
	"key_iv" text,
	"key_tag" text,
	"billing_table" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"sync_requested_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gcp_connections_status" CHECK ("gcp_connections"."status" in ('pending', 'ok', 'error'))
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"project_id" text NOT NULL,
	"day" date NOT NULL,
	"provider" text NOT NULL,
	"service" text NOT NULL,
	"metric" text NOT NULL,
	"amount" numeric NOT NULL,
	"source" text DEFAULT 'monitoring' NOT NULL,
	CONSTRAINT "usage_daily_source" CHECK ("usage_daily"."source" in ('monitoring'))
);
--> statement-breakpoint
ALTER TABLE "cost_daily" ADD CONSTRAINT "cost_daily_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gcp_connections" ADD CONSTRAINT "gcp_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gcp_connections" ADD CONSTRAINT "gcp_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gcp_connections" ADD CONSTRAINT "gcp_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_daily_key" ON "cost_daily" USING btree ("project_id","day","service","sku");--> statement-breakpoint
CREATE UNIQUE INDEX "gcp_connections_project_idx" ON "gcp_connections" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "gcp_connections_org_idx" ON "gcp_connections" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_daily_key" ON "usage_daily" USING btree ("project_id","day","provider","service","metric","source");