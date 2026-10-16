ALTER TABLE delivery_attempts ADD COLUMN attempt_number int;
WITH numbered AS (
 SELECT id,row_number() OVER(PARTITION BY delivery_id ORDER BY id) n FROM delivery_attempts
) UPDATE delivery_attempts a SET attempt_number=n.n FROM numbered n WHERE a.id=n.id;
ALTER TABLE delivery_attempts ALTER COLUMN attempt_number SET NOT NULL;
ALTER TABLE delivery_attempts ALTER COLUMN attempt_number SET DEFAULT 1;
ALTER TABLE delivery_attempts ADD CONSTRAINT delivery_attempt_number_positive CHECK(attempt_number>0);
CREATE UNIQUE INDEX delivery_attempt_identity ON delivery_attempts(delivery_id,attempt_number);
CREATE INDEX incidents_cause_result ON incidents(cause_run_id) WHERE cause_run_id IS NOT NULL;
CREATE INDEX incident_events_result ON incident_events(run_id) WHERE run_id IS NOT NULL;
