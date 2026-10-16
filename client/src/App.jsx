import React, { useEffect, useRef, useState, lazy, Suspense } from "react";
const LatencyChart = lazy(() => import("./LatencyChart.jsx"));
import "./style.css";
const empty = {
  name: "",
  host: "http://127.0.0.1:8099/health",
  probe_type: "http",
  port: 443,
  enabled: true,
  interval_ms: 10000,
  timeout_ms: 2000,
  expected_status: 200,
  max_bytes: 65536,
  tags: [],
};
const date = (value) =>
  value ? new Date(value).toLocaleString() : "No checks yet";
export default function App() {
  const [token, setToken] = useState(""),
    [auth, setAuth] = useState(false);
  const [summary, setSummary] = useState({}),
    [list, setList] = useState({ items: [], total: 0 }),
    [ops, setOps] = useState(null),
    [incidents, setIncidents] = useState([]);
  const [q, setQ] = useState(""),
    [state, setState] = useState(""),
    [tag, setTag] = useState(""),
    [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null),
    [detail, setDetail] = useState(null),
    [historyPage, setHistoryPage] = useState(1);
  const [form, setForm] = useState(null),
    [editing, setEditing] = useState(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [refresh, setRefresh] = useState(0),
    [updated, setUpdated] = useState(null);
  const busy = useRef(false),
    previousFocus = useRef(null);
  const [tagsInput, setTagsInput] = useState("");
  async function api(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: options.signal || AbortSignal.timeout(8000),
    });
    if (response.status === 401) setAuth(true);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Request failed");
    return body;
  }
  useEffect(() => {
    let stopped = false,
      timer,
      failures = 0,
      controller;
    async function poll() {
      if (busy.current) {
        timer = setTimeout(poll, 250);
        return;
      }
      busy.current = true;
      controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 8000);
      try {
        const params = new URLSearchParams({ q, state, tag, page, size: 20 });
        const [s, l, o, i, d] = await Promise.allSettled([
          api("/api/summary", { signal: controller.signal }),
          api(`/api/targets?${params}`, { signal: controller.signal }),
          api("/api/operations", { signal: controller.signal }),
          api("/api/incidents", { signal: controller.signal }),
          selected
            ? api(`/api/targets/${selected}?size=50&page=${historyPage}`, {
                signal: controller.signal,
              })
            : null,
        ]);
        if (!stopped) {
          if (s.status === "fulfilled") setSummary(s.value);
          if (l.status === "fulfilled") setList(l.value);
          if (o.status === "fulfilled") setOps(o.value);
          if (i.status === "fulfilled") setIncidents(i.value.items);
          if (d.status === "fulfilled") setDetail(d.value);
          const failed = [s, l, o, i, d].find((r) => r.status === "rejected");
          if (failed) {
            failures++;
            setError(
              failed.reason.name === "AbortError"
                ? "Refresh timed out. Retry or check the server."
                : failed.reason.message,
            );
          } else {
            setError("");
            setAuth(false);
            setUpdated(new Date());
            failures = 0;
          }
        }
      } catch (e) {
        if (!stopped) {
          setError(
            e.name === "AbortError"
              ? "Refresh timed out. Retry or check the server."
              : e.message,
          );
          failures++;
        }
      } finally {
        clearTimeout(deadline);
        busy.current = false;
        if (!stopped) {
          setLoading(false);
          timer = setTimeout(poll, Math.min(30000, 5000 * 2 ** failures));
        }
      }
    }
    poll();
    return () => {
      stopped = true;
      controller?.abort();
      clearTimeout(timer);
    };
  }, [token, q, state, tag, page, selected, historyPage, refresh]);
  async function mutate(url, method, body) {
    setSaving(true);
    try {
      await api(url, { method, body: JSON.stringify(body ?? {}) });
      setForm(null);
      setEditing(null);
      setRefresh((r) => r + 1);
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }
  useEffect(() => {
    if (!form) previousFocus.current?.focus();
  }, [form]);
  function openForm(t) {
    previousFocus.current = document.activeElement;
    setTagsInput(t?.tags.join(", ") || "");
    setEditing(t?.id || null);
    setForm(t ? { ...t, tags: [...t.tags] } : { ...empty });
  }
  const total = Object.values(summary).reduce((a, b) => a + b, 0);
  return (
    <div className="shell">
      <aside>
        <a className="brand" href="#">
          <span className="logo">N</span> netmon
          <span className="brand-dot">.</span>
        </a>
        <div className="workspace">NETWORK OPERATIONS</div>
        <nav>
          <a href="#overview">◉ Overview</a>
          <a href="#targets">▤ Monitored targets</a>
          <a href="#incidents">
            ⚑ Incidents <span>{incidents.length}</span>
          </a>
        </nav>
        <div className="aside-bottom">
          <span
            className={`dot ${ops?.worker_available ? "healthy" : "stale"}`}
          />
          {ops?.worker_available ? "Worker connected" : "Worker unavailable"}
          <small>PostgreSQL · independent workers</small>
        </div>
      </aside>
      <main id="overview">
        <header>
          <div>
            <div className="eyebrow">YOUR NETWORK, AT A GLANCE</div>
            <h1>Network overview</h1>
            <p>
              Availability, response times, and the signals that need your
              attention.
            </p>
          </div>
          <button onClick={() => openForm(null)}>＋ Add target</button>
        </header>
        <div className="toolbar">
          <span className="live">
            <span className="dot healthy" /> Monitoring console
          </span>
          <span>
            {updated
              ? `Updated ${updated.toLocaleTimeString()} · refresh 5s`
              : "Connecting…"}
          </span>
          <button className="quiet" onClick={() => setRefresh((r) => r + 1)}>
            ↻ Refresh
          </button>
        </div>
        {auth && (
          <form
            className="auth"
            onSubmit={(e) => {
              e.preventDefault();
              setToken(e.currentTarget.elements.token.value);
              setRefresh((r) => r + 1);
            }}
          >
            <label>
              Access token{" "}
              <input name="token" type="password" autoComplete="off" required />
            </label>
            <button>Connect</button>
          </form>
        )}
        {error && (
          <div className="error" role="alert">
            {error} Previous results may be out of date.
          </div>
        )}
        {ops && !ops.worker_available && (
          <div className="notice" role="status">
            No fresh worker heartbeat. Start a worker to collect checks; missing
            data is never counted as healthy.
          </div>
        )}
        <section className="stats" aria-label="Target status totals">
          {[
            ["All targets", total, "all"],
            ...Object.entries(summary).map(([k, v]) => [k, v, k]),
          ].map(([label, count, key]) => (
            <button
              className="stat"
              key={key}
              onClick={() => {
                setState(key === "all" ? "" : key);
                setPage(1);
              }}
            >
              <span>
                <i className={`dot ${key}`} />
                {label}
              </span>
              <strong>{count}</strong>
              <small>
                {key === "all"
                  ? "In this workspace"
                  : key === "healthy"
                    ? "Successful recent check"
                    : key === "stale"
                      ? "Check overdue"
                      : key === "unknown"
                        ? "Awaiting first result"
                        : key === "disabled"
                          ? "Monitoring paused"
                          : "Latest check failed"}
              </small>
            </button>
          ))}
        </section>
        <section className="panel" id="targets">
          <div className="panel-heading">
            <div>
              <h2>
                Monitored targets <span className="count">{list.total}</span>
              </h2>
              <p>Live status across your configured services.</p>
            </div>
          </div>
          <div className="filters">
            <label className="search">
              Search targets
              <input
                placeholder="Name or destination…"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(1);
                }}
              />
            </label>
            <label>
              Status
              <select
                value={state}
                onChange={(e) => {
                  setState(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All statuses</option>
                {["healthy", "failing", "unknown", "stale", "disabled"].map(
                  (s) => (
                    <option key={s}>{s}</option>
                  ),
                )}
              </select>
            </label>
            <label>
              Tag
              <input
                placeholder="e.g. demo"
                value={tag}
                onChange={(e) => {
                  setTag(e.target.value);
                  setPage(1);
                }}
              />
            </label>
          </div>
          <div
            className="table-wrap"
            tabIndex={0}
            aria-label="Scrollable results table"
          >
            <table>
              <thead>
                <tr>
                  <th>Target / destination</th>
                  <th>Status</th>
                  <th>Latency</th>
                  <th>Last check</th>
                  <th>Incidents</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <button
                        className="target-link"
                        onClick={() => {
                          setSelected(t.id);
                          setHistoryPage(1);
                        }}
                      >
                        {t.name}
                      </button>
                      <small className="host">
                        {t.probe_type.toUpperCase()} · {t.host}
                        {t.port ? `:${t.port}` : ""}
                      </small>
                      <div className="tags">
                        {t.tags.map((tag) => (
                          <span key={tag}>{tag}</span>
                        ))}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${t.state}`}>
                        <i className={`dot ${t.state}`} />
                        {t.state}
                      </span>
                    </td>
                    <td className="numeric">
                      {t.latency_ms === null
                        ? "—"
                        : `${Number(t.latency_ms).toFixed(1)} ms`}
                    </td>
                    <td>{date(t.last_completed_at)}</td>
                    <td>
                      {t.active_incidents > 0 ? (
                        <span className="incident-count">
                          {t.active_incidents} open
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <button className="quiet" onClick={() => openForm(t)}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!list.items.length && (
            <div className="empty">
              {loading
                ? "Loading targets…"
                : "No targets found. Add a target or adjust your filters."}
            </div>
          )}
          <footer>
            <span>
              Page {page} · {list.total} matching targets
            </span>
            <div>
              <button
                className="quiet"
                disabled={page === 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </button>
              <button
                className="quiet"
                disabled={page * 20 >= list.total}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </footer>
        </section>
        <div className="lower-grid">
          <section className="panel" id="incidents">
            <div className="panel-heading">
              <h2>
                Active incidents{" "}
                <span className="count">{incidents.length}</span>
              </h2>
            </div>
            {incidents.length ? (
              incidents.map((i) => (
                <div className="incident" key={i.id}>
                  <span className="badge failing">{i.kind}</span>
                  <div>
                    <strong>{i.name}</strong>
                    <small>Opened {date(i.opened_at)}</small>
                  </div>
                  <button
                    className="quiet"
                    disabled={!!i.acknowledged_at || saving}
                    onClick={() =>
                      mutate(`/api/incidents/${i.id}/acknowledge`, "POST", {})
                    }
                  >
                    {i.acknowledged_at ? "Acknowledged" : "Acknowledge"}
                  </button>
                </div>
              ))
            ) : (
              <div className="empty">
                <span className="clear-icon">✓</span>
                <strong>No active incidents</strong>
                <p>Confirmed failures will appear here.</p>
              </div>
            )}
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h2>Worker & delivery</h2>
            </div>
            <dl>
              <div>
                <dt>Checks in last minute</dt>
                <dd>{ops?.metrics.probes_last_minute ?? "—"}</dd>
              </div>
              <div>
                <dt>Failures in last minute</dt>
                <dd>{ops?.metrics.failures_last_minute ?? "—"}</dd>
              </div>
              <div>
                <dt>Oldest schedule lag</dt>
                <dd>
                  {ops
                    ? `${Math.round(ops.metrics.oldest_schedule_lag_ms ?? 0)} ms`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>Pending notifications</dt>
                <dd>{ops?.metrics.delivery_backlog ?? "—"}</dd>
              </div>
            </dl>
            {ops?.deliveries
              .filter((d) => d.last_error)
              .map((d) => (
                <div className="notice" key={d.id}>
                  {d.status} delivery · {d.attempts}/5 attempts · {d.last_error}
                </div>
              ))}
          </section>
        </div>
        {selected && (
          <section className="panel detail" aria-label="Target details">
            <div className="panel-heading">
              <h2>{detail?.target.name || "Loading target…"}</h2>
              <button
                className="quiet"
                onClick={() => {
                  setSelected(null);
                  setDetail(null);
                }}
              >
                Close details
              </button>
            </div>
            {detail && (
              <>
                <div className="detail-meta">
                  <span className={`badge ${detail.target.state}`}>
                    {detail.target.state}
                  </span>
                  <span>{detail.target.host}</span>
                  <span>
                    Interval {detail.target.interval_ms} ms · timeout{" "}
                    {detail.target.timeout_ms} ms
                  </span>
                </div>
                <h3>Recent latency · milliseconds</h3>
                <p className="muted">
                  24-hour window · page {historyPage}, up to 50 results. Gaps
                  mark failures or more than 3 intervals without a result.
                </p>
                <Suspense
                  fallback={<p role="status">Loading latency chart…</p>}
                >
                  <LatencyChart
                    results={detail.results}
                    intervalMs={detail.target.interval_ms}
                  />
                </Suspense>
                <div
                  className="table-wrap"
                  tabIndex={0}
                  aria-label="Scrollable results table"
                >
                  <table>
                    <thead>
                      <tr>
                        <th>Completed</th>
                        <th>Outcome</th>
                        <th>Latency</th>
                        <th>Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.results.map((r) => (
                        <tr key={r.run_id}>
                          <td>{date(r.completed_at)}</td>
                          <td>{r.outcome}</td>
                          <td>
                            {r.latency_ms === null
                              ? "—"
                              : `${r.latency_ms.toFixed(1)} ms`}
                          </td>
                          <td>{r.error_code || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <footer>
                  <button
                    className="quiet"
                    disabled={historyPage === 1}
                    onClick={() => setHistoryPage((p) => p - 1)}
                  >
                    Newer checks
                  </button>
                  <button
                    className="quiet"
                    disabled={detail.results.length < 50}
                    onClick={() => setHistoryPage((p) => p + 1)}
                  >
                    Older checks
                  </button>
                </footer>
                <h3>Incident history · latest 50</h3>
                {detail.incidents.length ? (
                  detail.incidents.map((i) => (
                    <p key={i.id}>
                      Opened {date(i.opened_at)} ·{" "}
                      {i.recovered_at
                        ? `Recovered ${date(i.recovered_at)}`
                        : "Still open"}
                      {i.acknowledged_at ? " · Acknowledged" : ""}
                    </p>
                  ))
                ) : (
                  <p className="muted">No incidents recorded.</p>
                )}
                <h3>Alert rules</h3>
                {detail.rules.map((r) => (
                  <p key={r.id}>
                    {r.kind}: {r.failure_threshold} consecutive breaches /{" "}
                    {r.recovery_threshold} successes to recover
                    {r.kind === "latency"
                      ? ` · ${r.window_samples} successful samples, average > ${r.latency_threshold_ms} ms`
                      : ""}{" "}
                    · reopen cooldown {r.cooldown_ms} ms
                  </p>
                ))}
                <p className="muted">
                  Rules can be configured through the documented API.
                </p>
              </>
            )}
          </section>
        )}
        <p className="footnote">
          NetMon · Unknown means no result. Stale means no recent check.
          Synthetic targets are labeled demo.
        </p>
      </main>
      {form && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="form-title"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !saving) setForm(null);
              if (e.key === "Tab") {
                const fields = [
                  ...e.currentTarget.querySelectorAll(
                    "button:not(:disabled),input,select",
                  ),
                ];
                const first = fields[0],
                  last = fields.at(-1);
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first.focus();
                }
              }
            }}
          >
            <h2 id="form-title">{editing ? "Edit target" : "Add target"}</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                mutate(
                  editing ? `/api/targets/${editing}` : "/api/targets",
                  editing ? "PUT" : "POST",
                  {
                    ...form,
                    tags: tagsInput
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  },
                );
              }}
            >
              <label>
                Name
                <input
                  autoFocus
                  required
                  maxLength={100}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label>
                Probe type
                <select
                  value={form.probe_type}
                  onChange={(e) =>
                    setForm({ ...form, probe_type: e.target.value })
                  }
                >
                  <option value="http">HTTP / HTTPS</option>
                  <option value="tcp">TCP connection</option>
                </select>
              </label>
              <label>
                {form.probe_type === "http"
                  ? "URL (no credentials or query string)"
                  : "Hostname or IP"}
                <input
                  required
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                />
              </label>
              {form.probe_type === "tcp" && (
                <label>
                  Port
                  <input
                    type="number"
                    min="1"
                    max="65535"
                    value={form.port}
                    onChange={(e) =>
                      setForm({ ...form, port: Number(e.target.value) })
                    }
                  />
                </label>
              )}
              <div className="form-grid">
                {[
                  ["Interval (ms)", "interval_ms", 1000, 86400000],
                  ["Timeout (ms)", "timeout_ms", 100, 30000],
                  ...(form.probe_type === "http"
                    ? [
                        ["Expected HTTP status", "expected_status", 100, 599],
                        ["Maximum response bytes", "max_bytes", 1, 1048576],
                      ]
                    : []),
                ].map(([label, key, min, max]) => (
                  <label key={key}>
                    {label}
                    <input
                      type="number"
                      required
                      min={min}
                      max={max}
                      value={form[key]}
                      onChange={(e) =>
                        setForm({ ...form, [key]: Number(e.target.value) })
                      }
                    />
                  </label>
                ))}
              </div>
              <label>
                Tags (comma separated)
                <input
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) =>
                    setForm({ ...form, enabled: e.target.checked })
                  }
                />{" "}
                Monitoring enabled
              </label>
              <p className="muted">
                Destination must be allowed by the operator. Saving resets
                current status; history is retained.
              </p>
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              <div className="modal-actions">
                {editing && (
                  <button
                    type="button"
                    className="danger"
                    disabled={saving}
                    onClick={() => {
                      if (
                        window.confirm(
                          "Archive this target? Monitoring stops; history is retained.",
                        )
                      ) {
                        mutate(`/api/targets/${editing}`, "DELETE");
                        if (selected === editing) {
                          setSelected(null);
                          setDetail(null);
                        }
                      }
                    }}
                  >
                    Archive
                  </button>
                )}
                <button
                  type="button"
                  className="quiet"
                  disabled={saving}
                  onClick={() => setForm(null)}
                >
                  Cancel
                </button>
                <button disabled={saving}>
                  {saving ? "Saving…" : "Save target"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
