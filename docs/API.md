# API reference (v2)

Same-origin JSON; bearer `Authorization: Bearer <API_TOKEN>` on every `/api` request when configured. No cookie sessions/CORS grants. Invalid input returns 400 with `{ "error": "...", "request_id": "..." }`; unavailable dependencies return 503 without internal details. Missing identifiers return 404; invalid UUIDs 400; authentication failure 401. Some early middleware errors omit request_id in the JSON but always use `X-Request-Id` after hostname validation. No secrets or stack traces are returned.

| Method/path                           | Contract                                                                                                                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET `/health/live`                    | Process liveness, independent of DB.                                                                                                                                                                     |
| GET `/health/ready`                   | Executes real `SELECT 1`; 503 if unavailable. Worker health is separate.                                                                                                                                 |
| GET `/api/summary`                    | Counts healthy/failing/unknown/stale/disabled, excluding archived targets.                                                                                                                               |
| GET `/api/targets`                    | `q` up to 100 chars; exact `tag` up to 30; `state`; page 1–10000, size 1–100 (default 25). Stable name/UUID sort; items/total/page/size. Search uses PostgreSQL ILIKE semantics (`%`/`_` are wildcards). |
| POST `/api/targets`                   | Full validated target configuration; 201 `{id}`. Default down rule created atomically.                                                                                                                   |
| GET `/api/targets/:id`                | target, recent results, latest 50 incidents, rules. `hours` 1–168 (default 24); paginated results, default 25, max 100; newest first. No full-history download.                                          |
| PUT `/api/targets/:id`                | Full replacement configuration. Invalidates claims/resets current state; retains history. Omitted fields take documented creation defaults.                                                              |
| DELETE `/api/targets/:id`             | Soft archive, stops monitoring, retains history/incident audit. Not a physical database delete.                                                                                                          |
| PUT `/api/targets/:id/rules`          | Upsert `down` or `latency` rule, reset counters, preserve incidents.                                                                                                                                     |
| GET `/api/incidents`                  | Active incidents, newest first; page/size bounds as above.                                                                                                                                               |
| POST `/api/incidents/:id/acknowledge` | JSON `{}`; idempotent acknowledgement event. Currently returns success even for absent/already-acknowledged IDs.                                                                                         |
| GET `/api/operations`                 | Recent 20 workers with freshness, at most 100 unsent deliveries, metrics/pool counters. Counts are per-process or rolling minute as labeled.                                                             |

Create request example (synthetic local target, requires demo mode/allowlist):

```json
{
  "name": "Demo API",
  "host": "http://127.0.0.1:8099/health",
  "probe_type": "http",
  "enabled": true,
  "interval_ms": 10000,
  "timeout_ms": 2000,
  "expected_status": 200,
  "max_bytes": 65536,
  "tags": ["demo"]
}
```

Names: 1–100 chars. URL: <=2048 chars, HTTP(S) only, no credentials/query/fragment. TCP: hostname/IP plus integer port 1–65535. Interval: 1000–86400000 ms; timeout 100–30000 ms and strictly smaller than interval. Expected status: 100–599 (exact equality, redirects never followed). Body cap: 1–1048576 bytes. Up to ten unique tags, 1–30 letters/digits/underscore/hyphen. TLS verification stays enabled. Failed checks have null latency and bounded error categories; errors never echo socket/database internals.

PowerShell (omit the Authorization header only for unauthenticated loopback development):

```powershell
$headers = @{Authorization="Bearer $env:API_TOKEN"}
$body = @{name='Demo API';host='http://127.0.0.1:8099/health';tags=@('demo')} | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:4000/api/targets -Method Post -Headers $headers -ContentType application/json -Body $body
Invoke-RestMethod 'http://127.0.0.1:4000/api/targets?state=healthy&size=25&page=1' -Headers $headers
```

Rule request defaults:

```json
{
  "kind": "latency",
  "failure_threshold": 3,
  "recovery_threshold": 2,
  "latency_threshold_ms": 500,
  "window_samples": 5,
  "cooldown_ms": 60000
}
```

Threshold counts/window samples 1–100; latency threshold 1–3600000 ms; cooldown 0–86400000 ms. Down rules ignore latency/window settings. Unknown/stale do not generate failures. See DESIGN.md for sample window/cooldown semantics.

Webhook payload (illustrative IDs/timestamps, not a claimed real delivery):

```json
{
  "version": 1,
  "event": "open",
  "incident_id": "d9712bc0-4c00-4000-8000-000000000001",
  "target_id": "d9712bc0-4c00-4000-8000-000000000002",
  "name": "Demo API",
  "rule": "down",
  "at": "2026-10-15T17:00:00.000Z"
}
```

Recovery uses `event: "recovery"` with the same incident ID. Headers include Content-Type and delivery UUID Idempotency-Key, plus optional environment-configured bearer secret. Payload deliberately excludes target URL, credentials and low-level errors.

Compatibility: v1 `/api/devices`, Socket.IO `bootstrap`/`status`, and automatic JSON-based ICMP polling are removed. Existing integrations must migrate to these endpoints and explicit database import/configuration. No implicit external destination probing occurs on startup.
