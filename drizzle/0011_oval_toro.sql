CREATE TABLE "calibration_run_snapshots" (
	"calibration_run_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"slot" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calibration_run_snapshots_calibration_run_id_slot_pk" PRIMARY KEY("calibration_run_id","slot"),
	CONSTRAINT "calibration_run_snapshots_slot_range" CHECK ("calibration_run_snapshots"."slot" between 1 and 2)
);
--> statement-breakpoint
ALTER TABLE "calibration_run_snapshots" ADD CONSTRAINT "calibration_run_snapshots_calibration_run_id_calibration_runs_id_fk" FOREIGN KEY ("calibration_run_id") REFERENCES "public"."calibration_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_run_snapshots" ADD CONSTRAINT "calibration_run_snapshots_snapshot_id_calibration_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."calibration_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calibration_run_snapshots_run_snapshot_unique" ON "calibration_run_snapshots" USING btree ("calibration_run_id","snapshot_id");--> statement-breakpoint
CREATE TRIGGER calibration_run_snapshots_immutable BEFORE UPDATE OR DELETE ON calibration_run_snapshots FOR EACH ROW EXECUTE FUNCTION reject_calibration_immutable_change();