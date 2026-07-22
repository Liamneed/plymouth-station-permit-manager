const $=id=>document.getElementById(id);
let originalFile=null,originalImage=null,stampedBlob=null,permit=null,coords={latitude:null,longitude:null,accuracy:null};
let selectedOcrReg='';
let confirmedReg='';
let ocrWorker=null,ocrBusy=false;
const normaliseReg=v=>String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
function formatReg(v){const n=normaliseReg(v);return n.length>4?`${n.slice(0,n.length-3)} ${n.slice(-3)}`:n}
function setOcrStatus(message,type='neutral'){
  const box=$('ocrStatus');
  box.className=`ocr-status ${type}`;
  box.textContent=message;
}
function scoreCandidate(candidate){
  const n=normaliseReg(candidate);
  let score=0;
  if(/^[A-Z]{2}\d{2}[A-Z]{3}$/.test(n))score=100; // Current UK format
  else if(/^[A-Z]\d{1,3}[A-Z]{3}$/.test(n))score=88; // Prefix format
  else if(/^[A-Z]{3}\d{1,3}[A-Z]$/.test(n))score=84; // Suffix format
  else if(/^[A-Z]{1,3}\d{1,4}$/.test(n)||/^\d{1,4}[A-Z]{1,3}$/.test(n))score=70; // Dateless/private
  if(n.length===7)score+=5;
  return score;
}
function extractUkRegistrations(text){
  const upper=String(text||'').toUpperCase()
    .replace(/[|!]/g,'I')
    .replace(/[^A-Z0-9\s-]/g,' ')
    .replace(/\s+/g,' ')
    .trim();
  const patterns=[
    /\b[A-Z]{2}\s*\d{2}\s*[A-Z]{3}\b/g,
    /\b[A-Z]\s*\d{1,3}\s*[A-Z]{3}\b/g,
    /\b[A-Z]{3}\s*\d{1,3}\s*[A-Z]\b/g,
    /\b(?:[A-Z]{1,3}\s*\d{1,4}|\d{1,4}\s*[A-Z]{1,3})\b/g
  ];
  const found=[];
  const add=(raw,bonus=0)=>{
    const clean=normaliseReg(raw);
    if(clean.length>=4&&clean.length<=8)found.push({value:clean,score:scoreCandidate(clean)+bonus});
  };
  for(const pattern of patterns){
    for(const match of upper.matchAll(pattern))add(match[0],18);
  }
  // Tesseract commonly returns a syntactically imperfect compact token such as
  // SFO8PYV (O instead of 0). Keep those tokens so format-aware correction can
  // turn them into a valid UK registration before the permit-register check.
  const compactTokens=upper.split(/\s+/).map(normaliseReg).filter(Boolean);
  const joined=normaliseReg(upper);
  if(joined.length>=5&&joined.length<=10)compactTokens.push(joined);
  for(const token of compactTokens){
    if(token.length>=5&&token.length<=8)add(token,4);
    if(token.length>8){
      for(let len=7;len>=5;len--){
        for(let i=0;i+len<=token.length;i++)add(token.slice(i,i+len),0);
      }
    }
  }
  return [...new Map(found.sort((a,b)=>b.score-a.score).map(x=>[x.value,x])).values()];
}

function expandYVVariants(value){
  const base=normaliseReg(value);
  const positions=[...base].map((ch,i)=>ch==='Y'||ch==='V'?i:-1).filter(i=>i>=0);
  if(!positions.length)return [base];
  const variants=new Set([base]);
  const max=Math.min(positions.length,4);
  for(let mask=1;mask<(1<<max);mask++){
    const chars=[...base];
    for(let bit=0;bit<max;bit++){
      if(mask&(1<<bit)){
        const i=positions[bit];
        chars[i]=chars[i]==='Y'?'V':'Y';
      }
    }
    variants.add(chars.join(''));
  }
  return [...variants];
}
async function scoreAgainstPermitRegisterLegacy(candidates){
  const expanded=[];
  for(const candidate of candidates.slice(0,8)){
    for(const value of expandYVVariants(candidate.value)){
      expanded.push({value,score:candidate.score-(value===candidate.value?0:2),ocrSource:candidate.value});
    }
  }
  const unique=[...new Map(expanded.map(x=>[x.value,x])).values()].slice(0,16);
  await Promise.all(unique.map(async candidate=>{
    try{
      const response=await fetch(`/api/evidence/check?registration=${encodeURIComponent(candidate.value)}`,{cache:'no-store'});
      const data=await response.json();
      candidate.registerResult=response.ok?data:null;
      if(response.ok&&data.key!=='not-listed')candidate.score+=250;
      if(response.ok&&data.valid)candidate.score+=50;
    }catch{}
  }));
  return unique.sort((a,b)=>b.score-a.score);
}


function cropImageRegion(img,box,scale=3){
  const sourceW=img.naturalWidth||img.width,sourceH=img.naturalHeight||img.height;
  const padX=Math.round(box.w*.08),padY=Math.round(box.h*.18);
  const sx=Math.max(0,Math.round(box.x-padX)),sy=Math.max(0,Math.round(box.y-padY));
  const sw=Math.min(sourceW-sx,Math.round(box.w+padX*2)),sh=Math.min(sourceH-sy,Math.round(box.h+padY*2));
  const out=document.createElement('canvas');
  out.width=Math.max(420,Math.min(1900,Math.round(sw*scale)));
  out.height=Math.max(110,Math.min(700,Math.round(sh*scale)));
  const ctx=out.getContext('2d',{willReadFrequently:true});
  ctx.fillStyle='#fff';ctx.fillRect(0,0,out.width,out.height);
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
  ctx.drawImage(img,sx,sy,sw,sh,0,0,out.width,out.height);
  return out;
}
function detectPlateRegions(img){
  const sourceW=img.naturalWidth||img.width,sourceH=img.naturalHeight||img.height;
  const workW=Math.min(720,sourceW),scale=workW/sourceW,workH=Math.max(1,Math.round(sourceH*scale));
  const canvas=document.createElement('canvas');canvas.width=workW;canvas.height=workH;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0,workW,workH);
  const data=ctx.getImageData(0,0,workW,workH).data;
  const mask=new Uint8Array(workW*workH);
  // White and yellow UK plates are bright with relatively low colour variation.
  for(let y=Math.round(workH*.18);y<workH;y++)for(let x=0;x<workW;x++){
    const i=(y*workW+x)*4,r=data[i],g=data[i+1],b=data[i+2],max=Math.max(r,g,b),min=Math.min(r,g,b);
    const grey=.299*r+.587*g+.114*b;
    const white=grey>142&&(max-min)<92;
    const yellow=r>135&&g>110&&b<150&&(r-b)>35;
    if(white||yellow)mask[y*workW+x]=1;
  }
  // Horizontal closing joins the plate background across dark characters.
  const closed=new Uint8Array(mask.length),radius=Math.max(2,Math.round(workW*.006));
  for(let y=0;y<workH;y++)for(let x=0;x<workW;x++){
    let hit=0;for(let dx=-radius;dx<=radius;dx++){const xx=x+dx;if(xx>=0&&xx<workW&&mask[y*workW+xx]){hit=1;break}}
    closed[y*workW+x]=hit;
  }
  const visited=new Uint8Array(closed.length),regions=[];
  const stackX=new Int32Array(closed.length),stackY=new Int32Array(closed.length);
  for(let y=Math.round(workH*.18);y<workH;y++)for(let x=0;x<workW;x++){
    const idx=y*workW+x;if(!closed[idx]||visited[idx])continue;
    let top=0,count=0,minX=x,maxX=x,minY=y,maxY=y;stackX[top]=x;stackY[top++]=y;visited[idx]=1;
    while(top){top--;const cx=stackX[top],cy=stackY[top];count++;if(cx<minX)minX=cx;if(cx>maxX)maxX=cx;if(cy<minY)minY=cy;if(cy>maxY)maxY=cy;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){if(!dx&&!dy)continue;const nx=cx+dx,ny=cy+dy;if(nx<0||ny<0||nx>=workW||ny>=workH)continue;const ni=ny*workW+nx;if(closed[ni]&&!visited[ni]){visited[ni]=1;stackX[top]=nx;stackY[top++]=ny}}
    }
    const w=maxX-minX+1,h=maxY-minY+1,aspect=w/h,area=w*h;
    if(w<workW*.10||h<workH*.025||h>workH*.24||aspect<2.0||aspect>8.5||area<workW*workH*.003)continue;
    const fill=count/area,centreY=(minY+maxY)/2/workH;
    const aspectScore=Math.max(0,1-Math.abs(aspect-4.5)/4.5),sizeScore=Math.min(1,w/(workW*.38));
    const score=aspectScore*55+sizeScore*30+fill*18+centreY*8;
    regions.push({x:minX/scale,y:minY/scale,w:w/scale,h:h/scale,score});
  }
  // Remove overlapping duplicates and keep the strongest plate-shaped regions.
  regions.sort((a,b)=>b.score-a.score);const kept=[];
  for(const r of regions){
    const overlap=kept.some(k=>{const ix=Math.max(0,Math.min(r.x+r.w,k.x+k.w)-Math.max(r.x,k.x)),iy=Math.max(0,Math.min(r.y+r.h,k.y+k.h)-Math.max(r.y,k.y));return ix*iy>Math.min(r.w*r.h,k.w*k.h)*.55});
    if(!overlap)kept.push(r);if(kept.length>=5)break;
  }
  return kept;
}
async function scanDetectedPlateRegions(img){
  const regions=detectPlateRegions(img);if(!regions.length)return [];
  const worker=await getOcrWorker(),reads=[];
  const selected=regions.slice(0,3),modes=['high','adaptive','normal'];
  let step=0,total=selected.length*modes.length;
  for(let r=0;r<selected.length;r++){
    const crop=cropImageRegion(img,selected[r],3.4);
    for(const mode of modes){
      step++;setOcrStatus(`Scanning detected plate area ${step}/${total}…`);
      await worker.setParameters({tessedit_pageseg_mode:mode==='adaptive'?'8':'7',user_defined_dpi:'300'});
      const result=await worker.recognize(preprocessCanvas(crop,mode));
      reads.push({label:`detected-${r}-${mode}`,candidates:extractUkRegistrations(result?.data?.text)});
    }
  }
  return aggregateCandidates(reads);
}

function makeOcrCanvas(img,crop='full',mode='threshold',angle=0){
  const sourceW=img.naturalWidth||img.width,sourceH=img.naturalHeight||img.height;
  let sx=0,sy=0,sw=sourceW,sh=sourceH;
  if(crop==='lower'){sy=Math.round(sourceH*.35);sh=Math.round(sourceH*.65)}
  if(crop==='plate-band'){sx=Math.round(sourceW*.08);sy=Math.round(sourceH*.48);sw=Math.round(sourceW*.84);sh=Math.round(sourceH*.42)}
  const maxW=1900,scale=Math.min(1.7,maxW/sw);
  const baseW=Math.max(1,Math.round(sw*scale)),baseH=Math.max(1,Math.round(sh*scale));
  const radians=angle*Math.PI/180;
  const canvas=document.createElement('canvas');
  canvas.width=Math.ceil(Math.abs(baseW*Math.cos(radians))+Math.abs(baseH*Math.sin(radians)));
  canvas.height=Math.ceil(Math.abs(baseH*Math.cos(radians))+Math.abs(baseW*Math.sin(radians)));
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.translate(canvas.width/2,canvas.height/2);ctx.rotate(radians);
  ctx.drawImage(img,sx,sy,sw,sh,-baseW/2,-baseH/2,baseW,baseH);
  ctx.setTransform(1,0,0,1,0,0);
  const image=ctx.getImageData(0,0,canvas.width,canvas.height),d=image.data;
  for(let i=0;i<d.length;i+=4){
    const grey=.299*d[i]+.587*d[i+1]+.114*d[i+2];
    let value;
    if(mode==='contrast')value=Math.max(0,Math.min(255,(grey-128)*2.4+128));
    else if(mode==='soft')value=Math.max(0,Math.min(255,(grey-110)*1.65+128));
    else value=grey>142?255:grey<82?0:Math.max(0,Math.min(255,(grey-112)*2.5+128));
    d[i]=d[i+1]=d[i+2]=value;
  }
  ctx.putImageData(image,0,0);
  return canvas;
}
async function getOcrWorker(){
  if(ocrWorker)return ocrWorker;
  if(!window.Tesseract)throw new Error('OCR library did not load. Check the internet connection and retry.');
  setOcrStatus('Loading registration reader…');
  ocrWorker=await Tesseract.createWorker('eng',1,{
    logger:m=>{
      if(m.status==='recognizing text')setOcrStatus(`Reading registration… ${Math.round((m.progress||0)*100)}%`);
      else if(m.status)setOcrStatus(`${m.status.charAt(0).toUpperCase()+m.status.slice(1)}…`);
    }
  });
  await ocrWorker.setParameters({
    tessedit_char_whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ',
    preserve_interword_spaces:'1'
  });
  return ocrWorker;
}
function isCompleteUkRegistration(value){
  const n=normaliseReg(value);
  return /^(?:[A-Z]{2}\d{2}[A-Z]{3}|[A-Z]\d{1,3}[A-Z]{3}|[A-Z]{3}\d{1,3}[A-Z]|[A-Z]{1,3}\d{1,4}|\d{1,4}[A-Z]{1,3})$/.test(n);
}
function markSelectedRegistration(value,source='option'){
  const reg=normaliseReg(value);
  selectedOcrReg=reg;
  confirmedReg='';
  document.querySelectorAll('#ocrChoiceButtons button').forEach(button=>{
    const active=normaliseReg(button.dataset.registration)===reg;
    button.classList.toggle('selected',active);
    button.setAttribute('aria-pressed',active?'true':'false');
  });
  const input=$('registration');
  input.classList.remove('confirmed');
  const summary=$('selectedRegSummary');
  if(summary){
    summary.hidden=!reg;
    summary.innerHTML=reg?`Selected registration: <strong>${formatReg(reg)}</strong> — press CONFIRM after checking the photograph.`:'';
  }
  permit=null;stampedBlob=null;
  $('permitResult').className='permit-result neutral';
  $('permitResult').textContent='Confirm the registration to check the permit';
  drawStamp();
  updateSubmit();
}
function confirmSelectedRegistration(){
  const reg=normaliseReg($('registration').value);
  if(!reg||!isCompleteUkRegistration(reg)){
    alert('Enter or select a complete UK registration first.');
    return false;
  }
  selectedOcrReg=reg;
  confirmedReg=reg;
  document.querySelectorAll('#ocrChoiceButtons button').forEach(button=>{
    const active=normaliseReg(button.dataset.registration)===reg;
    button.classList.toggle('selected',active);
    button.setAttribute('aria-pressed',active?'true':'false');
  });
  $('registration').classList.add('confirmed');
  const summary=$('selectedRegSummary');
  if(summary){
    summary.hidden=false;
    summary.innerHTML=`Confirmed registration: <strong>${formatReg(reg)}</strong>`;
  }
  return true;
}
function clearSelectedRegistration(){
  selectedOcrReg='';confirmedReg='';
  document.querySelectorAll('#ocrChoiceButtons button').forEach(button=>{
    button.classList.remove('selected');button.setAttribute('aria-pressed','false');
  });
  $('registration').classList.remove('confirmed');
  const summary=$('selectedRegSummary');if(summary){summary.hidden=true;summary.textContent=''}
}
function showOcrChoices(candidates){
  const wrap=$('ocrChoices'),holder=$('ocrChoiceButtons');
  holder.innerHTML='';
  const unique=[...new Map(candidates.filter(x=>isCompleteUkRegistration(x.value)).slice(0,6).map(x=>[normaliseReg(x.value),x])).values()];
  if(!unique.length){wrap.hidden=true;clearSelectedRegistration();return}
  unique.forEach((candidate,index)=>{
    const button=document.createElement('button');
    button.type='button';
    const source=candidate.source||'Browser fallback';
    const confidence=Number.isFinite(candidate.apiConfidence)?` · ${candidate.apiConfidence.toFixed(1)}%`:'';
    button.innerHTML=`<span class="choice-reg">${formatReg(candidate.value)}${confidence}</span><span class="choice-source">${source}</span>`;
    button.dataset.registration=candidate.value;
    button.setAttribute('aria-pressed','false');
    if(index===0)button.classList.add('best');
    button.title=`${source}${confidence}`;
    button.addEventListener('click',()=>{
      $('registration').value=formatReg(candidate.value);
      markSelectedRegistration(candidate.value,'option');
      setOcrStatus(`Selected ${formatReg(candidate.value)}. Check the photograph, then press CONFIRM.`,'success');
    });
    holder.appendChild(button);
  });
  wrap.hidden=false;
  if(selectedOcrReg)markSelectedRegistration(selectedOcrReg,'option');
}
async function recogniseRegistrationLegacy(){
  if(!originalImage||ocrBusy)return;
  ocrBusy=true;$('ocrBtn').disabled=true;
  setOcrStatus('Preparing photograph for registration recognition…');
  try{
    const worker=await getOcrWorker();
    const attempts=[
      {crop:'plate-band',mode:'threshold',psm:'7',angle:0},
      {crop:'plate-band',mode:'contrast',psm:'7',angle:-7},
      {crop:'plate-band',mode:'contrast',psm:'7',angle:7},
      {crop:'plate-band',mode:'soft',psm:'7',angle:-12},
      {crop:'plate-band',mode:'soft',psm:'7',angle:12},
      {crop:'lower',mode:'contrast',psm:'11',angle:0},
      {crop:'lower',mode:'soft',psm:'11',angle:0},
      {crop:'full',mode:'contrast',psm:'11',angle:0}
    ];
    let candidates=[];
    for(const attempt of attempts){
      await worker.setParameters({tessedit_pageseg_mode:attempt.psm});
      const canvas=makeOcrCanvas(originalImage,attempt.crop,attempt.mode,attempt.angle||0);
      const result=await worker.recognize(canvas);
      candidates.push(...extractUkRegistrations(result?.data?.text));
    }
    candidates=[...new Map(candidates.sort((a,b)=>b.score-a.score).map(x=>[x.value,x])).values()];
    candidates=await scoreAgainstPermitRegister(candidates);
    if(!candidates.length){
      setOcrStatus('No registration confidently detected. Retake closer to the number plate or type it manually.','warning');
      return;
    }
    showOcrChoices(candidates);
    const best=candidates[0];
    $('registration').value=formatReg(best.value);
    markSelectedRegistration(best.value,'automatic');
    permit=null;stampedBlob=null;
    $('permitResult').className='permit-result neutral';
    $('permitResult').textContent='Registration detected — checking permit…';
    const alternatives=candidates.slice(1,4).map(x=>formatReg(x.value));
    const registerMatched=best.registerResult&&best.registerResult.key!=='not-listed';
    const correction=best.ocrSource&&best.ocrSource!==best.value?` OCR first read ${formatReg(best.ocrSource)}, but the permit register matched ${formatReg(best.value)}.`:'';
    setOcrStatus(`${registerMatched?'Permit-register match: ':'Detected '}${formatReg(best.value)}.${correction}${alternatives.length?` Other possibilities: ${alternatives.join(', ')}.`:''} Please confirm it is correct.`,'success');
    await drawStamp();
  }catch(error){
    console.error('OCR error',error);
    setOcrStatus(`Automatic reading failed: ${error.message}. You can still enter the registration manually.`,'error');
  }finally{
    ocrBusy=false;$('ocrBtn').disabled=false;updateSubmit();
  }
}
$('registration').addEventListener('input',e=>{e.target.value=formatReg(e.target.value);const reg=normaliseReg(e.target.value);if(reg!==selectedOcrReg)clearSelectedRegistration();confirmedReg='';permit=null;stampedBlob=null;$('registration').classList.remove('confirmed');$('permitResult').className='permit-result neutral';$('permitResult').textContent='Confirm the registration to check the permit';drawStamp();updateSubmit()});
async function handleSelectedPhoto(e){
  const file=e.target.files?.[0];if(!file)return;
  try{
    originalFile=file;originalImage=await loadImage(file);
    $('photoHelp').textContent=`${file.name||'Photo'} selected`;
    permit=null;confirmedReg='';$('registration').value='';clearSelectedRegistration();
    $('permitResult').className='permit-result neutral';$('permitResult').textContent='Permit not checked';
    await drawStamp();updateSubmit();
    requestGps({automatic:true});
    await recogniseRegistration();
  }finally{
    // Allow the same photo to be selected again after a retry.
    e.target.value='';
  }
}
$('takePhotoBtn').addEventListener('click',()=>$('cameraInput').click());
$('choosePhotoBtn').addEventListener('click',()=>$('galleryInput').click());
$('cameraInput').addEventListener('change',handleSelectedPhoto);
$('galleryInput').addEventListener('change',handleSelectedPhoto);
$('ocrBtn').addEventListener('click',recogniseRegistration);
function loadImage(file){return new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>{URL.revokeObjectURL(img.src);resolve(img)};img.onerror=reject;img.src=URL.createObjectURL(file)})}
function wrap(ctx,text,maxWidth){const words=String(text).split(/\s+/);const lines=[];let line='';for(const word of words){const test=line?`${line} ${word}`:word;if(ctx.measureText(test).width>maxWidth&&line){lines.push(line);line=word}else line=test}if(line)lines.push(line);return lines}
async function drawStamp(){if(!originalImage)return;const canvas=$('previewCanvas'),max=1800,scale=Math.min(1,max/Math.max(originalImage.width,originalImage.height));canvas.width=Math.round(originalImage.width*scale);canvas.height=Math.round(originalImage.height*scale);const ctx=canvas.getContext('2d');ctx.drawImage(originalImage,0,0,canvas.width,canvas.height);const pad=Math.max(20,Math.round(canvas.width*.025)),font=Math.max(24,Math.round(canvas.width*.027));ctx.font=`800 ${font}px system-ui`;const lines=[`PLYMOUTH TAXI EVIDENCE`, `REG: ${confirmedReg?formatReg(confirmedReg):'NOT CONFIRMED'}`, new Date().toLocaleString('en-GB'), `LOCATION: ${$('locationLabel').value||'NOT ENTERED'}`, coords.latitude?`GPS: ${Number(coords.latitude).toFixed(6)}, ${Number(coords.longitude).toFixed(6)} (±${Math.round(coords.accuracy)}m)`:'GPS: NOT CAPTURED', `PERMIT: ${permit?.label||'NOT CHECKED'}`];let all=[];for(const line of lines)all.push(...wrap(ctx,line,canvas.width-pad*2));const lineH=font*1.25,boxH=all.length*lineH+pad*1.5,y=canvas.height-boxH;ctx.fillStyle='rgba(0,0,0,.78)';ctx.fillRect(0,y,canvas.width,boxH);ctx.fillStyle='#fff';all.forEach((line,i)=>ctx.fillText(line,pad,y+pad+font+i*lineH));canvas.style.display='block';stampedBlob=await new Promise(r=>canvas.toBlob(r,'image/jpeg',.9));updateSubmit()}
async function checkPermit(){
  const reg=normaliseReg($('registration').value);if(!reg||confirmedReg!==reg){alert('Confirm the registration before checking the permit.');return}
  const box=$('permitResult');box.className='permit-result neutral';box.textContent='Checking permit…';
  try{const r=await fetch(`/api/evidence/check?registration=${encodeURIComponent(reg)}`,{cache:'no-store'}),d=await r.json();if(!r.ok)throw new Error(d.error||'Permit check failed');permit=d;const cls=d.valid?(d.key==='expiring'?'due':'valid'):'invalid';box.className=`permit-result ${cls}`;box.innerHTML=`${d.label}<small>${d.detail||''}${d.plateNumber?` Plate ${d.plateNumber}.`:''}</small>`;await drawStamp()}catch(e){permit=null;box.className='permit-result invalid';box.textContent=e.message;updateSubmit()}
}
$('checkBtn').addEventListener('click',async()=>{if(!confirmSelectedRegistration())return;setOcrStatus(`Confirmed ${formatReg(confirmedReg)}. Checking permit…`,'success');await checkPermit()});
async function reverseGeocode(){
  if(!coords.latitude||!coords.longitude)return;
  const choices=$('locationChoices'),holder=$('locationChoiceButtons');
  try{
    const response=await fetch(`/api/evidence/reverse-geocode?lat=${encodeURIComponent(coords.latitude)}&lon=${encodeURIComponent(coords.longitude)}`,{cache:'no-store'});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'Address lookup failed');
    const suggestions=Array.isArray(data.suggestions)?data.suggestions.filter(Boolean):[];
    holder.innerHTML='';
    suggestions.forEach((label,index)=>{
      const button=document.createElement('button');button.type='button';button.textContent=label;
      button.addEventListener('click',async()=>{$('locationLabel').value=label;stampedBlob=null;await drawStamp()});
      holder.appendChild(button);
      if(index===0&&!$('locationLabel').value.trim())$('locationLabel').value=label;
    });
    choices.hidden=!suggestions.length;
    await drawStamp();
  }catch(error){console.warn('Reverse geocode failed',error)}
}
function requestGps({automatic=false}={}){
  const status=$('gpsStatus');
  if(!navigator.geolocation){status.textContent='Geolocation is not supported on this device.';return}
  status.textContent=automatic?'Requesting GPS location automatically…':'Getting GPS location…';
  navigator.geolocation.getCurrentPosition(async position=>{
    coords={latitude:position.coords.latitude,longitude:position.coords.longitude,accuracy:position.coords.accuracy};
    status.textContent=`${coords.latitude.toFixed(6)}, ${coords.longitude.toFixed(6)} ±${Math.round(coords.accuracy)}m — finding street/area…`;
    await reverseGeocode();
    status.textContent=`${coords.latitude.toFixed(6)}, ${coords.longitude.toFixed(6)} ±${Math.round(coords.accuracy)}m`;
  },error=>{status.textContent=`Location unavailable: ${error.message}`},{enableHighAccuracy:true,timeout:20000,maximumAge:0});
}
$('gpsBtn').addEventListener('click',()=>requestGps());
$('stampBtn').addEventListener('click',drawStamp);$('locationLabel').addEventListener('input',()=>{stampedBlob=null;updateSubmit()});
function updateSubmit(){$('submitBtn').disabled=!(originalFile&&stampedBlob&&permit&&confirmedReg&&confirmedReg===normaliseReg($('registration').value))}
$('submitBtn').addEventListener('click',async()=>{const btn=$('submitBtn'),status=$('submitStatus');btn.disabled=true;status.textContent='Saving evidence…';try{await drawStamp();const fd=new FormData();fd.append('original',originalFile,originalFile.name||'original.jpg');fd.append('stamped',stampedBlob,'stamped.jpg');fd.append('registration',normaliseReg($('registration').value));fd.append('observedAt',new Date().toISOString());fd.append('latitude',coords.latitude??'');fd.append('longitude',coords.longitude??'');fd.append('accuracy',coords.accuracy??'');fd.append('locationLabel',$('locationLabel').value);fd.append('notes',$('notes').value);const r=await fetch('/api/evidence/submit',{method:'POST',body:fd}),d=await r.json();if(!r.ok)throw new Error(d.error||'Submission failed');status.textContent=`Saved as ${d.reference}. ${d.message}`;alert(`Evidence saved\n${d.reference}\n${d.permit.label}`)}catch(e){status.textContent=e.message;alert(e.message)}finally{updateSubmit()}});
window.addEventListener('beforeunload',()=>{if(ocrWorker)ocrWorker.terminate().catch(()=>{})});

async function loadEmailStatus(){
  const config=$('emailConfigStatus'),button=$('testEmailBtn'),status=$('testEmailStatus');
  try{
    const response=await fetch('/api/evidence/email-status',{cache:'no-store'});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||'Unable to check email configuration.');
    if(data.configured){
      config.textContent=`Configured to send to ${data.recipient} through ${data.host}:${data.port}.`;
      button.disabled=false;
      status.className='email-test-status neutral';
      status.textContent='Ready. This sends a simple test message only and does not create an evidence record.';
    }else{
      config.textContent='Email is not configured. Add the SMTP settings to .env and restart the server.';
      button.disabled=true;
      status.className='email-test-status error';
      status.textContent='Test email unavailable until EVIDENCE_EMAIL and SMTP settings are configured.';
    }
  }catch(error){
    config.textContent='Email status could not be checked.';
    button.disabled=true;
    status.className='email-test-status error';
    status.textContent=error.message;
  }
}

$('testEmailBtn').addEventListener('click',async()=>{
  const button=$('testEmailBtn'),status=$('testEmailStatus');
  button.disabled=true;
  status.className='email-test-status neutral';
  status.textContent='Verifying SMTP connection and sending test email…';
  try{
    const response=await fetch('/api/evidence/test-email',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        registration:normaliseReg($('registration').value),
        permitLabel:permit?.label||'Not checked'
      })
    });
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||'Test email failed.');
    status.className='email-test-status success';
    status.textContent=data.message||'Test email sent successfully.';
  }catch(error){
    status.className='email-test-status error';
    status.textContent=`Test email failed: ${error.message}`;
  }finally{
    button.disabled=false;
  }
});

loadEmailStatus();

/* Enhanced ANPR test mode: format-aware substitutions, ensemble voting and manual perspective crop. */
let plateCorners=[];
let activeCorner=-1;
const CONFUSIONS={
  '0':['O','D','Q'],'O':['0','D','Q'],'D':['0','O'],'Q':['0','O'],
  '1':['I','L'],'I':['1','L'],'L':['1','I'],
  '2':['Z'],'Z':['2'],'5':['S'],'S':['5'],'6':['G'],'G':['6'],
  '8':['B'],'B':['8'],'7':['T'],'T':['7'],'Y':['V'],'V':['Y']
};
function currentUkShape(n){return n.length===7?'LLDDLLL':null}
function prefixShape(n){return n.length>=5&&n.length<=7?'L'.repeat(1)+'D'.repeat(n.length-4)+'LLL':null}
function suffixShape(n){return n.length>=5&&n.length<=7?'LLL'+'D'.repeat(n.length-4)+'L':null}
function charAllowed(ch,type){return type==='L'?/[A-Z]/.test(ch):/\d/.test(ch)}
function generateFormatVariants(value,limit=80){
  const base=normaliseReg(value), shapes=[];
  if(base.length===7)shapes.push('LLDDLLL','LLLDDDL');
  if(base.length>=5&&base.length<=7){shapes.push('L'+'D'.repeat(base.length-4)+'LLL','LLL'+'D'.repeat(base.length-4)+'L')}
  const out=new Map();
  const add=(v,cost,reason)=>{if(!out.has(v)||out.get(v).cost>cost)out.set(v,{value:v,cost,reason})};
  add(base,0,'OCR');
  for(const shape of shapes){
    let states=[{chars:[...base],cost:0,changes:[]}];
    for(let i=0;i<base.length;i++){
      const next=[];
      for(const state of states){
        const ch=state.chars[i], type=shape[i];
        if(charAllowed(ch,type))next.push(state);
        for(const alt of CONFUSIONS[ch]||[]){
          if(charAllowed(alt,type)){
            const chars=[...state.chars];chars[i]=alt;
            next.push({chars,cost:state.cost+1,changes:[...state.changes,`${ch}/${alt}`]});
          }
        }
      }
      states=next.sort((a,b)=>a.cost-b.cost).slice(0,limit);
    }
    for(const state of states){
      const v=state.chars.join('');
      if(state.chars.every((ch,i)=>charAllowed(ch,shape[i])))add(v,state.cost,state.changes.join(', '));
    }
  }
  return [...out.values()].sort((a,b)=>a.cost-b.cost).slice(0,limit);
}
async function scoreAgainstPermitRegister(candidates){
  const map=new Map();
  for(const candidate of candidates.slice(0,18)){
    for(const variant of generateFormatVariants(candidate.value,60)){
      const score=(candidate.score||0)+(candidate.votes||1)*18-variant.cost*7;
      const old=map.get(variant.value);
      if(!old||old.score<score)map.set(variant.value,{value:variant.value,score,ocrSource:candidate.value,votes:candidate.votes||1,correction:variant.reason});
    }
  }
  const unique=[...map.values()].sort((a,b)=>b.score-a.score).slice(0,45);
  await Promise.all(unique.map(async candidate=>{
    try{
      const response=await fetch(`/api/evidence/check?registration=${encodeURIComponent(candidate.value)}`,{cache:'no-store'});
      const data=await response.json();candidate.registerResult=response.ok?data:null;
      if(response.ok&&data.key!=='not-listed')candidate.score+=400;
      if(response.ok&&data.valid)candidate.score+=80;
    }catch{}
  }));
  return unique.sort((a,b)=>b.score-a.score);
}
function aggregateCandidates(reads){
  const map=new Map();
  for(const read of reads){
    for(const c of read.candidates){
      const old=map.get(c.value)||{value:c.value,score:0,votes:0,sources:new Set()};
      old.score+=c.score||0;old.votes+=1;old.sources.add(read.label);map.set(c.value,old);
    }
  }
  return [...map.values()].map(x=>({...x,sources:[...x.sources]})).sort((a,b)=>(b.votes-a.votes)||(b.score-a.score));
}
function renderAssistCanvas(){
  if(!originalImage)return;
  const canvas=$('cropCanvas'), max=1100, scale=Math.min(1,max/(originalImage.naturalWidth||originalImage.width));
  canvas.width=Math.round((originalImage.naturalWidth||originalImage.width)*scale);
  canvas.height=Math.round((originalImage.naturalHeight||originalImage.height)*scale);
  canvas.dataset.scale=String(scale);
  const ctx=canvas.getContext('2d');ctx.drawImage(originalImage,0,0,canvas.width,canvas.height);
  if(plateCorners.length){
    ctx.lineWidth=Math.max(3,canvas.width*.004);ctx.strokeStyle='#29c777';ctx.fillStyle='#29c777';ctx.font=`900 ${Math.max(17,canvas.width*.022)}px system-ui`;
    ctx.beginPath();plateCorners.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));if(plateCorners.length===4)ctx.closePath();ctx.stroke();
    plateCorners.forEach((p,i)=>{ctx.beginPath();ctx.arc(p.x,p.y,Math.max(9,canvas.width*.012),0,Math.PI*2);ctx.fill();ctx.fillStyle='#07111f';ctx.fillText(String(i+1),p.x-5,p.y+6);ctx.fillStyle='#29c777'});
  }
  const names=['top-left','top-right','bottom-right','bottom-left'];
  $('cornerStatus').textContent=plateCorners.length<4?`Tap ${names[plateCorners.length]} corner.`:'Corners ready. Drag any point to refine, then scan.';
  $('scanCropBtn').disabled=plateCorners.length!==4;
}
function resetPlateCorners(){
  if(!originalImage)return;const canvas=$('cropCanvas');
  plateCorners=[];activeCorner=-1;renderAssistCanvas();
}
function canvasPoint(event){
  const canvas=$('cropCanvas'),r=canvas.getBoundingClientRect();
  const touch=event.touches?.[0]||event.changedTouches?.[0]||event;
  return{x:(touch.clientX-r.left)*canvas.width/r.width,y:(touch.clientY-r.top)*canvas.height/r.height};
}
function nearestCorner(p){let best=-1,dist=Infinity;plateCorners.forEach((q,i)=>{const d=Math.hypot(q.x-p.x,q.y-p.y);if(d<dist){dist=d;best=i}});return dist<Math.max(35,$('cropCanvas').width*.05)?best:-1}
function installCornerEvents(){
  const c=$('cropCanvas');
  const down=e=>{e.preventDefault();const p=canvasPoint(e),near=nearestCorner(p);if(near>=0)activeCorner=near;else if(plateCorners.length<4){plateCorners.push(p);activeCorner=plateCorners.length-1}renderAssistCanvas()};
  const move=e=>{if(activeCorner<0)return;e.preventDefault();plateCorners[activeCorner]=canvasPoint(e);renderAssistCanvas()};
  const up=e=>{if(activeCorner>=0){e.preventDefault();activeCorner=-1;renderAssistCanvas()}};
  c.addEventListener('pointerdown',down);c.addEventListener('pointermove',move);c.addEventListener('pointerup',up);c.addEventListener('pointercancel',up);
}
function rectifiedPlateCanvas(){
  if(plateCorners.length!==4)throw new Error('Mark all four plate corners first.');
  const source=$('cropCanvas'),sctx=source.getContext('2d'),src=sctx.getImageData(0,0,source.width,source.height),pts=plateCorners;
  const top=Math.hypot(pts[1].x-pts[0].x,pts[1].y-pts[0].y),bottom=Math.hypot(pts[2].x-pts[3].x,pts[2].y-pts[3].y);
  const left=Math.hypot(pts[3].x-pts[0].x,pts[3].y-pts[0].y),right=Math.hypot(pts[2].x-pts[1].x,pts[2].y-pts[1].y);
  const w=Math.max(480,Math.min(1800,Math.round(Math.max(top,bottom)*2.8))),h=Math.max(120,Math.min(520,Math.round(Math.max(left,right)*2.8)));
  const out=document.createElement('canvas');out.width=w;out.height=h;const octx=out.getContext('2d'),dst=octx.createImageData(w,h);
  for(let y=0;y<h;y++){const v=y/(h-1);for(let x=0;x<w;x++){const u=x/(w-1);
    const sx=(1-u)*(1-v)*pts[0].x+u*(1-v)*pts[1].x+u*v*pts[2].x+(1-u)*v*pts[3].x;
    const sy=(1-u)*(1-v)*pts[0].y+u*(1-v)*pts[1].y+u*v*pts[2].y+(1-u)*v*pts[3].y;
    const ix=Math.max(0,Math.min(source.width-1,Math.round(sx))),iy=Math.max(0,Math.min(source.height-1,Math.round(sy))),si=(iy*source.width+ix)*4,di=(y*w+x)*4;
    dst.data[di]=src.data[si];dst.data[di+1]=src.data[si+1];dst.data[di+2]=src.data[si+2];dst.data[di+3]=255;
  }}octx.putImageData(dst,0,0);return out;
}
function preprocessCanvas(input,mode){
  const out=document.createElement('canvas');out.width=input.width;out.height=input.height;const ctx=out.getContext('2d',{willReadFrequently:true});ctx.drawImage(input,0,0);const im=ctx.getImageData(0,0,out.width,out.height),d=im.data;
  let sum=0;for(let i=0;i<d.length;i+=4)sum+=.299*d[i]+.587*d[i+1]+.114*d[i+2];const mean=sum/(d.length/4);
  for(let i=0;i<d.length;i+=4){const g=.299*d[i]+.587*d[i+1]+.114*d[i+2];let v=g;
    if(mode==='adaptive')v=g>mean*.92?255:0;
    else if(mode==='high')v=Math.max(0,Math.min(255,(g-128)*3+128));
    else if(mode==='invert')v=g>mean?0:255;
    else v=Math.max(0,Math.min(255,(g-120)*2+135));d[i]=d[i+1]=d[i+2]=v;
  }ctx.putImageData(im,0,0);return out;
}
async function scanCanvasEnsemble(base,labelPrefix='manual crop'){
  const worker=await getOcrWorker(),reads=[],modes=['normal','high','adaptive','invert'],psms=['7','8','13'];let step=0,total=modes.length*psms.length;
  for(const mode of modes){for(const psm of psms){step++;setOcrStatus(`Scanning corrected plate ${step}/${total}…`);await worker.setParameters({tessedit_pageseg_mode:psm,user_defined_dpi:'300'});
    const result=await worker.recognize(preprocessCanvas(base,mode));reads.push({label:`${labelPrefix}-${mode}-${psm}`,candidates:extractUkRegistrations(result?.data?.text)});
  }}return aggregateCandidates(reads);
}
async function scanMarkedPlate(){
  if(ocrBusy)return;ocrBusy=true;$('scanCropBtn').disabled=true;
  try{let candidates=await scanCanvasEnsemble(rectifiedPlateCanvas());candidates=await scoreAgainstPermitRegister(candidates);applyBestCandidates(candidates,'Corrected-angle scan');}
  catch(e){setOcrStatus(`Marked-plate scan failed: ${e.message}`,'error')}finally{ocrBusy=false;$('scanCropBtn').disabled=plateCorners.length!==4;updateSubmit()}
}
function applyBestCandidates(candidates,prefix='Detected'){
  candidates=candidates.filter(item=>isCompleteUkRegistration(item.value));
  if(!candidates.length){setOcrStatus('No reliable complete UK registration found. Retake closer to the plate or enter it manually.','warning');return}
  showOcrChoices(candidates);
  const best=candidates[0];
  const isSpecialist=best.source==='Plate Recognizer';
  const highConfidence=isSpecialist&&Number.isFinite(best.apiConfidence)&&best.apiConfidence>=95;
  permit=null;stampedBlob=null;confirmedReg='';
  $('registration').classList.remove('confirmed');
  $('permitResult').className='permit-result neutral';
  $('permitResult').textContent='Confirm the registration to check the permit';
  if(highConfidence){
    $('registration').value=formatReg(best.value);
    markSelectedRegistration(best.value,'automatic');
    setOcrStatus(`${prefix}: ${formatReg(best.value)} (${best.apiConfidence.toFixed(1)}% confidence). Check the photograph, then press CONFIRM.`,'success');
  }else{
    $('registration').value='';
    clearSelectedRegistration();
    setOcrStatus(`${prefix} returned possible registrations. Tap the correct option, check it against the photograph, then press CONFIRM.`,'warning');
  }
  drawStamp();
}
async function recogniseRegistrationBrowserFallback(){
  if(!originalImage||ocrBusy)return;ocrBusy=true;$('ocrBtn').disabled=true;setOcrStatus('Running multi-pass plate recognition…');
  try{
    const worker=await getOcrWorker();
    // First scan automatically detected bright, plate-shaped regions. This avoids
    // large evidence-overlay text, taxi livery and other lettering dominating OCR.
    const detectedReads=await scanDetectedPlateRegions(originalImage);
    const attempts=[
      {crop:'plate-band',mode:'threshold',psm:'7',angle:0},{crop:'plate-band',mode:'contrast',psm:'7',angle:-5},{crop:'plate-band',mode:'contrast',psm:'7',angle:5},
      {crop:'plate-band',mode:'soft',psm:'8',angle:-10},{crop:'plate-band',mode:'soft',psm:'8',angle:10},{crop:'plate-band',mode:'contrast',psm:'13',angle:-15},{crop:'plate-band',mode:'contrast',psm:'13',angle:15},
      {crop:'lower',mode:'contrast',psm:'11',angle:0},{crop:'lower',mode:'soft',psm:'12',angle:0},{crop:'full',mode:'contrast',psm:'11',angle:0}
    ];
    const reads=[];let i=0;
    for(const a of attempts){i++;setOcrStatus(`Automatic scan ${i}/${attempts.length}…`);await worker.setParameters({tessedit_pageseg_mode:a.psm,user_defined_dpi:'300'});const result=await worker.recognize(makeOcrCanvas(originalImage,a.crop,a.mode,a.angle||0));reads.push({label:`${a.crop}-${a.mode}-${a.angle}`,candidates:extractUkRegistrations(result?.data?.text)});}
    let candidates=aggregateCandidates(reads);
    for(const candidate of detectedReads){
      const old=candidates.find(x=>x.value===candidate.value);
      if(old){old.votes+=(candidate.votes||1)*2;old.score+=(candidate.score||0)+55}
      else candidates.push({...candidate,votes:(candidate.votes||1)*2,score:(candidate.score||0)+55});
    }
    candidates.sort((a,b)=>(b.votes-a.votes)||(b.score-a.score));
    candidates=await scoreAgainstPermitRegister(candidates);candidates.forEach(item=>item.source='Browser fallback');applyBestCandidates(candidates,'Browser fallback');
    if(!candidates.length){setOcrStatus('No confident plate read. Retake closer to the plate or choose one of the suggested options if shown.','warning')}
  }catch(e){console.error(e);setOcrStatus(`Automatic reading failed: ${e.message}. Retake closer to the plate or enter it manually.`,'error')}
  finally{ocrBusy=false;$('ocrBtn').disabled=false;updateSubmit()}
}

async function recogniseRegistration(){
  if(!originalFile||ocrBusy)return;
  ocrBusy=true;$('ocrBtn').disabled=true;
  setOcrStatus('Reading number plate with specialist ANPR…');
  try{
    const form=new FormData();
    form.append('upload',originalFile,originalFile.name||'vehicle.jpg');
    const response=await fetch('/api/evidence/read-plate',{method:'POST',body:form});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw Object.assign(new Error(data.error||'Specialist plate recognition failed.'),{fallbackAllowed:data.fallbackAllowed!==false});
    let candidates=(Array.isArray(data.candidates)?data.candidates:[]).map(item=>({
      value:normaliseReg(item.value),
      score:Number(item.score)||0,
      votes:4,
      apiConfidence:Number.isFinite(Number(item.confidence))?Number(item.confidence):null,
      source:'Plate Recognizer'
    })).filter(item=>isCompleteUkRegistration(item.value));
    candidates=[...new Map(candidates.sort((a,b)=>(b.apiConfidence??-1)-(a.apiConfidence??-1)).map(item=>[item.value,item])).values()];
    if(!candidates.length)throw Object.assign(new Error('No number plate was found by specialist ANPR.'),{fallbackAllowed:true});
    applyBestCandidates(candidates,'Plate Recognizer');
  }catch(error){
    console.warn('Specialist ANPR unavailable; using browser fallback:',error.message);
    setOcrStatus(`${error.message} Trying on-device fallback…`,'warning');
    ocrBusy=false;$('ocrBtn').disabled=false;
    await recogniseRegistrationBrowserFallback();
    return;
  }finally{
    if(ocrBusy){ocrBusy=false;$('ocrBtn').disabled=false;updateSubmit()}
  }
}

$('resetCornersBtn').addEventListener('click',resetPlateCorners);
$('scanCropBtn').addEventListener('click',scanMarkedPlate);
// Manual corner-marking UI removed for the streamlined mobile workflow.

