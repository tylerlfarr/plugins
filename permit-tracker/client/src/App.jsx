import React, { useEffect, useMemo, useState } from 'react';

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res;
}

const TABS = [
  { id: 'permits', label: 'Permits' },
  { id: 'attention', label: 'Attention' },
  { id: 'import', label: 'Import' },
  { id: 'sources', label: 'Sources' },
  { id: 'connectors', label: 'Connectors' },
];

export default function App() {
  const [tab, setTab] = useState('permits');
  const [meta, setMeta] = useState({ connectors: [], staleDays: 14, fairfaxFieldAvailability: {} });
  const [stats, setStats] = useState(null);
  const [permits, setPermits] = useState([]);
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState({});
  const [savedFilters, setSavedFilters] = useState([]);
  const [sort, setSort] = useState({ key: 'updated_at', dir: 'desc' });
  const [selected, setSelected] = useState(new Set());
  const [detail, setDetail] = useState(null);
  const [milestones, setMilestones] = useState([]);
  const [officialIds, setOfficialIds] = useState([]);
  const [history, setHistory] = useState([]);
  const [readiness, setReadiness] = useState(null);
  const [attention, setAttention] = useState([]);
  const [bulk, setBulk] = useState({ internal_status: '', owner: '' });
  const [message, setMessage] = useState('');
  const [importPreview, setImportPreview] = useState(null);
  const [schedule, setSchedule] = useState(null);
  const [conflicts, setConflicts] = useState([]);
  const [sources, setSources] = useState([]);
  const [connectForm, setConnectForm] = useState({
    state: 'VA',
    county: '',
    city: '',
    record_type: 'building',
    portal_url: '',
  });
  const [connectResult, setConnectResult] = useState(null);
  const [discoverUrl, setDiscoverUrl] = useState('');
  const [discoverResult, setDiscoverResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const connectors = meta.connectors || [];

  async function refreshLists() {
    const params = new URLSearchParams({ q, sort: sort.key, dir: sort.dir, ...filters });
    Object.keys([...params.keys()]).forEach(() => {});
    // drop empties
    for (const [k, v] of [...params.entries()]) if (!v) params.delete(k);
    const [p, s, f] = await Promise.all([
      api(`/api/permits?${params}`),
      api('/api/stats'),
      api('/api/filters'),
    ]);
    setPermits(p.permits);
    setStats(s);
    setSavedFilters(f.filters);
  }

  async function openDetail(id) {
    const data = await api(`/api/permits/${id}`);
    setDetail(data.permit);
    setMilestones(data.milestones);
    setOfficialIds(data.officialIds);
    setHistory(data.history);
    setReadiness(data.readiness || null);
  }

  function readinessClass(state) {
    if (state === 'ready') return 'live';
    if (state === 'blocked') return 'danger';
    if (state === 'needs_verification') return 'warn';
    return '';
  }

  function readinessLabel(state) {
    if (state === 'ready') return 'Ready';
    if (state === 'blocked') return 'Blocked';
    if (state === 'needs_verification') return 'Needs verification';
    return state || '—';
  }

  useEffect(() => {
    api('/api/meta').then(setMeta);
  }, []);

  useEffect(() => {
    refreshLists().catch((e) => setMessage(String(e.message || e)));
  }, [q, filters, sort]);

  useEffect(() => {
    if (tab === 'attention') {
      Promise.all([api('/api/attention'), api('/api/schedule/preview'), api('/api/conflicts')]).then(
        ([a, s, c]) => {
          setAttention(a.items);
          setSchedule(s);
          setConflicts(c.conflicts);
        }
      );
    }
    if (tab === 'sources') {
      api('/api/sources').then((d) => setSources(d.sources || []));
    }
  }, [tab]);

  async function runConnectLocation() {
    setBusy(true);
    try {
      const data = await api('/api/connect-location', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(connectForm),
      });
      setConnectResult(data);
      setMessage(data.message || data.status);
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function runDiscover() {
    if (!discoverUrl) return;
    setBusy(true);
    try {
      const data = await api('/api/discover/arcgis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: discoverUrl }),
      });
      setDiscoverResult(data.result);
      setMessage(`Discovery: ${data.result.state}`);
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function activateSourceKey(key) {
    setBusy(true);
    try {
      await api(`/api/sources/${key}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewedBy: 'ui.reviewer' }),
      });
      setSources((await api('/api/sources')).sources);
      setMessage(`Activated ${key} after review`);
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  const selectedIds = useMemo(() => [...selected], [selected]);

  function toggleSort(key) {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
    );
  }

  async function saveDetail() {
    setBusy(true);
    try {
      await api(`/api/permits/${detail.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(detail),
      });
      setMessage('Saved.');
      await refreshLists();
      await openDetail(detail.id);
    } finally {
      setBusy(false);
    }
  }

  async function runSync(id, forceFail = false) {
    setBusy(true);
    try {
      const data = await api(`/api/sync/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceFail }),
      });
      setMessage(`Check: ${data.result.outcome}${data.result.mode ? ` (${data.result.mode})` : ''}`);
      await refreshLists();
      if (detail?.id === id) await openDetail(id);
    } finally {
      setBusy(false);
    }
  }

  async function syncFairfaxShaped() {
    setBusy(true);
    try {
      const data = await api('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fairfaxOnly: true }),
      });
      setMessage(
        `Fairfax sync finished: ${data.counts?.total ?? data.results?.length ?? 0} checks` +
          (data.counts ? ` (updated ${data.counts.updated}, no_change ${data.counts.no_change})` : '')
      );
      await refreshLists();
      if (tab === 'attention') {
        setAttention((await api('/api/attention')).items);
        setSchedule(await api('/api/schedule/preview'));
      }
    } finally {
      setBusy(false);
    }
  }

  async function applyBulk() {
    if (!selectedIds.length) return;
    const patch = {};
    if (bulk.internal_status) patch.internal_status = bulk.internal_status;
    if (bulk.owner) patch.owner = bulk.owner;
    if (!Object.keys(patch).length) return;
    await api('/api/permits/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selectedIds, patch }),
    });
    setSelected(new Set());
    setMessage(`Bulk updated ${selectedIds.length}.`);
    await refreshLists();
  }

  async function importStoreWorkbook() {
    setBusy(true);
    try {
      const data = await api('/api/import/workbook/store', { method: 'POST' });
      setMessage(
        `Source workbook import: ${data.summary.permits_created} created, ${data.summary.permits_updated} updated, ${data.summary.sections} sections, ${data.summary.official_ids} IDs` +
          (data.summary.conflicts ? `, ${data.summary.conflicts} conflicts` : '')
      );
      await refreshLists();
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function previewFile(file) {
    const fd = new FormData();
    fd.append('file', file);
    const data = await api('/api/import/workbook/preview', { method: 'POST', body: fd });
    setImportPreview(data);
    setTab('import');
  }

  async function commitFile(file) {
    const fd = new FormData();
    fd.append('file', file);
    setBusy(true);
    try {
      const data = await api('/api/import/workbook/commit', { method: 'POST', body: fd });
      setMessage(`Committed: ${JSON.stringify(data.summary)}`);
      await refreshLists();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>Permit Ledger</h1>
          <p>
            Workbook-native checks for communities/lots — preserve the spreadsheet workflow, show
            what changed before the morning meeting.
          </p>
        </div>
        <nav className="nav" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? 'active' : ''}
              onClick={() => {
                setTab(t.id);
                setMessage('');
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="banner warn">
        Fairfax County = live GIS reads (issued-heavy; no pending/comments/holds/inspections).
        Loudoun + Prince William + other AHJs = unsupported (unavailable — no live→synthetic
        fallback). Source workbook import is section-aware; fixtures stay isolated from imports.
      </div>
      {stats ? (
        <div className="banner">
          {stats.sections} sections · {stats.lotGroups} lot groups · {stats.permits} permits ·{' '}
          {stats.withIds} with IDs · {stats.officialIds} extracted IDs · {stats.attention} attention
          {stats.readiness
            ? ` · Ready ${stats.readiness.ready} / Blocked ${stats.readiness.blocked} / Needs verification ${stats.readiness.needs_verification}`
            : ''}
        </div>
      ) : null}
      {message ? <div className="banner">{message}</div> : null}

      {tab === 'permits' && (
        <>
          <div className="toolbar">
            <input
              type="search"
              placeholder="Search community, lot, housetype, ID, notes…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <select
              value={filters.jurisdiction_code || ''}
              onChange={(e) => setFilters((f) => ({ ...f, jurisdiction_code: e.target.value }))}
            >
              <option value="">All jurisdictions</option>
              {connectors.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
            <select
              value={filters.internal_status || ''}
              onChange={(e) => setFilters((f) => ({ ...f, internal_status: e.target.value }))}
            >
              <option value="">Internal status</option>
              <option value="watching">watching</option>
              <option value="needs_followup">needs_followup</option>
              <option value="done">done</option>
            </select>
            <select
              value={filters.readiness_state || ''}
              onChange={(e) => setFilters((f) => ({ ...f, readiness_state: e.target.value }))}
            >
              <option value="">Lot readiness</option>
              <option value="ready">Ready</option>
              <option value="blocked">Blocked</option>
              <option value="needs_verification">Needs verification</option>
            </select>
            <label className="muted">
              <input
                type="checkbox"
                checked={filters.approaching_start === 'true'}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    approaching_start: e.target.checked ? 'true' : '',
                  }))
                }
              />{' '}
              Approaching start
            </label>
            <label className="muted">
              <input
                type="checkbox"
                checked={filters.has_official_id === 'true'}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    has_official_id: e.target.checked ? 'true' : '',
                  }))
                }
              />{' '}
              Has official ID
            </label>
            <label className="muted">
              <input
                type="checkbox"
                checked={filters.fairfax_shaped === 'true'}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    fairfax_shaped: e.target.checked ? 'true' : '',
                  }))
                }
              />{' '}
              Fairfax-shaped
            </label>
            <select
              defaultValue=""
              onChange={(e) => {
                const sf = savedFilters.find((x) => String(x.id) === e.target.value);
                if (!sf) return;
                const def = JSON.parse(sf.definition);
                setQ(def.q || '');
                const { q: _q, ...rest } = def;
                setFilters(
                  Object.fromEntries(
                    Object.entries(rest).map(([k, v]) => [k, v === true ? 'true' : v || ''])
                  )
                );
              }}
            >
              <option value="">Saved filters…</option>
              {savedFilters.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <a className="btn" href="/api/export.xlsx">
              Structured export
            </a>
            <button type="button" className="btn primary" disabled={busy} onClick={syncFairfaxShaped}>
              Run Fairfax checks
            </button>
          </div>

          <div className="toolbar">
            <span className="muted">{selectedIds.length} selected</span>
            <select
              value={bulk.internal_status}
              onChange={(e) => setBulk((b) => ({ ...b, internal_status: e.target.value }))}
            >
              <option value="">Bulk internal status</option>
              <option value="watching">watching</option>
              <option value="needs_followup">needs_followup</option>
              <option value="done">done</option>
            </select>
            <input
              type="text"
              placeholder="Bulk owner"
              value={bulk.owner}
              onChange={(e) => setBulk((b) => ({ ...b, owner: e.target.value }))}
            />
            <button type="button" className="btn" onClick={applyBulk}>
              Apply bulk
            </button>
          </div>

          <div className="layout">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th onClick={() => toggleSort('community_name')}>Community / Lot</th>
                    <th onClick={() => toggleSort('primary_official_id')}>Official IDs</th>
                    <th onClick={() => toggleSort('official_status')}>Official</th>
                    <th onClick={() => toggleSort('readiness_state')}>Lot readiness</th>
                    <th onClick={() => toggleSort('internal_status')}>Internal</th>
                    <th>Check</th>
                  </tr>
                </thead>
                <tbody>
                  {permits.map((p) => (
                    <tr
                      key={p.id}
                      className={selected.has(p.id) || detail?.id === p.id ? 'selected' : ''}
                      onClick={() => openDetail(p.id)}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.has(p.id)}
                          onChange={() =>
                            setSelected((prev) => {
                              const n = new Set(prev);
                              if (n.has(p.id)) n.delete(p.id);
                              else n.add(p.id);
                              return n;
                            })
                          }
                        />
                      </td>
                      <td>
                        <strong>
                          {p.project_code} · {p.community_name}
                        </strong>
                        <div className="muted">
                          Lot {p.lot_label}
                          {p.housetype ? ` · ${p.housetype}` : ''}
                          {p.target_start
                            ? ` · start ${p.target_start}${
                                p.days_to_start != null ? ` (${p.days_to_start}d)` : ''
                              }`
                            : ''}
                        </div>
                      </td>
                      <td>
                        <div className="mono">{p.primary_official_id || '—'}</div>
                        <span
                          className={`pill ${
                            p.jurisdiction_code === 'fairfax_county' ? 'live' : 'warn'
                          }`}
                        >
                          {p.jurisdiction_code}
                          {p.jurisdiction_confirmed ? '' : ' · unconfirmed'}
                        </span>
                      </td>
                      <td>
                        <div>{p.official_status}</div>
                        <div className="muted mono">{p.source_native_status || '—'}</div>
                      </td>
                      <td>
                        <span className={`pill ${readinessClass(p.readiness_state)}`}>
                          {readinessLabel(p.readiness_state)}
                        </span>
                        <div className="muted">
                          {(p.readiness_summary || '').slice(0, 80)}
                          {(p.readiness_summary || '').length > 80 ? '…' : ''}
                        </div>
                      </td>
                      <td>
                        <div>{p.internal_status}</div>
                        <div className="muted">{p.owner || '—'}</div>
                      </td>
                      <td>
                        <div>{p.last_check_outcome}</div>
                        <div className="muted">{p.last_successful_check_at || ''}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <aside className="panel stack">
              <h2>Permit detail</h2>
              {!detail ? (
                <p className="muted">Select a row.</p>
              ) : (
                <>
                  <div className="fields">
                    {[
                      ['primary_official_id', 'Primary official ID'],
                      ['jurisdiction_code', 'Jurisdiction'],
                      ['source_native_status', 'Source-native status'],
                      ['official_status', 'Official status'],
                      ['internal_status', 'Internal status'],
                      ['owner', 'Owner'],
                      ['next_action', 'Next action'],
                      ['next_action_due', 'Next action due', 'date'],
                      ['source_url', 'Source URL'],
                    ].map(([key, label, type]) => (
                      <div className="field" key={key}>
                        <label htmlFor={key}>{label}</label>
                        <input
                          id={key}
                          type={type || 'text'}
                          value={detail[key] ?? ''}
                          onChange={(e) => setDetail({ ...detail, [key]: e.target.value })}
                        />
                      </div>
                    ))}
                    <div className="field full">
                      <label>Notes (from workbook col S — preserved)</label>
                      <textarea rows={3} readOnly value={detail.notes_raw || ''} />
                    </div>
                  </div>
                  {readiness ? (
                    <>
                      <h3>Lot readiness (configured rules)</h3>
                      <p className="muted">
                        Operational assessment — missing evidence is never Ready. {readiness.assessment_note}
                      </p>
                      <div>
                        <span className={`pill ${readinessClass(readiness.state)}`}>
                          {readiness.state_label || readinessLabel(readiness.state)}
                        </span>
                        {readiness.target_start ? (
                          <span className="muted">
                            {' '}
                            · Target start {readiness.target_start}
                            {readiness.days_to_start != null
                              ? ` (${readiness.days_to_start}d)`
                              : ''}
                          </span>
                        ) : null}
                      </div>
                      <div className="muted">{readiness.summary}</div>
                      {readiness.outstanding?.length ? (
                        <>
                          <strong>Outstanding</strong>
                          <ul className="history">
                            {readiness.outstanding.map((o) => (
                              <li key={`${o.id}-${o.key || o.label}`}>
                                {o.label}: {o.detail || o.status}
                                {o.value ? <span className="mono"> · {o.value}</span> : ''}
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                      {readiness.gaps?.length ? (
                        <>
                          <strong>Needs verification / gaps</strong>
                          <ul className="history">
                            {readiness.gaps.map((g) => (
                              <li key={`${g.id}-${g.key || g.label}`}>
                                {g.label}: {g.detail || g.status}
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                      {readiness.satisfied?.length ? (
                        <>
                          <strong>Satisfied</strong>
                          <ul className="history">
                            {readiness.satisfied.slice(0, 8).map((s) => (
                              <li key={`${s.id}-${s.key || s.label}`}>
                                {s.label}
                                {s.value ? <span className="mono"> · {s.value}</span> : ''}
                                <span className="muted"> · {s.status}</span>
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                    </>
                  ) : null}
                  <h3>Official IDs extracted</h3>
                  <ul className="history">
                    {officialIds.map((o) => (
                      <li key={o.id}>
                        <span className="mono">{o.official_id}</span> · {o.jurisdiction_guess}{' '}
                        {o.is_primary ? '(primary)' : ''}
                      </li>
                    ))}
                  </ul>
                  <h3>Internal milestones</h3>
                  <ul className="history">
                    {milestones.map((m) => (
                      <li key={m.id}>
                        <strong>{m.label}</strong>
                        <div className="mono">
                          {m.value}{' '}
                          <span className="muted">
                            [{m.value_kind}] {m.key.startsWith('official_') ? '· connector' : '· internal'}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="toolbar">
                    <button type="button" className="btn primary" disabled={busy} onClick={saveDetail}>
                      Save
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy || !detail.primary_official_id}
                      onClick={() => runSync(detail.id)}
                    >
                      Check source
                    </button>
                    <button type="button" className="btn" disabled={busy} onClick={() => runSync(detail.id, true)}>
                      Simulate failure
                    </button>
                  </div>
                  <h3>Change history</h3>
                  <ul className="history">
                    {history.map((h) => (
                      <li key={h.id}>
                        <strong>{h.field}</strong> · {h.changed_by} · {h.source}
                        <div className="muted mono">
                          {h.old_value || '∅'} → {h.new_value || '∅'}
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </aside>
          </div>
        </>
      )}

      {tab === 'attention' && (
        <div className="panel stack">
          <h2>Attention — morning meeting</h2>
          <p className="muted">
            Approaching starts, readiness blockers, needs-verification gaps, revision impact
            (review — not auto-invalidation), official changes, overdue actions, unresolved matching,
            and no-progress (progress_anchor). Successful checks do not reset the progress clock.
          </p>
          {schedule ? (
            <div className="attention-item">
              <strong>Schedule preview (local — not sent)</strong>
              <div className="muted">
                Interval {schedule.config?.interval_minutes}m · retries {schedule.config?.max_retries} ·
                backoff {schedule.config?.backoff_ms}ms · timeout {schedule.config?.timeout_ms}ms
              </div>
              <div>{schedule.digestPreview?.subject}</div>
              <ul className="history">
                {(schedule.digestPreview?.bullets || []).map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
              <div className="muted">{schedule.digestPreview?.note}</div>
            </div>
          ) : null}
          {conflicts.length > 0 ? (
            <div className="attention-item warn">
              <strong>Import conflicts pending: {conflicts.length}</strong>
              <ul className="history">
                {conflicts.slice(0, 8).map((c) => (
                  <li key={c.id}>
                    {c.community_name} / {c.lot_label} · {c.field}: app={c.app_value} vs
                    incoming={c.incoming_value}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {attention.length === 0 ? (
            <p>No open items.</p>
          ) : (
            attention.map((a) => (
              <div key={a.id} className={`attention-item ${a.kind}`}>
                <div>
                  <strong>{a.kind}</strong> · {a.community_name} / {a.lot_label}
                  {a.readiness_state ? ` · ${a.readiness_state}` : ''}
                </div>
                <div>{a.message}</div>
                <div className="muted mono">{a.primary_official_id || '—'}</div>
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    await api(`/api/attention/${a.id}/ack`, { method: 'POST' });
                    setAttention((await api('/api/attention')).items);
                  }}
                >
                  Acknowledge
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'import' && (
        <div className="panel stack">
          <h2>Source workbook import</h2>
          <p className="muted">
            Import profile for this employer workbook (separate from reusable core). Section-aware
            Permit Tracker (24 header blocks), Permit Revisions, Masterfile Plan Tracker, MST
            references. Indirect Cost / 2018 IRC / Corewall / WHSD are archived (not wiped).
          </p>
          <div className="toolbar">
            <button type="button" className="btn primary" disabled={busy} onClick={importStoreWorkbook}>
              Import store source workbook
            </button>
            <label className="btn">
              Preview upload
              <input
                type="file"
                accept=".xlsx"
                hidden
                onChange={(e) => e.target.files?.[0] && previewFile(e.target.files[0])}
              />
            </label>
            <label className="btn">
              Commit upload
              <input
                type="file"
                accept=".xlsx"
                hidden
                onChange={(e) => e.target.files?.[0] && commitFile(e.target.files[0])}
              />
            </label>
          </div>
          {importPreview ? (
            <>
              <div>
                {importPreview.sectionCount} sections · {importPreview.rowCount} lot/permit rows ·{' '}
                {importPreview.revisions} revisions · {importPreview.masterfile} masterfile ·{' '}
                {importPreview.mstIds} MST IDs
                {importPreview.archivedRowCount
                  ? ` · ${importPreview.archivedRowCount} archived rows stored`
                  : ''}
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>Community</th>
                      <th>Jurisdiction</th>
                      <th>Source</th>
                      <th>Header row</th>
                      <th>Cols</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importPreview.sections.map((s) => (
                      <tr key={`${s.project_code}-${s.headerRow}`}>
                        <td className="mono">{s.project_code}</td>
                        <td>{s.community_name}</td>
                        <td>{s.jurisdiction_code}</td>
                        <td className="muted">{s.jurisdiction_source}</td>
                        <td>{s.headerRow}</td>
                        <td>{s.headerCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="muted">
              Upload a workbook to preview sections, or import the store source workbook.
            </p>
          )}
        </div>
      )}

      {tab === 'sources' && (
        <div className="panel stack">
          <h2>Connect a location</h2>
          <p className="muted">
            Choose state + county/city and record type. Verified sources show first; discovery
            candidates need review before activation. Counties do not auto-connect.
          </p>
          <div className="toolbar">
            <input
              placeholder="State"
              value={connectForm.state}
              onChange={(e) => setConnectForm((f) => ({ ...f, state: e.target.value }))}
            />
            <input
              placeholder="County"
              value={connectForm.county}
              onChange={(e) => setConnectForm((f) => ({ ...f, county: e.target.value }))}
            />
            <input
              placeholder="City / town (optional)"
              value={connectForm.city}
              onChange={(e) => setConnectForm((f) => ({ ...f, city: e.target.value }))}
            />
            <select
              value={connectForm.record_type}
              onChange={(e) => setConnectForm((f) => ({ ...f, record_type: e.target.value }))}
            >
              <option value="building">building</option>
              <option value="zoning">zoning</option>
              <option value="planning">planning</option>
              <option value="inspections">inspections</option>
            </select>
          </div>
          <div className="toolbar">
            <input
              style={{ minWidth: '16rem', flex: 1 }}
              placeholder="Optional official ArcGIS / portal URL"
              value={connectForm.portal_url}
              onChange={(e) => setConnectForm((f) => ({ ...f, portal_url: e.target.value }))}
            />
            <button type="button" className="btn primary" disabled={busy} onClick={runConnectLocation}>
              Connect location
            </button>
          </div>
          {connectResult ? (
            <div className={`attention-item ${connectResult.status}`}>
              <strong>{connectResult.status}</strong>
              <div>{connectResult.message}</div>
              <div className="muted">autoConnect={String(connectResult.autoConnect)}</div>
              {(connectResult.namedLimits || []).slice(0, 6).map((l) => (
                <div key={l} className="muted">
                  · {l}
                </div>
              ))}
              <h3>Verified</h3>
              <ul className="history">
                {(connectResult.verifiedSources || []).map((s) => (
                  <li key={s.key}>
                    <span className="mono">{s.key}</span> · {s.state}
                    {s.activated ? ' · activated' : ''}
                    {!s.activated && s.state === 'verified' ? (
                      <>
                        {' '}
                        <button type="button" className="btn" disabled={busy} onClick={() => activateSourceKey(s.key)}>
                          Review & activate
                        </button>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
              <h3>Candidates / unsupported</h3>
              <ul className="history">
                {[...(connectResult.candidates || []), ...(connectResult.unsupportedSources || [])]
                  .slice(0, 12)
                  .map((s) => (
                    <li key={s.key || s.endpoint}>
                      <span className="mono">{s.key || 'discovery'}</span> · {s.state}
                      <div className="muted">{s.coverage_limitations || (s.limitations || []).join('; ')}</div>
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}

          <h2>Source registry</h2>
          <p className="muted">Verified vs speculative kept separate. ArcGIS ≠ automatically supported.</p>
          {sources.map((s) => (
            <div key={s.key} className="attention-item">
              <div>
                <strong>{s.key}</strong>{' '}
                <span className={`pill ${s.state === 'verified' ? 'live' : 'warn'}`}>{s.state}</span>
                {s.activated ? <span className="pill live">activated</span> : null}
              </div>
              <div className="mono">
                {s.jurisdiction_code} · {s.platform} · {s.adapter_type}
              </div>
              <div>{s.coverage_limitations}</div>
              <div className="muted mono">{s.endpoint}</div>
            </div>
          ))}

          <h2>Inspect ArcGIS URL</h2>
          <div className="toolbar">
            <input
              style={{ minWidth: '16rem', flex: 1 }}
              placeholder="FeatureServer or MapServer layer URL"
              value={discoverUrl}
              onChange={(e) => setDiscoverUrl(e.target.value)}
            />
            <button type="button" className="btn" disabled={busy} onClick={runDiscover}>
              Inspect
            </button>
          </div>
          {discoverResult ? (
            <div className="attention-item">
              <strong>
                {discoverResult.state} · {discoverResult.platform}
              </strong>
              <div className="muted mono">{discoverResult.endpoint}</div>
              <div>Proposed mappings: {JSON.stringify(discoverResult.proposedMappings)}</div>
              <div className="muted">
                {(discoverResult.limitations || []).join(' · ') || 'No limitations noted'}
              </div>
              <div className="muted">{discoverResult.note}</div>
            </div>
          ) : null}
        </div>
      )}

      {tab === 'connectors' && (
        <div className="panel stack">
          <h2>Connectors & Fairfax field availability</h2>
          {connectors.map((c) => (
            <div key={c.code} className="attention-item">
              <div>
                <strong>{c.label}</strong>{' '}
                <span className={`pill ${c.mode}`}>{c.mode}</span>
              </div>
              <div className="mono">{c.code}</div>
              <div>{c.notes}</div>
            </div>
          ))}
          <h3>Fairfax Building Records PLUS fields</h3>
          <ul className="history">
            {Object.entries(meta.fairfaxFieldAvailability || {}).map(([k, v]) => (
              <li key={k}>
                <span className="mono">{k}</span> · <span className={`pill ${v === 'live' ? 'live' : 'warn'}`}>{v}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="footer-note">Workbook-native prototype · not production-ready · never present synthetic as live</p>
    </div>
  );
}
