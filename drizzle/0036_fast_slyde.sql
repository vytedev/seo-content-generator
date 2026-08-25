DROP INDEX "finding_review_sets_run_unique";--> statement-breakpoint
ALTER TABLE "finding_review_sets" ADD COLUMN "round" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "finding_review_sets_run_round_unique" ON "finding_review_sets" USING btree ("run_id","round");--> statement-breakpoint
ALTER TABLE "finding_review_sets" ADD CONSTRAINT "finding_review_sets_round" CHECK ("finding_review_sets"."round" >= 1);