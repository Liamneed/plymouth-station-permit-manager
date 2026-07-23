let csrf = '';
let currentTab = 'permits';
let reconcileSession = null;

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = csrf;
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function init() {
  try {
    csrf = (await api('/api/permit-auth')).csrf;
    const status = await api('/api/database/status');
    $('dbState').textContent = status.connected ? 'Connected' : 'Unavailable';
    $('dbState').style.color = status.connected ? '#66efb4' : '#ff91a3';
    bind();
    load();
  } catch (error) {
    $('content').innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
}

function bind() {
  $('search').addEventListener('input', debounce(load, 250));
  $('status').addEventListener('change', load);
  $('refreshBtn').onclick = load;
  $('newBtn').onclick = () => openEdit();
  $('syncBtn').onclick = openReconcile;
  $('cancelBtn').onclick = () => $('editDialog').close();
  $('editForm').onsubmit = savePermit;
  $('reconcileClose').onclick = () => $('reconcileDialog').close();
  $('reconcileApply').onclick = applyReconciliation;
  document.querySelectorAll('[data-tab]').forEach(button => {
    button.onclick = () => {
      currentTab = button.dataset.tab;
      document.querySelectorAll('[data-tab]').forEach(item => item.classList.toggle('active', item === button));
      load();
    };
  });
  $('keyCancel').onclick = () => $('keyDialog').close();
  $('keyForm').onsubmit = createKey;
}

async function load() {
  if (currentTab === 'permits') return loadPermits();
  if (currentTab === 'api') return renderApi();
  if (currentTab === 'operators') return loadOperators();
  return loadLogs(currentTab);
}

function syncBadge(record) {
  const status = record.sync_status || 'not_synced';
  const label = {
    synced: 'Synced', failed: 'Sync failed', mismatch: 'Mismatch', pending: 'Pending', not_synced: 'Not synced'
  }[status] || status;
  return `<span class="badge sync-${esc(status)}" title="${esc(record.sync_message || '')}">${esc(label)}</span>`;
}

async function loadPermits() {
  const query = new URLSearchParams({ search: $('search').value, status: $('status').value });
  const data = await api('/api/database/permits?' + query);
  $('recordCount').textContent = data.records.length;
  $('dueCount').textContent = data.records.filter(row => ['due', 'expired', 'missing'].includes(row.permitStatus.key)).length;
  $('content').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Registration</th><th>Plate</th><th>Operator</th><th>Callsign</th><th>Permit</th><th>Expiry</th><th>Status</th><th>External sync</th><th>Updated</th><th></th></tr></thead><tbody>${data.records.map(row => `<tr><td class="reg">${esc(row.display_registration || row.registration)}</td><td>${esc(row.plate_number || '—')}</td><td>${esc(row.operator_name || '—')}</td><td>${esc(row.callsign || '—')}</td><td>${esc(row.permit_number || '—')}</td><td>${esc(row.expires_on ? String(row.expires_on).slice(0, 10) : '—')}</td><td><span class="badge ${esc(row.permitStatus.key)}">${esc(row.permitStatus.label)}</span></td><td>${syncBadge(row)}</td><td>${esc(row.permit_updated_at ? new Date(row.permit_updated_at).toLocaleString() : '—')}</td><td><button class="rowbtn" data-edit="${esc(row.registration)}">EDIT</button></td></tr>`).join('')}</tbody></table></div>`;
  document.querySelectorAll('[data-edit]').forEach(button => button.onclick = async () => openEdit(await api('/api/database/permits/' + button.dataset.edit)));
}

function openEdit(record = {}) {
  const form = $('editForm');
  form.reset();
  const values = {
    registration: record.registration,
    plateNumber: record.plate_number,
    operator: record.operator_name,
    callsign: record.callsign,
    permitNumber: record.permit_number,
    permitType: record.permit_type,
    validFrom: record.valid_from ? String(record.valid_from).slice(0, 10) : '',
    expiresOn: record.expires_on ? String(record.expires_on).slice(0, 10) : '',
    permitNotes: record.permit_notes
  };
  for (const [name, value] of Object.entries(values)) if (form.elements[name]) form.elements[name].value = value ?? '';
  form.elements.needACab.checked = Boolean(record.needacab);
  form.elements.permitSuspended.checked = Boolean(record.permit_suspended);
  form.elements.syncAutocab.checked = Boolean(record.needacab || record.integration_provider === 'autocab');
  form.elements.registration.readOnly = Boolean(record.registration);
  $('syncHint').textContent = record.external_vehicle_id
    ? `Linked Autocab vehicle ${record.external_vehicle_id}. The full vehicle record will be read, only motExpiryDate changed, then read again to verify.`
    : 'The vehicle will be matched by registration and plate before Autocab is changed.';
  $('formError').textContent = '';
  $('editDialog').showModal();
}

async function savePermit(event) {
  event.preventDefault();
  const formData = new FormData(event.target);
  const body = Object.fromEntries(formData);
  body.needACab = event.target.elements.needACab.checked;
  body.permitSuspended = event.target.elements.permitSuspended.checked;
  body.syncAutocab = event.target.elements.syncAutocab.checked;
  try {
    const result = await api('/api/database/permits', { method: 'POST', body: JSON.stringify(body) });
    $('editDialog').close();
    await loadPermits();
    if (result.syncResult) alert(result.syncResult.changed ? 'Permit saved and Autocab updated and verified.' : 'Permit saved. Autocab already had the same expiry date.');
  } catch (error) {
    $('formError').textContent = error.message;
  }
}

function reconcileActionOptions(row) {
  const dbDate = row.database?.expiryDate || '';
  const acDate = row.autocab?.motExpiryDate || '';
  const options = [{ value: 'none', label: 'No change' }];
  if (row.plateMatch && row.autocab && acDate) options.push({ value: row.database ? 'autocab_to_database' : 'import_autocab', label: `Use Autocab date ${acDate}` });
  if (row.plateMatch && row.database && dbDate && row.autocab) options.push({ value: 'database_to_autocab', label: `Use permit database date ${dbDate}` });
  const selected = row.recommendedAction === 'review' ? 'none' : row.recommendedAction;
  return `<select class="reconcile-action" data-reg="${esc(row.registration)}">${options.map(option => `<option value="${option.value}" ${option.value === selected ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select>`;
}

async function openReconcile() {
  $('reconcileBody').innerHTML = '<p class="muted">Loading current Autocab vehicle details and comparing them with PostgreSQL…</p>';
  $('reconcileSummary').textContent = 'Working…';
  $('reconcileApply').disabled = true;
  $('reconcileDialog').showModal();
  try {
    reconcileSession = await api('/api/database/autocab/reconcile');
    const summary = reconcileSession.summary;
    $('reconcileSummary').textContent = `${summary.total} relevant records checked · ${summary.actionable} safe automatic actions available`;
    $('reconcileBody').innerHTML = `<div class="table-wrap"><table class="reconcile-table"><thead><tr><th>Registration</th><th>Database plate</th><th>Autocab plate</th><th>Database expiry</th><th>Autocab expiry</th><th>Comparison</th><th>Action</th></tr></thead><tbody>${reconcileSession.rows.map(row => `<tr><td class="reg">${esc(row.displayRegistration)}</td><td>${esc(row.database?.plateNumber || row.database?.permitNumber || '—')}</td><td>${esc(row.autocab?.plateNumber || '—')}</td><td>${esc(row.database?.expiryDate || '—')}</td><td>${esc(row.autocab?.motExpiryDate || '—')}</td><td><span class="badge compare-${esc(row.status)}">${esc(row.status.replaceAll('_', ' '))}</span><div class="comparison-message">${esc(row.message)}</div></td><td>${reconcileActionOptions(row)}</td></tr>`).join('')}</tbody></table></div>`;
    $('reconcileApply').disabled = false;
  } catch (error) {
    $('reconcileSummary').textContent = 'Reconciliation failed';
    $('reconcileBody').innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
}

async function applyReconciliation() {
  if (!reconcileSession) return;
  const rows = [...document.querySelectorAll('.reconcile-action')]
    .map(select => ({ registration: select.dataset.reg, action: select.value }))
    .filter(row => row.action !== 'none');
  if (!rows.length) return alert('No synchronisation actions are selected.');
  if (!confirm(`Apply ${rows.length} selected synchronisation action${rows.length === 1 ? '' : 's'}?`)) return;
  $('reconcileApply').disabled = true;
  $('reconcileSummary').textContent = 'Applying and verifying updates…';
  try {
    const result = await api('/api/database/autocab/reconcile/apply', {
      method: 'POST',
      body: JSON.stringify({ sessionId: reconcileSession.sessionId, rows })
    });
    const failures = result.results.filter(row => !row.ok);
    $('reconcileSummary').textContent = `${result.updated} updated and verified · ${result.failed} failed`;
    $('reconcileBody').innerHTML = `<div class="result-grid">${result.results.map(row => `<article class="sync-result ${row.ok ? 'ok' : 'bad'}"><strong>${esc(row.registration)}</strong><span>${esc(row.action.replaceAll('_', ' '))}</span><p>${esc(row.ok ? `Verified expiry ${row.expiryDate || ''}` : row.error)}</p></article>`).join('')}</div>${failures.length ? '<p class="error">Failed items remain marked for attention in the permit database.</p>' : ''}`;
    reconcileSession = null;
    await loadPermits();
  } catch (error) {
    $('reconcileSummary').textContent = 'Update failed';
    $('reconcileBody').insertAdjacentHTML('afterbegin', `<p class="error">${esc(error.message)}</p>`);
    $('reconcileApply').disabled = false;
  }
}

async function loadOperators() {
  const data = await api('/api/database/integrations/operators');
  $('recordCount').textContent = data.records.length;
  $('dueCount').textContent = data.records.reduce((sum, row) => sum + Number(row.attention_count || 0), 0);
  $('content').innerHTML = `<div class="operator-grid">${data.records.map(row => `<article class="operator-card"><h2>${esc(row.name)}</h2><p>${esc(row.integration_type || 'manual')} integration</p><dl><div><dt>Vehicles</dt><dd>${esc(row.vehicle_count)}</dd></div><div><dt>Synced</dt><dd>${esc(row.synced_count)}</dd></div><div><dt>Attention</dt><dd>${esc(row.attention_count)}</dd></div></dl></article>`).join('')}</div>`;
}

async function loadLogs(type) {
  const data = await api(`/api/database/logs?type=${type}&search=${encodeURIComponent($('search').value)}`);
  $('recordCount').textContent = data.records.length;
  $('dueCount').textContent = '—';
  $('content').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Time</th><th>${type === 'audit' ? 'Action' : 'Level'}</th><th>${type === 'audit' ? 'Registration' : 'Category'}</th><th>Message / actor</th><th>Request</th><th>Details</th></tr></thead><tbody>${data.records.map(row => `<tr><td>${esc(new Date(row.occurred_at).toLocaleString())}</td><td>${esc(row.action || row.level)}</td><td>${esc(row.registration || row.category || '—')}</td><td>${esc(row.actor || row.message || '—')}</td><td>${esc([row.method, row.path, row.status_code].filter(Boolean).join(' '))}</td><td class="logmeta">${esc(JSON.stringify(row.after_data || row.metadata || {}))}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderApi() {
  $('recordCount').textContent = '—';
  $('dueCount').textContent = '—';
  $('content').innerHTML = `<div style="display:grid;gap:14px"><div><h2>Database API</h2><p class="muted">Read endpoint: <code>GET /api/v1/permits/:registration</code><br>Header: <code>Authorization: Bearer ppm_…</code></p></div><div><button id="createKeyBtn">CREATE API KEY</button></div><div><h3>Limited public lookup</h3><code>GET /api/public/v1/permits/:registration</code></div></div>`;
  $('createKeyBtn').onclick = () => { $('keyResult').textContent = ''; $('keyDialog').showModal(); };
}

async function createKey(event) {
  event.preventDefault();
  const form = event.target;
  const scopes = [];
  if (form.elements.read.checked) scopes.push('permit:read');
  if (form.elements.write.checked) scopes.push('permit:write');
  try {
    const data = await api('/api/database/api-keys', { method: 'POST', body: JSON.stringify({ name: form.elements.name.value, scopes }) });
    $('keyResult').textContent = data.token;
  } catch (error) {
    $('keyResult').textContent = error.message;
  }
}

function debounce(fn, milliseconds) {
  let timer;
  return () => { clearTimeout(timer); timer = setTimeout(fn, milliseconds); };
}

init();
