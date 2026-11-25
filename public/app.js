let data=null,currentUser=null,selectedType='In',adjustment='No',clockContext=null,reportPanel='today',approvalTab='late',approvalData={late:[],adjustments:[]},reportData={clockMaster:[],workingHours:[]},capturedClockImage=null,cameraStream=null;
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
  $('#desktopClockBlock').classList.toggle('hidden',!desktopBlocked);
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
    $('#cameraLive').classList.add('hidden');
    $('#cameraPreviewWrap').classList.add('hidden');
    $('#cameraIdle').classList.remove('hidden');
    $('#uploadTitle').textContent='Clock Image';
    $('#uploadHint').textContent='Unable to edit on desktop · use your phone to clock';
  }else if(!capturedClockImage){
    $('#uploadTitle').textContent='Take Clock Photo';
    $('#uploadHint').textContent='Live camera only · required before Save';
  }
  return !desktopBlocked;
}
async function openClockCamera(){
  if(isDesktopClockBlocked()){toast('Clock In/Out is only available on mobile. Please use your phone.','error');return}
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){toast('Live camera is not available in this browser. Please use your phone camera.','error');return}
  try{
    stopClockCamera();
    capturedClockImage=null;
    $('#cameraPreviewWrap').classList.add('hidden');
    cameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
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
async function showApp(user){currentUser=user;$('#login').classList.add('hidden');$('#app').classList.remove('hidden');$('#userName').textContent=user.name;$('#userRole').textContent=user.permission;$('#avatar').textContent=initials(user.name);$('#clockDate').value=todayMY();$('#clockTime').value=timeMY();$('#dateInput').value=todayMY();applyClockMode();applyClockDevicePolicy();applySavedSidebarState();await loadClockContext();setView('clock')}
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
    if(!capturedClockImage) throw new Error('Clock Image is required. Please take a live photo.');
    if(capturedClockImage.size>8*1024*1024) throw new Error('Clock Image must be 8 MB or smaller');
    btn.disabled=true;btn.classList.add('loading');
    const payload={type:selectedType,date:$('#clockDate').value,time:$('#clockTime').value,adjustment,remarks:$('#clockRemarks').value.trim(),captureSource:'camera',image:capturedClockImage};
    const j=await api('/api/clock',{method:'POST',body:JSON.stringify(payload)});
    toast(selectedType+' saved at '+j.time);
    clearClockPhoto();
    if(adjustment==='Yes')$('#clockRemarks').value='';
    await loadClockContext();
  }catch(e){toast(e.message,'error')}
  finally{btn.classList.remove('loading');applyClockDevicePolicy()}
}
function resetClock(){setType('In');setAdjustment('No');$('#clockDate').value=todayMY();$('#clockTime').value=timeMY();$('#clockRemarks').value='';clearClockPhoto();loadClockContext()}

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
function setReportPanel(panel){reportPanel=panel;$$('[data-report-panel]').forEach(b=>b.classList.toggle('active',b.dataset.reportPanel===panel));renderReport()}
function renderReport(){
  if(!data)return;
  const q=$('#search').value.trim().toLowerCase();
  const meta=[data.date,data.dayType,data.holiday].filter(Boolean).join(' · ');
  $('#todayCards').classList.toggle('hidden',reportPanel!=='today');
  $('#reportTableBlock').classList.toggle('hidden',reportPanel==='today');

  if(reportPanel==='today'){
    const cards=(data.items||[])
      .filter(x=>x.clockIn)
      .filter(x=>!q||`${x.staffCode} ${x.name} ${x.department}`.toLowerCase().includes(q));
    $('#reportPanelTitle').textContent='Today';
    $('#resultMeta').textContent=`${cards.length} staff clocked in${meta?' · '+meta:''}`;
    $('#todayCards').innerHTML=cards.map(x=>`
      <article class="today-staff-card">
        <div class="today-avatar">${esc(initials(x.name))}</div>
        <div class="today-card-copy">
          <strong>${esc(x.name)}</strong>
          <span>In <b>${esc(x.clockIn)}</b></span>
        </div>
      </article>`).join('');
    if(!cards.length)$('#todayCards').innerHTML='<div class="empty-card-state">No staff has clocked in for this date.</div>';
    return;
  }

  if(reportPanel==='clockmaster'){
    const rows=(reportData.clockMaster||[]).filter(x=>!q||`${x.staffCode} ${x.name} ${x.department} ${x.type} ${x.lateResult} ${x.dayType}`.toLowerCase().includes(q));
    $('#reportPanelTitle').textContent='Clock Master';
    $('#resultMeta').textContent=`${rows.length} clock records${meta?' · '+meta:''}`;
    $('#reportHead').innerHTML='<tr><th>Date</th><th>Time</th><th>Staff Name</th><th>Type</th><th>Department</th><th>Late Result</th><th>Day Type</th></tr>';
    const departments=[...new Set(rows.map(x=>x.department||'Unassigned'))];
    let body='';
    for(const dept of departments){
      const deptRows=rows.filter(x=>(x.department||'Unassigned')===dept);
      body+=`<tr class="department-group-row"><td colspan="7"><strong>${esc(dept)}</strong><span>${deptRows.length}</span></td></tr>`;
      const staffNames=[...new Set(deptRows.map(x=>x.name||x.staffCode||'Unknown'))];
      for(const staffName of staffNames){
        const staffRows=deptRows.filter(x=>(x.name||x.staffCode||'Unknown')===staffName);
        body+=`<tr class="staff-group-row"><td colspan="7"><strong>${esc(staffName)}</strong><span>${staffRows.length}</span></td></tr>`;
        body+=staffRows.map(x=>`<tr><td>${esc(x.date)}</td><td>${esc(x.time)}</td><td>${esc(x.name)}</td><td>${esc(x.type)}</td><td>${esc(x.department||'—')}</td><td>${esc(x.lateResult||'—')}</td><td>${esc(x.dayType||'—')}</td></tr>`).join('');
      }
    }
    $('#reportRows').innerHTML=body||'<tr><td colspan="7" class="empty-cell">No clock records</td></tr>';
    return;
  }

  const rows=(reportData.workingHours||[]).filter(x=>!q||`${x.staffCode} ${x.name} ${x.position} ${x.department} ${x.otApproval}`.toLowerCase().includes(q));
  $('#reportPanelTitle').textContent='Working Hours';
  $('#resultMeta').textContent=`${rows.length} staff records${meta?' · '+meta:''}`;
  $('#reportHead').innerHTML='<tr><th>Date</th><th>Staff Name</th><th>Duration</th><th>In</th><th>Out</th><th>Actual OT Hour</th><th>OT Approval Hours</th><th>Lunch Out</th><th>Lunch In</th><th>OT Approval</th><th>Position</th><th>Department</th></tr>';
  $('#reportRows').innerHTML=rows.map(x=>`<tr><td>${esc(x.date)}</td><td><strong>${esc(x.name)}</strong><small>${esc(x.staffCode)}</small></td><td>${esc(x.duration||'—')}</td><td>${esc(x.clockIn||'—')}</td><td>${esc(x.clockOut||'—')}</td><td>${esc(x.actualOTHour||'—')}</td><td>${esc(x.otApprovalHours||'00:00')}</td><td>${esc(x.lunchOut||'—')}</td><td>${esc(x.lunchIn||'—')}</td><td>${esc(x.otApproval||'—')}</td><td>${esc(x.position||'—')}</td><td>${esc(x.department||'—')}</td></tr>`).join('');
  if(!$('#reportRows').innerHTML)$('#reportRows').innerHTML='<tr><td colspan="12" class="empty-cell">No working hour records</td></tr>';
}

async function loadApprovals(){try{approvalData=await api('/api/approval-center');$('#lateCount').textContent=approvalData.late.length;$('#adjustmentCount').textContent=approvalData.adjustments.length;renderApprovals()}catch(e){toast(e.message,'error')}}
function setApprovalTab(tab){approvalTab=tab;$$('[data-approval-tab]').forEach(b=>b.classList.toggle('active',b.dataset.approvalTab===tab));renderApprovals()}
function renderApprovals(){
  const q=$('#approvalSearch').value.trim().toLowerCase();
  const list=(approvalTab==='late'?approvalData.late:approvalData.adjustments).filter(x=>!q||`${x.name} ${x.staffCode} ${x.department} ${x.type} ${x.remarks}`.toLowerCase().includes(q));
  if(approvalTab==='late'){
    $('#approvalTitle').textContent='Clock Late Approval';
    $('#approvalTableHead').innerHTML='<tr><th>Date</th><th>Staff</th><th>Department</th><th>Type</th><th>Clock Time</th><th>Late Time</th><th>Late Result</th><th>Approval</th></tr>';
    $('#approvalRows').innerHTML=list.map(x=>`<tr><td>${esc(x.date)}</td><td><strong>${esc(x.name)}</strong><small>${esc(x.staffCode)}</small></td><td>${esc(x.department)}</td><td>${esc(x.type)}</td><td>${esc(x.time)}</td><td>${esc(x.lateTime||'—')}</td><td>${esc(x.lateResult||'—')}</td><td><span class="approval-status">${esc(x.approval||'Pending')}</span></td></tr>`).join('');
  }else{
    $('#approvalTitle').textContent='Clock Adjustment Approval';
    $('#approvalTableHead').innerHTML='<tr><th>Date</th><th>Staff</th><th>Department</th><th>Type</th><th>Time</th><th>Remarks</th><th>Approval</th><th>Approval By</th></tr>';
    $('#approvalRows').innerHTML=list.map(x=>`<tr><td>${esc(x.date)}</td><td><strong>${esc(x.name)}</strong><small>${esc(x.staffCode)}</small></td><td>${esc(x.department)}</td><td>${esc(x.type)}</td><td>${esc(x.time)}</td><td>${esc(x.remarks||'—')}</td><td><span class="approval-status">${esc(x.approval||'Pending')}</span></td><td>${esc(x.approvalBy||'—')}</td></tr>`).join('');
  }
  if(!$('#approvalRows').innerHTML)$('#approvalRows').innerHTML='<tr><td colspan="8" class="empty-cell">No items</td></tr>';
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
$('#refreshBtn').onclick=loadReport;
$('#dateInput').onchange=loadReport;
$('#search').oninput=renderReport;
$('#approvalSearch').oninput=renderApprovals;
window.addEventListener('resize',()=>{if(!isMobile()){$('#sidebar').classList.remove('open');$('#scrim').classList.add('hidden');applySavedSidebarState()}else{document.body.classList.remove('sidebar-collapsed')}applyClockDevicePolicy()});
window.addEventListener('pagehide',stopClockCamera);
setType('In');
init();