CREATE TABLE targets (
 id uuid PRIMARY KEY, name varchar(100) NOT NULL, host varchar(2048) NOT NULL,
 probe_type text NOT NULL CHECK(probe_type IN ('http','tcp')), port int CHECK(port BETWEEN 1 AND 65535),
 enabled boolean NOT NULL DEFAULT true, deleted_at timestamptz,
 interval_ms int NOT NULL CHECK(interval_ms BETWEEN 1000 AND 86400000),
 timeout_ms int NOT NULL CHECK(timeout_ms BETWEEN 100 AND 30000 AND timeout_ms < interval_ms),
 expected_status int NOT NULL DEFAULT 200 CHECK(expected_status BETWEEN 100 AND 599),
 max_bytes int NOT NULL DEFAULT 65536 CHECK(max_bytes BETWEEN 1 AND 1048576),
 tags text[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 next_due timestamptz NOT NULL DEFAULT now(), run_id uuid, claim_token uuid, lease_until timestamptz,
 scheduled_at timestamptz, last_completed_at timestamptz, outcome text CHECK(outcome IN ('success','failure')),
 latency_ms double precision CHECK(latency_ms >= 0), error_code varchar(40),
 CHECK(probe_type <> 'tcp' OR port IS NOT NULL)
);
CREATE INDEX targets_due ON targets(next_due) WHERE enabled AND deleted_at IS NULL;
CREATE INDEX targets_name ON targets(name,id) WHERE deleted_at IS NULL;
CREATE INDEX targets_tags ON targets USING gin(tags);
CREATE TABLE results (
 run_id uuid PRIMARY KEY, target_id uuid NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
 scheduled_at timestamptz NOT NULL, started_at timestamptz NOT NULL, completed_at timestamptz NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('success','failure')), latency_ms double precision CHECK(latency_ms >= 0),
 error_code varchar(40), error_message varchar(200), worker_id uuid NOT NULL,
 CHECK(completed_at >= started_at)
);
CREATE INDEX results_target_time ON results(target_id,completed_at DESC);
CREATE INDEX results_retention ON results(completed_at);
CREATE TABLE rules (
 id uuid PRIMARY KEY, target_id uuid NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('down','latency')), failure_threshold int NOT NULL DEFAULT 3 CHECK(failure_threshold BETWEEN 1 AND 100),
 recovery_threshold int NOT NULL DEFAULT 2 CHECK(recovery_threshold BETWEEN 1 AND 100),
 latency_threshold_ms int NOT NULL DEFAULT 500 CHECK(latency_threshold_ms > 0),
 window_samples int NOT NULL DEFAULT 5 CHECK(window_samples BETWEEN 1 AND 100),
 cooldown_ms int NOT NULL DEFAULT 60000 CHECK(cooldown_ms BETWEEN 0 AND 86400000),
 failures int NOT NULL DEFAULT 0, successes int NOT NULL DEFAULT 0, last_notified_at timestamptz,
 UNIQUE(target_id,kind)
);
CREATE TABLE incidents (
 id uuid PRIMARY KEY, rule_id uuid NOT NULL REFERENCES rules(id), target_id uuid NOT NULL REFERENCES targets(id),
 opened_at timestamptz NOT NULL, recovered_at timestamptz, acknowledged_at timestamptz,
 cause_run_id uuid REFERENCES results(run_id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX incidents_one_open ON incidents(rule_id) WHERE recovered_at IS NULL;
CREATE INDEX incidents_recent ON incidents(opened_at DESC);
CREATE TABLE incident_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, incident_id uuid NOT NULL REFERENCES incidents(id),
 kind text NOT NULL CHECK(kind IN ('open','recovery','acknowledge')), at timestamptz NOT NULL DEFAULT now(),
 run_id uuid REFERENCES results(run_id) ON DELETE SET NULL
);
CREATE TABLE deliveries (
 id uuid PRIMARY KEY, incident_id uuid NOT NULL REFERENCES incidents(id), event_id bigint NOT NULL UNIQUE REFERENCES incident_events(id),
 payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','exhausted')),
 attempts int NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5), next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, claim_token uuid, last_error varchar(80), delivered_at timestamptz
);
CREATE INDEX deliveries_due ON deliveries(next_attempt_at) WHERE status='pending';
CREATE TABLE delivery_attempts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, delivery_id uuid NOT NULL REFERENCES deliveries(id),
 attempted_at timestamptz NOT NULL DEFAULT now(), success boolean NOT NULL, error_code varchar(80)
);
CREATE TABLE workers (
 id uuid PRIMARY KEY, heartbeat_at timestamptz NOT NULL DEFAULT now(), active int NOT NULL DEFAULT 0,
 completed bigint NOT NULL DEFAULT 0, failures bigint NOT NULL DEFAULT 0, db_errors bigint NOT NULL DEFAULT 0
);
