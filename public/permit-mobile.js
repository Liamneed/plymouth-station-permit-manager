let permits=[],activeFilter='all';
const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),norm=v=>String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
function operator(p){return p.needACab?'Need-A-Cab':'Other operator'}
function issue(p){return p.needACab&&p.plateMatch===false}
function details(p){
  if(!p.needACab)return '<span class="muted">City register only</span>';
  const state=esc(p.needACabPermitStatus||'missing');const label=esc(p.needACabPermitStatusLabel||'No permit date');
  return `<span class="detail-main ${state}">${label}</span><small>CS ${esc(p.callsign||'—')} · Autocab ${esc(p.needACabPlateNumber||'—')}${p.needACabPermitExpiryDisplay?` · ${esc(p.needACabPermitExpiryDisplay)}`:''}</small>`;
}
function row(p){
  const mismatch=issue(p)?'<span class="badge issue">Plate mismatch</span>':'';
  return `<article class="permit-row ${p.needACab?'nac':'other'} ${issue(p)?'has-issue':''}"><div class="registration"><strong>${esc(p.registration)}</strong><small>Listed in Plymouth register</small></div><div class="plate"><strong>${esc(p.plateNumber)}</strong></div><div class="operator"><span class="badge ${p.needACab?'nac':'other'}">${operator(p)}</span>${mismatch}</div><div class="details">${details(p)}</div></article>`;
}
function filteredRows(){const q=norm($('searchInput').value);return permits.filter(p=>{const search=!q||norm(p.registration).includes(q)||norm(p.plateNumber).includes(q)||norm(p.callsign).includes(q);const filter=activeFilter==='all'||(activeFilter==='nac'&&p.needACab)||(activeFilter==='other'&&!p.needACab)||(activeFilter==='issues'&&issue(p));return search&&filter;});}
function renderSummary(){const nac=permits.filter(p=>p.needACab).length,other=permits.length-nac,issues=permits.filter(issue).length;$('summary').innerHTML=`<div><span>Total</span><strong>${permits.length}</strong></div><div><span>Need-A-Cab</span><strong>${nac}</strong></div><div><span>Other</span><strong>${other}</strong></div><div><span>Issues</span><strong>${issues}</strong></div>`;}
function render(){const rows=filteredRows();const q=norm($('searchInput').value);$('statusLine').textContent=q||activeFilter!=='all'?`${rows.length} matching record${rows.length===1?'':'s'}`:`${permits.length} Plymouth permit records`;$('results').innerHTML=rows.length?rows.map(row).join(''):'<div class="empty">No matching permit record found.</div>';}
async function load(){try{const r=await fetch('/api/permit-public-search',{cache:'no-store'}),d=await r.json();if(!r.ok)throw new Error(d.error||'Unable to load register');permits=d.permits||[];renderSummary();render()}catch(e){$('statusLine').textContent=e.message;$('results').innerHTML='<div class="empty error">Permit records are temporarily unavailable.</div>'}}
$('searchInput').addEventListener('input',render);$('refreshBtn').addEventListener('click',load);document.querySelectorAll('.filters button').forEach(btn=>btn.addEventListener('click',()=>{activeFilter=btn.dataset.filter;document.querySelectorAll('.filters button').forEach(x=>x.classList.toggle('active',x===btn));render()}));load();
