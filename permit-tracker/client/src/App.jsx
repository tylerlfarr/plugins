import React, { useEffect, useMemo, useRef, useState } from 'react';

async function api(path, options = {}) {
  const headers = {
    'X-Requested-With': 'PermitLedger',
    ...(options.headers || {}),
  };
  const res = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const ct = res.headers.get('content-type') || '';
  const isJson = ct.includes('application/json');
  if (!res.ok) {
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const err = new Error(body?.message || body?.error || text || res.statusText);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  if (isJson) return res.json();
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
  /** Last clean server copy — drafts live in `detail`; never auto-overwrite with server on conflict. */
  const [detailServer, setDetailServer] = useState(null);
  const [detailConflict, setDetailConflict] = useState(null); // { server, draft, reason }
  const [milestones, setMilestones] = useState([]);
  const [officialIds, setOfficialIds] = useState([]);
  const [history, setHistory] = useState([]);
  const [readiness, setReadiness] = useState(null);
  const [properties, setProperties] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [contactJobs, setContactJobs] = useState([]);
  const [tracerfy, setTracerfy] = useState(null);
  const [selectedPropertyId, setSelectedPropertyId] = useState(null);
  const detailRequestSeq = useRef(0);
  const [propertyForm, setPropertyForm] = useState({
    id: null,
    site_address: '',
    city: '',
    state: '',
    zip: '',
    parcel_apn: '',
    parcel_jurisdiction: '',
  });
  const emptyPropertyForm = {
    id: null,
    site_address: '',
    city: '',
    state: '',
    zip: '',
    parcel_apn: '',
    parcel_jurisdiction: '',
  };
  const [manualContact, setManualContact] = useState({
    role: 'property_owner',
    full_name: '',
    company: '',
    phone: '',
    email: '',
    mailing_address: '',
  });
  const [crosswalkPreview, setCrosswalkPreview] = useState(null);
  const [crosswalkMissing, setCrosswalkMissing] = useState([]);
  const [waiverForm, setWaiverForm] = useState({ milestone_key: '', reason: '' });
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
  const [authGate, setAuthGate] = useState(null); // null | { enabled, user }
  const [loginForm, setLoginForm] = useState({ email: '', password: '' });

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

  function applyPropertyToForm(prop) {
    if (!prop) {
      setPropertyForm({ ...emptyPropertyForm });
      setSelectedPropertyId(null);
      return;
    }
    setSelectedPropertyId(prop.id);
    setPropertyForm({
      id: prop.id,
      site_address: prop.site_address || '',
      city: prop.city || '',
      state: prop.state || '',
      zip: prop.zip || '',
      parcel_apn: prop.parcel_apn || '',
      parcel_jurisdiction: prop.parcel_jurisdiction || '',
    });
  }

  async function openDetail(id) {
    const requestId = ++detailRequestSeq.current;
    // Preserve prior selection across reload (demo/contact actions must not wipe it).
    const keepId = selectedPropertyId;
    // Clear record-specific form state immediately to avoid carryover while loading
    setPropertyForm({ ...emptyPropertyForm });
    setSelectedPropertyId(null);
    setContacts([]);
    setContactJobs([]);
    setProperties([]);
    setManualContact({
      role: 'property_owner',
      full_name: '',
      company: '',
      phone: '',
      email: '',
      mailing_address: '',
    });
    const data = await api(`/api/permits/${id}`);
    // Ignore out-of-order responses
    if (requestId !== detailRequestSeq.current) return;
    setDetail(data.permit);
    setDetailServer(data.permit);
    setDetailConflict(null);
    setMilestones(data.milestones);
    setOfficialIds(data.officialIds);
    setHistory(data.history);
    setReadiness(data.readiness || null);
    setProperties(data.properties || []);
    setContacts(data.contacts || []);
    setContactJobs(data.contactJobs || []);
    setTracerfy(data.tracerfy || null);
    const props = data.properties || [];
    const confirmed = props.filter((p) => p.link_state === 'confirmed');
    const kept = keepId ? props.find((p) => p.id === keepId) : null;
    // Prefer prior selection (survives demo/contact actions), else unambiguous defaults.
    if (kept) {
      applyPropertyToForm(kept);
    } else if (confirmed.length === 1) {
      applyPropertyToForm(confirmed[0]);
    } else if (props.length === 1 && confirmed.length === 0) {
      applyPropertyToForm(props[0]);
    } else {
      applyPropertyToForm(null);
    }
  }

  async function saveProperty({ confirm = false } = {}) {
    if (!detail?.lot_group_id) {
      setMessage('Missing lot_group_id on permit — re-open the row.');
      return;
    }
    setBusy(true);
    try {
      const body = {
        ...propertyForm,
        id: propertyForm.id || undefined,
        lot_group_id: detail.lot_group_id,
        permit_record_id: detail.id,
        link_state: confirm ? 'confirmed' : 'candidate',
      };
      const result = await api('/api/properties', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (result.property?.id) setSelectedPropertyId(result.property.id);
      await openDetail(detail.id);
      setMessage(confirm ? 'Property confirmed for lot.' : 'Property saved as candidate.');
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmSelectedProperty(prop) {
    if (!detail || !prop) return;
    setBusy(true);
    try {
      await api(`/api/properties/${prop.id}/confirm-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lot_group_id: detail.lot_group_id,
          permit_record_id: detail.id,
        }),
      });
      applyPropertyToForm(prop);
      await openDetail(detail.id);
      setMessage(`Confirmed property ${prop.site_address || prop.parcel_apn}`);
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  function selectedProperty() {
    if (selectedPropertyId) {
      return properties.find((p) => p.id === selectedPropertyId) || null;
    }
    return null;
  }

  async function findContacts() {
    if (!detail) return;
    const prop = selectedProperty();
    if (!prop) {
      setMessage('Select/confirm the property that will be searched first.');
      return;
    }
    if (prop.link_state !== 'confirmed') {
      setMessage(`Confirm property before Find contacts (current link: ${prop.link_state}).`);
      return;
    }
    setBusy(true);
    try {
      const result = await api('/api/contacts/find', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: prop.id,
          permit_record_id: detail.id,
          endpoint: 'instant_trace',
        }),
      });
      const addr = result.searchedAddress
        ? `${result.searchedAddress.site_address}, ${result.searchedAddress.city} ${result.searchedAddress.state} ${result.searchedAddress.zip}`
        : prop.site_address;
      if (result.error) {
        setMessage(
          `Find contacts failed (${result.provider?.mode || 'unknown'}): ${result.error.error || result.error.detail || JSON.stringify(result.error)} · searched ${addr}`
        );
      } else if (result.isolation) {
        setMessage(
          `Find contacts: ${result.provider?.mode} isolated (${result.isolation}). Searched ${addr}. No attach to operational workbook.`
        );
      } else if (result.deduped) {
        setMessage(
          `Find contacts: reused prior job #${result.job?.id} (${result.contacts?.length || 0} candidates). Searched ${addr}.`
        );
      } else {
        setMessage(
          `Find contacts: ${result.saved?.length || 0} candidates · mode ${result.provider?.mode} · est ${result.estimatedCredits ?? '—'} credits. Searched ${addr}.`
        );
      }
      await openDetail(detail.id);
      await refreshLists();
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function saveManualContact() {
    if (!detail) return;
    setBusy(true);
    try {
      await api('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...manualContact,
          property_id: selectedPropertyId || undefined,
          permit_record_id: detail.id,
          lot_group_id: detail.lot_group_id,
          status: 'confirmed',
          record_origin: 'manual',
        }),
      });
      setMessage('Manual contact saved.');
      setManualContact({
        role: 'property_owner',
        full_name: '',
        company: '',
        phone: '',
        email: '',
        mailing_address: '',
      });
      await openDetail(detail.id);
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function setProviderMode(mode) {
    setBusy(true);
    try {
      const data = await api('/api/contacts/provider-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      setTracerfy(data.tracerfy);
      setMessage(`Provider mode: ${data.tracerfy.mode}`);
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function createInventedDemoProperty() {
    if (!detail) return;
    setBusy(true);
    try {
      const data = await api('/api/properties/demo-sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lot_group_id: detail.lot_group_id,
          permit_record_id: detail.id,
        }),
      });
      setProperties(data.properties || []);
      applyPropertyToForm(data.property);
      setMessage(
        data.note ||
          'Invented sandbox_demo property ready — Find contact information will return labeled demo contacts only.'
      );
      if (tracerfy?.mode !== 'local_fixture' && tracerfy?.mode !== 'hosted_sandbox') {
        try {
          const modeData = await api('/api/contacts/provider-mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'local_fixture' }),
          });
          setTracerfy(modeData.tracerfy);
        } catch {
          /* owner-only mode switch may fail for operators — local_fixture is usually already default */
        }
      }
      await openDetail(detail.id);
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function previewCrosswalkFile(file) {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const data = await api('/api/property-crosswalk/preview', { method: 'POST', body: fd });
      setCrosswalkPreview(
        (data.preview || []).map((r) => ({
          ...r,
          selected: ['matched_stable_key', 'matched_project_lot'].includes(r.match_status),
        }))
      );
      setMessage(`Crosswalk preview: ${data.rowCount} rows`);
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function commitCrosswalkSelected() {
    if (!crosswalkPreview?.length) return;
    setBusy(true);
    try {
      const data = await api('/api/property-crosswalk/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: crosswalkPreview, confirmSelectedOnly: true }),
      });
      setMessage(
        `Crosswalk commit: linked ${data.summary?.linked || 0}, created ${data.summary?.created || 0}, skipped ${data.summary?.skipped || 0}`
      );
      setCrosswalkMissing((await api('/api/property-crosswalk/missing')).rows || []);
      await refreshLists();
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function offerOfficialAddress() {
    if (!detail) return;
    setBusy(true);
    try {
      const data = await api('/api/properties/offer-official-address', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permit_record_id: detail.id }),
      });
      setMessage(
        data.offered
          ? `Official site address offered as candidate: ${data.property?.site_address}`
          : `No official site address: ${data.reason}`
      );
      await openDetail(detail.id);
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function submitWaiver() {
    if (!detail || !waiverForm.milestone_key || !waiverForm.reason) {
      setMessage('Waiver needs milestone key + reason.');
      return;
    }
    setBusy(true);
    try {
      await api(`/api/milestones/${detail.id}/waiver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(waiverForm),
      });
      setMessage(`Waiver recorded for ${waiverForm.milestone_key}`);
      setWaiverForm({ milestone_key: '', reason: '' });
      await openDetail(detail.id);
      await refreshLists();
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function revokeWaiver(key) {
    if (!detail) return;
    await api(`/api/milestones/${detail.id}/waiver/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ milestone_key: key }),
    });
    await openDetail(detail.id);
    await refreshLists();
  }

  async function clearMilestone(m) {
    if (!detail) return;
    setBusy(true);
    try {
      const data = await api(`/api/permits/${detail.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          milestones: [{ key: m.key, clear: true }],
          expected_row_version: detail.row_version ?? 1,
        }),
      });
      setMessage(`Cleared milestone ${m.key} (audited)`);
      if (data.permit) {
        setDetail(data.permit);
        setDetailServer(data.permit);
      }
      await openDetail(detail.id);
    } catch (e) {
      handleStaleSave(e);
    } finally {
      setBusy(false);
    }
  }

  async function setContactStatus(id, status) {
    await api(`/api/contacts/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (detail) await openDetail(detail.id);
  }

  function handleStaleSave(e) {
    if (e.status === 409 || e.body?.error === 'stale_write') {
      const server = e.body?.permit;
      setDetailConflict({
        server,
        draft: detail,
        reason: e.body?.message || 'Server copy changed; draft kept — reload deliberately.',
      });
      setMessage(
        e.body?.message ||
          'Stale save blocked. Your draft was kept; reload server values or keep editing, then save with the new version.'
      );
      return true;
    }
    if (e.body?.error === 'expected_row_version_required') {
      setMessage(e.body?.message || 'Reload the permit detail before saving (version required).');
      return true;
    }
    setMessage(String(e.message || e));
    return false;
  }

  async function saveMilestone(m, value) {
    if (!detail) return;
    setBusy(true);
    try {
      const data = await api(`/api/permits/${detail.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          milestones: [{ key: m.key, label: m.label, value, value_kind: m.value_kind || 'text' }],
          expected_row_version: detail.row_version ?? 1,
        }),
      });
      if (data.permit) {
        setDetail(data.permit);
        setDetailServer(data.permit);
        setDetailConflict(null);
      }
      await openDetail(detail.id);
      await refreshLists();
    } catch (e) {
      handleStaleSave(e);
    } finally {
      setBusy(false);
    }
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
    (async () => {
      try {
        const status = await api('/api/auth/status');
        setAuthGate({ enabled: status.enabled, user: status.user });
        if (!status.enabled || status.user) {
          const m = await api('/api/meta');
          setMeta(m);
          if (m.tracerfy) setTracerfy(m.tracerfy);
        }
      } catch (e) {
        setMessage(String(e.message || e));
      }
    })();
  }, []);

  useEffect(() => {
    // Wait for auth bootstrap; when invite-only, do not hit protected APIs until signed in.
    if (authGate === null) return;
    if (authGate.enabled && !authGate.user) return;
    refreshLists().catch((e) => setMessage(String(e.message || e)));
  }, [q, filters, sort, authGate]);

  useEffect(() => {
    if (authGate === null) return;
    if (authGate?.enabled && !authGate?.user) return;
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
  }, [tab, authGate]);

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
      // Official status fields are read-only — omit them
      const {
        official_status: _os,
        source_native_status: _sns,
        ...rest
      } = detail;
      const data = await api(`/api/permits/${detail.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          primary_official_id: rest.primary_official_id,
          jurisdiction_code: rest.jurisdiction_code,
          internal_status: rest.internal_status,
          owner: rest.owner,
          next_action: rest.next_action,
          next_action_due: rest.next_action_due,
          source_url: rest.source_url,
          permit_kind: rest.permit_kind,
          jurisdiction_confirmed: Boolean(rest.jurisdiction_confirmed),
          expected_row_version: detail.row_version ?? 1,
          expected_updated_at: detail.updated_at,
        }),
      });
      setMessage('Saved.');
      if (data.permit) {
        setDetail(data.permit);
        setDetailServer(data.permit);
        setDetailConflict(null);
      }
      await refreshLists();
      await openDetail(detail.id);
    } catch (e) {
      handleStaleSave(e);
      await refreshLists();
    } finally {
      setBusy(false);
    }
  }

  async function runSync(id) {
    setBusy(true);
    try {
      const data = await api(`/api/sync/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
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
      const total = data.counts?.total ?? data.results?.length ?? 0;
      if (total === 0) {
        setMessage(
          data.diagnostic ||
            'Fairfax sync finished: 0 checks. Import a workbook with Fairfax County official IDs first — this button re-checks saved IDs; it does not discover new permits in the county GIS.'
        );
      } else {
        setMessage(
          `Fairfax sync finished: ${total} checks` +
            (data.counts
              ? ` (updated ${data.counts.updated}, no_change ${data.counts.no_change}, not_found ${data.counts.not_found}, blocked ${data.counts.blocked || 0}, unsupported ${data.counts.unsupported || 0}, unavailable ${data.counts.unavailable}, failed ${data.counts.failed})`
              : '')
        );
      }
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
    if (!selectedIds.length) {
      setMessage('Select one or more permits before applying a bulk update.');
      return;
    }
    const patch = {};
    if (bulk.internal_status) patch.internal_status = bulk.internal_status;
    if (bulk.owner) patch.owner = bulk.owner;
    if (!Object.keys(patch).length) {
      setMessage('Choose a bulk internal status and/or owner before Apply bulk.');
      return;
    }
    const data = await api('/api/permits/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selectedIds, patch }),
    });
    setSelected(new Set());
    setMessage(`Bulk updated ${data.changed ?? selectedIds.length} of ${selectedIds.length}.`);
    await refreshLists();
    // Do not silently replace an unsaved draft. Surface conflict; require deliberate reload.
    if (detail?.id && selectedIds.includes(detail.id)) {
      const serverRow = (data.permits || []).find((p) => p.id === detail.id);
      const dirty =
        detailServer &&
        (detail.internal_status !== detailServer.internal_status ||
          detail.owner !== detailServer.owner ||
          detail.next_action !== detailServer.next_action ||
          detail.jurisdiction_code !== detailServer.jurisdiction_code ||
          Boolean(detail.jurisdiction_confirmed) !== Boolean(detailServer.jurisdiction_confirmed));
      if (dirty && serverRow) {
        setDetailConflict({
          server: serverRow,
          draft: detail,
          reason: 'Bulk update changed this row while you had unsaved edits. Draft kept.',
        });
        setMessage(
          'Bulk updated selection. Open detail has unsaved edits — draft kept. Reload server values or keep editing, then Save.'
        );
      } else {
        await openDetail(detail.id);
      }
    }
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

  if (authGate?.enabled && !authGate?.user) {
    return (
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <h1>Permit Ledger</h1>
            <p>Invite-only pilot — sign in with your issued account.</p>
          </div>
        </header>
        <div className="panel stack" style={{ maxWidth: 420, margin: '2rem auto' }}>
          <h2>Sign in</h2>
          {message ? <div className="banner">{message}</div> : null}
          <div className="field">
            <label htmlFor="login-email">Email</label>
            <input
              id="login-email"
              type="email"
              autoComplete="username"
              value={loginForm.email}
              onChange={(e) => setLoginForm((f) => ({ ...f, email: e.target.value }))}
            />
          </div>
          <div className="field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={loginForm.password}
              onChange={(e) => setLoginForm((f) => ({ ...f, password: e.target.value }))}
            />
          </div>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const data = await api('/api/auth/login', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(loginForm),
                });
                setAuthGate({ enabled: true, user: data.user });
                const m = await api('/api/meta');
                setMeta(m);
                if (m.tracerfy) setTracerfy(m.tracerfy);
                setMessage('');
              } catch (e) {
                setMessage(String(e.message || e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Sign in
          </button>
        </div>
      </div>
    );
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
        {authGate?.user ? (
          <div className="muted" style={{ marginLeft: 'auto', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            <span>{authGate.user.email}</span>
            <button
              type="button"
              className="btn"
              onClick={async () => {
                await api('/api/auth/logout', { method: 'POST' });
                setAuthGate({ enabled: true, user: null });
                setMessage('Signed out');
              }}
            >
              Sign out
            </button>
          </div>
        ) : null}
      </header>

      <div className="banner">
        Operator path: <strong>Import</strong> workbook → <strong>Resolve</strong> missing property /
        jurisdiction inputs → <strong>Check</strong> eligible records (activated source + confirmed
        AHJ) → <strong>Review</strong> Attention / structured export. Owner source setup (activate
        Fairfax PLUS) is separate. Building use ≠ work type.
      </div>
      {detailConflict ? (
        <div className="banner warn" role="alert">
          Conflict: {detailConflict.reason} Server version{' '}
          {detailConflict.server?.row_version ?? '—'} · your draft kept in the form.
          <div className="empty-actions" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn"
              onClick={async () => {
                if (detailConflict.server?.id) await openDetail(detailConflict.server.id);
                else setDetailConflict(null);
              }}
            >
              Reload server values
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                // Keep draft; adopt server row_version only so a subsequent Save can be attempted
                // after deliberate field merge by the operator — do not auto-apply draft onto server.
                if (detailConflict.server && detail) {
                  setDetail({
                    ...detail,
                    row_version: detailConflict.server.row_version,
                    updated_at: detailConflict.server.updated_at,
                  });
                  setDetailServer(detailConflict.server);
                }
                setDetailConflict(null);
                setMessage(
                  'Draft kept with updated version token. Review fields against server before Save — Save will not auto-merge.'
                );
              }}
            >
              Keep editing draft
            </button>
          </div>
        </div>
      ) : null}

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
              placeholder="Filter saved records (community, lot, ID, notes)…"
              title="Filters permits already imported into this app. Does not search Fairfax County GIS for new permits."
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
              value={filters.use_classification || ''}
              onChange={(e) => setFilters((f) => ({ ...f, use_classification: e.target.value }))}
              title="Building use — separate from work type (new/alteration/demolition)"
            >
              <option value="">Use (all)</option>
              <option value="residential">Residential</option>
              <option value="commercial">Commercial</option>
              <option value="mixed_use">Mixed-use</option>
              <option value="unknown">Unknown</option>
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
                checked={filters.missing_property === 'true'}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    missing_property: e.target.checked ? 'true' : '',
                  }))
                }
              />{' '}
              Missing property
            </label>
            <label className="muted">
              <input
                type="checkbox"
                checked={filters.contacts_available === 'true'}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    contacts_available: e.target.checked ? 'true' : '',
                  }))
                }
              />{' '}
              Contacts available
            </label>
            <label className="muted">
              <input
                type="checkbox"
                checked={filters.contact_review_needed === 'true'}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    contact_review_needed: e.target.checked ? 'true' : '',
                  }))
                }
              />{' '}
              Contact review needed
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
            <button
              type="button"
              className="btn"
              disabled={busy}
              title="Save current filters (including building use)"
              onClick={async () => {
                const name = window.prompt('Name this filter set');
                if (!name) return;
                setBusy(true);
                try {
                  const definition = { q, ...filters };
                  await api('/api/filters', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, definition }),
                  });
                  setMessage(`Saved filter “${name}”`);
                  await refreshLists();
                } catch (err) {
                  setMessage(String(err.message || err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save filters
            </button>
            <a
              className="btn"
              href={`/api/export.xlsx?${new URLSearchParams(
                Object.fromEntries(
                  Object.entries({ q, ...filters }).filter(([, v]) => v != null && String(v) !== '')
                )
              )}`}
              title="Filtered-row export: same q + filters as the table (exact ID agreement). Confirmed contacts only."
            >
              Structured export
            </a>
            <a
              className="btn"
              href={`/api/export.xlsx?${new URLSearchParams({
                includeReviewed: '1',
                ...Object.fromEntries(
                  Object.entries({ q, ...filters }).filter(([, v]) => v != null && String(v) !== '')
                ),
              })}`}
              title="Filtered-row export + reviewed contact candidates. Same q/filters as table."
            >
              Export + reviewed
            </a>
            {selectedIds.length ? (
              <a
                className="btn"
                href={`/api/export.xlsx?${new URLSearchParams({
                  selectedIds: selectedIds.join(','),
                  ...Object.fromEntries(
                    Object.entries({ q, ...filters }).filter(([, v]) => v != null && String(v) !== '')
                  ),
                })}`}
                title="Selected-row export: only checked rows (still import-origin). Distinct from filtered-row export."
              >
                Export selected ({selectedIds.length})
              </a>
            ) : null}
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              title="Re-checks imported Fairfax County official IDs against live GIS. Does not discover new permits."
              onClick={syncFairfaxShaped}
            >
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

          {(!stats || stats.permits === 0) && (
            <div className="empty-state" role="status">
              <h2>No permits imported yet</h2>
              <p>
                Permit Ledger tracks workbook rows you import. Searching or filtering the table only
                narrows <strong>saved</strong> records — it does not discover new permits in Fairfax
                County GIS.
              </p>
              <p className="muted">
                <strong>Run Fairfax checks</strong> re-checks official IDs already saved with Fairfax
                County jurisdiction. With zero imports, it correctly reports 0 checks.
              </p>
              <div className="empty-actions">
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => {
                    setMessage('');
                    setTab('import');
                  }}
                >
                  Go to Import
                </button>
              </div>
            </div>
          )}

          <div className="layout">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th onClick={() => toggleSort('community_name')}>Community / Lot</th>
                    <th onClick={() => toggleSort('primary_official_id')}>Official IDs</th>
                    <th onClick={() => toggleSort('official_status')}>Official</th>
                    <th onClick={() => toggleSort('use_classification')}>Use</th>
                    <th onClick={() => toggleSort('readiness_state')}>Lot readiness</th>
                    <th onClick={() => toggleSort('internal_status')}>Internal</th>
                    <th>Check</th>
                  </tr>
                </thead>
                <tbody>
                  {stats?.permits > 0 && permits.length === 0 ? (
                    <tr>
                      <td colSpan={8}>
                        <div className="empty-state compact">
                          <p>
                            No saved permits match the current filter/search. Clear search or filters
                            to see imported rows again. This search does not query Fairfax GIS.
                          </p>
                        </div>
                      </td>
                    </tr>
                  ) : null}
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
                        <div>
                          {meta.useClassLabels?.[p.use_classification] ||
                            p.use_classification ||
                            'Unknown'}
                        </div>
                        <div className="muted mono">
                          {(p.use_classification_source || 'unknown_default').replace(/_/g, ' ')}
                        </div>
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
                      ['internal_status', 'Internal status'],
                      ['owner', 'Assigned to'],
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
                    <label className="muted">
                      <input
                        type="checkbox"
                        checked={Boolean(detail.jurisdiction_confirmed)}
                        onChange={(e) =>
                          setDetail({ ...detail, jurisdiction_confirmed: e.target.checked ? 1 : 0 })
                        }
                      />{' '}
                      Jurisdiction confirmed (required for operational live checks)
                    </label>
                    <div className="field">
                      <label>Official status (connector · read-only)</label>
                      <input readOnly value={detail.official_status ?? ''} />
                    </div>
                    <div className="field">
                      <label>Source-native status (connector · read-only)</label>
                      <input readOnly value={detail.source_native_status ?? ''} />
                    </div>
                    <div className="field">
                      <label>Building use (≠ work type)</label>
                      <div className="mono">
                        {detail.use_classification || 'unknown'}
                        <span className="muted">
                          {' '}
                          · source {detail.use_classification_source || 'unknown_default'}
                        </span>
                      </div>
                      {detail.use_classification_official_label ? (
                        <div className="muted">
                          Official label: {detail.use_classification_official_label}
                        </div>
                      ) : (
                        <div className="muted">No explicit official use label — Unknown unless overridden</div>
                      )}
                      <select
                        value={detail.use_classification_manual || ''}
                        onChange={async (e) => {
                          const v = e.target.value;
                          setBusy(true);
                          try {
                            const data = await api(`/api/permits/${detail.id}/use-classification`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify(v ? { use_classification: v } : { clear: true }),
                            });
                            setDetail({ ...detail, ...data.permit });
                            setMessage(
                              v
                                ? `Manual use override: ${v} (survives later sync)`
                                : 'Cleared manual use override'
                            );
                            await refreshLists();
                          } catch (err) {
                            setMessage(String(err.message || err));
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        <option value="">No manual override</option>
                        <option value="residential">Override → Residential</option>
                        <option value="commercial">Override → Commercial</option>
                        <option value="mixed_use">Override → Mixed-use</option>
                        <option value="unknown">Override → Unknown</option>
                      </select>
                    </div>
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
                  <h3>Property identity</h3>
                  <p className="muted">
                    Select/confirm the exact address or jurisdiction-qualified parcel before Find
                    contacts. State is never defaulted. Lot ranges need explicit evidence.
                  </p>
                  {selectedProperty() ? (
                    <div className="attention-item">
                      <strong>Will search</strong>
                      <div className="mono">
                        {selectedProperty().site_address || '(no street)'}
                        {selectedProperty().parcel_apn
                          ? ` · APN ${selectedProperty().parcel_apn}`
                          : ''}
                      </div>
                      <div className="muted">
                        {[selectedProperty().city, selectedProperty().state, selectedProperty().zip]
                          .filter(Boolean)
                          .join(', ') || 'city/state/ZIP incomplete'}
                        {selectedProperty().parcel_jurisdiction
                          ? ` · jurisdiction ${selectedProperty().parcel_jurisdiction}`
                          : ''}
                        {' · '}
                        link: {selectedProperty().link_state}
                      </div>
                    </div>
                  ) : (
                    <p className="muted">No property selected — choose a linked candidate or enter one.</p>
                  )}
                  <div className="fields">
                    {[
                      ['site_address', 'Site address'],
                      ['city', 'City'],
                      ['state', 'State (required — no default)'],
                      ['zip', 'ZIP'],
                      ['parcel_apn', 'Parcel / APN'],
                      ['parcel_jurisdiction', 'Parcel jurisdiction'],
                    ].map(([key, label]) => (
                      <div className="field" key={key}>
                        <label htmlFor={`prop_${key}`}>{label}</label>
                        <input
                          id={`prop_${key}`}
                          value={propertyForm[key] ?? ''}
                          onChange={(e) => setPropertyForm({ ...propertyForm, [key]: e.target.value })}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="toolbar">
                    <button type="button" className="btn" disabled={busy} onClick={() => saveProperty()}>
                      Save property{propertyForm.id ? ` #${propertyForm.id}` : ''}
                    </button>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busy}
                      onClick={() => saveProperty({ confirm: true })}
                    >
                      Confirm property for lot
                    </button>
                    <button type="button" className="btn" disabled={busy} onClick={offerOfficialAddress}>
                      Offer official site address
                    </button>
                  </div>
                  <ul className="history">
                    {properties.map((p) => (
                      <li key={p.link_id || p.id}>
                        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                          <input
                            type="radio"
                            name="selectedProperty"
                            checked={selectedPropertyId === p.id}
                            onChange={() => applyPropertyToForm(p)}
                          />
                          <span>
                            <strong>{p.site_address || p.parcel_apn || '—'}</strong> · {p.city}, {p.state}{' '}
                            {p.zip}
                            <div className="muted">
                              #{p.id} · {p.link_state} · {p.match_state} · {p.source}
                              {p.parcel_apn ? ` · APN ${p.parcel_apn}` : ''}
                              {p.record_origin === 'sandbox_demo'
                                ? ' · INVENTED sandbox_demo'
                                : ''}
                            </div>
                          </span>
                        </label>
                        {p.link_state !== 'confirmed' ? (
                          <button
                            type="button"
                            className="btn"
                            disabled={busy}
                            onClick={() => confirmSelectedProperty(p)}
                          >
                            Confirm this property
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>

                  <h3>Find contact information</h3>
                  <p className="muted">
                    Roles are separate (owner ≠ applicant ≠ contractor). Provider return ≠ confirmed.
                    Production Tracerfy stays off until owner configures secrets outside chat.
                    {tracerfy ? ` Mode: ${tracerfy.mode}.` : ''}
                  </p>
                  {selectedProperty() ? (
                    <div className="attention-item">
                      <strong>Address / parcel to search</strong>
                      <div className="mono">
                        {selectedProperty().site_address || '(no street)'}
                        {selectedProperty().parcel_apn
                          ? ` · APN ${selectedProperty().parcel_apn}`
                          : ''}
                      </div>
                      <div className="muted">
                        {[selectedProperty().city, selectedProperty().state, selectedProperty().zip]
                          .filter(Boolean)
                          .join(', ')}
                        {selectedProperty().record_origin === 'sandbox_demo'
                          ? ' · INVENTED sandbox_demo property (demo contacts only)'
                          : ' · operational property'}
                      </div>
                    </div>
                  ) : (
                    <p className="muted">Select a confirmed property to show the search address.</p>
                  )}
                  {!tracerfy?.tokenPresent || !tracerfy?.productionGatesOk ? (
                    <div className="banner warn">
                      Connect Tracerfy to enable live lookups. Until then, use an invented demo
                      property for labeled sandbox/fixture contacts, or enter manual contacts.
                      {meta.tracerfySetupNote ? (
                        <div className="muted" style={{ marginTop: '0.35rem' }}>
                          {meta.tracerfySetupNote}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {(meta.authUser?.role === 'owner' || !meta.authEnabled) && (
                    <details className="attention-item">
                      <summary>
                        <strong>Owner setup — Tracerfy (env / secrets only)</strong>
                      </summary>
                      <p className="muted">
                        Do not paste tokens here or in chat. On the host, set environment / Fly secrets
                        per <span className="mono">docs/deploy.md</span>:
                      </p>
                      <ul className="history">
                        <li>
                          <span className="mono">TRACERFY_API_TOKEN</span> — provider token
                        </li>
                        <li>
                          <span className="mono">tracerfy_spend_limit_credits</span> — spend cap setting
                        </li>
                        <li>
                          <span className="mono">tracerfy_commercial_confirmed=1</span> — ToS confirm
                        </li>
                        <li>
                          <span className="mono">tracerfy_production_enabled=1</span> — unlock production
                          mode after gates pass
                        </li>
                      </ul>
                      <p className="muted">
                        This preview keeps production disabled. Demo contacts use invented{' '}
                        <span className="mono">sandbox_demo</span> properties only and never enter
                        operational exports.
                      </p>
                    </details>
                  )}
                  <div className="toolbar">
                    {['local_fixture', 'hosted_sandbox', 'production'].map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={`btn ${tracerfy?.mode === m || tracerfy?.requestedMode === m ? 'primary' : ''}`}
                        disabled={busy || (m === 'production' && !tracerfy?.productionGatesOk)}
                        onClick={() => setProviderMode(m)}
                        title={
                          m === 'production' && !tracerfy?.productionGatesOk
                            ? 'Connect Tracerfy to enable live lookups'
                            : m
                        }
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                  <div className="toolbar">
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={createInventedDemoProperty}
                      title="Creates an invented sandbox_demo address for labeled demo contacts"
                    >
                      Create invented demo property
                    </button>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busy}
                      onClick={findContacts}
                    >
                      Find contact information
                    </button>
                  </div>
                  <h4>Add manual contact</h4>
                  <div className="fields">
                    <div className="field">
                      <label htmlFor="mc_role">Role</label>
                      <select
                        id="mc_role"
                        value={manualContact.role}
                        onChange={(e) => setManualContact({ ...manualContact, role: e.target.value })}
                      >
                        {[
                          'property_owner',
                          'owner_company',
                          'applicant',
                          'contractor',
                          'developer',
                          'architect_engineer',
                          'agency_contact',
                          'internal_assignee',
                          'unknown_party',
                        ].map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </div>
                    {[
                      ['full_name', 'Full name'],
                      ['company', 'Company'],
                      ['phone', 'Phone'],
                      ['email', 'Email'],
                      ['mailing_address', 'Mailing address'],
                    ].map(([key, label]) => (
                      <div className="field" key={key}>
                        <label htmlFor={`mc_${key}`}>{label}</label>
                        <input
                          id={`mc_${key}`}
                          value={manualContact[key]}
                          onChange={(e) => setManualContact({ ...manualContact, [key]: e.target.value })}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="toolbar">
                    <button type="button" className="btn" disabled={busy} onClick={saveManualContact}>
                      Save manual contact
                    </button>
                  </div>
                  <ul className="history">
                    {contacts.map((c) => (
                      <li key={c.id}>
                        <strong>{c.full_name || c.company || '—'}</strong> · {c.role} · {c.status}
                        <div className="mono">
                          {c.phone || '—'} · {c.email || '—'}
                        </div>
                        <div className="muted">
                          {c.provider || 'manual'} · {c.provider_source} · {c.validation_state} · retrieved{' '}
                          {c.retrieved_at || '—'}
                          {c.record_origin === 'sandbox_demo' || c.record_origin === 'local_fixture'
                            ? ` · DEMO ${c.record_origin.toUpperCase()} — not operational`
                            : ''}
                          {c.notes && String(c.notes).includes('DEMO')
                            ? ` · ${c.notes}`
                            : ''}
                          {c.restriction_flags_json && c.restriction_flags_json !== '[]'
                            ? ` · flags ${c.restriction_flags_json}`
                            : ''}
                        </div>
                        <div className="toolbar">
                          <button type="button" className="btn" onClick={() => setContactStatus(c.id, 'confirmed')}>
                            Accept
                          </button>
                          <button type="button" className="btn" onClick={() => setContactStatus(c.id, 'rejected')}>
                            Reject
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {contactJobs.length ? (
                    <ul className="history">
                      {contactJobs.slice(0, 5).map((j) => (
                        <li key={j.id}>
                          Job {j.id}: {j.status} · {j.mode} · est {j.estimated_credits} / actual{' '}
                          {j.actual_credits}
                          {j.error ? ` · ${j.error}` : ''}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  <h3>Milestone waiver</h3>
                  <p className="muted">Record-level n/a waiver with reason; revoke anytime. Not a global completion.</p>
                  <div className="toolbar">
                    <select
                      value={waiverForm.milestone_key}
                      onChange={(e) => setWaiverForm({ ...waiverForm, milestone_key: e.target.value })}
                    >
                      <option value="">Milestone…</option>
                      {milestones
                        .filter((m) => !m.key.startsWith('official_'))
                        .map((m) => (
                          <option key={m.key} value={m.key}>
                            {m.label}
                          </option>
                        ))}
                    </select>
                    <input
                      placeholder="Reason required"
                      value={waiverForm.reason}
                      onChange={(e) => setWaiverForm({ ...waiverForm, reason: e.target.value })}
                    />
                    <button type="button" className="btn" disabled={busy} onClick={submitWaiver}>
                      Waive
                    </button>
                  </div>

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
                        {m.key.startsWith('official_') ? (
                          <div className="mono">
                            {m.value}{' '}
                            <span className="muted">[official · read-only]</span>
                          </div>
                        ) : (
                          <div className="field">
                            <input
                              defaultValue={m.value ?? ''}
                              onBlur={(e) => {
                                if (String(e.target.value) !== String(m.value ?? '')) {
                                  saveMilestone(m, e.target.value);
                                }
                              }}
                            />
                            <span className="muted">[{m.value_kind}] editable · manual assertion</span>
                            <button type="button" className="btn" onClick={() => clearMilestone(m)}>
                              Clear (audit)
                            </button>
                            <button
                              type="button"
                              className="btn"
                              onClick={() => revokeWaiver(m.key)}
                              title="Revoke any active waiver for this milestone"
                            >
                              Revoke waiver
                            </button>
                          </div>
                        )}
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
                      title="Requires activated source + confirmed jurisdiction for operational live checks"
                    >
                      Check source
                    </button>
                    {meta.simulateFailureEnabled ? (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        title="Test-only: set PERMIT_ALLOW_SIMULATE_FAILURE=1"
                        onClick={async () => {
                          setMessage(
                            'Simulate failure is confined to explicit test config and is not exposed on this operational path.'
                          );
                        }}
                      >
                        Simulate failure
                      </button>
                    ) : null}
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
            {meta.storeWorkbookAvailable ? (
              <button type="button" className="btn primary" disabled={busy} onClick={importStoreWorkbook}>
                Import store source workbook
              </button>
            ) : (
              <p className="muted">
                Stored source workbook is not available on this host. Upload a .xlsx file below — that
                is the primary hosted import path.
              </p>
            )}
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

          <h2>Property crosswalk</h2>
          <p className="muted">
            CSV/XLSX address/parcel mapping by community/project + lot. Preview matches, ambiguities,
            missing input, and ranges. Confirm selected rows before commit — server revalidates.
          </p>
          <div className="toolbar">
            <a className="btn" href="/api/property-crosswalk/template.csv">
              Download template
            </a>
            <label className="btn">
              Preview crosswalk file
              <input
                type="file"
                accept=".csv,.xlsx,.xls"
                hidden
                onChange={(e) => e.target.files?.[0] && previewCrosswalkFile(e.target.files[0])}
              />
            </label>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !crosswalkPreview?.length}
              onClick={commitCrosswalkSelected}
            >
              Commit selected
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={async () => {
                setCrosswalkMissing((await api('/api/property-crosswalk/missing')).rows || []);
              }}
            >
              Missing-input queue
            </button>
          </div>
          {crosswalkPreview?.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Select</th>
                    <th>Row</th>
                    <th>Project / Lot</th>
                    <th>Address</th>
                    <th>Match</th>
                  </tr>
                </thead>
                <tbody>
                  {crosswalkPreview.map((r, idx) => (
                    <tr key={`${r.source_row}-${idx}`}>
                      <td>
                        <input
                          type="checkbox"
                          checked={Boolean(r.selected)}
                          onChange={(e) => {
                            const next = [...crosswalkPreview];
                            next[idx] = { ...r, selected: e.target.checked };
                            setCrosswalkPreview(next);
                          }}
                        />
                      </td>
                      <td>{r.source_row}</td>
                      <td className="mono">
                        {r.project_code} / {r.lot_label}
                      </td>
                      <td>
                        {r.site_address} {r.city} {r.state} {r.zip}
                      </td>
                      <td>
                        <span
                          className={`pill ${
                            String(r.match_status).startsWith('matched')
                              ? 'live'
                              : r.match_status === 'unmatched' || r.match_status === 'missing_input'
                                ? 'danger'
                                : 'warn'
                          }`}
                        >
                          {r.match_status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {crosswalkMissing?.length ? (
            <>
              <h3>Lots missing property identity</h3>
              <ul className="history">
                {crosswalkMissing.slice(0, 20).map((r) => (
                  <li key={r.lot_group_id}>
                    {r.community_name} / {r.lot_label} · {r.project_code}
                    <span className="muted"> · use template — do not fabricate addresses</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
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
              {connectResult.ambiguousFairfax ? (
                <div className="muted">
                  Fairfax is ambiguous — pick Fairfax County or City of Fairfax explicitly.
                </div>
              ) : null}
              {(connectResult.namedLimits || []).length ? (
                <ul className="history">
                  {connectResult.namedLimits.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              ) : null}
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
