-- Allocate every run activity sequence under one run-scoped transaction lock.
CREATE OR REPLACE FUNCTION allocate_run_activity_sequence() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.run_id::text, 0));
  SELECT coalesce(max(sequence), 0) + 1 INTO NEW.sequence
    FROM run_activity_events WHERE run_id=NEW.run_id;
  NEW.payload := jsonb_set(NEW.payload, '{sequence}', to_jsonb(NEW.sequence), true);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS run_activity_events_allocate_sequence ON run_activity_events;--> statement-breakpoint
CREATE TRIGGER run_activity_events_allocate_sequence BEFORE INSERT ON run_activity_events FOR EACH ROW EXECUTE FUNCTION allocate_run_activity_sequence();--> statement-breakpoint

-- Persist step lifecycle at mutation time; the activity id makes retries observational.
CREATE OR REPLACE FUNCTION append_step_lifecycle_activity() RETURNS trigger AS $$
DECLARE
  activity_type text;
  event_time timestamptz;
  event_summary text;
BEGIN
  IF TG_OP='UPDATE' AND OLD.status=NEW.status THEN RETURN NEW; END IF;
  activity_type := CASE NEW.status
    WHEN 'running' THEN 'step_started'
    WHEN 'waiting' THEN 'step_waiting'
    WHEN 'retryable_failed' THEN 'step_failed'
    WHEN 'blocked' THEN 'step_blocked'
    WHEN 'succeeded' THEN 'step_succeeded'
    ELSE NULL
  END;
  IF activity_type IS NULL THEN RETURN NEW; END IF;
  event_time := CASE
    WHEN NEW.status='running' THEN coalesce(NEW.started_at,NEW.updated_at,NEW.created_at)
    WHEN NEW.status IN ('retryable_failed','blocked','succeeded') THEN coalesce(NEW.completed_at,NEW.updated_at,NEW.created_at)
    ELSE coalesce(NEW.updated_at,NEW.created_at)
  END;
  event_summary := initcap(replace(NEW.step::text,'_',' '))||': '||replace(NEW.status::text,'_',' ')||'.';
  INSERT INTO run_activity_events(activity_id,run_id,sequence,type,step,summary,payload,occurred_at)
  VALUES('step:'||NEW.id::text||':'||activity_type,NEW.run_id,1,activity_type,NEW.step,event_summary,
    jsonb_build_object('activity_id','step:'||NEW.id::text||':'||activity_type,'run_id',NEW.run_id::text,
      'sequence',1,'type',activity_type,'occurred_at',event_time,'step',NEW.step,'summary',event_summary),event_time)
  ON CONFLICT(activity_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS step_executions_activity ON step_executions;--> statement-breakpoint
CREATE TRIGGER step_executions_activity AFTER INSERT OR UPDATE OF status ON step_executions FOR EACH ROW EXECUTE FUNCTION append_step_lifecycle_activity();--> statement-breakpoint

-- Historical rows predate transition-time recording. Preserve a truthful current-state projection once.
INSERT INTO run_activity_events(activity_id,run_id,sequence,type,step,summary,payload,occurred_at)
SELECT 'step:'||e.id::text||':'||x.type,e.run_id,1,x.type,e.step,
  initcap(replace(e.step::text,'_',' '))||': '||replace(e.status::text,'_',' ')||'.',
  jsonb_build_object('activity_id','step:'||e.id::text||':'||x.type,'run_id',e.run_id::text,
    'sequence',1,'type',x.type,'occurred_at',x.occurred_at,'step',e.step,
    'summary',initcap(replace(e.step::text,'_',' '))||': '||replace(e.status::text,'_',' ')||'.'),x.occurred_at
FROM step_executions e
CROSS JOIN LATERAL (SELECT
  CASE e.status WHEN 'running' THEN 'step_started' WHEN 'waiting' THEN 'step_waiting'
    WHEN 'retryable_failed' THEN 'step_failed' WHEN 'blocked' THEN 'step_blocked'
    WHEN 'succeeded' THEN 'step_succeeded' END type,
  CASE WHEN e.status='running' THEN coalesce(e.started_at,e.updated_at,e.created_at)
    WHEN e.status IN ('retryable_failed','blocked','succeeded') THEN coalesce(e.completed_at,e.updated_at,e.created_at)
    ELSE coalesce(e.updated_at,e.created_at) END occurred_at) x
WHERE x.type IS NOT NULL
ON CONFLICT(activity_id) DO NOTHING;
