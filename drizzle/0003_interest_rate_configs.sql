CREATE TYPE "public"."rate_model" AS ENUM('fixed', 'floating');--> statement-breakpoint
CREATE TABLE "interest_rate_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rate_model" "rate_model" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"base_apr_bps" integer NOT NULL,
	"min_apr_bps" integer DEFAULT 0 NOT NULL,
	"max_apr_bps" integer DEFAULT 10000 NOT NULL,
	"amount_tiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reputation_tiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"updated_by" uuid,
	"updated_by_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "interest_rate_configs" ADD CONSTRAINT "interest_rate_configs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "interest_rate_configs_model_version_key" ON "interest_rate_configs" USING btree ("rate_model","version");--> statement-breakpoint
CREATE UNIQUE INDEX "interest_rate_configs_active_model_key" ON "interest_rate_configs" USING btree ("rate_model") WHERE "interest_rate_configs"."is_active";--> statement-breakpoint
CREATE INDEX "idx_interest_rate_configs_model_created_at" ON "interest_rate_configs" USING btree ("rate_model","created_at");--> statement-breakpoint
-- Seed the schedules that were previously hardcoded in
-- app/api/loans/apply/route.ts, so behaviour is unchanged until an admin
-- publishes a new version. Reputation multipliers start neutral (1.00x).
--
-- Thresholds are 1000.000001/2000.000001 rather than 1000/2000 because the old
-- ladder compared with a strict `amount > 1000`, while tiers match on
-- `amount >= minAmount`. This keeps a loan of exactly 1000 or 2000 XLM priced
-- the way it was before the change; admins can round these off when they next
-- publish a schedule.
INSERT INTO "interest_rate_configs"
	("rate_model", "version", "is_active", "base_apr_bps", "min_apr_bps", "max_apr_bps", "amount_tiers", "reputation_tiers", "notes", "updated_by_email")
VALUES
	(
		'fixed', 1, true, 1500, 100, 5000,
		'[{"minAmount":1000.000001,"aprBps":1200},{"minAmount":2000.000001,"aprBps":1000}]'::jsonb,
		'[{"minScore":0,"multiplierBps":10000},{"minScore":500,"multiplierBps":10000},{"minScore":750,"multiplierBps":10000}]'::jsonb,
		'Initial schedule migrated from hardcoded APR ladder (issue #321)',
		'system@trustlend.org'
	),
	(
		'floating', 1, true, 500, 100, 5000,
		'[{"minAmount":1000.000001,"aprBps":450},{"minAmount":2000.000001,"aprBps":400}]'::jsonb,
		'[{"minScore":0,"multiplierBps":10000},{"minScore":500,"multiplierBps":10000},{"minScore":750,"multiplierBps":10000}]'::jsonb,
		'Initial schedule migrated from hardcoded APR ladder (issue #321)',
		'system@trustlend.org'
	)
ON CONFLICT DO NOTHING;
