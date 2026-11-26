let data=null,currentUser=null,selectedType='In',adjustment='No',clockContext=null,reportPanel='today',approvalTab='late',approvalData={late:[],adjustments:[]},reportData={workingHours:[]},workingDetailRows=[],capturedClockImage=null,cameraStream=null,clockLocation=null,clockLocationRequestSeq=0;
const reportTableState={
  working:{sortKey:'',sortDir:'',filters:{}}
};
const $=s=>document.querySelector(s),$$=s=>Array.from(document.querySelectorAll(s));
function todayMY(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
function timeMY(){const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date()).map(x=>[x.type,x.value]));return `${p.hour}:${p.minute}`}
function shiftYmd(ymd,days){const d=new Date(`${ymd}T12:00:00+08:00`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)}
function isDesktopClockDevice(){
  const ua=String(navigator.userAgent||'');
  const mobileUa=/(Android|iPhone|iPad|iPod|Mobile)/i.test(ua);
  const desktopUa=/(Windows NT|Macintosh|X11|CrOS)/i.test(ua);
  return desktopUa&&!mobileUa;
}
function mapEmbedUrl(latitude,longitude){
  const lat=Number(latitude),lng=Number(longitude),pad=0.003;
  const bbox=[lng-pad,lat-pad,lng+pad,lat+pad].map(x=>x.toFixed(6)).join('%2C');
  return 'https://www.openstreetmap.org/export/embed.html?bbox='+bbox+'&layer=mapnik&marker='+lat.toFixed(6)+'%2C'+lng.toFixed(6);
}
function setLocationPermissionHelp(show){
  const actionRow=$('#locationActionRow'),helpBtn=$('#locationPermissionHelpBtn'),help=$('#locationPermissionHelp');
  if(actionRow)actionRow.classList.toggle('hidden',!show);
  if(helpBtn)helpBtn.classList.toggle('hidden',!show);
  if(!show&&help)help.classList.add('hidden');
}
function renderClockLocation(){
  const input=$('#clockLocation'),meta=$('#clockLocationMeta'),frame=$('#clockLocationMap'),actionRow=$('#locationActionRow');
  if(!input||!meta||!frame)return;
  if(isDesktopClockBlocked()){
    input.value='Available when clocking on mobile';
    meta.textContent='Desktop view is read-only. Location is captured automatically on the employee phone.';
    frame.removeAttribute('src');
    frame.classList.add('hidden');
    if(actionRow)actionRow.classList.add('hidden');
    setLocationPermissionHelp(false);
    return;
  }
  if(!clockLocation){
    frame.removeAttribute('src');
    frame.classList.add('hidden');
    return;
  }
  input.value=clockLocation.latitude.toFixed(6)+', '+clockLocation.longitude.toFixed(6);
  frame.src=mapEmbedUrl(clockLocation.latitude,clockLocation.longitude);
  frame.classList.remove('hidden');

  meta.textContent='GPS accuracy ±'+Math.round(clockLocation.accuracy)+' m · Location captured from Safari/iOS';
  if(actionRow)actionRow.classList.add('hidden');
  setLocationPermissionHelp(false);
}
const GPS_TARGET_ACCURACY_M=100;
function positionToClockLocation(position){
  if(!position||!position.coords)return null;
  const latitude=Number(position.coords.latitude);
  const longitude=Number(position.coords.longitude);
  const accuracy=Number(position.coords.accuracy);
  if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||!Number.isFinite(accuracy))return null;
  return {
    latitude,
    longitude,
    accuracy,
    capturedAt:new Date(position.timestamp||Date.now()).toISOString()
  };
}
function locationErrorMessage(error){
  if(error&&error.code===1)return 'Location permission was denied. Please allow Location for this website in your phone settings.';
  if(error&&error.code===2)return 'Current location is unavailable. Please make sure Location Services and GPS are enabled.';
  if(error&&error.code===3)return 'Location request timed out. Please retry.';
  return 'Unable to get current location. Please retry.';
}
function collectAccuratePosition({force=false,onProgress}={}){
  return new Promise((resolve,reject)=>{
    let settled=false,best=null,watchId=null;
    const cleanup=()=>{if(watchId!==null&&navigator.geolocation)navigator.geolocation.clearWatch(watchId);clearTimeout(timer)};
    const finish=(fn,value)=>{if(settled)return;settled=true;cleanup();fn(value)};
    const timer=setTimeout(()=>{
      if(best)return finish(resolve,best);
      return finish(reject,{code:3,message:'Location request timed out'});
    },12000);
    watchId=navigator.geolocation.watchPosition(position=>{
      const accuracy=Number(position.coords?.accuracy);
      if(!Number.isFinite(accuracy))return;
      if(!best||accuracy<Number(best.coords?.accuracy))best=position;
      if(typeof onProgress==='function')onProgress(best,accuracy);
      if(accuracy<=GPS_TARGET_ACCURACY_M)finish(resolve,position);
    },error=>{
      if(error&&error.code===1)return finish(reject,error);
      if(error&&error.code===2&&!best)return;
      if(error&&error.code===3&&!best)return;
    },{
      enableHighAccuracy:true,
      timeout:10000,
      maximumAge:force?0:15000
    });
  });
}
async function captureClockLocation({silent=false,force=false}={}){
  if(isDesktopClockBlocked()){clockLocation=null;renderClockLocation();return null}
  const input=$('#clockLocation'),meta=$('#clockLocationMeta'),actionRow=$('#locationActionRow'),helpBtn=$('#locationPermissionHelpBtn'),help=$('#locationPermissionHelp'),frame=$('#clockLocationMap');
  const requestId=++clockLocationRequestSeq;
  if(input)input.value='Getting current location...';
  if(meta)meta.textContent='Please allow Location permission. This is required for Clock.';
  if(actionRow)actionRow.classList.add('hidden');
  if(helpBtn)helpBtn.classList.add('hidden');
  if(help)help.classList.add('hidden');
  if(frame){frame.removeAttribute('src');frame.classList.add('hidden')}

  if(!navigator.geolocation){
    if(requestId!==clockLocationRequestSeq)return null;
    clockLocation=null;
    if(input)input.value='Location unavailable';
    if(meta)meta.textContent='Location is not available in this browser. Please use your phone.';
    if(actionRow)actionRow.classList.remove('hidden');
    if(helpBtn)helpBtn.classList.add('hidden');
    if(!silent)toast('Location is not available in this browser. Please use your phone.','error');
    return null;
  }

  try{
    const position=await collectAccuratePosition({
      force,
      onProgress:(best)=>{
        if(requestId!==clockLocationRequestSeq)return;
        const bestLocation=positionToClockLocation(best);
        if(bestLocation){
          clockLocation=bestLocation;
          renderClockLocation();
        }
        const bestAccuracy=Number(best?.coords?.accuracy);
        if(meta&&Number.isFinite(bestAccuracy)){
          meta.textContent='GPS accuracy ±'+Math.round(bestAccuracy)+' m · Location received · Checking for a better GPS sample...';
        }
      }
    });
    if(requestId!==clockLocationRequestSeq)return null;
    clockLocation=positionToClockLocation(position);
    if(!clockLocation)throw new Error('Invalid location received from device.');
    renderClockLocation();
    return clockLocation;
  }catch(e){
    if(requestId!==clockLocationRequestSeq)return null;

    clockLocation=null;
    if(input)input.value='Location unavailable';
    if(meta)meta.textContent=locationErrorMessage(e);
    if(frame){frame.removeAttribute('src');frame.classList.add('hidden')}
    if(actionRow)actionRow.classList.remove('hidden');
    const helpRecommended=!!(e&&e.code===1);
    if(helpBtn)helpBtn.classList.toggle('hidden',!helpRecommended);
    if(!helpRecommended&&help)help.classList.add('hidden');
    if(!silent)toast(locationErrorMessage(e),'error');
    return null;
  }
}
async function ensureFreshClockLocation(){
  const capturedMs=clockLocation?Date.parse(clockLocation.capturedAt):0;
  if(!clockLocation || !Number.isFinite(capturedMs) || Date.now()-capturedMs>2*60*1000){
    await captureClockLocation({silent:false});
  }
  if(!clockLocation)throw new Error('Location access is required to clock in/out. Please enable Location permission.');
  return clockLocation;
}
function dataUrlBytes(dataUrl){
  const base64=String(dataUrl||'').split(',')[1]||'';
  const padding=base64.endsWith('==')?2:(base64.endsWith('=')?1:0);
  return Math.max(0,Math.floor(base64.length*3/4)-padding);
}
function stopClockCamera(){
  if(cameraStream){cameraStream.getTracks().forEach(track=>track.stop());cameraStream=null}
  const video=$('#clockCamera');
  if(video)video.srcObject=null;
  const live=$('#cameraLive');
  if(live)live.classList.add('hidden');
}
function clearClockPhoto(){
  stopClockCamera();
  capturedClockImage=null;
  const preview=$('#clockPhotoPreview');
  if(preview)preview.removeAttribute('src');
  const previewWrap=$('#cameraPreviewWrap');
  if(previewWrap)previewWrap.classList.add('hidden');
  const idle=$('#cameraIdle');
  if(idle)idle.classList.remove('hidden');
  if($('#uploadTitle'))$('#uploadTitle').textContent='Take Clock Photo';
  if($('#uploadHint'))$('#uploadHint').textContent='Live camera only · required before Save';
}
function isDesktopClockBlocked(){
  return isDesktopClockDevice();
}
function applyClockDevicePolicy(){
  const desktopBlocked=isDesktopClockBlocked();
  $('#clockFormBody').classList.remove('hidden');
  $('#clockCameraBox').classList.toggle('desktop-camera-disabled',desktopBlocked);
  $('#openCameraBtn').disabled=desktopBlocked;
  $('#capturePhotoBtn').disabled=desktopBlocked;
  $('#retakePhotoBtn').disabled=desktopBlocked;
  $('#saveClockBtn').disabled=desktopBlocked;
  $('#saveClockBtn').classList.toggle('desktop-disabled',desktopBlocked);
  if(desktopBlocked){
    stopClockCamera();
    capturedClockImage=null;
    clockLocation=null;
    $('#cameraLive').classList.add('hidden');
    $('#cameraPreviewWrap').classList.add('hidden');
    $('#cameraIdle').classList.remove('hidden');
    $('#uploadTitle').textContent='Clock Image';
    $('#uploadHint').textContent='Unable to edit on desktop · use your phone to clock';
  }else if(!capturedClockImage){
    $('#uploadTitle').textContent='Take Clock Photo';
    $('#uploadHint').textContent='Live camera only · required before Save';
  }
  renderClockLocation();
  return !desktopBlocked;
}
async function openClockCamera(){
  if(isDesktopClockBlocked()){toast('Clock In/Out is only available on mobile. Please use your phone.','error');return}
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){toast('Live camera is not available in this browser. Please use your phone camera.','error');return}
  try{
    stopClockCamera();
    capturedClockImage=null;
    $('#cameraPreviewWrap').classList.add('hidden');

    // Start both permission-sensitive requests from the same real user tap.
    // This is more reliable on iPhone Safari than relying only on page-load geolocation.
    const locationPromise=captureClockLocation({silent:true,force:true});
    const mediaPromise=navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
    cameraStream=await mediaPromise;
    await locationPromise;
    const video=$('#clockCamera');
    video.srcObject=cameraStream;
    await video.play();
    $('#cameraIdle').classList.add('hidden');
    $('#cameraLive').classList.remove('hidden');
  }catch(e){
    stopClockCamera();
    $('#cameraIdle').classList.remove('hidden');
    toast('Camera access is required to clock in/out. Please allow camera permission.','error');
  }
}
function captureClockPhoto(){
  const video=$('#clockCamera');
  if(!video||!video.videoWidth||!video.videoHeight){toast('Camera is not ready yet.','error');return}
  const canvas=$('#clockPhotoCanvas');
  const maxSide=1600;
  const scale=Math.min(1,maxSide/Math.max(video.videoWidth,video.videoHeight));
  canvas.width=Math.max(1,Math.round(video.videoWidth*scale));
  canvas.height=Math.max(1,Math.round(video.videoHeight*scale));
  const ctx=canvas.getContext('2d');
  ctx.drawImage(video,0,0,canvas.width,canvas.height);
  const dataUrl=canvas.toDataURL('image/jpeg',0.85);
  const size=dataUrlBytes(dataUrl);
  if(size>8*1024*1024){toast('Clock Image must be 8 MB or smaller','error');return}
  capturedClockImage={name:'clock-'+Date.now()+'.jpg',type:'image/jpeg',size,dataUrl};
  $('#clockPhotoPreview').src=dataUrl;
  stopClockCamera();
  $('#cameraIdle').classList.add('hidden');
  $('#cameraPreviewWrap').classList.remove('hidden');
  $('#uploadTitle').textContent='Photo captured';
  $('#uploadHint').textContent=Math.max(1,Math.round(size/1024))+' KB · live camera';
}
async function api(url,opts={}){const r=await fetch(url,{headers:{'content-type':'application/json',...(opts.headers||{})},...opts});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||`HTTP ${r.status}`);return j}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function toast(msg,type='ok'){const el=$('#toast');el.textContent=msg;el.className=`toast ${type}`;clearTimeout(window.__toast);window.__toast=setTimeout(()=>el.classList.add('hidden'),3200)}
function initials(name){return String(name||'T').trim().split(/\s+/).map(x=>x[0]).join('').slice(0,2).toUpperCase()}
async function init(){try{const me=await api('/api/me');await showApp(me.user)}catch{showLogin()}}
function showLogin(){$('#login').classList.remove('hidden');$('#app').classList.add('hidden')}
async function showApp(user){currentUser=user;$('#login').classList.add('hidden');$('#app').classList.remove('hidden');$('#userName').textContent=user.name;$('#userRole').textContent=user.permission;$('#avatar').textContent=initials(user.name);$('#clockDate').value=todayMY();$('#clockTime').value=timeMY();$('#dateInput').value=todayMY();applyClockMode();applyClockDevicePolicy();applySavedSidebarState();await loadClockContext();setView('clock');if(!isDesktopClockBlocked())captureClockLocation({silent:true})}
async function login(){try{$('#loginMsg').textContent='';const j=await api('/api/login',{method:'POST',body:JSON.stringify({username:$('#username').value,password:$('#password').value})});await showApp(j.user)}catch(e){$('#loginMsg').textContent=e.message}}

async function loadClockContext(){
  try{
    const date=$('#clockDate').value||todayMY();
    clockContext=await api(`/api/clock/context?date=${encodeURIComponent(date)}`);
    $('#clockStaffName').value=clockContext.staffName||currentUser.name||'';
    $('#clockDepartment').value=clockContext.department||'';
    applyUsedTypes();
    updateClockStatus();
  }catch(e){toast(e.message,'error')}
}
function updateClockStatus(){
  const field=$('#clockCheckStatus'),label=$('#clockCheckLabel'),wrap=$('#clockCheckWrap'),note=$('#clockCheckNote');
  if(selectedType==='In'){
    label.classList.remove('hidden');wrap.classList.remove('hidden');
    label.textContent='Missing Out';
    const missing=!!clockContext?.missingOut;
    field.value=missing?'Yes':'No';
    note.textContent=missing?'Please make adjustment for yesterday Out.':'';
    note.classList.toggle('hidden',!missing);
  }else if(selectedType==='Out'){
    label.classList.remove('hidden');wrap.classList.remove('hidden');
    label.textContent='Missing In';
    const missing=!!clockContext?.missingIn;
    field.value=missing?'Yes':'No';
    note.textContent=missing?'Please make adjustment for today In.':'';
    note.classList.toggle('hidden',!missing);
  }else{
    label.classList.add('hidden');wrap.classList.add('hidden');
    field.value='';note.textContent='';note.classList.add('hidden');
  }
}
function applyUsedTypes(){
  const used=new Set((clockContext?.usedTypes||[]).map(x=>String(x)));
  const buttons=$$('#typeGrid button');
  buttons.forEach(b=>{
    const recorded=used.has(b.dataset.type);
    b.disabled=recorded;
    b.classList.toggle('already-recorded',recorded);
    b.title=recorded?b.dataset.type+' already recorded for this date':'';
  });
  if(used.has(selectedType)){
    const next=buttons.find(b=>!b.disabled);
    if(next)selectedType=next.dataset.type;
  }
  buttons.forEach(b=>b.classList.toggle('selected',b.dataset.type===selectedType));
}
function setType(type){
  const button=$$('#typeGrid button').find(b=>b.dataset.type===type);
  if(button&&button.disabled)return;
  selectedType=type;
  $$('#typeGrid button').forEach(b=>b.classList.toggle('selected',b.dataset.type===type));
  updateClockStatus();
}
function clientClockSequenceError(type){
  const date=$('#clockDate').value||todayMY();
  const used=new Set((clockContext?.usedTypes||[]).map(x=>String(x)));

  if(type==='In')return '';
  if(type==='Overnight Out'){
    return clockContext?.overnightOutAllowed
      ? ''
      : 'No valid Night Shift In found for the previous day. Overnight Out is not allowed.';
  }
  if(!used.has('In')){
    return adjustment==='Yes'
      ? 'No In record for '+date+'. Please make the In adjustment first.'
      : 'No In record for today. Please clock In first.';
  }
  if(type==='Lunch In'&&!used.has('Lunch Out'))return 'No Lunch Out record. Lunch In is not allowed.';
  if(type==='Extra In'&&!used.has('Extra Out'))return 'No Extra Out record. Extra In is not allowed.';
  if(type==='Outstation In'&&!used.has('Outstation Out'))return 'No Outstation Out record. Outstation In is not allowed.';
  return '';
}
function setAdjustment(value){adjustment=value;$$('#adjustment button').forEach(b=>b.classList.toggle('selected',b.dataset.value===value));applyClockMode()}
function applyClockMode(){
  const yes=adjustment==='Yes',today=todayMY();
  $('#clockDate').max=today;
  $('#clockDate').disabled=!yes;
  $('#clockTime').disabled=!yes;
  $('#remarksRequiredMark').classList.toggle('hidden',!yes);
  if(!yes){$('#clockDate').value=today;$('#clockTime').value=timeMY();$('#clockRemarks').value=''}
}
async function saveClock(){
  const btn=$('#saveClockBtn');
  try{
    if(isDesktopClockBlocked()) throw new Error('Clock In/Out is only available on mobile. Please use your phone.');
    const today=todayMY();
    if(adjustment==='No'){$('#clockDate').value=today;$('#clockTime').value=timeMY()}
    if($('#clockDate').value>today) throw new Error('Future date is not allowed');
    if(adjustment==='Yes'&&!$('#clockRemarks').value.trim()) throw new Error('Remarks is required for Adjustment = Yes');
    if(adjustment==='No'&&$('#clockDate').value!==today) throw new Error('Past date is Adjustment only');
    const sequenceError=clientClockSequenceError(selectedType);
    if(sequenceError) throw new Error(sequenceError);
    if(!capturedClockImage) throw new Error('Clock Image is required. Please take a live photo.');
    if(capturedClockImage.size>8*1024*1024) throw new Error('Clock Image must be 8 MB or smaller');
    await ensureFreshClockLocation();
    btn.disabled=true;btn.classList.add('loading');
    const payload={type:selectedType,date:$('#clockDate').value,time:$('#clockTime').value,adjustment,remarks:$('#clockRemarks').value.trim(),captureSource:'camera',image:capturedClockImage,location:clockLocation};
    const j=await api('/api/clock',{method:'POST',body:JSON.stringify(payload)});
    toast(selectedType+' saved at '+j.time);
    clearClockPhoto();
    clockLocation=null;
    renderClockLocation();
    if(adjustment==='Yes')$('#clockRemarks').value='';
    await loadClockContext();
    captureClockLocation({silent:true});
  }catch(e){toast(e.message,'error')}
  finally{btn.classList.remove('loading');applyClockDevicePolicy()}
}
function resetClock(){setType('In');setAdjustment('No');$('#clockDate').value=todayMY();$('#clockTime').value=timeMY();$('#clockRemarks').value='';clearClockPhoto();clockLocation=null;renderClockLocation();loadClockContext();if(!isDesktopClockBlocked())captureClockLocation({silent:true})}

function setView(view){
  if(view!=='clock')stopClockCamera();
  $('#clockView').classList.toggle('hidden',view!=='clock');
  $('#reportView').classList.toggle('hidden',view!=='report');
  $('#approvalView').classList.toggle('hidden',view!=='approval');
  $$('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  const titles={clock:'Clock',report:'Report',approval:'Approval Center'};
  $('#headerTitle').textContent=titles[view]||'TBH HR';
  $('#headerEyebrow').textContent='TBH INDUSTRIES · HUMAN RESOURCES';
  closeMenu();
  if(view==='clock'&&!isDesktopClockBlocked()&&!clockLocation)captureClockLocation({silent:true});
  if(view==='report')loadReport();
  if(view==='approval')loadApprovals()
}
function isMobile(){return window.matchMedia('(max-width:760px)').matches}
function applySavedSidebarState(){
  if(isMobile()){document.body.classList.remove('sidebar-collapsed');return}
  const collapsed=localStorage.getItem('tbhhr-sidebar-collapsed')==='1';
  document.body.classList.toggle('sidebar-collapsed',collapsed);
}
function toggleMenu(){
  if(isMobile()){
    const open=$('#sidebar').classList.toggle('open');
    $('#scrim').classList.toggle('hidden',!open);
    return;
  }
  const collapsed=!document.body.classList.contains('sidebar-collapsed');
  document.body.classList.toggle('sidebar-collapsed',collapsed);
  localStorage.setItem('tbhhr-sidebar-collapsed',collapsed?'1':'0');
}
function closeMenu(){if(isMobile()){$('#sidebar').classList.remove('open');$('#scrim').classList.add('hidden')}}

async function loadReport(){
  try{
    const date=$('#dateInput').value;
    const [daily,detail]=await Promise.all([
      api(`/api/attendance/daily?date=${encodeURIComponent(date)}`),
      api(`/api/report/day?date=${encodeURIComponent(date)}`)
    ]);
    data=daily;
    reportData=detail;
    const day=String(date||'').slice(8,10).replace(/^0/,'');
    if(day)$('#todayModuleDay').textContent=day;
    renderReport();
  }catch(e){toast(e.message,'error')}
}
function setReportPanel(panel){
  reportPanel=panel;
  closeReportFilter();
  $$('[data-report-panel]').forEach(b=>b.classList.toggle('active',b.dataset.reportPanel===panel));
  renderReport();
}
function reportPanelState(){
  return reportTableState[reportPanel]||{sortKey:'',sortDir:'',filters:{}};
}
function reportColumnValue(row,key){
  if(key==='location'){
    const loc=row.location;
    return loc?`${loc.latitude}, ${loc.longitude} ±${Math.round(Number(loc.accuracy)||0)}m`:'';
  }
  if(key==='name')return String(row.name||'').trim();
  return row[key]??'';
}
function reportSortToken(value,key){
  const s=String(value??'').trim();
  if(key==='date'){
    let m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if(m)return Number(`${m[3]}${m[2].padStart(2,'0')}${m[1].padStart(2,'0')}`);
    m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(m)return Number(`${m[1]}${m[2]}${m[3]}`);
  }
  const tm=s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if(tm){
    let h=Number(tm[1]),mins=Number(tm[2]);
    const ap=String(tm[3]||'').toUpperCase();
    if(ap){if(h===12)h=0;if(ap==='PM')h+=12}
    return h*60+mins;
  }
  const n=Number(s.replace(/[^0-9.-]/g,''));
  if(s&&Number.isFinite(n)&&/^[\s$RMrm0-9.,:+-]+$/.test(s))return n;
  return s.toLowerCase();
}
function reportFilterMatches(row,key,value){
  const selected=String(value||'');
  const actual=String(reportColumnValue(row,key)??'').trim();
  if(!selected)return true;
  if(selected==='__BLANK__')return !actual;
  return actual===selected;
}
function applyReportTableState(rows){
  const state=reportPanelState();
  let out=rows.filter(row=>Object.entries(state.filters||{}).every(([key,value])=>reportFilterMatches(row,key,value)));
  if(state.sortKey&&state.sortDir){
    const key=state.sortKey,dir=state.sortDir==='desc'?-1:1;
    out=out.map((row,index)=>({row,index})).sort((a,b)=>{
      const av=reportSortToken(reportColumnValue(a.row,key),key);
      const bv=reportSortToken(reportColumnValue(b.row,key),key);
      let cmp=0;
      if(typeof av==='number'&&typeof bv==='number')cmp=av-bv;
      else cmp=String(av).localeCompare(String(bv),undefined,{numeric:true,sensitivity:'base'});
      return (cmp||a.index-b.index)*dir;
    }).map(x=>x.row);
  }
  return out;
}
function reportHeader(columns){
  const state=reportPanelState();
  const filterSvg='<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4h14l-5.4 6.1v4.5L8.5 16v-5.9L3 4Z"></path></svg>';
  return '<tr>'+columns.map(col=>{
    const filtered=!!String(state.filters?.[col.key]||'').trim();
    return `<th><div class="report-th-inner"><button type="button" class="report-sort-label" data-report-sort="${esc(col.key)}" aria-label="Sort ${esc(col.label)}" title="Click to sort">${esc(col.label)}</button><span class="report-th-actions"><button type="button" class="report-th-btn report-filter-btn${filtered?' active':''}" data-report-filter="${esc(col.key)}" data-report-label="${esc(col.label)}" aria-label="Filter ${esc(col.label)}" title="Filter ${esc(col.label)}">${filterSvg}</button></span></div></th>`;
  }).join('')+'</tr>';
}
function cycleReportSort(key){
  const state=reportPanelState();
  if(state.sortKey!==key){state.sortKey=key;state.sortDir='asc'}
  else if(state.sortDir==='asc')state.sortDir='desc';
  else{state.sortKey='';state.sortDir=''}
  closeReportFilter();
  renderReport();
}
function reportFilterSourceRows(panel){
  const q=$('#search').value.trim().toLowerCase();
  if(panel==='working'){
    return (reportData.workingHours||[]).filter(x=>!q||`${x.staffCode} ${x.name} ${x.department} ${x.otApproval}`.toLowerCase().includes(q));
  }
  return [];
}
function reportFilterOptions(key){
  const state=reportPanelState();
  let rows=reportFilterSourceRows(reportPanel);
  rows=rows.filter(row=>Object.entries(state.filters||{}).every(([filterKey,value])=>filterKey===key||reportFilterMatches(row,filterKey,value)));
  const seen=new Map();
  for(const row of rows){
    const raw=String(reportColumnValue(row,key)??'').trim();
    const value=raw||'__BLANK__';
    const identity=value.toLowerCase();
    if(!seen.has(identity))seen.set(identity,{value,label:raw||'(Blank)'});
  }
  const options=[...seen.values()].sort((a,b)=>a.label.localeCompare(b.label,undefined,{numeric:true,sensitivity:'base'}));
  const selected=String(state.filters?.[key]||'');
  if(selected&&!options.some(x=>x.value===selected)){
    options.unshift({value:selected,label:selected==='__BLANK__'?'(Blank)':selected});
  }
  return options;
}
function openReportFilter(button,key,label){
  const pop=$('#reportFilterPopover'),select=$('#reportFilterSelect');
  if(!pop||!select)return;
  const state=reportPanelState();
  pop.dataset.key=key;
  pop.dataset.panel=reportPanel;
  $('#reportFilterLabel').textContent='Filter '+label;
  select.innerHTML='';
  const all=document.createElement('option');
  all.value='';
  all.textContent='All';
  select.appendChild(all);
  for(const item of reportFilterOptions(key)){
    const option=document.createElement('option');
    option.value=item.value;
    option.textContent=item.label;
    select.appendChild(option);
  }
  select.value=state.filters?.[key]||'';
  pop.classList.remove('hidden');
  const r=button.getBoundingClientRect();
  const width=Math.min(300,window.innerWidth-24);
  pop.style.width=width+'px';
  const left=Math.max(12,Math.min(window.innerWidth-width-12,r.right-width));
  pop.style.left=left+'px';
  pop.style.top=Math.min(window.innerHeight-135,r.bottom+8)+'px';
  setTimeout(()=>select.focus(),0);
}
function closeReportFilter(){
  const pop=$('#reportFilterPopover');
  if(pop)pop.classList.add('hidden');
}
function applyReportFilterSelection(){
  const pop=$('#reportFilterPopover'),select=$('#reportFilterSelect');
  if(!pop||!select)return;
  const panel=pop.dataset.panel,key=pop.dataset.key;
  const state=reportTableState[panel];
  if(!state||!key)return closeReportFilter();
  const value=select.value;
  if(value)state.filters[key]=value;
  else delete state.filters[key];
  closeReportFilter();
  renderReport();
}
function renderReport(){
  if(!data)return;
  const q=$('#search').value.trim().toLowerCase();
  const meta=[data.date,data.dayType,data.holiday].filter(Boolean).join(' · ');
  $('#todayCards').classList.toggle('hidden',reportPanel!=='today');
  $('#reportTableBlock').classList.toggle('hidden',reportPanel==='today');

  if(reportPanel==='today'){
    const cards=(data.items||[])
      .map(x=>{
        if(x.clockOut)return null;
        if(x.lunchIn)return {...x,currentStatus:'Back from Lunch',currentStatusTime:x.lunchIn};
        if(x.lunchOut)return {...x,currentStatus:'Lunch Time',currentStatusTime:x.lunchOut};
        if(x.clockIn)return {...x,currentStatus:'In Time',currentStatusTime:x.clockIn};
        return null;
      })
      .filter(Boolean)
      .filter(x=>!q||`${x.staffCode} ${x.name} ${x.department}`.toLowerCase().includes(q));
    $('#reportPanelTitle').textContent='Today';
    $('#resultMeta').textContent=`${cards.length} staff currently working${meta?' · '+meta:''}`;
    $('#todayCards').innerHTML=cards.map(x=>`
      <article class="today-staff-card">
        <div class="today-avatar">${esc(initials(x.name))}</div>
        <div class="today-card-copy">
          <strong>${esc(x.name)}</strong>
          <span>${esc(x.currentStatus)} <b>${esc(x.currentStatusTime)}</b></span>
        </div>
      </article>`).join('');
    if(!cards.length)$('#todayCards').innerHTML='<div class="empty-card-state">No staff is currently working for this date.</div>';
    return;
  }

  const columns=[
    {key:'date',label:'Date'},
    {key:'name',label:'Staff Name'},
    {key:'department',label:'Department'},
    {key:'shift',label:'Shift'},
    {key:'duration',label:'Duration'},
    {key:'lateResult',label:'Late Result'},
    {key:'clockIn',label:'In'},
    {key:'lunchOut',label:'Lunch Out'},
    {key:'lunchIn',label:'Lunch In'},
    {key:'clockOut',label:'Out'},
    {key:'actualOTHour',label:'Actual OT Hour'},
    {key:'otApprovalHours',label:'OT Approval Hours'},
    {key:'otApproval',label:'OT Approval'}
  ];
  let rows=(reportData.workingHours||[]).filter(x=>!q||`${x.staffCode} ${x.name} ${x.department} ${x.shift} ${x.lateResult} ${x.otApproval}`.toLowerCase().includes(q));
  rows=applyReportTableState(rows);
  $('#reportPanelTitle').textContent='Working Hours';
  $('#resultMeta').textContent=`${rows.length} staff records${meta?' · '+meta:''}`;
  $('#reportHead').innerHTML=reportHeader(columns);
  workingDetailRows=rows;
  $('#reportRows').innerHTML=rows.map((x,index)=>`<tr class="working-hours-row" data-working-detail="${index}" tabindex="0" aria-label="View working hour details for ${esc(x.name)}"><td>${esc(x.date)}</td><td><strong>${esc(x.name)}</strong><small>${esc(x.staffCode)}</small></td><td>${esc(x.department||'—')}</td><td>${esc(x.shift||'Normal')}</td><td>${esc(x.duration||'—')}</td><td>${esc(x.lateResult||'—')}</td><td>${esc(x.clockIn||'—')}</td><td>${esc(x.lunchOut||'—')}</td><td>${esc(x.lunchIn||'—')}</td><td>${esc(x.clockOut||'—')}</td><td>${esc(x.actualOTHour||'—')}</td><td>${esc(x.otApprovalHours||'00:00')}</td><td>${esc(x.otApproval||'—')}</td></tr>`).join('');
  if(!$('#reportRows').innerHTML)$('#reportRows').innerHTML='<tr><td colspan="13" class="empty-cell">No working hour records</td></tr>';
}

function workingDetailDate(value){
  const m=String(value||'').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if(!m)return String(value||'');
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return Number(m[1])+' '+months[Number(m[2])-1];
}
function openWorkingDetails(index){
  const x=workingDetailRows[Number(index)];
  if(!x)return;
  $('#workingDetailsTitle').textContent=x.name||'Working Hours Details';
  $('#workingDetailsMeta').textContent=[x.department,x.shift,x.date].filter(Boolean).join(' · ');
  $('#workingDetailsEvents').innerHTML=(x.events||[]).map(event=>`
    <div class="working-detail-event">
      <span class="working-detail-date">${esc(workingDetailDate(event.date))}</span>
      <span class="working-detail-type">${esc(event.type)}</span>
      <strong>${esc(event.time||'—')}</strong>
    </div>`).join('')||'<div class="working-detail-empty">No clock events.</div>';
  $('#workingDetailsModal').classList.remove('hidden');
}
function closeWorkingDetails(){
  $('#workingDetailsModal').classList.add('hidden');
}

async function loadApprovals(){try{approvalData=await api('/api/approval-center');$('#lateCount').textContent=approvalData.late.length;$('#adjustmentCount').textContent=approvalData.adjustments.length;renderApprovals()}catch(e){toast(e.message,'error')}}
function setApprovalTab(tab){approvalTab=tab;$$('[data-approval-tab]').forEach(b=>b.classList.toggle('active',b.dataset.approvalTab===tab));renderApprovals()}
function lateApprovalActions(x){
  const status=String(x.approval||'').trim();
  if(!approvalData.canApprove||status&&status.toLowerCase()!=='pending')return '—';
  return `<div class="approval-action-group"><button type="button" class="approval-action-btn approve" data-late-action="approve" data-clock-key="${esc(x.key)}">Approve</button><button type="button" class="approval-action-btn reject" data-late-action="reject" data-clock-key="${esc(x.key)}">Reject</button></div>`;
}
async function submitLateApproval(button){
  const action=button.dataset.lateAction,key=button.dataset.clockKey;
  if(!action||!key)return;
  button.closest('.approval-action-group')?.querySelectorAll('button').forEach(b=>b.disabled=true);
  try{
    const result=await api('/api/approval-center/late-action',{method:'POST',body:JSON.stringify({key,action})});
    toast(result.status+' successfully');
    await loadApprovals();
  }catch(e){
    toast(e.message,'error');
    button.closest('.approval-action-group')?.querySelectorAll('button').forEach(b=>b.disabled=false);
  }
}
function renderApprovals(){
  const q=$('#approvalSearch').value.trim().toLowerCase();
  const list=(approvalTab==='late'?approvalData.late:approvalData.adjustments).filter(x=>!q||`${x.name} ${x.staffCode} ${x.department} ${x.type} ${x.remarks}`.toLowerCase().includes(q));
  if(approvalTab==='late'){
    $('#approvalTitle').textContent='Clock Late Approval';
    $('#approvalTableHead').innerHTML='<tr><th>Date</th><th>Staff</th><th>Department</th><th>Type</th><th>Clock Time</th><th>Late Time</th><th>Total Late (min)</th><th>Late Reason</th><th>Approval</th><th>Action</th></tr>';
    $('#approvalRows').innerHTML=list.map(x=>`<tr><td>${esc(x.date)}</td><td><strong>${esc(x.name)}</strong><small>${esc(x.staffCode)}</small></td><td>${esc(x.department)}</td><td>${esc(x.type)}</td><td>${esc(x.time)}</td><td>${esc(x.lateTime||'—')}</td><td>${esc(x.totalLate||'—')}</td><td>${esc(x.remarks||'—')}</td><td><span class="approval-status">${esc(x.approval||'Pending')}</span></td><td>${lateApprovalActions(x)}</td></tr>`).join('');
  }else{
    $('#approvalTitle').textContent='Clock Adjustment Approval';
    $('#approvalTableHead').innerHTML='<tr><th>Date</th><th>Staff</th><th>Department</th><th>Type</th><th>Time</th><th>Remarks</th><th>Approval</th><th>Approval By</th></tr>';
    $('#approvalRows').innerHTML=list.map(x=>`<tr><td>${esc(x.date)}</td><td><strong>${esc(x.name)}</strong><small>${esc(x.staffCode)}</small></td><td>${esc(x.department)}</td><td>${esc(x.type)}</td><td>${esc(x.time)}</td><td>${esc(x.remarks||'—')}</td><td><span class="approval-status">${esc(x.approval||'Pending')}</span></td><td>${esc(x.approvalBy||'—')}</td></tr>`).join('');
  }
  if(!$('#approvalRows').innerHTML)$('#approvalRows').innerHTML=`<tr><td colspan="${approvalTab==='late'?10:8}" class="empty-cell">No items</td></tr>`;
}

$('#loginBtn').onclick=login;
$('#password').addEventListener('keydown',e=>{if(e.key==='Enter')login()});
$('#logoutBtn').onclick=async()=>{await api('/api/logout',{method:'POST'});showLogin()};
$('#menuBtn').onclick=toggleMenu;
$('#scrim').onclick=closeMenu;
$$('[data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view));
$$('[data-report-panel]').forEach(b=>b.onclick=()=>setReportPanel(b.dataset.reportPanel));
$$('[data-approval-tab]').forEach(b=>b.onclick=()=>setApprovalTab(b.dataset.approvalTab));
$$('#typeGrid button').forEach(b=>b.onclick=()=>setType(b.dataset.type));
$$('#adjustment button').forEach(b=>b.onclick=()=>setAdjustment(b.dataset.value));
$('#clockDate').onchange=async()=>{if($('#clockDate').value>todayMY()){$('#clockDate').value=todayMY();toast('Future date is not allowed','error')}await loadClockContext()};

$('#saveClockBtn').onclick=saveClock;
$('#cancelClockBtn').onclick=resetClock;
$('#openCameraBtn').onclick=openClockCamera;
$('#capturePhotoBtn').onclick=captureClockPhoto;
$('#cancelCameraBtn').onclick=()=>{stopClockCamera();$('#cameraIdle').classList.remove('hidden')};
$('#retakePhotoBtn').onclick=()=>{clearClockPhoto();openClockCamera()};
$('#retryLocationBtn').onclick=()=>captureClockLocation({silent:false,force:true});
$('#locationPermissionHelpBtn').onclick=()=>{
  const help=$('#locationPermissionHelp');
  const open=help.classList.toggle('hidden');
  $('#locationPermissionHelpBtn').textContent=open?'How to Enable Location':'Hide Location Help';
};
$('#refreshBtn').onclick=loadReport;
$('#dateInput').onchange=loadReport;
$('#search').oninput=renderReport;
$('#approvalSearch').oninput=renderApprovals;
$('#approvalRows').addEventListener('click',e=>{
  const button=e.target.closest('[data-late-action]');
  if(button)submitLateApproval(button);
});
$('#reportHead').addEventListener('click',e=>{
  const sort=e.target.closest('[data-report-sort]');
  if(sort){cycleReportSort(sort.dataset.reportSort);return}
  const filter=e.target.closest('[data-report-filter]');
  if(filter){openReportFilter(filter,filter.dataset.reportFilter,filter.dataset.reportLabel||'Column')}
});
$('#reportRows').addEventListener('click',e=>{
  const row=e.target.closest('[data-working-detail]');
  if(row)openWorkingDetails(row.dataset.workingDetail);
});
$('#reportRows').addEventListener('keydown',e=>{
  if((e.key==='Enter'||e.key===' ')&&e.target.matches('[data-working-detail]')){
    e.preventDefault();
    openWorkingDetails(e.target.dataset.workingDetail);
  }
});
$('#closeWorkingDetailsBtn').onclick=closeWorkingDetails;
$('#workingDetailsModal').addEventListener('click',e=>{if(e.target===$('#workingDetailsModal'))closeWorkingDetails()});
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#workingDetailsModal').classList.contains('hidden'))closeWorkingDetails()});
$('#reportFilterSelect').onchange=applyReportFilterSelection;
$('#reportFilterSelect').addEventListener('keydown',e=>{if(e.key==='Escape')closeReportFilter()});
document.addEventListener('click',e=>{
  const pop=$('#reportFilterPopover');
  if(!pop||pop.classList.contains('hidden'))return;
  if(pop.contains(e.target)||e.target.closest('[data-report-filter]'))return;
  closeReportFilter();
});
window.addEventListener('resize',()=>{if(!isMobile()){$('#sidebar').classList.remove('open');$('#scrim').classList.add('hidden');applySavedSidebarState()}else{document.body.classList.remove('sidebar-collapsed')}applyClockDevicePolicy()});
window.addEventListener('pagehide',stopClockCamera);
setType('In');
init();