ALTER TABLE "revision_noop_completions" DROP CONSTRAINT "revision_noop_completions_source";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "deterministic_repair_cycles" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "revision_noop_completions" ADD CONSTRAINT "revision_noop_completions_source" CHECK ("revision_noop_completions"."revision_source" in ('operator_findings','deterministic_repair','coherence_repair'));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_deterministic_repair_cycles_range" CHECK ("runs"."deterministic_repair_cycles" between 0 and 2);