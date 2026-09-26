CREATE TABLE "platform_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"setting_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"value_bps" integer NOT NULL,
	"notes" text,
	"updated_by" uuid,
	"updated_by_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_settings_key_version_key" ON "platform_settings" USING btree ("setting_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_settings_active_key" ON "platform_settings" USING btree ("setting_key") WHERE "platform_settings"."is_active";--> statement-breakpoint
CREATE INDEX "idx_platform_settings_key_created_at" ON "platform_settings" USING btree ("setting_key","created_at");--> statement-breakpoint
-- Seed the values that were previously hardcoded, so behaviour is unchanged
-- until an admin publishes a new one. 100 bps = 1.00%, matching both the old
-- `principal * 0.01` in the repay route and DEFAULT_PLATFORM_FEE_BPS in
-- contracts/lending/src/lib.rs.
INSERT INTO "platform_settings"
	("setting_key", "version", "is_active", "value_bps", "notes", "updated_by_email")
VALUES
	(
		'platform_fee_bps', 1, true, 100,
		'Initial value migrated from the hardcoded 1% platform fee (issue #324)',
		'system@trustlend.org'
	)
ON CONFLICT DO NOTHING;
