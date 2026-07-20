let csrf = "";
let permits = [];
let currentFilter = "all";
let selectedVehicle = null;

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = csrf;
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) location.href = '/permit-login';
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

async function initialise() {
  try {
    const auth = await api('/api/permit-auth');
    csrf = auth.csrf;
    bindEvents();
    await loadDashboard();
  } catch (error) {
    location.href = '/permit-login';
  }
}

function bindEvents() {
  $('refreshBtn').addEventListener('click', loadDashboard);
  $('permitSearch').addEventListener('input', renderPermits);
  $('permitSort').addEventListener('change', renderPermits);
  $('createPermitBtn').addEventListener('click', () => openModal(null, 'create'));
  $('closeModalBtn').addEventListener('click', closeModal);
  $('cancelModalBtn').addEventListener('click', closeModal);
  $('permitModal').addEventListener('click', (event) => { if (event.target === $('permitModal')) closeModal(); });
  $('permitForm').addEventListener('submit', savePermit);
  $('vehiclePicker').addEventListener('input', renderVehicleChoices);
  $('refreshAuditBtn').addEventListener('click', loadAudit);
  $('refreshRegisterBtn').addEventListener('click', loadRegister);
  $('registerUploadForm').addEventListener('submit', uploadRegister);
  $('registerSearch').addEventListener('input', renderRegister);
  $('registerFilter').addEventListener('change', renderRegister);
  $('logoutBtn').addEventListener('click', async () => { await api('/api/permit-logout', { method: 'POST', body: '{}' }); location.href = '/permit-login'; });
  $('closeGwrModalBtn').addEventListener('click', closeGwrModal);
  $('cancelGwrModalBtn').addEventListener('click', closeGwrModal);
  $('gwrPermitForm').addEventListener('submit', saveGwrPermit);
  document.querySelectorAll('.summary-card').forEach(button => button.addEventListener('click', () => {
    currentFilter = button.dataset.filter;
    document.querySelectorAll('.summary-card').forEach(item => item.classList.toggle('active', item === button));
    renderPermits();
  }));
  document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(panel => panel.classList.remove('active'));
  $(`${name}Panel`).classList.add('active');
  if (name === 'audit') loadAudit();
  if (name === 'register') loadRegister();
}

async function loadDashboard() {
  $('loadingState').classList.remove('hidden');
  $('errorState').classList.add('hidden');
  $('permitGrid').classList.add('hidden');
  try {
    const data = await api('/api/permit-dashboard');
    permits = data.permits || [];
    updateSummary(data.summary || {});
    $('lastUpdated').textContent = `Updated ${new Date(data.generatedAt).toLocaleString('en-GB')}`;
    renderPermits();
  } catch (error) {
    $('errorState').textContent = error.message;
    $('errorState').classList.remove('hidden');
  } finally {
    $('loadingState').classList.add('hidden');
  }
}

function updateSummary(summary) {
  const map = { all: 'total', valid: 'valid', expiring: 'expiring', expired: 'expired', missing: 'missing' };
  document.querySelectorAll('.summary-card').forEach(card => {
    card.querySelector('strong').textContent = summary[map[card.dataset.filter]] ?? 0;
  });
}

function renderPermits() {
  const query = $('permitSearch').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const sort = $('permitSort').value;
  let rows = permits.filter(item => {
    const matchFilter = currentFilter === 'all' || item.status === currentFilter;
    const haystack = `${item.registration}${item.plateNumber}${item.callsign}`.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return matchFilter && (!query || haystack.includes(query));
  });
  rows = [...rows].sort((a, b) => {
    if (sort === 'callsign') return Number(a.callsign) - Number(b.callsign);
    if (sort === 'registration') return a.registration.localeCompare(b.registration);
    if (sort === 'status') return a.status.localeCompare(b.status) || Number(a.callsign) - Number(b.callsign);
    const ax = a.permitExpiryDate || '9999-12-31', bx = b.permitExpiryDate || '9999-12-31';
    return ax.localeCompare(bx) || Number(a.callsign) - Number(b.callsign);
  });
  $('permitGrid').innerHTML = rows.map(cardHtml).join('');
  $('permitGrid').classList.toggle('hidden', rows.length === 0);
  $('emptyState').classList.toggle('hidden', rows.length !== 0);
  document.querySelectorAll('[data-edit-id]').forEach(button => button.addEventListener('click', () => {
    const permit = permits.find(item => String(item.vehicleId) === button.dataset.editId);
    openModal(permit, permit?.permitExpiryDate ? 'update' : 'create');
  }));
  document.querySelectorAll('[data-gwr-id]').forEach(button => button.addEventListener('click', () => { const permit = permits.find(item => String(item.vehicleId) === button.dataset.gwrId); openGwrModal(permit); }));
}

function cardHtml(item) {
  const days = item.daysUntilExpiry;
  const note = days === null ? 'No expiry date held' : days < 0 ? `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue` : days === 0 ? 'Expires today' : `${days} day${days === 1 ? '' : 's'} remaining`;
  return `<article class="permit-card ${escapeHtml(item.status)}">
    <div class="card-head">
      <div><div class="callsign">Callsign ${escapeHtml(item.callsign)}</div><div class="vehicle-id">Vehicle ID ${escapeHtml(item.vehicleId)}</div></div>
      <span class="badge ${escapeHtml(item.status)}">${escapeHtml(item.statusLabel)}</span>
    </div>
    <div class="card-details">
      <div class="detail"><span>Registration</span><strong>${escapeHtml(item.registration || '—')}</strong></div>
      <div class="detail"><span>Plate number</span><strong>${escapeHtml(item.plateNumber || '—')}</strong></div>
    </div>
    <div class="expiry-block">
      <div><span>Permit expiry date</span><strong>${escapeHtml(item.permitExpiryDisplay)}</strong><div class="days-note">${escapeHtml(note)}</div></div>
    </div>
    <div class="card-actions dual"><button class="btn secondary" data-edit-id="${escapeHtml(item.vehicleId)}">${item.permitExpiryDate ? 'Update permit' : 'Create permit'}</button><button class="btn print" data-gwr-id="${escapeHtml(item.vehicleId)}">${item.gwrPermit ? 'Print GWR permit' : 'Create GWR permit'}</button></div>
  </article>`;
}

function openModal(permit, action) {
  selectedVehicle = permit || null;
  $('formAction').value = action;
  $('modalTitle').textContent = action === 'create' ? 'Create new permit' : 'Update permit';
  $('modalKicker').textContent = action === 'create' ? 'New permit record' : 'Existing permit record';
  $('savePermitBtn').textContent = action === 'create' ? 'Create permit' : 'Update permit';
  $('vehiclePickerField').classList.toggle('hidden', Boolean(permit));
  $('vehiclePicker').value = '';
  $('vehicleChoices').classList.add('hidden');
  $('formExpiry').value = permit?.permitExpiryDate || '';
  $('modalError').classList.add('hidden');
  $('modalWarning').classList.add('hidden');
  setSelectedVehicle(permit);
  $('permitModal').classList.remove('hidden');
  setTimeout(() => (permit ? $('formExpiry') : $('vehiclePicker')).focus(), 30);
}

function closeModal() {
  $('permitModal').classList.add('hidden');
  selectedVehicle = null;
}

function setSelectedVehicle(permit) {
  selectedVehicle = permit || null;
  $('selectedVehicleSummary').classList.toggle('hidden', !permit);
  $('formVehicleId').value = permit?.vehicleId || '';
  $('formCallsign').textContent = permit?.callsign || '—';
  $('formRegistration').textContent = permit?.registration || '—';
  $('formPlate').textContent = permit?.plateNumber || '—';
  $('formCurrentExpiry').textContent = permit?.permitExpiryDisplay || '—';
  if (permit) $('vehiclePicker').value = `${permit.registration} · Plate ${permit.plateNumber} · Callsign ${permit.callsign}`;
}

function renderVehicleChoices() {
  const query = $('vehiclePicker').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!query) return $('vehicleChoices').classList.add('hidden');
  const choices = permits.filter(item => `${item.registration}${item.plateNumber}${item.callsign}`.toUpperCase().replace(/[^A-Z0-9]/g, '').includes(query)).slice(0, 12);
  $('vehicleChoices').innerHTML = choices.length ? choices.map(item => `<button type="button" class="vehicle-choice" data-choice-id="${escapeHtml(item.vehicleId)}"><strong>${escapeHtml(item.callsign)}</strong><span>${escapeHtml(item.registration)}</span><span>Plate ${escapeHtml(item.plateNumber)}</span></button>`).join('') : '<div class="state-card">No matching Hackney found.</div>';
  $('vehicleChoices').classList.remove('hidden');
  document.querySelectorAll('[data-choice-id]').forEach(button => button.addEventListener('click', () => {
    const item = permits.find(row => String(row.vehicleId) === button.dataset.choiceId);
    setSelectedVehicle(item);
    $('vehicleChoices').classList.add('hidden');
    if (item?.permitExpiryDate) {
      $('modalWarning').textContent = 'This vehicle already has a permit. Saving will replace the current expiry date.';
      $('modalWarning').classList.remove('hidden');
    }
  }));
}

async function savePermit(event) {
  event.preventDefault();
  $('modalError').classList.add('hidden');
  if (!selectedVehicle) return showModalError('Select a Hackney first.');
  const expiry = $('formExpiry').value;
  if (!expiry) return showModalError('Enter the permit expiry date.');
  const action = $('formAction').value;
  const allowOverwrite = action === 'create' && Boolean(selectedVehicle.permitExpiryDate);
  $('savePermitBtn').disabled = true;
  $('savePermitBtn').textContent = 'Saving…';
  try {
    const result = await api('/api/permit-manual', { method: 'POST', body: JSON.stringify({
      vehicleId: selectedVehicle.vehicleId,
      registration: selectedVehicle.registration,
      plateNumber: selectedVehicle.plateNumber,
      permitExpiryDate: expiry,
      action,
      allowOverwrite,
    })});
    const index = permits.findIndex(item => String(item.vehicleId) === String(result.permit.vehicleId));
    if (index >= 0) permits[index] = { ...permits[index], ...result.permit };
    closeModal();
    renderPermits();
    await loadDashboard();
    showToast(result.message);
  } catch (error) {
    showModalError(error.message);
  } finally {
    $('savePermitBtn').disabled = false;
    $('savePermitBtn').textContent = action === 'create' ? 'Create permit' : 'Update permit';
  }
}

function showModalError(message) {
  $('modalError').textContent = message;
  $('modalError').classList.remove('hidden');
}

function showToast(message) {
  $('toast').textContent = message;
  $('toast').classList.remove('hidden');
  setTimeout(() => $('toast').classList.add('hidden'), 3500);
}

async function loadAudit() {
  $('auditList').innerHTML = '<div class="state-card">Loading audit history…</div>';
  try {
    const data = await api('/api/permit-audit');
    $('auditList').innerHTML = data.rows.length ? data.rows.map(row => `<article class="audit-row">
      <div><strong>${escapeHtml(row.callsign || '—')}</strong><small>${escapeHtml(row.registration || '')}</small></div>
      <div><strong>${escapeHtml(row.status || 'Update')}</strong><small>${escapeHtml(row.message || '')}</small></div>
      <div><strong>${escapeHtml(row.newExpiry || row.verifiedExpiry || '—')}</strong><small>${escapeHtml(row.timestamp ? new Date(row.timestamp).toLocaleString('en-GB') : '')}</small></div>
    </article>`).join('') : '<div class="state-card">No permit changes have been recorded yet.</div>';
  } catch (error) {
    $('auditList').innerHTML = `<div class="state-card error">${escapeHtml(error.message)}</div>`;
  }
}


async function openGwrModal(permit){
  selectedVehicle=permit; $('gwrVehicleId').value=permit.vehicleId; $('gwrCallsign').textContent=permit.callsign||'—'; $('gwrRegistration').textContent=permit.registration||'—'; $('gwrPlate').textContent=permit.plateNumber||'—'; $('gwrExpiry').textContent=permit.permitExpiryDisplay||'—'; $('gwrDriverName').value=permit.gwrPermit?.driverName||''; $('gwrDriverNumber').value=permit.gwrPermit?.driverNumber||''; $('gwrPhoto').value=''; $('gwrError').classList.add('hidden'); $('gwrModal').classList.remove('hidden'); setTimeout(()=>$('gwrDriverName').focus(),30);
}
function closeGwrModal(){ $('gwrModal').classList.add('hidden'); }
async function saveGwrPermit(event){
  event.preventDefault(); const id=$('gwrVehicleId').value; const form=new FormData(); form.append('driverName',$('gwrDriverName').value.trim()); form.append('driverNumber',$('gwrDriverNumber').value.trim()); if($('gwrPhoto').files[0])form.append('photo',$('gwrPhoto').files[0]);
  const button=$('savePrintGwrBtn');button.disabled=true;button.textContent='Saving…';$('gwrError').classList.add('hidden');
  try{const response=await fetch(`/api/gwr-permit/${encodeURIComponent(id)}`,{method:'POST',headers:{'x-csrf-token':csrf},body:form});const data=await response.json();if(!response.ok)throw new Error(data.error||'Unable to save permit');const item=permits.find(x=>String(x.vehicleId)===String(id));if(item)item.gwrPermit=data.record;closeGwrModal();renderPermits();window.open(data.printUrl,'_blank','noopener');showToast('GWR display permit saved.');}catch(error){$('gwrError').textContent=error.message;$('gwrError').classList.remove('hidden');}finally{button.disabled=false;button.textContent='Save and open printable permit';}
}


let plymouthRegister = [];
function registerRowHtml(item){
  const operator=item.needACab?'<span class="operator-badge nac">Need-A-Cab</span>':'<span class="operator-badge external">Other operator</span>';
  const compare=!item.needACab?'<span class="comparison-badge na">Register only</span>':item.plateMatch?'<span class="comparison-badge ok">Plate matches</span>':'<span class="comparison-badge issue">Plate mismatch</span>';
  const detail=item.needACab?`Callsign ${escapeHtml(item.callsign||'—')} · Autocab ${escapeHtml(item.needACabPlateNumber||'—')}`:'Not managed in Need-A-Cab Autocab';
  return `<div class="register-row"><span class="reg-strong">${escapeHtml(item.registration)}</span><span>${escapeHtml(item.plateNumber)}</span>${operator}${compare}<span>${detail}</span></div>`;
}
function renderRegister(){
  const q=($('registerSearch')?.value||'').toUpperCase().replace(/[^A-Z0-9]/g,'');const filter=$('registerFilter')?.value||'all';
  const rows=plymouthRegister.filter(item=>{const search=!q||`${item.registration}${item.plateNumber}${item.callsign||''}${item.needACabPlateNumber||''}`.toUpperCase().replace(/[^A-Z0-9]/g,'').includes(q);const show=filter==='all'||(filter==='needacab'&&item.needACab)||(filter==='external'&&!item.needACab)||(filter==='issues'&&item.needACab&&item.plateMatch===false);return search&&show;});
  $('registerTable').innerHTML=`<div class="register-row header"><span>Registration</span><span>Plymouth plate</span><span>Operator</span><span>Comparison</span><span>Need-A-Cab detail</span></div>${rows.map(registerRowHtml).join('')||'<div class="state-card">No register records match this view.</div>'}`;
}
async function loadRegister(){
  $('registerTable').innerHTML='<div class="state-card">Loading Plymouth register…</div>';
  try{const data=await api('/api/plymouth-register');plymouthRegister=data.records||[];const s=data.summary||{};const values=[s.total,s.needACabVehicles,s.matchedNeedACab,s.plateMismatches,s.missingNeedACab];document.querySelectorAll('#registerSummary strong').forEach((el,i)=>el.textContent=values[i]??0);$('registerUpdated').textContent=`${s.total||0} records · Updated ${data.updatedAt?new Date(data.updatedAt).toLocaleString('en-GB'):'not yet'} · ${data.sourceFile||'No source file'}`;renderRegister();}catch(error){$('registerTable').innerHTML=`<div class="state-card error">${escapeHtml(error.message)}</div>`;}
}
async function uploadRegister(event){event.preventDefault();const file=$('registerFile').files[0];if(!file)return;const form=new FormData();form.append('file',file);const button=$('uploadRegisterBtn');button.disabled=true;button.textContent='Uploading…';$('registerMessage').classList.add('hidden');try{const data=await api('/api/plymouth-register-upload',{method:'POST',body:form});$('registerMessage').textContent=data.message;$('registerMessage').className='inline-message success';$('registerFile').value='';await loadRegister();}catch(error){$('registerMessage').textContent=error.message;$('registerMessage').className='inline-message error';}finally{button.disabled=false;button.textContent='Upload register';}}

initialise();
