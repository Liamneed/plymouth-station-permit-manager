let permits=[],activeFilter='all';
const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),norm=v=>String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
function issue(p){return p.needACab&&p.plateMatch===false}
function permitState(p){
  if(!p.needACab)return {key:'valid',label:'VALID PERMIT',title:'Current permit record listed in the Plymouth register'};
  if(issue(p))return {key:'issue',label:'MISMATCH',title:`Plymouth plate ${p.plateNumber||'—'} does not match Autocab plate ${p.needACabPlateNumber||'—'}`};
  const key=p.needACabPermitStatus||'missing';
  const days=Number(p.needACabDaysUntilExpiry);
  const labels={valid:'VALID',expiring:Number.isFinite(days)?`DUE ${Math.max(0,days)}D`:'DUE',expired:'EXPIRED',missing:'NO DATE',error:'ERROR'};
  const title=key==='expiring'&&Number.isFinite(days)
    ? `Need-A-Cab permit expires in ${Math.max(0,days)} day${days===1?'':'s'}`
    : (p.needACabPermitStatusLabel||'Need-A-Cab permit status');
  return {key:key==='expiring'?'due':key==='valid'?'valid':'issue',label:labels[key]||String(p.needACabPermitStatusLabel||'NO DATE').toUpperCase(),title};
}
function row(p){const st=permitState(p);return `<article class="permit-row ${p.needACab?'nac':'other'} ${issue(p)?'has-issue':''}" title="${esc(st.title)}"><span class="registration">${esc(p.registration||'—')}</span><span class="plate-number">${esc(p.plateNumber||'—')}</span><span class="operator ${p.needACab?'nac':'other'}">${p.needACab?'NEED-A-CAB':'OTHER'}</span><span class="callsign">${esc(p.callsign||'—')}</span><span class="permit ${st.key}">${esc(st.label)}</span></article>`}
function filteredRows(){const q=norm($('searchInput').value);return permits.filter(p=>{const search=!q||[p.registration,p.plateNumber,p.callsign,p.needACabPlateNumber].some(x=>norm(x).includes(q));const filter=activeFilter==='all'||(activeFilter==='nac'&&p.needACab)||(activeFilter==='other'&&!p.needACab)||(activeFilter==='issues'&&issue(p));return search&&filter;});}
function renderSummary(){const nac=permits.filter(p=>p.needACab).length,other=permits.length-nac,issues=permits.filter(issue).length;$('summary').innerHTML=[['total','Total',permits.length],['nac','Need-A-Cab',nac],['other','Other',other],['issues','Issues',issues]].map(([k,l,v])=>`<div class="count ${k}"><span>${l}</span><strong>${v}</strong></div>`).join('');}
function render(){const rows=filteredRows();const q=norm($('searchInput').value);$('statusLine').textContent=q||activeFilter!=='all'?`${rows.length} matching record${rows.length===1?'':'s'}`:`${permits.length} Plymouth permit records`;$('results').innerHTML=rows.length?rows.map(row).join(''):'<div class="message">No matching permit record found.</div>';}
async function load(){try{const r=await fetch('/api/permit-public-search',{cache:'no-store'}),d=await r.json();if(!r.ok)throw new Error(d.error||'Unable to load register');permits=d.permits||[];renderSummary();render()}catch(e){$('statusLine').textContent=e.message;$('results').innerHTML='<div class="message error">Permit records are temporarily unavailable.</div>'}}
$('searchInput').addEventListener('input',render);$('refreshBtn').addEventListener('click',load);document.querySelectorAll('.filters button').forEach(btn=>btn.addEventListener('click',()=>{activeFilter=btn.dataset.filter;document.querySelectorAll('.filters button').forEach(x=>x.classList.toggle('active',x===btn));render()}));load();
