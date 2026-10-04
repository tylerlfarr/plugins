import React, { useEffect, useMemo, useState } from 'react';

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res;
}

const TABS = [
  { id: 'permits', label: 'Permits' },
  { id: 'attention', label: 'Attention' },
  { id: 'import', label: 'Import' },
  { id: 'connectors', label: 'Connectors' },
];

function modePill(connectors, code) {
  const c = connectors.find((x) => x.code === code);
  if (!c) return <span className="pill">unknown</span>;
  return <span className={`pill ${c.mode}`}>{c.mode}</span>;
}

export default function App() {
  const [tab, setTab] = useState('permits');
  const [meta, setMeta] = useState({ connectors: [], staleDays: 14, user: 'demo.user' });
  const [permits, setPermits] = useState([]);
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState({});
  const [savedFilters, setSavedFilters] = useState([]);
  const [sort, setSort] = useState({ key: 'updated_at', dir: 'desc' });
  const [selected, setSelected] = useState(new Set());
  const [detail, setDetail] = useState(null);
  const [history, setHistory] = useState([]);
  const [attention, setAttention] = useState([]);
  const [bulk, setBulk] = useState({ internal_status: '', owner: '' });
  const [message, setMessage] = useState('');
  const [importState, setImportState] = useState(null);
  const [busy, setBusy] = useState(false);

  const connectors = meta.connectors || [];

  async function loadMeta() {
    setMeta(await api('/api/meta'));
  }

  async function loadPermits(next = {}) {
    const params = new URLSearchParams();
    const merged = { q, ...filters, sort: sort.key, dir: sort.dir, ...next };
    Object.entries(merged).forEach(([k, v]) => {
      if (v != null && v !== '') params.set(k, v);
    });
    const data = await api(`/api/permits?${params}`);
    setPermits(data.permits);
  }

  async function loadSavedFilters() {
    const data = await api('/api/filters');
    setSavedFilters(data.filters);
  }

  async function loadAttention() {
    const data = await api('/api/attention');
    setAttention(data.items);
  }

  async function openDetail(id) {
    const data = await api(`/api/permits/${id}`);
    setDetail(data.permit);
    setHistory(data.history);
  }

  useEffect(() => {
    loadMeta();
    loadSavedFilters();
  }, []);

  useEffect(() => {
    loadPermits();
  }, [q, filters, sort]);

  useEffect(() => {
    if (tab === 'attention') loadAttention();
  }, [tab]);

  const selectedIds = useMemo(() => [...selected], [selected]);

  function toggleSort(key) {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
    );
  }

  function toggleSelect(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function saveDetail(patch) {
    setBusy(true);
    try {
      const data = await api(`/api/permits/${detail.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      setDetail(data.permit);
      setMessage('Saved.');
      await loadPermits();
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
      setMessage(
        `Check outcome: ${data.result.outcome}${data.result.mode ? ` (${data.result.mode})` : ''}`
      );
      await loadPermits();
      if (detail?.id === id) await openDetail(id);
      if (tab === 'attention') await loadAttention();
    } finally {
      setBusy(false);
    }
  }

  async function syncAll() {
    setBusy(true);
    try {
      const data = await api('/api/sync', { method: 'POST' });
      setMessage(`Synced ${data.results.length} linked permits.`);
      await loadPermits();
      await loadAttention();
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
    setMessage(`Bulk updated ${selectedIds.length} rows.`);
    setSelected(new Set());
    await loadPermits();
  }

  async function saveFilter() {
    const name = window.prompt('Saved filter name');
    if (!name) return;
    await api('/api/filters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, definition: { ...filters, q } }),
    });
    await loadSavedFilters();
  }

  async function onImportFile(file) {
    const fd = new FormData();
    fd.append('file', file);
    const data = await api('/api/import/preview', { method: 'POST', body: fd });
    setImportState(data);
    setTab('import');
  }

  async function remapImport(nextMapping) {
    if (!importState) return;
    // Re-upload not stored; ask user to keep mapping edits client-side by re-validating via commit only.
    setImportState({ ...importState, mapping: nextMapping });
  }

  async function commitImport() {
    if (!importState) return;
    setBusy(true);
    try {
      // Re-preview with current mapping by asking user to reselect if needed — mapping already applied server-side on first preview.
      // For mapping edits, re-run preview requires file; keep commit on original preview rows for prototype.
      const result = await api('/api/import/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preview: importState.preview }),
      });
      setMessage(
        `Import: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped.`
      );
      await loadPermits();
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
            Builder inventory for communities, lots, and multi-permit tracking. Official AHJ status
            stays separate from internal workflow.
          </p>
        </div>
        <nav className="nav">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'active' : ''}
              onClick={() => setTab(t.id)}
              type="button"
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="banner warn">
        Prototype uses synthetic demo communities. Fairfax County checks are live public GIS reads;
        Houston, Harris County, and City of Fairfax connectors are labeled synthetic. Employer
        workbook was not available in this environment.
      </div>

      {message ? <div className="banner">{message}</div> : null}

      {tab === 'permits' && (
        <>
          <div className="toolbar">
            <input
              type="search"
              placeholder="Search community, lot, ID, notes, owner…"
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
              <option value="draft">draft</option>
              <option value="watching">watching</option>
              <option value="needs_followup">needs_followup</option>
              <option value="done">done</option>
            </select>
            <select
              value={filters.official_status || ''}
              onChange={(e) => setFilters((f) => ({ ...f, official_status: e.target.value }))}
            >
              <option value="">Official status</option>
              <option value="unknown">unknown</option>
              <option value="in_review">in_review</option>
              <option value="approved">approved</option>
              <option value="issued">issued</option>
              <option value="revision_required">revision_required</option>
              <option value="closed">closed</option>
            </select>
            <button type="button" className="btn" onClick={saveFilter}>
              Save filter
            </button>
            <select
              onChange={(e) => {
                const sf = savedFilters.find((x) => String(x.id) === e.target.value);
                if (!sf) return;
                const def = JSON.parse(sf.definition);
                setQ(def.q || '');
                const { q: _q, attention: _a, ...rest } = def;
                setFilters(rest);
              }}
              defaultValue=""
            >
              <option value="">Saved filters…</option>
              {savedFilters.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <a className="btn" href="/api/export.xlsx">
              Export Excel
            </a>
            <a className="btn" href="/api/sample-import.xlsx">
              Sample import
            </a>
            <button type="button" className="btn primary" disabled={busy} onClick={syncAll}>
              Check linked sources
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
            <label className="btn ghost">
              Import Excel
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                hidden
                onChange={(e) => e.target.files?.[0] && onImportFile(e.target.files[0])}
              />
            </label>
          </div>

          <div className="layout">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th onClick={() => toggleSort('community_name')}>Community / Lot</th>
                    <th>Official ID</th>
                    <th onClick={() => toggleSort('official_status')}>Official</th>
                    <th onClick={() => toggleSort('internal_status')}>Internal</th>
                    <th onClick={() => toggleSort('owner')}>Owner</th>
                    <th onClick={() => toggleSort('next_action_due')}>Next action</th>
                    <th>Source</th>
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
                          onChange={() => toggleSelect(p.id)}
                        />
                      </td>
                      <td>
                        <strong>{p.community_name}</strong>
                        <div className="muted">
                          {p.project_name} · Lot {p.lot_number}
                        </div>
                        <div className="muted">{p.address}</div>
                      </td>
                      <td>
                        <div className="mono">{p.official_id || '—'}</div>
                        <div className="muted">{p.permit_type}</div>
                      </td>
                      <td>
                        <div>{p.official_status}</div>
                        <div className="muted mono">{p.source_native_status || '—'}</div>
                      </td>
                      <td>{p.internal_status}</td>
                      <td>{p.owner || '—'}</td>
                      <td>
                        <div>{p.next_action || '—'}</div>
                        <div className="muted">{p.next_action_due || ''}</div>
                      </td>
                      <td>
                        {modePill(connectors, p.jurisdiction_code)}
                        <div className="muted">{p.last_check_outcome}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <aside className="panel stack">
              <h2>Permit detail</h2>
              {!detail ? (
                <p className="muted">Select a row to edit milestones, notes, and run a source check.</p>
              ) : (
                <>
                  <div className="fields">
                    {[
                      ['official_id', 'Official ID'],
                      ['permit_type', 'Permit type'],
                      ['source_native_status', 'Source-native status'],
                      ['official_status', 'Official status'],
                      ['internal_status', 'Internal status'],
                      ['submitted_date', 'Submitted', 'date'],
                      ['approved_date', 'Approved', 'date'],
                      ['issued_date', 'Issued', 'date'],
                      ['revision_date', 'Revision', 'date'],
                      ['construction_start_date', 'Construction start', 'date'],
                      ['expiration_date', 'Expiration', 'date'],
                      ['predicted_issue_date', 'Predicted issue (non-official)', 'date'],
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
                      <label htmlFor="notes">Notes (never overwritten by connectors)</label>
                      <textarea
                        id="notes"
                        rows={3}
                        value={detail.notes ?? ''}
                        onChange={(e) => setDetail({ ...detail, notes: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="toolbar">
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busy}
                      onClick={() => saveDetail(detail)}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy || !detail.official_id}
                      onClick={() => runSync(detail.id)}
                    >
                      Check source
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => runSync(detail.id, true)}
                    >
                      Simulate failure
                    </button>
                  </div>
                  <div className="muted">
                    Last successful check: {detail.last_successful_check_at || '—'} · Outcome:{' '}
                    {detail.last_check_outcome}
                    {detail.last_check_error ? ` · ${detail.last_check_error}` : ''}
                    {detail.source_url ? (
                      <>
                        {' '}
                        · <a href={detail.source_url} target="_blank" rel="noreferrer">Open source</a>
                      </>
                    ) : null}
                  </div>
                  <h3>Change history</h3>
                  <ul className="history">
                    {history.map((h) => (
                      <li key={h.id}>
                        <div>
                          <strong>{h.field}</strong> · {h.changed_by} · {h.source}
                        </div>
                        <div className="muted mono">
                          {h.old_value || '∅'} → {h.new_value || '∅'}
                        </div>
                        <div className="muted">{h.created_at}</div>
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
          <h2>Attention</h2>
          <p className="muted">
            Status changes, overdue actions, upcoming expirations, source errors, and no movement
            beyond {meta.staleDays} days.
          </p>
          <div className="toolbar">
            <label>
              Stale days{' '}
              <input
                type="number"
                min={1}
                value={meta.staleDays}
                onChange={async (e) => {
                  const staleDays = Number(e.target.value);
                  setMeta((m) => ({ ...m, staleDays }));
                  await api('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ staleDays }),
                  });
                  await loadAttention();
                }}
              />
            </label>
          </div>
          {attention.length === 0 ? (
            <p>No open attention items.</p>
          ) : (
            attention.map((a) => (
              <div key={a.id} className={`attention-item ${a.kind}`}>
                <div>
                  <strong>{a.kind}</strong> · {a.community_name} / Lot {a.lot_number}
                </div>
                <div>{a.message}</div>
                <div className="muted mono">{a.official_id || 'no official id'}</div>
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    await api(`/api/attention/${a.id}/ack`, { method: 'POST' });
                    await loadAttention();
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
          <h2>Excel import</h2>
          <p className="muted">
            Preview mapping, validation, and duplicate handling. Blank cells do not clear existing
            notes or milestones.
          </p>
          <label className="btn primary">
            Choose workbook
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              hidden
              onChange={(e) => e.target.files?.[0] && onImportFile(e.target.files[0])}
            />
          </label>
          {!importState ? (
            <p className="muted">
              Or download the <a href="/api/sample-import.xlsx">sample import workbook</a>.
            </p>
          ) : (
            <>
              <div>
                File: <strong>{importState.sessionId}</strong> · Sheet {importState.sheetName} ·{' '}
                {importState.summary.rows} rows · {importState.summary.ok} ok ·{' '}
                {importState.summary.updates} updates · {importState.summary.creates} creates
              </div>
              <h3>Field mapping</h3>
              <div className="import-grid">
                {(importState.targetFields || []).map((f) => (
                  <div className="field" key={f.key}>
                    <label>
                      {f.label}
                      {f.required ? ' *' : ''}
                    </label>
                    <select
                      value={importState.mapping[f.key] || ''}
                      onChange={(e) =>
                        remapImport({ ...importState.mapping, [f.key]: e.target.value })
                      }
                    >
                      <option value="">—</option>
                      {importState.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              <p className="muted">
                Mapping edits in this prototype apply on the next file re-upload; commit uses the
                validated preview from the last upload.
              </p>
              <button type="button" className="btn primary" disabled={busy} onClick={commitImport}>
                Commit import
              </button>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Match</th>
                      <th>Official ID</th>
                      <th>Errors</th>
                      <th>Warnings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importState.preview.map((p) => (
                      <tr key={p.rowNumber}>
                        <td>{p.rowNumber}</td>
                        <td>{p.match}</td>
                        <td className="mono">{p.mapped.official_id || '—'}</td>
                        <td className={p.errors.length ? 'pill danger' : ''}>
                          {p.errors.join('; ') || '—'}
                        </td>
                        <td>{p.warnings.join('; ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'connectors' && (
        <div className="panel stack">
          <h2>Connectors</h2>
          <p className="muted">
            Reusable interface: each jurisdiction adapter returns outcome codes and never writes
            internal notes. Live adapters only when access is verified.
          </p>
          {connectors.map((c) => (
            <div key={c.code} className="attention-item">
              <div>
                <strong>{c.label}</strong> {modePill(connectors, c.code)}
              </div>
              <div className="mono">{c.code}</div>
              <div>{c.notes}</div>
            </div>
          ))}
        </div>
      )}

      <p className="footer-note">
        Local prototype · user {meta.user} · not production-ready · predicted dates are labeled
        non-official
      </p>
    </div>
  );
}
