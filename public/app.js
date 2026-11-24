let data=null,currentUser=null,selectedType='In',adjustment='No',reportPanel='today',approvalTab='late',approvalData={late:[],adjustments:[]};
const $=s=>document.querySelector(s),$$=s=>Array.from(document.querySelectorAll(s));
function todayMY(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
async function api(url,opts={}){const r=await fetch(url,{headers:{'content-type':'application/json',...(opts.headers||{})},...opts});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||`HTTP ${r.status}`);return j}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function toast(msg,type='ok'){const el=$('#toast');el.textContent=msg;el.className=`toast ${type}`;clearTimeout(window.__toast);window.__toast=setTimeout(()=>el.classList.add('hidden'),3200)}
function initials(name){return String(name||'T').trim().split(/\s+/).map(x=>x[0]).join('').slice(0,2).toUpperCase()}
async function init(){try{const me=await api('/api/me');await showApp(me.user)}catch{showLogin()}}
function showLogin(){$('#login').classList.remove('hidden');$('#app').classList.add('hidden')}
async function showApp(user){currentUser=user;$('#login').classList.add('hidden');$('#app').classList.remove('hidden');$('#userName').textContent=user.name;$('#userRole').textContent=user.permission;$('#avatar').textContent=initials(user.name);$('#clockDate').value=todayMY();$('#dateInput').value=todayMY();await loadClockContext();setView('clock')}
async function login(){try{$('#loginMsg').textContent='';const j=await api('/api/login',{method:'POST',body:JSON.stringify({username:$('#username').value,password:$('#password').value})});await showApp(j.user)}catch(e){$('#loginMsg').textContent=e.message}}

async function loadClockContext(){try{const date=$('#clockDate').value||todayMY();data=await api(`/api/attendance/daily?date=${encodeURIComponent(date)}`);const items=data.items||[],sel=$('#clockStaff'),prev=sel.value;sel.innerHTML=items.map(x=>`<option value="${esc(x.staffCode)}">${esc(x.name)}${x.department?' · '+esc(x.department):''}</option>`).join('');if(!items.length)sel.innerHTML=`<option value="${esc(currentUser.staffCode)}">${esc(currentUser.name)}</option>`;if(prev&&items.some(x=>x.staffCode===prev))sel.value=prev;else if(items.some(x=>x.staffCode===currentUser.staffCode))sel.value=currentUser.staffCode;updateClockStatus()}catch(e){toast(e.message,'error')}}
function updateClockStatus(){const row=(data?.items||[]).find(x=>x.staffCode===$('#clockStaff').value);$('#checkInStatus').value=row?.clockIn||'Missing In';$('#checkOutStatus').value=row?.clockOut||'Missing Out'}
function setType(type){selectedType=type;$$('#typeGrid button').forEach(b=>b.classList.toggle('selected',b.dataset.type===type))}
function setAdjustment(value){adjustment=value;$$('#adjustment button').forEach(b=>b.classList.toggle('selected',b.dataset.value===value))}
async function saveClock(){const btn=$('#saveClockBtn');try{btn.disabled=true;btn.classList.add('loading');const payload={type:selectedType,staffCode:$('#clockStaff').value,date:$('#clockDate').value,adjustment};const j=await api('/api/clock',{method:'POST',body:JSON.stringify(payload)});toast(`${selectedType} saved at ${j.time}`);$('#clockImage').value='';$('#uploadTitle').textContent='Upload Clock Image';$('#uploadHint').textContent='Tap to select or take a photo';await loadClockContext()}catch(e){toast(e.message,'error')}finally{btn.disabled=false;btn.classList.remove('loading')}}
function resetClock(){setType('In');setAdjustment('No');$('#clockDate').value=todayMY();$('#clockImage').value='';$('#uploadTitle').textContent='Upload Clock Image';$('#uploadHint').textContent='Tap to select or take a photo';loadClockContext()}

function setView(view){$('#clockView').classList.toggle('hidden',view!=='clock');$('#reportView').classList.toggle('hidden',view!=='report');$('#approvalView').classList.toggle('hidden',view!=='approval');$$('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));closeMenu();if(view==='report')loadReport();if(view==='approval')loadApprovals()}
function openMenu(){$('#sidebar').classList.add('open');$('#scrim').classList.remove('hidden')}
function closeMenu(){$('#sidebar').classList.remove('open');$('#scrim').classList.add('hidden')}

async function loadReport(){try{data=await api(`/api/attendance/daily?date=${encodeURIComponent($('#dateInput').value)}`);renderReport()}catch(e){toast(e.message,'error')}}
function setReportPanel(panel){reportPanel=panel;$$('[data-report-panel]').forEach(b=>b.classList.toggle('active',b.dataset.reportPanel===panel));renderReport()}
function renderReport(){
  if(!data)return;
  const items=data.items||[],q=$('#search').value.trim().toLowerCase();
  const rows=items.filter(x=>!q||`${x.staffCode} ${x.name} ${x.department} ${x.position}`.toLowerCase().includes(q));
  $('#resultMeta').textContent=[data.date,data.dayType,data.holiday].filter(Boolean).join(' · ');
  const k=data.kpi||{};
  if(reportPanel==='today'){
    $('#reportPanelTitle').textContent='Today';
    $('#reportSummary').innerHTML=[['Total',k.total],['Present',k.present],['Late',k.late],['Missing',k.missing],['Absent',k.absent]].map(([l,v])=>`<div><span>${l}</span><strong>${v??0}</strong></div>`).join('');
    $('#reportHead').innerHTML='<tr><th>Staff</th><th>Department</th><th>In</th><th>Lunch</th><th>Out</th><th>Late</th><th>Status</th></tr>';
    $('#reportRows').innerHTML=rows.map(x=>`<tr><td><strong>${esc(x.name)}</strong><small>${esc(x.staffCode)}</small></td><td>${esc(x.department)}</td><td>${esc(x.clockIn)}</td><td>${esc(x.lunchOut)}${x.lunchIn?' - '+esc(x.lunchIn):''}</td><td>${esc(x.clockOut)}</td><td>${esc(x.late)}</td><td><span class="pill ${esc(x.status).replaceAll(' ','-')}">${esc(x.status)}</span></td></tr>`).join('');
  }else if(reportPanel==='clockin'){
    $('#reportPanelTitle').textContent='Clock In';
    $('#reportSummary').innerHTML='';
    $('#reportHead').innerHTML='<tr><th>Staff</th><th>Department</th><th>Clock In</th><th>Late</th><th>Status</th></tr>';
    $('#reportRows').innerHTML=rows.map(x=>`<tr><td><strong>${esc(x.name)}</strong><small>${esc(x.staffCode)}</small></td><td>${esc(x.department)}</td><td>${esc(x.clockIn||'—')}</td><td>${esc(x.late||'—')}</td><td><span class="pill ${esc(x.status).replaceAll(' ','-')}">${esc(x.status)}</span></td></tr>`).join('');
  }else{
    $('#reportPanelTitle').textContent='Working Hours';
    $('#reportSummary').innerHTML='';
    $('#reportHead').innerHTML='<tr><th>Staff</th><th>Department</th><th>Schedule</th><th>Start</th><th>End</th><th>Source</th></tr>';
    $('#reportRows').innerHTML=rows.map(x=>`<tr><td><strong>${esc(x.name)}</strong><small>${esc(x.staffCode)}</small></td><td>${esc(x.department)}</td><td>${esc(x.schedule||'Unassigned')}</td><td>${esc(x.scheduledStart||'—')}</td><td>${esc(x.scheduledEnd||'—')}</td><td>${esc(x.scheduleSource||'—')}</td></tr>`).join('');
  }
  if(!$('#reportRows').innerHTML)$('#reportRows').innerHTML='<tr><td colspan="8" class="empty-cell">No records</td></tr>';
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
$('#menuBtn').onclick=()=>$('#sidebar').classList.contains('open')?closeMenu():openMenu();
$('#scrim').onclick=closeMenu;
$$('[data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view));
$$('[data-report-panel]').forEach(b=>b.onclick=()=>setReportPanel(b.dataset.reportPanel));
$$('[data-approval-tab]').forEach(b=>b.onclick=()=>setApprovalTab(b.dataset.approvalTab));
$$('#typeGrid button').forEach(b=>b.onclick=()=>setType(b.dataset.type));
$$('#adjustment button').forEach(b=>b.onclick=()=>setAdjustment(b.dataset.value));
$('#clockDate').onchange=loadClockContext;
$('#clockStaff').onchange=updateClockStatus;
$('#saveClockBtn').onclick=saveClock;
$('#cancelClockBtn').onclick=resetClock;
$('#clockImage').onchange=e=>{const f=e.target.files?.[0];if(f){$('#uploadTitle').textContent=f.name;$('#uploadHint').textContent=`${Math.max(1,Math.round(f.size/1024))} KB selected`;toast('Photo selected. Image storage will be connected separately.','info')}};
$('#refreshBtn').onclick=loadReport;
$('#dateInput').onchange=loadReport;
$('#search').oninput=renderReport;
$('#approvalSearch').oninput=renderApprovals;
setType('In');
init();