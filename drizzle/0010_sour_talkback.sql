DROP INDEX "calibration_reports_hash_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "calibration_reports_hash_unique" ON "calibration_reports" USING btree ("calibration_run_id","report_hash");