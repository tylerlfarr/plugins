import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  classifyFieldDiffs,
  buildPatchFromDecisions,
  isPermitDraftDirty,
  dirtyPermitPatch,
  isPropertyFormDirty,
  isMilestoneEditsDirty,
  isRecordWorkspaceDirty,
} from './draftMerge.js';

const INTERNAL_STATUS_OPTIONS = [
  { value: 'watching', label: 'Watching' },
  { value: 'needs_followup', label: 'Needs follow-up' },
  { value: 'done', label: 'Done' },
];

const JURISDICTION_OPTIONS = [
  { value: 'fairfax_county', label: 'Fairfax County' },
  { value: 'loudoun_county', label: 'Loudoun County (unsupported)' },
  { value: 'prince_william_county', label: 'Prince William County (unsupported)' },
  { value: 'unresolved', label: 'Unresolved / other' },
];

function statusLabel(code) {
  return INTERNAL_STATUS_OPTIONS.find((o) => o.value === code)?.label || code || '—';
}

function jurisdictionLabel(code) {
  return JURISDICTION_OPTIONS.find((o) => o.value === code)?.label || code || '—';
}

const HISTORY_FIELD_LABELS = {
  owner: 'Owner',
  next_action: 'Next action',
  next_action_due: 'Next action due',
  internal_status: 'Internal status',
  official_status: 'Official status',
  primary_official_id: 'Official ID',
  jurisdiction_code: 'Jurisdiction',
  jurisdiction_confirmed: 'Jurisdiction confirmed',
  jurisdiction_source: 'Jurisdiction source',
  source_url: 'Source URL',
  permit_kind: 'Permit kind',
  lot_group_id: 'Lot group',
  use_classification_manual: 'Use classification (manual)',
  readiness_state: 'Workbook readiness',
};

function historyFieldLabel(field) {
  const key = String(field || '');
  if (HISTORY_FIELD_LABELS[key]) return HISTORY_FIELD_LABELS[key];
  if (key.startsWith('milestone:')) {
    const rest = key.slice('milestone:'.length).replace(/_/g, ' ');
    return `Milestone · ${rest}`;
  }
  return key || '—';
}

/** Session-expiry / revoke: callers clear local drafts; never silent-restore after re-login. */
let onAuthExpired = null;

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
    if (res.status === 401 && typeof onAuthExpired === 'function' && !path.startsWith('/api/auth/')) {
      onAuthExpired();
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
  { id: 'opportunities', label: 'Opportunities' },
  { id: 'attention', label: 'Attention' },
  { id: 'import', label: 'Import' },
  { id: 'sources', label: 'Sources' },
  { id: 'connectors', label: 'Connectors' },
];

const OPP_DISPOSITIONS = [
  { value: 'new', label: 'New' },
  { value: 'reviewing', label: 'Reviewing' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'follow_up', label: 'Follow-up' },
  { value: 'not_relevant', label: 'Not relevant' },
  { value: 'archived', label: 'Archived' },
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
  const [detailConflict, setDetailConflict] = useState(null); // { server, draft, base, reason }
  const [fieldDecisions, setFieldDecisions] = useState({}); // { field: 'draft'|'server' }
  const [navGuard, setNavGuard] = useState(null); // { type, targetId?, nextTab?, proceed? }
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
  /** Clean property baseline for dirty detection (mirrors detailServer). */
  const [propertyFormServer, setPropertyFormServer] = useState(null);
  /** In-progress milestone values before blur save: { [key]: string }. */
  const [milestoneEdits, setMilestoneEdits] = useState({});
  const emptyPropertyForm = {
    id: null,
    site_address: '',
    city: '',
    state: '',
    zip: '',
    parcel_apn: '',
    parcel_jurisdiction: '',
  };

  function clearWorkspaceDrafts() {
    setDetail(null);
    setDetailServer(null);
    setDetailConflict(null);
    setFieldDecisions({});
    setNavGuard(null);
    setPropertyForm({ ...emptyPropertyForm });
    setPropertyFormServer(null);
    setMilestoneEdits({});
    setMilestones([]);
    setSelectedPropertyId(null);
  }
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
  const [incompleteMasterfile, setIncompleteMasterfile] = useState([]);
  const [openRevisions, setOpenRevisions] = useState([]);
  const [bulk, setBulk] = useState({ internal_status: '', owner: '' });
  const [message, setMessage] = useState('');
  const [importPreview, setImportPreview] = useState(null); // includes previewId for commit-from-preview
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
  const [createUserForm, setCreateUserForm] = useState({
    email: '',
    password: '',
    displayName: '',
  });
  const [usersList, setUsersList] = useState([]);
  const [oppCoverage, setOppCoverage] = useState(null);
  const [oppCoverageAck, setOppCoverageAck] = useState(false);
  const [oppSearchForm, setOppSearchForm] = useState({
    jurisdiction_code: 'fairfax_county',
    issued_from: '',
    issued_to: '',
    app_type_alias: 'Residential',
    record_status: '',
    address_contains: '',
    result_record_count: '25',
  });
  const [oppSearchResult, setOppSearchResult] = useState(null);
  const [oppSelectedHits, setOppSelectedHits] = useState(new Set());
  const [oppPipeline, setOppPipeline] = useState([]);
  const [oppPipelineFilter, setOppPipelineFilter] = useState('');
  const [oppSelectedIds, setOppSelectedIds] = useState(new Set());
  const [oppSearches, setOppSearches] = useState([]);
  const [oppGroups, setOppGroups] = useState([]);
  const [oppDetail, setOppDetail] = useState(null);
  const [soughtRole, setSoughtRole] = useState('');
  const [contactCostPreview, setContactCostPreview] = useState(null);
  const [oppSoughtRole, setOppSoughtRole] = useState('');
  const [oppHandoffPreview, setOppHandoffPreview] = useState(null);
  const [oppContactResults, setOppContactResults] = useState(null);
  const SOUGHT_ROLE_OPTIONS = [
    'property_owner',
    'owner_company',
    'applicant',
    'contractor',
    'developer',
    'architect_engineer',
    'agency_contact',
    'unknown_party',
  ];
  const [oppLinkPermitId, setOppLinkPermitId] = useState('');
  const [assistantQuery, setAssistantQuery] = useState('');
  const [assistantResult, setAssistantResult] = useState(null);
  const [assistantStatus, setAssistantStatus] = useState(null);
  const [evidenceSummary, setEvidenceSummary] = useState(null);
  const [projectHandoffPreview, setProjectHandoffPreview] = useState(null);
  const [oppCoordHandoffPreview, setOppCoordHandoffPreview] = useState(null);
  const [sourceProposals, setSourceProposals] = useState([]);
  const [handoffIncludeSensitive, setHandoffIncludeSensitive] = useState(false);

  const connectors = meta.connectors || [];
  const isOwner = Boolean(
    !meta.authEnabled || meta.authUser?.role === 'owner' || authGate?.user?.role === 'owner'
  );

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
      setPropertyFormServer({ ...emptyPropertyForm });
      setSelectedPropertyId(null);
      return;
    }
    setSelectedPropertyId(prop.id);
    const next = {
      id: prop.id,
      site_address: prop.site_address || '',
      city: prop.city || '',
      state: prop.state || '',
      zip: prop.zip || '',
      parcel_apn: prop.parcel_apn || '',
      parcel_jurisdiction: prop.parcel_jurisdiction || '',
    };
    setPropertyForm(next);
    setPropertyFormServer({ ...next });
  }

  function detailIsDirty() {
    return isRecordWorkspaceDirty({
      detail,
      detailServer,
      propertyForm,
      propertyFormServer,
      milestoneEdits,
      milestones,
    });
  }

  async function openDetail(id, { force = false } = {}) {
    if (
      !force &&
      detail?.id &&
      Number(detail.id) !== Number(id) &&
      detailIsDirty()
    ) {
      setNavGuard({ type: 'switch', targetId: id });
      return;
    }
    const requestId = ++detailRequestSeq.current;
    // Preserve prior selection across reload only when staying on same permit
    const keepId = Number(detail?.id) === Number(id) ? selectedPropertyId : null;
    // Clear record-specific form state immediately to avoid carryover while loading
    setPropertyForm({ ...emptyPropertyForm });
    setPropertyFormServer(null);
    setMilestoneEdits({});
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
    setFieldDecisions({});
    setNavGuard(null);
    setMilestoneEdits({});
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

  async function requestTabChange(nextTab) {
    if (detailIsDirty() && tab !== nextTab) {
      setNavGuard({ type: 'tab', nextTab });
      return;
    }
    setMessage('');
    setTab(nextTab);
  }

  async function discardDraftAndProceed() {
    const g = navGuard;
    setNavGuard(null);
    setDetailConflict(null);
    setFieldDecisions({});
    setMilestoneEdits({});
    if (g?.type === 'switch' && g.targetId != null) {
      await openDetail(g.targetId, { force: true });
    } else if (g?.type === 'tab') {
      if (detail?.id) await openDetail(detail.id, { force: true });
      setTab(g.nextTab);
    } else if (g?.type === 'signout') {
      await api('/api/auth/logout', { method: 'POST' });
      setAuthGate({ enabled: true, user: null });
      clearWorkspaceDrafts();
      setMessage('Signed out — unsaved drafts discarded (not restored on next sign-in).');
    }
  }

  async function savePendingWorkspace() {
    const milestonePatch = [];
    for (const [key, value] of Object.entries(milestoneEdits || {})) {
      const m = milestones.find((row) => row.key === key);
      if (!m) continue;
      if (String(value ?? '') === String(m.value ?? '')) continue;
      milestonePatch.push({
        key: m.key,
        label: m.label,
        value,
        value_kind: m.value_kind || 'text',
      });
    }
    const fieldPatch = dirtyPermitPatch(detail, detailServer);
    const hasPermitPatch = Object.keys(fieldPatch).length > 0 || milestonePatch.length > 0;
    if (hasPermitPatch) {
      const patchOverride = { ...fieldPatch };
      if (milestonePatch.length) patchOverride.milestones = milestonePatch;
      setMilestoneEdits({});
      await saveDetail({ patchOverride });
    }
    if (isPropertyFormDirty(propertyForm, propertyFormServer)) {
      await saveProperty({ confirm: false });
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

  async function previewFindContacts() {
    if (!detail) return;
    const prop = selectedProperty();
    if (!prop) {
      setMessage('Select/confirm the property that will be searched first.');
      return;
    }
    if (!soughtRole) {
      setMessage('Choose which role is sought first (owner ≠ applicant ≠ contractor ≠ borrower).');
      return;
    }
    setBusy(true);
    try {
      const preview = await api('/api/contacts/cost-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          propertyIds: [prop.id],
          sought_role: soughtRole,
          endpoint: 'instant_trace',
        }),
      });
      setContactCostPreview(preview);
      setMessage(
        `Cost preview: ${preview.deduplicatedTargetCount} target(s) · max ${preview.maxEstimatedCredits} credits ($${preview.maxEstimatedUsd}) · mode ${preview.providerMode} · budget ${preview.availableBudgetCredits} · live ${preview.liveEnrichmentStatus}`
      );
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function findContacts() {
    if (!detail) return;
    const prop = selectedProperty();
    if (!prop) {
      setMessage('Select/confirm the property that will be searched first.');
      return;
    }
    if (prop.link_state !== 'confirmed' && prop.record_origin !== 'sandbox_demo') {
      setMessage(`Confirm property before Find contacts (current link: ${prop.link_state}).`);
      return;
    }
    if (!soughtRole) {
      setMessage('Choose which role is sought before Find contacts.');
      return;
    }
    if (!contactCostPreview) {
      setMessage('Run cost preview first — shows deduped count, max cost, mode, and budget.');
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
          sought_role: soughtRole,
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
          `Find contacts: reused prior job #${result.job?.id} (${result.contacts?.length || 0} candidates). Sought ${soughtRole}. Searched ${addr}.`
        );
      } else {
        setMessage(
          `Find contacts: ${result.saved?.length || 0} candidates · sought ${soughtRole} · mode ${result.provider?.mode} · actual ${result.actualCredits ?? 0} credits. Searched ${addr}.`
        );
      }
      setContactCostPreview(null);
      await openDetail(detail.id);
      await refreshLists();
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function runAssistantQuery() {
    const text = assistantQuery.trim();
    if (!text) {
      setMessage('Enter a filter or summary request for the assistant.');
      return;
    }
    setBusy(true);
    try {
      const out = await api('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: text,
          permitId: detail?.id || null,
          intent: 'auto',
        }),
      });
      setAssistantResult(out);
      setAssistantStatus(out.ai || null);
      if (out.filterMapping && !out.filterMapping.abstain) {
        const fm = out.filterMapping;
        setQ(fm.q || '');
        setFilters({ ...fm.filters });
        setMessage(
          `Assistant filters applied (${out.ai?.state || 'unavailable'}): ${
            Object.keys(fm.filters || {}).join(', ') || (fm.q ? 'q' : 'none')
          }`
        );
      } else if (out.filterMapping?.abstain) {
        setMessage(
          `Assistant abstained: ${out.filterMapping.reviewTask || out.message || 'review required'}`
        );
      } else if (out.evidence) {
        setEvidenceSummary(out.evidence);
        setMessage(
          out.evidence.unknown
            ? 'Evidence summary: Unknown — review task (no invented facts)'
            : 'Evidence summary ready'
        );
      } else {
        setMessage(out.message || 'Assistant response');
      }
    } catch (err) {
      setMessage(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function summarizeSelectedEvidence() {
    if (!detail?.id) {
      setMessage('Open a permit to summarize evidence.');
      return;
    }
    setBusy(true);
    try {
      const out = await api('/api/assistant/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permitId: detail.id }),
      });
      setEvidenceSummary(out);
      setMessage(
        out.unknown
          ? 'Evidence incomplete/conflicting — Unknown + review task (no invented facts)'
          : 'Evidence summary from retrieved records only'
      );
    } catch (err) {
      setMessage(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function previewProjectHandoff() {
    setBusy(true);
    try {
      const out = await api('/api/handoffs/project/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filters: { q, ...filters },
          selectedIds: selectedIds.length ? selectedIds : null,
          includeSensitive: handoffIncludeSensitive,
        }),
      });
      setProjectHandoffPreview(out);
      setMessage(
        `Project handoff preview: ${out.counts?.total ?? 0} rows · blocked ${
          out.counts?.blocked ?? 0
        } · sensitive ${out.includeSensitive ? 'on' : 'off'}`
      );
    } catch (err) {
      setMessage(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function previewOppCoordHandoff() {
    setBusy(true);
    try {
      const out = await api('/api/handoffs/opportunity/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: oppSelectedIds.size ? [...oppSelectedIds] : null,
          includeSensitive: handoffIncludeSensitive,
        }),
      });
      setOppCoordHandoffPreview(out);
      setMessage(
        `Opportunity handoff preview: ${out.counts?.total ?? 0} · qualified ${
          out.counts?.qualified ?? 0
        } · sensitive ${out.includeSensitive ? 'on' : 'off'}`
      );
    } catch (err) {
      setMessage(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function refreshSourceProposals() {
    if (!isOwner) return;
    const out = await api('/api/assistant/source-proposals');
    setSourceProposals(out.proposals || []);
  }

  async function previewOppContactHandoff() {
    const ids = oppSelectedIds.size ? [...oppSelectedIds] : oppDetail ? [oppDetail.id] : [];
    if (!ids.length) {
      setMessage('Select pipeline opportunities (or open one) for contact review handoff.');
      return;
    }
    if (!oppSoughtRole) {
      setMessage('Choose which role is sought — never equate owner/applicant/contractor/borrower.');
      return;
    }
    setBusy(true);
    try {
      const out = await api('/api/opportunities/contact-handoff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          opportunityIds: ids,
          sought_role: oppSoughtRole,
          dryRun: true,
        }),
      });
      setOppHandoffPreview(out);
      setOppContactResults(null);
      const p = out.preview || {};
      setMessage(
        `Handoff preview: ${p.deduplicatedTargetCount ?? 0} deduped · max $${p.maxEstimatedUsd ?? 0} · mode ${p.providerMode} · live ${p.liveEnrichmentStatus} · ambiguous ${out.ambiguous?.length || 0}`
      );
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmOppContactHandoff() {
    if (!oppHandoffPreview?.preview?.purchaseAllowed) {
      setMessage('Live enrichment is BLOCKED — fixture cost preview must show purchaseAllowed.');
      return;
    }
    const ids = oppHandoffPreview.preview.targets.map((t) => t.opportunityId);
    setBusy(true);
    try {
      const out = await api('/api/opportunities/contact-handoff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          opportunityIds: ids,
          sought_role: oppSoughtRole,
          dryRun: false,
          confirm: true,
        }),
      });
      setOppContactResults(out);
      setMessage(
        `Contact review prepared: ${out.results?.length || 0} lookups · actual credits ${out.totalActualCredits ?? 0} (fixture $0) · live ${out.liveEnrichmentStatus}`
      );
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function suppressContactChannel(c, channel) {
    const value = channel === 'email' ? c.email : channel === 'mail' ? c.mailing_address : c.phone;
    if (!value) {
      setMessage(`No ${channel} value to suppress on this contact.`);
      return;
    }
    const reason = window.prompt(`Reason to suppress ${channel} (${value})?`) || '';
    if (!reason.trim()) return;
    setBusy(true);
    try {
      await api('/api/contacts/suppress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel,
          value,
          reason,
          property_id: c.property_id,
          full_name: c.full_name,
        }),
      });
      setMessage(`Suppressed ${channel} — relookup/re-import will not resurrect.`);
      if (detail) await openDetail(detail.id);
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
        draft: { ...detail },
        base: detailServer ? { ...detailServer } : null,
        reason: e.body?.message || 'Server copy changed; draft kept — resolve field by field.',
      });
      setFieldDecisions({});
      setMessage(
        e.body?.message ||
          'Stale save blocked. Choose server vs draft for each changed field, then Save decided fields.'
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
      setMilestoneEdits((prev) => {
        const next = { ...prev };
        delete next[m.key];
        return next;
      });
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
    onAuthExpired = () => {
      // Server session gone (logout elsewhere or expiry). Discard in-memory drafts —
      // never silently re-apply them after the next login.
      clearWorkspaceDrafts();
      setAuthGate({ enabled: true, user: null });
      setMessage('Session ended. Sign in again — prior unsaved drafts were discarded.');
    };
    return () => {
      onAuthExpired = null;
    };
  }, []);

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
    function onBeforeUnload(ev) {
      if (
        !isRecordWorkspaceDirty({
          detail,
          detailServer,
          propertyForm,
          propertyFormServer,
          milestoneEdits,
          milestones,
        })
      ) {
        return;
      }
      ev.preventDefault();
      ev.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [detail, detailServer, propertyForm, propertyFormServer, milestoneEdits, milestones]);

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
          setIncompleteMasterfile(a.incompleteMasterfile || []);
          setOpenRevisions(a.openRevisions || []);
          setSchedule(s);
          setConflicts(c.conflicts);
        }
      );
    }
    if (tab === 'sources') {
      api('/api/sources').then((d) => setSources(d.sources || []));
      if (isOwner) refreshUsers();
    }
    if (tab === 'opportunities') {
      Promise.all([
        api('/api/opportunities/coverage'),
        api('/api/opportunities'),
        api('/api/opportunity-searches'),
        api('/api/opportunity-groups'),
      ])
        .then(([cov, pipe, searches, groups]) => {
          setOppCoverage(cov);
          setOppPipeline(pipe.items || []);
          setOppSearches(searches.searches || []);
          setOppGroups(groups.groups || []);
        })
        .catch((e) => setMessage(String(e.message || e)));
    }
  }, [tab, authGate, isOwner]);

  async function refreshOppPipeline() {
    const [pipe, groups, searches] = await Promise.all([
      api(`/api/opportunities${oppPipelineFilter ? `?disposition=${encodeURIComponent(oppPipelineFilter)}` : ''}`),
      api('/api/opportunity-groups'),
      api('/api/opportunity-searches'),
    ]);
    setOppPipeline(pipe.items || []);
    setOppGroups(groups.groups || []);
    setOppSearches(searches.searches || []);
  }

  async function runOppSearch() {
    if (!oppCoverageAck) {
      setMessage('Acknowledge coverage limitations before searching.');
      return;
    }
    setBusy(true);
    try {
      const body = {
        ...oppSearchForm,
        result_record_count: Number(oppSearchForm.result_record_count) || 25,
      };
      const data = await api('/api/opportunities/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setOppSearchResult(data);
      setOppSelectedHits(new Set());
      setMessage(data.message || data.status);
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function saveSelectedHits() {
    const hits = (oppSearchResult?.results || []).filter((r) =>
      oppSelectedHits.has(r.officialId)
    );
    if (!hits.length) {
      setMessage('Select discovery hits to save to the private watchlist.');
      return;
    }
    setBusy(true);
    try {
      const out = await api('/api/opportunities/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidates: hits }),
      });
      setMessage(
        `Saved ${out.saved?.length || 0} new · deduped ${out.deduped?.length || 0} (private pipeline)`
      );
      await refreshOppPipeline();
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function saveOppSearchCriteria(kind = 'dynamic') {
    setBusy(true);
    try {
      const criteria =
        kind === 'static_list'
          ? {
              official_ids: [...oppSelectedIds]
                .map((id) => oppPipeline.find((o) => o.id === id)?.official_id)
                .filter(Boolean),
            }
          : { ...oppSearchForm };
      const name =
        kind === 'static_list'
          ? `Static list ${new Date().toISOString().slice(0, 10)}`
          : `Fairfax ${oppSearchForm.app_type_alias || 'browse'} ${oppSearchForm.issued_from || ''}`.trim();
      await api('/api/opportunity-searches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, criteria, kind }),
      });
      setMessage(kind === 'static_list' ? 'Saved static selected list' : 'Saved dynamic search criteria');
      await refreshOppPipeline();
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function patchOpp(id, patch) {
    setBusy(true);
    try {
      const data = await api(`/api/opportunities/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      setOppDetail(data.item);
      await refreshOppPipeline();
      setMessage('Opportunity updated');
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function linkOppToProject(id) {
    const permitRecordId = Number(oppLinkPermitId);
    if (!Number.isFinite(permitRecordId)) {
      setMessage('Enter an existing import permit record id — lots are never invented.');
      return;
    }
    setBusy(true);
    try {
      const data = await api(`/api/opportunities/${id}/link-project`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permitRecordId }),
      });
      setOppDetail(data.item);
      await refreshOppPipeline();
      setMessage('Linked to existing project permit (facts not copied)');
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

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

  async function refreshUsers() {
    if (!isOwner || (meta.authEnabled && !authGate?.user)) return;
    try {
      const data = await api('/api/auth/users');
      setUsersList(data.users || []);
    } catch {
      setUsersList([]);
    }
  }

  async function createTrialUser() {
    setBusy(true);
    try {
      await api('/api/auth/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: createUserForm.email,
          password: createUserForm.password,
          displayName: createUserForm.displayName,
          role: 'operator',
        }),
      });
      setCreateUserForm({ email: '', password: '', displayName: '' });
      setMessage('Trial operator created — share login privately (not email invite).');
      await refreshUsers();
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

  async function saveDetail({ patchOverride, expectedVersion } = {}) {
    if (!detail) return;
    setBusy(true);
    try {
      // Only send dirty fields (or explicit merge patch) — never wipe unrelated server values
      const patch =
        patchOverride ||
        dirtyPermitPatch(detail, detailServer);
      if (!Object.keys(patch).length) {
        setMessage('No local changes to save.');
        setBusy(false);
        return;
      }
      const version =
        expectedVersion ??
        detailConflict?.server?.row_version ??
        detail.row_version ??
        1;
      const data = await api(`/api/permits/${detail.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...patch,
          expected_row_version: version,
        }),
      });
      setMessage('Saved.');
      if (data.permit) {
        setDetail(data.permit);
        setDetailServer(data.permit);
        setDetailConflict(null);
        setFieldDecisions({});
      }
      await refreshLists();
      await openDetail(detail.id, { force: true });
      if (navGuard?.type === 'switch' && navGuard.targetId != null) {
        const target = navGuard.targetId;
        setNavGuard(null);
        await openDetail(target, { force: true });
      } else if (navGuard?.type === 'tab') {
        const next = navGuard.nextTab;
        setNavGuard(null);
        setTab(next);
      }
    } catch (e) {
      handleStaleSave(e);
      await refreshLists();
    } finally {
      setBusy(false);
    }
  }

  async function saveReconciledFields() {
    if (!detailConflict?.server || !detail) return;
    const base = detailConflict.base || detailServer;
    const diffs = classifyFieldDiffs(base, detailConflict.draft || detail, detailConflict.server);
    try {
      const patch = buildPatchFromDecisions(diffs, fieldDecisions, detailConflict.server);
      // Apply draft-only + chosen draft fields onto form first for local consistency
      const merged = { ...detailConflict.server };
      for (const row of diffs) {
        if (row.status === 'draft_only' || (row.status === 'conflict' && fieldDecisions[row.key] === 'draft')) {
          merged[row.key] = row.draft;
        }
      }
      setDetail({ ...merged, row_version: detailConflict.server.row_version });
      await saveDetail({
        patchOverride: patch,
        expectedVersion: detailConflict.server.row_version,
      });
    } catch (e) {
      setMessage(String(e.message || e));
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
      let counts = data.counts;
      let diagnostic = data.diagnostic;
      if (data.async && data.job?.id) {
        setMessage(
          `Fairfax sync job #${data.job.id} queued on the server` +
            (data.coalesced ? ' (joined existing job)' : '') +
            ' — closing this tab will not cancel it…'
        );
        const deadline = Date.now() + 180000;
        let finished = null;
        while (Date.now() < deadline) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 800));
          // eslint-disable-next-line no-await-in-loop
          const poll = await api(`/api/sync/jobs/${data.job.id}`);
          finished = poll.job;
          if (finished?.status === 'succeeded' || finished?.status === 'failed') break;
        }
        if (!finished || (finished.status !== 'succeeded' && finished.status !== 'failed')) {
          setMessage(
            `Fairfax sync job #${data.job.id} still running on the server. Check Sources / Attention later — work continues after browser close.`
          );
          return;
        }
        if (finished.status === 'failed') {
          setMessage(`Fairfax sync job #${finished.id} failed: ${finished.error || 'unknown'}`);
          return;
        }
        let summary = pollSummary(finished);
        counts = summary.counts;
        diagnostic = summary.diagnostic;
      }
      const total = counts?.total ?? data.results?.length ?? 0;
      if (total === 0) {
        setMessage(
          diagnostic ||
            'Fairfax sync finished: 0 checks. Import a workbook with Fairfax County official IDs first — this button re-checks saved IDs; it does not discover new permits in the county GIS.'
        );
      } else {
        setMessage(
          `Fairfax sync finished: ${total} checks` +
            (counts
              ? ` (updated ${counts.updated}, no_change ${counts.no_change}, not_found ${counts.not_found}, blocked ${counts.blocked || 0}, unsupported ${counts.unsupported || 0}, unavailable ${counts.unavailable}, failed ${counts.failed})`
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

  function pollSummary(job) {
    try {
      return JSON.parse(job?.summary_json || '{}');
    } catch {
      return {};
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
    // Do not silently replace an unsaved draft. Surface field-level reconcile.
    if (detail?.id && selectedIds.includes(detail.id)) {
      const serverRow = (data.permits || []).find((p) => p.id === detail.id);
      if (detailIsDirty() && serverRow) {
        setDetailConflict({
          server: serverRow,
          draft: { ...detail },
          base: detailServer ? { ...detailServer } : null,
          reason: 'Bulk update changed this row while you had unsaved edits. Resolve fields before Save.',
        });
        setFieldDecisions({});
        setMessage(
          'Bulk updated selection. Open detail has unsaved edits — choose server vs draft per field, then Save decided fields.'
        );
      } else {
        await openDetail(detail.id, { force: true });
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
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const data = await api('/api/import/workbook/preview', { method: 'POST', body: fd });
      setImportPreview(data);
      setTab('import');
      setMessage(
        `Preview ready: ${data.filename || file.name} · ${data.sectionCount} sections · ${data.rowCount} rows. Commit this preview without re-selecting the file.`
      );
    } catch (e) {
      setImportPreview(null);
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function commitPreviewedWorkbook() {
    if (!importPreview?.previewId) {
      setMessage('Preview a workbook first, then commit that exact preview.');
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('previewId', importPreview.previewId);
      const data = await api('/api/import/workbook/commit', { method: 'POST', body: fd });
      setMessage(
        `Committed ${data.filename || importPreview.filename}: ${data.summary?.permits_created ?? 0} created, ${data.summary?.permits_updated ?? 0} updated` +
          (data.changedBy ? ` · by ${data.changedBy}` : '')
      );
      setImportPreview(null);
      await refreshLists();
    } catch (e) {
      setMessage(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function resolveImportConflict(conflict, resolution) {
    setBusy(true);
    try {
      let version = detail?.id === conflict.permit_record_id ? detail.row_version : null;
      if (version == null && conflict.permit_record_id) {
        const d = await api(`/api/permits/${conflict.permit_record_id}`);
        version = d.permit?.row_version;
      }
      const data = await api(`/api/conflicts/${conflict.id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resolution,
          expected_row_version: version ?? 1,
        }),
      });
      setMessage(`Conflict ${conflict.field}: ${resolution} (version ${data.row_version})`);
      setConflicts((await api('/api/conflicts')).conflicts);
      setAttention((await api('/api/attention')).items);
      if (detail?.id === conflict.permit_record_id) {
        await openDetail(detail.id, { force: true });
      }
      await refreshLists();
    } catch (e) {
      handleStaleSave(e);
      setMessage(String(e.message || e));
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
            <p>Private pilot — sign in with your issued account.</p>
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
              onClick={() => requestTabChange(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        {authGate?.user ? (
          <div className="muted" style={{ marginLeft: 'auto', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            <span>
              {authGate.user.email}
              {authGate.user.role ? ` · ${authGate.user.role}` : ''}
            </span>
            {detailIsDirty() ? <span className="pill warn">Unsaved edits</span> : null}
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (detailIsDirty()) {
                  setNavGuard({ type: 'signout' });
                  return;
                }
                api('/api/auth/logout', { method: 'POST' }).then(() => {
                  setAuthGate({ enabled: true, user: null });
                  clearWorkspaceDrafts();
                  setMessage('Signed out');
                });
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
      {navGuard ? (
        <div className="banner warn" role="dialog" aria-label="Unsaved changes">
          You have unsaved edits (permit fields, property form, and/or in-progress milestones).
          Choose Save, Discard, or Cancel before leaving.
          <div className="empty-actions" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const g = navGuard;
                  await savePendingWorkspace();
                  // saveDetail clears switch/tab guards; handle leftover (property-only or sign-out).
                  if (g?.type === 'signout') {
                    setNavGuard(null);
                    await api('/api/auth/logout', { method: 'POST' });
                    setAuthGate({ enabled: true, user: null });
                    clearWorkspaceDrafts();
                    setMessage('Signed out');
                  } else if (navGuard) {
                    const left = navGuard;
                    setNavGuard(null);
                    if (left.type === 'switch' && left.targetId != null) {
                      await openDetail(left.targetId, { force: true });
                    } else if (left.type === 'tab') {
                      setTab(left.nextTab);
                    }
                  }
                } catch (e) {
                  setMessage(String(e.message || e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save
            </button>
            <button type="button" className="btn" onClick={discardDraftAndProceed}>
              Discard
            </button>
            <button type="button" className="btn ghost" onClick={() => setNavGuard(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {detailConflict ? (
        <div className="banner warn" role="alert">
          <div>
            Conflict: {detailConflict.reason} Server version{' '}
            {detailConflict.server?.row_version ?? '—'}. Choose server vs draft for each field that
            both sides changed; unrelated server fields stay unless you choose draft.
          </div>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Your draft</th>
                  <th>Server</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {classifyFieldDiffs(
                  detailConflict.base || detailServer,
                  detailConflict.draft || detail,
                  detailConflict.server
                )
                  .filter((r) => r.status !== 'unchanged')
                  .map((row) => (
                    <tr key={row.key}>
                      <td>{row.label}</td>
                      <td className="mono">{String(row.draft ?? '∅')}</td>
                      <td className="mono">{String(row.server ?? '∅')}</td>
                      <td>
                        {row.status === 'conflict' ? (
                          <select
                            value={fieldDecisions[row.key] || ''}
                            onChange={(e) =>
                              setFieldDecisions((d) => ({ ...d, [row.key]: e.target.value }))
                            }
                          >
                            <option value="">Choose…</option>
                            <option value="draft">Keep draft</option>
                            <option value="server">Take server</option>
                          </select>
                        ) : row.status === 'draft_only' ? (
                          <span className="muted">Will save draft</span>
                        ) : (
                          <span className="muted">Keep server</span>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div className="empty-actions" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn"
              onClick={async () => {
                if (detailConflict.server?.id) await openDetail(detailConflict.server.id, { force: true });
                else setDetailConflict(null);
              }}
            >
              Discard draft · reload server
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={saveReconciledFields}
            >
              Save decided fields
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
          <div className="panel stack" data-testid="assistant-panel" style={{ marginBottom: 12 }}>
            <h3>Assistant (optional)</h3>
            <p className="muted">
              Natural language → supported filters, or evidence summaries from retrieved records
              only. AI is optional — when unavailable, deterministic helpers still work. Never
              invents IDs/dates/contacts; never lending approval.
            </p>
            <div className="banner" data-testid="assistant-ai-state">
              AI state:{' '}
              <strong>
                {(assistantStatus || meta.assistant?.ai || assistantResult?.ai)?.state ||
                  'unavailable'}
              </strong>
              {' — '}
              {(assistantStatus || meta.assistant?.ai || assistantResult?.ai)?.reason ||
                'No model required for filter helpers'}
            </div>
            <div className="toolbar">
              <input
                type="search"
                data-testid="assistant-query"
                placeholder='e.g. “blocked Fairfax lots approaching start” or “why is this blocked”'
                value={assistantQuery}
                onChange={(e) => setAssistantQuery(e.target.value)}
                style={{ minWidth: 280, flex: 1 }}
              />
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                data-testid="assistant-run"
                onClick={runAssistantQuery}
              >
                Apply / ask
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy || !detail?.id}
                data-testid="assistant-summarize"
                onClick={summarizeSelectedEvidence}
              >
                What changed / why blocked
              </button>
            </div>
            {assistantResult?.filterMapping ? (
              <div className="attention-item" data-testid="assistant-filter-result">
                <div>
                  Filters:{' '}
                  <span className="mono">
                    {JSON.stringify({
                      q: assistantResult.filterMapping.q,
                      ...assistantResult.filterMapping.filters,
                    })}
                  </span>
                </div>
                {(assistantResult.filterMapping.notes || []).map((n) => (
                  <div key={n} className="muted">
                    {n}
                  </div>
                ))}
                {(assistantResult.filterMapping.unsupportedGeography || []).length ? (
                  <div className="banner warn">
                    Unsupported geography:{' '}
                    {assistantResult.filterMapping.unsupportedGeography
                      .map((g) => g.label)
                      .join(', ')}
                  </div>
                ) : null}
                {assistantResult.filterMapping.reviewTask ? (
                  <div className="banner warn">Review: {assistantResult.filterMapping.reviewTask}</div>
                ) : null}
                {assistantResult.filterMapping.filterLinks?.applyQuery ? (
                  <div className="muted">
                    Filter link:{' '}
                    <span className="mono">?{assistantResult.filterMapping.filterLinks.applyQuery}</span>
                  </div>
                ) : null}
              </div>
            ) : null}
            {evidenceSummary?.summary ? (
              <div className="attention-item" data-testid="assistant-evidence">
                <strong>Evidence summary</strong>
                <ul className="history">
                  {(evidenceSummary.summary.bullets || []).map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
                {evidenceSummary.reviewTask ? (
                  <div className="banner warn">{evidenceSummary.reviewTask}</div>
                ) : null}
                <div className="muted">{evidenceSummary.disclaimer}</div>
              </div>
            ) : null}
            <div className="toolbar">
              <label className="muted">
                <input
                  type="checkbox"
                  checked={handoffIncludeSensitive}
                  onChange={(e) => setHandoffIncludeSensitive(e.target.checked)}
                />{' '}
                Include sensitive columns in handoff (off by default)
              </label>
              <button
                type="button"
                className="btn"
                disabled={busy}
                data-testid="project-handoff-preview"
                onClick={previewProjectHandoff}
              >
                Preview project handoff
              </button>
              <a
                className="btn"
                data-testid="project-handoff-export"
                href={`/api/handoffs/project.xlsx?${new URLSearchParams({
                  ...Object.fromEntries(
                    Object.entries({ q, ...filters }).filter(
                      ([, v]) => v != null && String(v) !== ''
                    )
                  ),
                  ...(selectedIds.length ? { selectedIds: selectedIds.join(',') } : {}),
                  ...(handoffIncludeSensitive ? { includeSensitive: '1' } : {}),
                })}`}
              >
                Export project handoff
              </a>
            </div>
            {projectHandoffPreview ? (
              <div className="attention-item" data-testid="project-handoff-result">
                Counts: total {projectHandoffPreview.counts?.total} · blocked{' '}
                {projectHandoffPreview.counts?.blocked} · with due{' '}
                {projectHandoffPreview.counts?.withDue} · sensitive omitted:{' '}
                {(projectHandoffPreview.sensitiveColumnsOmitted || []).join(', ') || 'none'}
                <ul className="history">
                  {(projectHandoffPreview.preview || []).slice(0, 5).map((r) => (
                    <li key={r.permit_record_id}>
                      {r.community_name} lot {r.lot_label} · {r.readiness_state} · owner{' '}
                      {r.owner || '—'} · {r.next_action || '—'}{' '}
                      {r.next_action_due ? `due ${r.next_action_due}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
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
              {INTERNAL_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
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
                })}`}
                title="Exports the checked rows only — ignores current search/filters. Count matches selection."
              >
                Export selected ({selectedIds.length} rows · ignores filters)
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
              {INTERNAL_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
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
                County jurisdiction. With zero imports, it correctly reports 0 checks. To browse
                public Fairfax activity without imports, use the <strong>Opportunities</strong> tab.
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
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setMessage('');
                    setTab('opportunities');
                  }}
                >
                  Open Opportunities
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
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') openDetail(p.id);
                      }}
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
                          {jurisdictionLabel(p.jurisdiction_code)}
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
                          Workbook: {readinessLabel(p.readiness_state)}
                        </span>
                        <div className="muted">
                          AHJ:{' '}
                          {p.official_status
                            ? p.official_status
                            : p.primary_official_id
                              ? 'Not verified'
                              : 'No official ID'}
                        </div>
                        <div className="muted">
                          {(p.readiness_summary || '').slice(0, 80)}
                          {(p.readiness_summary || '').length > 80 ? '…' : ''}
                        </div>
                      </td>
                      <td>
                        <div>{statusLabel(p.internal_status)}</div>
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
              <h2>
                Permit detail
                {detailIsDirty() ? <span className="pill warn"> Unsaved</span> : null}
              </h2>
              {!detail ? (
                <p className="muted">Select a row.</p>
              ) : (
                <>
                  <div className="toolbar sticky-save">
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busy || Boolean(detailConflict)}
                      onClick={() => saveDetail()}
                    >
                      Save
                    </button>
                    <span className="muted">
                      {detailIsDirty()
                        ? 'Unsaved edits — Save sends only changed fields'
                        : 'No local edits'}
                    </span>
                  </div>
                  <div className="fields">
                    <div className="field">
                      <label htmlFor="primary_official_id">Primary official ID</label>
                      <input
                        id="primary_official_id"
                        type="text"
                        value={detail.primary_official_id ?? ''}
                        onChange={(e) =>
                          setDetail({ ...detail, primary_official_id: e.target.value })
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="jurisdiction_code">Jurisdiction</label>
                      <select
                        id="jurisdiction_code"
                        value={detail.jurisdiction_code ?? ''}
                        onChange={(e) =>
                          setDetail({ ...detail, jurisdiction_code: e.target.value })
                        }
                      >
                        <option value="">Select jurisdiction…</option>
                        {JURISDICTION_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                        {detail.jurisdiction_code &&
                        !JURISDICTION_OPTIONS.some((o) => o.value === detail.jurisdiction_code) ? (
                          <option value={detail.jurisdiction_code}>
                            {detail.jurisdiction_code}
                          </option>
                        ) : null}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="internal_status">Internal status</label>
                      <select
                        id="internal_status"
                        value={detail.internal_status ?? ''}
                        onChange={(e) =>
                          setDetail({ ...detail, internal_status: e.target.value })
                        }
                      >
                        <option value="">Select status…</option>
                        {INTERNAL_STATUS_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="owner">Assigned to</label>
                      <input
                        id="owner"
                        type="text"
                        value={detail.owner ?? ''}
                        onChange={(e) => setDetail({ ...detail, owner: e.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="next_action">Next action</label>
                      <input
                        id="next_action"
                        type="text"
                        value={detail.next_action ?? ''}
                        onChange={(e) => setDetail({ ...detail, next_action: e.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="next_action_due">Next action due</label>
                      <input
                        id="next_action_due"
                        type="date"
                        value={detail.next_action_due ?? ''}
                        onChange={(e) =>
                          setDetail({ ...detail, next_action_due: e.target.value })
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="source_url">Source URL</label>
                      <input
                        id="source_url"
                        type="text"
                        value={detail.source_url ?? ''}
                        onChange={(e) => setDetail({ ...detail, source_url: e.target.value })}
                      />
                    </div>
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
                      <h3>Workbook completeness vs official verification</h3>
                      <p className="muted">
                        These are separate signals. Neither means lending approval, clear-to-close,
                        funding authorization, or inspection completion.
                      </p>
                      <div className="empty-actions" style={{ gap: 8, flexWrap: 'wrap' }}>
                        <span className={`pill ${readinessClass(readiness.state)}`}>
                          Workbook: {readiness.state_label || readinessLabel(readiness.state)}
                        </span>
                        <span
                          className={`pill ${
                            detail.official_status ? 'live' : 'warn'
                          }`}
                        >
                          Official AHJ:{' '}
                          {detail.official_status ||
                            (detail.primary_official_id ? 'Not verified yet' : 'No official ID')}
                        </span>
                      </div>
                      <p className="muted">
                        Workbook rules — missing evidence is never Ready. {readiness.assessment_note}
                      </p>
                      {readiness.target_start ? (
                        <div className="muted">
                          Target start {readiness.target_start}
                          {readiness.days_to_start != null
                            ? ` (${readiness.days_to_start}d)`
                            : ''}
                        </div>
                      ) : null}
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
                    Ask which role is sought first — owner ≠ applicant ≠ contractor ≠ borrower.
                    Provider return ≠ confirmed. Live enriched-lead pilot is{' '}
                    <strong>BLOCKED</strong> (hard spend lock: production off, spend cap 0,
                    fixture/sandbox only).
                    {isOwner && tracerfy ? ` Mode: ${tracerfy.mode}.` : ''}
                  </p>
                  <div className="field">
                    <label htmlFor="sought_role">Sought role (required)</label>
                    <select
                      id="sought_role"
                      value={soughtRole}
                      onChange={(e) => {
                        setSoughtRole(e.target.value);
                        setContactCostPreview(null);
                      }}
                    >
                      <option value="">— choose role —</option>
                      {SOUGHT_ROLE_OPTIONS.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </div>
                  {contactCostPreview ? (
                    <div className="attention-item" data-testid="contact-cost-preview">
                      <strong>Cost preview (before lookup)</strong>
                      <div>
                        Deduped targets: {contactCostPreview.deduplicatedTargetCount} · Max estimated:{' '}
                        {contactCostPreview.maxEstimatedCredits} credits ($
                        {contactCostPreview.maxEstimatedUsd}) · Mode:{' '}
                        {contactCostPreview.providerMode} · Available budget:{' '}
                        {contactCostPreview.availableBudgetCredits}
                        {contactCostPreview.fixtureCostZero ? ' · Fixture/sandbox cost $0' : ''}
                      </div>
                      <div className="muted">
                        Live enrichment: {contactCostPreview.liveEnrichmentStatus}
                        {contactCostPreview.liveEnrichmentBlockReason
                          ? ` — ${contactCostPreview.liveEnrichmentBlockReason}`
                          : ''}
                      </div>
                    </div>
                  ) : null}
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
                  {isOwner && (!tracerfy?.tokenPresent || !tracerfy?.productionGatesOk) ? (
                    <div className="banner warn">
                      Live paid contact lookup is not connected
                      {meta.demoShortcutsAllowed
                        ? '. Operators can still use an invented demo property for labeled sandbox contacts, or enter manual contacts.'
                        : '. On this RC host the invented demo-property shortcut is off — use Opportunities fixture contact review or enter manual contacts.'}
                    </div>
                  ) : null}
                  {isOwner ? (
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
                  ) : (
                    <p className="muted">
                      Provider mode is owner-managed. Operators use the configured fixture/sandbox
                      path for Find contact demos.
                    </p>
                  )}
                  {isOwner ? (
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
                  ) : null}
                  <div className="toolbar">
                    {meta.demoShortcutsAllowed ? (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={createInventedDemoProperty}
                        title="Creates an invented sandbox_demo address for labeled demo contacts"
                      >
                        Create invented demo property
                      </button>
                    ) : (
                      <p className="muted">
                        Invented demo-property shortcut is off on this host (RC default). Use
                        Opportunities → fixture contact review, or add a manual contact.
                      </p>
                    )}
                    <button
                      type="button"
                      className="btn"
                      disabled={busy || !soughtRole}
                      onClick={previewFindContacts}
                    >
                      Cost preview
                    </button>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busy || !soughtRole || !contactCostPreview}
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
                        <div className="muted">
                          Sought: {c.sought_role || '—'} · entity: {c.entity_kind || '—'}
                          {c.match_evidence_json && c.match_evidence_json !== '{}'
                            ? ` · evidence stored`
                            : ''}
                        </div>
                        <div className="toolbar">
                          <button type="button" className="btn" onClick={() => setContactStatus(c.id, 'confirmed')}>
                            Accept
                          </button>
                          <button type="button" className="btn" onClick={() => setContactStatus(c.id, 'rejected')}>
                            Reject
                          </button>
                          {c.email ? (
                            <button type="button" className="btn ghost" onClick={() => suppressContactChannel(c, 'email')}>
                              Suppress email
                            </button>
                          ) : null}
                          {c.phone ? (
                            <button type="button" className="btn ghost" onClick={() => suppressContactChannel(c, 'phone')}>
                              Suppress phone
                            </button>
                          ) : null}
                          {c.phone ? (
                            <button type="button" className="btn ghost" onClick={() => suppressContactChannel(c, 'sms')}>
                              Suppress SMS
                            </button>
                          ) : null}
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
                              value={
                                milestoneEdits[m.key] !== undefined
                                  ? milestoneEdits[m.key]
                                  : (m.value ?? '')
                              }
                              onChange={(e) =>
                                setMilestoneEdits((prev) => ({ ...prev, [m.key]: e.target.value }))
                              }
                              onBlur={(e) => {
                                if (String(e.target.value) !== String(m.value ?? '')) {
                                  saveMilestone(m, e.target.value).then(() => {
                                    setMilestoneEdits((prev) => {
                                      const next = { ...prev };
                                      delete next[m.key];
                                      return next;
                                    });
                                  });
                                } else {
                                  setMilestoneEdits((prev) => {
                                    const next = { ...prev };
                                    delete next[m.key];
                                    return next;
                                  });
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
                  <h3>Official evidence timestamps</h3>
                  <p className="muted">
                    Source event date is from the jurisdiction payload. Observed / last successful check
                    are when this app saw the record — not interchangeable.
                  </p>
                  <ul className="history">
                    <li>
                      Source event:{' '}
                      <span className="mono">{detail.source_event_at || '—'}</span>
                    </li>
                    <li>
                      Publication:{' '}
                      <span className="mono">{detail.source_publication_at || 'unavailable / —'}</span>
                    </li>
                    <li>
                      Observed:{' '}
                      <span className="mono">
                        {detail.source_observed_at || detail.last_checked_at || '—'}
                      </span>
                    </li>
                    <li>
                      Last successful check:{' '}
                      <span className="mono">{detail.last_successful_check_at || '—'}</span>
                      {detail.last_check_outcome ? (
                        <span className="muted"> · {detail.last_check_outcome}</span>
                      ) : null}
                    </li>
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
                        <strong>{historyFieldLabel(h.field)}</strong> · {h.changed_by} · {h.source}
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

      {tab === 'opportunities' && (
        <div className="panel stack">
          <h2>Opportunities — public activity discovery</h2>
          <p className="muted">
            Workbook-free Fairfax County browse for residential builder/developer relationship
            prospecting. Separate from Permits table search and from Run Fairfax checks (known-ID
            re-check).             Opportunities stay workspace-private and never auto-convert into marketing
            leads. Contact review handoff is fixture/sandbox only — live enriched-lead pilot{' '}
            <strong>BLOCKED</strong> (spend cap 0). Never invents borrower identity.
          </p>

          <div className="banner warn" role="region" aria-label="Coverage limitations">
            <strong>Coverage limitations (ack before search)</strong>
            <ul className="history">
              {(oppCoverage?.sources || [])
                .filter((s) => s.jurisdiction_code === 'fairfax_county')
                .flatMap((s) => s.limitations || [])
                .map((l) => (
                  <li key={l}>{l}</li>
                ))}
              {(oppCoverage?.sources || [])
                .filter((s) => s.status === 'unsupported')
                .map((s) => (
                  <li key={s.jurisdiction_code}>
                    {s.label}: unsupported — {(s.limitations || [])[0] || 'no live discovery'}
                  </li>
                ))}
            </ul>
            <p className="muted">
              Transparent match rules (not AI scores):{' '}
              {(oppCoverage?.match_rules || [])
                .map((r) => r.label)
                .slice(0, 5)
                .join(' · ')}
            </p>
            <label className="muted" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={oppCoverageAck}
                onChange={(e) => setOppCoverageAck(e.target.checked)}
              />
              I understand issued-only Fairfax coverage is not early-intent LO signal
            </label>
          </div>

          <h3>Discover (Fairfax public layer)</h3>
          <div className="toolbar">
            <select
              value={oppSearchForm.jurisdiction_code}
              onChange={(e) =>
                setOppSearchForm((f) => ({ ...f, jurisdiction_code: e.target.value }))
              }
            >
              <option value="fairfax_county">Fairfax County (supported)</option>
              <option value="loudoun_county">Loudoun (unsupported)</option>
              <option value="prince_william_county">Prince William (unsupported)</option>
              <option value="west_virginia">West Virginia (unsupported)</option>
            </select>
            <label className="muted">
              Issued from{' '}
              <input
                type="date"
                value={oppSearchForm.issued_from}
                onChange={(e) => setOppSearchForm((f) => ({ ...f, issued_from: e.target.value }))}
              />
            </label>
            <label className="muted">
              Issued to{' '}
              <input
                type="date"
                value={oppSearchForm.issued_to}
                onChange={(e) => setOppSearchForm((f) => ({ ...f, issued_to: e.target.value }))}
              />
            </label>
            <input
              placeholder="APPTYPEALIAS contains (e.g. Residential)"
              value={oppSearchForm.app_type_alias}
              onChange={(e) => setOppSearchForm((f) => ({ ...f, app_type_alias: e.target.value }))}
            />
            <input
              placeholder="Address contains"
              value={oppSearchForm.address_contains}
              onChange={(e) =>
                setOppSearchForm((f) => ({ ...f, address_contains: e.target.value }))
              }
            />
            <input
              placeholder="RECORD_STATUS equals"
              value={oppSearchForm.record_status}
              onChange={(e) => setOppSearchForm((f) => ({ ...f, record_status: e.target.value }))}
            />
            <button
              type="button"
              className="btn primary"
              disabled={busy || !oppCoverageAck}
              onClick={runOppSearch}
            >
              Search public activity
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => saveOppSearchCriteria('dynamic')}
            >
              Save dynamic criteria
            </button>
          </div>

          {oppSearchResult ? (
            <div className={`attention-item ${oppSearchResult.status === 'failed' || oppSearchResult.status === 'unsupported' ? 'warn' : ''}`}>
              <strong>
                Result status: {oppSearchResult.status}
              </strong>
              <div>{oppSearchResult.message}</div>
              <div className="muted">
                Page {oppSearchResult.page?.offset ?? 0} · showing {oppSearchResult.page?.limit ?? 0}{' '}
                (cap {oppSearchResult.page?.limitRequested ?? 25}) · zero / partial / unsupported /
                failed are distinct outcomes
              </div>
              <div className="toolbar" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || !oppSelectedHits.size}
                  onClick={saveSelectedHits}
                >
                  Add selected to private watchlist ({oppSelectedHits.size})
                </button>
              </div>
              <div className="opp-results">
                {(oppSearchResult.results || []).map((r) => (
                  <article key={r.officialId} className="opp-card">
                    <header>
                      <label>
                        <input
                          type="checkbox"
                          checked={oppSelectedHits.has(r.officialId)}
                          onChange={(e) => {
                            setOppSelectedHits((prev) => {
                              const n = new Set(prev);
                              if (e.target.checked) n.add(r.officialId);
                              else n.delete(r.officialId);
                              return n;
                            });
                          }}
                        />{' '}
                        <span className="mono">{r.officialId}</span>
                      </label>
                      {r.already_saved ? <span className="pill warn">already saved</span> : null}
                      <span className="pill">{r.intent_label}</span>
                    </header>
                    <p>{r.activity_summary}</p>
                    <p className="muted">
                      Type: {r.permitType || '—'} · Status: {r.sourceNativeStatus || '—'} · Issued:{' '}
                      {r.issuedDate || '—'} · Event: {r.sourceEventAt || '—'}
                    </p>
                    <p className="muted">
                      Address: {r.address || '—'}
                      {r.city ? `, ${r.city}` : ''} · Parcel: {r.parcel || '—'}
                    </p>
                    <p className="muted">
                      Company evidence: {r.companyEvidence || 'unavailable on this layer'} · Role
                      evidence: {r.roleEvidence || 'unavailable on this layer'}
                    </p>
                    <p className="muted">
                      Why match:{' '}
                      {(r.match_reasons || []).map((m) => m.detail || m.rule).join(' · ') || '—'}
                    </p>
                    <p className="muted">Limitations: {(r.limitations || []).join(' · ')}</p>
                    <p className="muted">{r.intent_note}</p>
                  </article>
                ))}
              </div>
            </div>
          ) : null}

          <h3>Private pipeline</h3>
          <div className="toolbar">
            <select
              value={oppPipelineFilter}
              onChange={(e) => {
                setOppPipelineFilter(e.target.value);
              }}
              onBlur={() => refreshOppPipeline().catch((e) => setMessage(String(e.message || e)))}
            >
              <option value="">All dispositions</option>
              {OPP_DISPOSITIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => refreshOppPipeline().catch((e) => setMessage(String(e.message || e)))}
            >
              Refresh pipeline
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !oppSelectedIds.size}
              onClick={() => saveOppSearchCriteria('static_list')}
            >
              Save static selected list
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || oppSelectedIds.size < 2}
              onClick={async () => {
                setBusy(true);
                try {
                  const out = await api('/api/opportunity-groups/propose', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ opportunityIds: [...oppSelectedIds] }),
                  });
                  setMessage(
                    `Proposed ${out.groups?.length || 0} group(s) from parcel/address evidence (reversible)`
                  );
                  await refreshOppPipeline();
                } catch (e) {
                  setMessage(String(e.message || e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Group selected (evidence)
            </button>
            {oppSelectedIds.size ? (
              <a
                className="btn"
                href={`/api/opportunities-export.xlsx?${new URLSearchParams({
                  selectedIds: [...oppSelectedIds].join(','),
                })}`}
              >
                Export selected ({oppSelectedIds.size})
              </a>
            ) : (
              <a className="btn" href="/api/opportunities-export.xlsx">
                Export pipeline
              </a>
            )}
            <button
              type="button"
              className="btn"
              disabled={busy}
              data-testid="opp-coord-handoff-preview"
              onClick={previewOppCoordHandoff}
            >
              Preview opportunity handoff
            </button>
            <a
              className="btn"
              data-testid="opp-coord-handoff-export"
              href={`/api/handoffs/opportunity.xlsx?${new URLSearchParams({
                ...(oppSelectedIds.size
                  ? { selectedIds: [...oppSelectedIds].join(',') }
                  : {}),
                ...(handoffIncludeSensitive ? { includeSensitive: '1' } : {}),
              })}`}
            >
              Export opportunity handoff
            </a>
          </div>
          {oppCoordHandoffPreview ? (
            <div className="attention-item" data-testid="opp-coord-handoff-result">
              Opportunity handoff counts: total {oppCoordHandoffPreview.counts?.total} · qualified{' '}
              {oppCoordHandoffPreview.counts?.qualified} · follow-up{' '}
              {oppCoordHandoffPreview.counts?.followUp} · contact review{' '}
              {oppCoordHandoffPreview.counts?.needsContactReview} · sensitive omitted:{' '}
              {(oppCoordHandoffPreview.sensitiveColumnsOmitted || []).join(', ') || 'none'}
              <ul className="history">
                {(oppCoordHandoffPreview.preview || []).slice(0, 5).map((r) => (
                  <li key={r.opportunity_id}>
                    {r.official_id} · {r.disposition} · role {r.role_evidence} · freshness{' '}
                    {r.source_freshness || 'unknown'} · {r.permitted_scope?.slice(0, 80)}…
                  </li>
                ))}
              </ul>
              <div className="muted">{oppCoordHandoffPreview.note}</div>
            </div>
          ) : null}

          <div className="layout">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th>Official ID</th>
                    <th>Activity</th>
                    <th>Disposition</th>
                    <th>Assignee</th>
                    <th>Next</th>
                    <th>Group</th>
                  </tr>
                </thead>
                <tbody>
                  {oppPipeline.length === 0 ? (
                    <tr>
                      <td colSpan={7}>
                        <span className="muted">
                          Empty watchlist — search Fairfax public activity above (blank workspace
                          OK).
                        </span>
                      </td>
                    </tr>
                  ) : (
                    oppPipeline.map((o) => (
                      <tr
                        key={o.id}
                        className={oppDetail?.id === o.id ? 'selected' : ''}
                        onClick={() => {
                          setOppDetail(o);
                          setOppLinkPermitId(o.linked_permit_record_id ? String(o.linked_permit_record_id) : '');
                        }}
                      >
                        <td>
                          <input
                            type="checkbox"
                            checked={oppSelectedIds.has(o.id)}
                            onChange={(e) => {
                              e.stopPropagation();
                              setOppSelectedIds((prev) => {
                                const n = new Set(prev);
                                if (e.target.checked) n.add(o.id);
                                else n.delete(o.id);
                                return n;
                              });
                            }}
                          />
                        </td>
                        <td className="mono">{o.official_id}</td>
                        <td>{o.activity_summary}</td>
                        <td>{o.disposition_label || o.disposition}</td>
                        <td>{o.assignee || '—'}</td>
                        <td>
                          {o.next_action || '—'}
                          {o.next_action_due ? ` · ${o.next_action_due}` : ''}
                        </td>
                        <td>{o.group_id || '—'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <aside className="detail">
              {oppDetail ? (
                <>
                  <h3 className="mono">{oppDetail.official_id}</h3>
                  <p>{oppDetail.activity_summary}</p>
                  <p className="muted">
                    Intent: issued_activity — not early-intent. Company/role:{' '}
                    {oppDetail.company_evidence || 'unavailable'} /{' '}
                    {oppDetail.role_evidence || 'unavailable'}
                  </p>
                  <div className="field">
                    <label htmlFor="opp-disp">Disposition</label>
                    <select
                      id="opp-disp"
                      value={oppDetail.disposition}
                      onChange={(e) => patchOpp(oppDetail.id, { disposition: e.target.value })}
                    >
                      {OPP_DISPOSITIONS.map((d) => (
                        <option key={d.value} value={d.value}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="opp-assignee">Assignee</label>
                    <input
                      id="opp-assignee"
                      value={oppDetail.assignee || ''}
                      onChange={(e) =>
                        setOppDetail((d) => ({ ...d, assignee: e.target.value }))
                      }
                      onBlur={() => patchOpp(oppDetail.id, { assignee: oppDetail.assignee })}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="opp-reason">Reason</label>
                    <input
                      id="opp-reason"
                      value={oppDetail.reason || ''}
                      onChange={(e) => setOppDetail((d) => ({ ...d, reason: e.target.value }))}
                      onBlur={() => patchOpp(oppDetail.id, { reason: oppDetail.reason })}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="opp-next">Next action</label>
                    <input
                      id="opp-next"
                      value={oppDetail.next_action || ''}
                      onChange={(e) =>
                        setOppDetail((d) => ({ ...d, next_action: e.target.value }))
                      }
                      onBlur={() =>
                        patchOpp(oppDetail.id, {
                          next_action: oppDetail.next_action,
                          next_action_due: oppDetail.next_action_due,
                        })
                      }
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="opp-due">Next action date</label>
                    <input
                      id="opp-due"
                      type="date"
                      value={oppDetail.next_action_due || ''}
                      onChange={(e) =>
                        setOppDetail((d) => ({ ...d, next_action_due: e.target.value }))
                      }
                      onBlur={() =>
                        patchOpp(oppDetail.id, { next_action_due: oppDetail.next_action_due })
                      }
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="opp-link">Link existing import permit id</label>
                    <div className="toolbar">
                      <input
                        id="opp-link"
                        className="mono"
                        placeholder="permit_records.id"
                        value={oppLinkPermitId}
                        onChange={(e) => setOppLinkPermitId(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => linkOppToProject(oppDetail.id)}
                      >
                        Link project
                      </button>
                      {oppDetail.linked_permit_record_id ? (
                        <button
                          type="button"
                          className="btn ghost"
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true);
                            try {
                              const data = await api(
                                `/api/opportunities/${oppDetail.id}/unlink-project`,
                                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
                              );
                              setOppDetail(data.item);
                              await refreshOppPipeline();
                            } catch (e) {
                              setMessage(String(e.message || e));
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          Unlink
                        </button>
                      ) : null}
                    </div>
                    <p className="muted">Never invents a lot — import permit/lot must already exist.</p>
                  </div>
                  <p className="muted">
                    Why match:{' '}
                    {(oppDetail.match_reasons || [])
                      .map((m) => m.detail || m.rule)
                      .join(' · ') || '—'}
                  </p>
                  <h4>Contact review handoff</h4>
                  <p className="muted">
                    Select sought role before any lookup. Property activity ≠ borrower. Fixture cost
                    remains $0; live purchase path stays blocked.
                  </p>
                  <div className="field">
                    <label htmlFor="opp-sought-role">Sought role</label>
                    <select
                      id="opp-sought-role"
                      value={oppSoughtRole}
                      onChange={(e) => {
                        setOppSoughtRole(e.target.value);
                        setOppHandoffPreview(null);
                        setOppContactResults(null);
                      }}
                    >
                      <option value="">— choose role —</option>
                      {SOUGHT_ROLE_OPTIONS.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="toolbar">
                    <button
                      type="button"
                      className="btn"
                      disabled={busy || !oppSoughtRole}
                      onClick={previewOppContactHandoff}
                    >
                      Cost preview ({oppSelectedIds.size || 1})
                    </button>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busy || !oppHandoffPreview?.preview?.purchaseAllowed}
                      onClick={confirmOppContactHandoff}
                      data-testid="opp-contact-confirm"
                    >
                      Run fixture contact review
                    </button>
                  </div>
                  {oppHandoffPreview ? (
                    <div className="attention-item" data-testid="opp-handoff-preview">
                      <strong>
                        Preview · live {oppHandoffPreview.preview?.liveEnrichmentStatus || '—'}
                      </strong>
                      <div>
                        Deduped: {oppHandoffPreview.preview?.deduplicatedTargetCount ?? 0} · Max $
                        {oppHandoffPreview.preview?.maxEstimatedUsd ?? 0} · Mode:{' '}
                        {oppHandoffPreview.preview?.providerMode} · Budget:{' '}
                        {oppHandoffPreview.preview?.availableBudgetCredits}
                      </div>
                      {(oppHandoffPreview.ambiguous || []).length ? (
                        <div className="muted">
                          Ambiguous / skipped:{' '}
                          {oppHandoffPreview.ambiguous
                            .map((a) => `${a.officialId} (${a.reason})`)
                            .join(' · ')}
                        </div>
                      ) : null}
                      <div className="muted">{oppHandoffPreview.borrowerNote}</div>
                    </div>
                  ) : null}
                  {oppContactResults?.results ? (
                    <ul className="history" data-testid="opp-contact-results">
                      {oppContactResults.results.map((r) => (
                        <li key={r.opportunityId}>
                          <span className="mono">{r.officialId}</span> · sought {r.soughtRole} ·{' '}
                          {r.saved?.length || 0} candidate(s) · credits {r.actualCredits ?? 0}
                          {(r.saved || []).map((c) => (
                            <div key={c.id} className="muted">
                              {c.full_name || c.company} · {c.role} · {c.status}
                            </div>
                          ))}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : (
                <p className="muted">Select a pipeline row to qualify, assign follow-up, or link.</p>
              )}
            </aside>
          </div>

          <h3>Saved searches</h3>
          <ul className="history">
            {oppSearches.length === 0 ? (
              <li className="muted">No saved dynamic criteria or static lists yet.</li>
            ) : (
              oppSearches.map((s) => (
                <li key={s.id}>
                  <strong>{s.name}</strong> · {s.kind}
                  {s.last_reviewed_at ? ` · last review ${s.last_reviewed_at}` : ' · never reviewed'}
                  <button
                    type="button"
                    className="btn"
                    style={{ marginLeft: 8 }}
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const data = await api(`/api/opportunity-searches/${s.id}/run`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: '{}',
                        });
                        if (s.kind === 'dynamic') setOppSearchResult(data);
                        setMessage(
                          `${data.message || 'Ran search'} · new-since-review flags applied when watermark set`
                        );
                      } catch (e) {
                        setMessage(String(e.message || e));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Run
                  </button>
                  <button
                    type="button"
                    className="btn"
                    style={{ marginLeft: 4 }}
                    disabled={busy}
                    onClick={async () => {
                      await api(`/api/opportunity-searches/${s.id}/reviewed`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: '{}',
                      });
                      setMessage('Watermark set — New since last review');
                      await refreshOppPipeline();
                    }}
                  >
                    Mark reviewed
                  </button>
                </li>
              ))
            )}
          </ul>

          <h3>Candidate groups</h3>
          <p className="muted">
            Related permits grouped by parcel or address stem when evidence allows. Links are
            proposed until reviewed; unlinking is reversible. No per-row contact charges.
          </p>
          {oppGroups.length === 0 ? (
            <p className="muted">No groups yet — select 2+ related pipeline rows and Group selected.</p>
          ) : (
            oppGroups.map((g) => (
              <div key={g.id} className="attention-item">
                <strong>
                  {g.label}
                </strong>{' '}
                <span className="pill">{g.link_status}</span>
                <div className="muted">
                  Evidence: {g.evidence?.rule || '—'} · {g.member_count} members · {g.disposition}
                </div>
                <div className="toolbar">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={async () => {
                      await api(`/api/opportunity-groups/${g.id}/link-status`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status: 'reviewed' }),
                      });
                      await refreshOppPipeline();
                    }}
                  >
                    Mark reviewed
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={busy}
                    onClick={async () => {
                      await api(`/api/opportunity-groups/${g.id}/link-status`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status: 'unlinked' }),
                      });
                      await refreshOppPipeline();
                    }}
                  >
                    Unlink (reversible)
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'attention' && (
        <div className="panel stack">
          <h2>Attention — morning meeting</h2>
          <p className="muted">
            Approaching starts, readiness blockers, needs-verification gaps, revision impact
            (review — not auto-invalidation), official changes, overdue actions, unresolved matching,
            and no-progress (progress_anchor). Acknowledge hides an item from this list; it does not
            fix the underlying issue — use Open record or conflict controls for that.
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
          {openRevisions.length > 0 ? (
            <div className="attention-item warn">
              <strong>Open permit revisions: {openRevisions.length}</strong>
              <p className="muted" style={{ margin: '4px 0 8px' }}>
                Received-revised-permit is still blank. Review impact on linked lots — do not treat as
                auto-invalidation.
              </p>
              <ul className="history">
                {openRevisions.map((r) => (
                  <li key={r.id}>
                    <div>
                      {r.community_code || '—'} / {r.lot || '—'}
                      {r.reason ? ` · ${r.reason}` : ''}
                    </div>
                    <div className="muted">
                      Submitted {r.date_submitted || '—'} · revised start {r.revised_start_sheet || '—'}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {incompleteMasterfile.length > 0 ? (
            <div className="attention-item">
              <strong>Incomplete masterfile rows: {incompleteMasterfile.length}</strong>
              <p className="muted" style={{ margin: '4px 0 8px' }}>
                Plan-tracker rows missing an approved date. Read-only — coordinate outside the app or
                re-import when the workbook advances.
              </p>
              <ul className="history">
                {incompleteMasterfile.map((m) => (
                  <li key={m.id}>
                    <div>
                      {m.neighborhood || m.product_name || m.house_type || `Row ${m.id}`}
                      {m.product_name ? ` · ${m.product_name}` : ''}
                    </div>
                    <div className="muted">
                      Missing: {(m.missing || []).join(', ') || 'date_approved'}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {conflicts.length > 0 ? (
            <div className="attention-item warn">
              <strong>Import conflicts pending: {conflicts.length}</strong>
              <ul className="history">
                {conflicts.map((c) => (
                  <li key={c.id}>
                    <div>
                      {c.community_name} / {c.lot_label} · {c.field}
                    </div>
                    <div className="muted mono">
                      app={c.app_value ?? '∅'} vs incoming={c.incoming_value ?? '∅'}
                    </div>
                    <div className="empty-actions" style={{ marginTop: 6 }}>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => resolveImportConflict(c, 'keep_app')}
                      >
                        Keep app
                      </button>
                      <button
                        type="button"
                        className="btn primary"
                        disabled={busy}
                        onClick={() => resolveImportConflict(c, 'take_incoming')}
                      >
                        Take incoming
                      </button>
                      {c.permit_record_id ? (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            setTab('permits');
                            openDetail(c.permit_record_id);
                          }}
                        >
                          Open record
                        </button>
                      ) : null}
                    </div>
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
                  {a.readiness_state ? ` · workbook ${a.readiness_state}` : ''}
                </div>
                <div>{a.message}</div>
                <div className="muted">
                  Owner: {a.owner || '—'} · Next: {a.next_action || '—'}
                  {a.next_action_due ? ` · Due ${a.next_action_due}` : ''}
                </div>
                <div className="muted mono">{a.primary_official_id || '—'}</div>
                <div className="empty-actions" style={{ marginTop: 6 }}>
                  {a.permit_record_id ? (
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => {
                        setTab('permits');
                        openDetail(a.permit_record_id);
                      }}
                    >
                      Open record
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn"
                    onClick={async () => {
                      await api(`/api/attention/${a.id}/ack`, { method: 'POST' });
                      setAttention((await api('/api/attention')).items);
                    }}
                  >
                    Acknowledge (hide only)
                  </button>
                </div>
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
              Choose workbook to preview
              <input
                type="file"
                accept=".xlsx,.xlsm"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) previewFile(f);
                }}
              />
            </label>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !importPreview?.previewId}
              onClick={commitPreviewedWorkbook}
              title="Commits the exact file that was previewed (no re-selection)"
            >
              Commit previewed workbook
            </button>
          </div>
          {importPreview ? (
            <>
              <div>
                <strong>{importPreview.filename}</strong>
                {importPreview.previewId ? (
                  <span className="muted"> · preview ready to commit</span>
                ) : null}
                <div>
                  {importPreview.sectionCount} sections · {importPreview.rowCount} lot/permit rows ·{' '}
                  {importPreview.revisions} revisions · {importPreview.masterfile} masterfile ·{' '}
                  {importPreview.mstIds} MST IDs
                  {importPreview.archivedRowCount
                    ? ` · ${importPreview.archivedRowCount} archived rows stored`
                    : ''}
                </div>
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
          {isOwner ? (
            <>
              <h2>Source discovery proposals (owner)</h2>
              <p className="muted">
                Cheap catalog proposals only — never auto-activate. Human approval required; use
                Activate on a verified/reviewed source separately. Broad API hunter deferred.
              </p>
              <div className="toolbar">
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  data-testid="source-proposals-run"
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const out = await api('/api/assistant/source-proposals', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({}),
                      });
                      setSourceProposals(out.proposals || []);
                      setMessage(
                        `Proposed ${out.count || 0} source(s) — proposal-only (${out.ai?.state || 'unavailable'})`
                      );
                    } catch (e) {
                      setMessage(String(e.message || e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Propose catalog sources
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    refreshSourceProposals()
                      .then(() => setMessage('Source proposals refreshed'))
                      .catch((e) => setMessage(String(e.message || e)))
                  }
                >
                  Refresh proposals
                </button>
              </div>
              {sourceProposals.length ? (
                <ul className="history" data-testid="source-proposals-list">
                  {sourceProposals.map((p) => (
                    <li key={p.id}>
                      <strong>{p.label}</strong> · {p.jurisdiction_code} · {p.status}
                      <div className="muted mono">{p.endpoint}</div>
                      <div className="muted">{p.rationale}</div>
                      {p.status === 'proposed' ? (
                        <div className="empty-actions" style={{ marginTop: 6 }}>
                          <button
                            type="button"
                            className="btn"
                            disabled={busy}
                            onClick={async () => {
                              setBusy(true);
                              try {
                                await api(`/api/assistant/source-proposals/${p.id}/ack`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ decision: 'approved_for_review' }),
                                });
                                await refreshSourceProposals();
                                setMessage(
                                  'Marked approved_for_review — still not activated. Use Sources activate after human review.'
                                );
                              } catch (e) {
                                setMessage(String(e.message || e));
                              } finally {
                                setBusy(false);
                              }
                            }}
                          >
                            Approve for review
                          </button>
                          <button
                            type="button"
                            className="btn"
                            disabled={busy}
                            onClick={async () => {
                              setBusy(true);
                              try {
                                await api(`/api/assistant/source-proposals/${p.id}/ack`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ decision: 'rejected' }),
                                });
                                await refreshSourceProposals();
                                setMessage('Proposal rejected');
                              } catch (e) {
                                setMessage(String(e.message || e));
                              } finally {
                                setBusy(false);
                              }
                            }}
                          >
                            Reject
                          </button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No open proposals.</p>
              )}
              <h2>Create trial user</h2>
              <p className="muted">
                Owner-only. Enter login + password privately — no email invitation. Creates an{' '}
                <span className="mono">operator</span> who can run workbook workflows but cannot
                administer users, activate sources, or change paid-provider settings.
              </p>
              <div className="fields">
                <div className="field">
                  <label htmlFor="create-user-email">Login (email)</label>
                  <input
                    id="create-user-email"
                    type="email"
                    autoComplete="off"
                    value={createUserForm.email}
                    onChange={(e) =>
                      setCreateUserForm((f) => ({ ...f, email: e.target.value }))
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor="create-user-password">Password (≥10)</label>
                  <input
                    id="create-user-password"
                    type="password"
                    autoComplete="new-password"
                    value={createUserForm.password}
                    onChange={(e) =>
                      setCreateUserForm((f) => ({ ...f, password: e.target.value }))
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor="create-user-name">Display name (optional)</label>
                  <input
                    id="create-user-name"
                    type="text"
                    autoComplete="off"
                    value={createUserForm.displayName}
                    onChange={(e) =>
                      setCreateUserForm((f) => ({ ...f, displayName: e.target.value }))
                    }
                  />
                </div>
              </div>
              <button
                type="button"
                className="btn primary"
                disabled={busy || !createUserForm.email || createUserForm.password.length < 10}
                onClick={createTrialUser}
              >
                Create operator
              </button>
              {usersList.length ? (
                <ul className="history">
                  {usersList.map((u) => (
                    <li key={u.id}>
                      <span className="mono">{u.email}</span> · {u.role}
                      {u.active ? '' : ' · inactive'}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <div className="banner warn">
              Source activation and user administration are owner-only. Operators can still check
              permits when a source is already activated and the AHJ is confirmed.
            </div>
          )}

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
                    {!s.activated && s.state === 'verified' && isOwner ? (
                      <>
                        {' '}
                        <button type="button" className="btn" disabled={busy} onClick={() => activateSourceKey(s.key)}>
                          Review & activate
                        </button>
                      </>
                    ) : null}
                    {!s.activated && s.state === 'verified' && !isOwner ? (
                      <span className="muted"> · waiting for owner activation</span>
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
          <p className="muted">
            Verified vs speculative kept separate. Activation requires an executable adapter + config —
            adapter_type strings alone are not enough. ArcGIS ≠ automatically supported.
          </p>
          {sources.map((s) => (
            <div key={s.key} className="attention-item">
              <div>
                <strong>{s.key}</strong>{' '}
                <span className={`pill ${s.state === 'verified' ? 'live' : 'warn'}`}>{s.state}</span>
                {s.activated ? <span className="pill live">activated</span> : null}
                {s.adapter_operational ? (
                  <span className="pill live">ops adapter</span>
                ) : (
                  <span className="pill warn">no ops adapter</span>
                )}
              </div>
              <div className="mono">
                {s.jurisdiction_code} · {s.platform} · {s.adapter_type}
              </div>
              <div>{s.coverage_limitations}</div>
              {s.capabilities ? (
                <div className="muted">
                  Caps: applications={String(s.capabilities.applications)} · issued=
                  {String(s.capabilities.issued)} · fetch={String(s.capabilities.fetch)} · refresh=
                  {String(s.capabilities.refresh)}
                </div>
              ) : null}
              {!s.activatable && s.activation_blocker ? (
                <div className="muted">Activation blocked: {s.activation_blocker}</div>
              ) : null}
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
          <p className="muted">
            Stable jurisdiction codes. Unsupported markets (Loudoun, PWC, West Virginia, City of Fairfax)
            stay labeled unsupported — checks return unavailable, never fabricated live results.
          </p>
          {connectors.map((c) => (
            <div key={c.code} className="attention-item">
              <div>
                <strong>{c.label}</strong>{' '}
                <span className={`pill ${c.mode}`}>{c.mode}</span>
              </div>
              <div className="mono">{c.code}</div>
              <div>{c.notes}</div>
              {c.capabilities ? (
                <div className="muted">
                  applications={String(c.capabilities.applications)} · issued=
                  {String(c.capabilities.issued)} · active_status=
                  {String(c.capabilities.active_status)} · pending=
                  {String(c.capabilities.pending)}
                </div>
              ) : null}
              <div className="muted">{c.honestLabel}</div>
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
