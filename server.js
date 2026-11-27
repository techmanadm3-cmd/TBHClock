const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { GoogleSheetsClient } = require('./src/googleSheets');
const { rowsToObjects, buildDailyAttendance, findPreviousScheduledWorkDate, isMissingOutFromPrevious, isAutoNightShift } = require('./src/attendance');

const PORT = Number(process.env.PORT || 8080);
const APP_SECRET = process.env.APP_SECRET || 'dev-secret-change-me';
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || '1VY4ZK4Upd6XBT-gdXxfd2ZbgfAlr5MdveDVoIeAGhTI';
const CACHE_SECONDS = Number(process.env.CLOCK_CACHE_SECONDS || 120);
const UPLOAD_ROOT = process.env.UPLOAD_ROOT || path.join(__dirname,'uploads');
const CLOCK_IMAGE_ROOT = path.join(UPLOAD_ROOT,'clock-images');
const credentialsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) : null;
const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'secrets/google-service-account.json');
const sheets = new GoogleSheetsClient({ spreadsheetId: SPREADSHEET_ID, credentialsPath, credentialsJson });

const cache = new Map();
const clockSaveLocks = new Map();

function isDesktopClockRequest(req) {
  const ua = String(req.headers['user-agent'] || '');
  const mobileUa = /(Android|iPhone|iPad|iPod|Mobile)/i.test(ua);
  const desktopUa = /(Windows NT|Macintosh|X11|CrOS)/i.test(ua);
  return desktopUa && !mobileUa;
}
async function withClockSaveLock(key, fn) {
  const previous = clockSaveLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => current);
  clockSaveLocks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (clockSaveLocks.get(key) === tail) clockSaveLocks.delete(key);
  }
}

async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() < hit.exp) return hit.value;
  const value = await fn();
  cache.set(key, { value, exp: Date.now() + ttl * 1000 });
  return value;
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', APP_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifySession(token) {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', APP_SECRET).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!data.exp || Date.now() > data.exp) return null;
  return data;
}
function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map(x => { const i=x.indexOf('='); return [x.slice(0,i).trim(), decodeURIComponent(x.slice(i+1))]; }));
}
function json(res, code, body, headers={}) {
  res.writeHead(code, {'content-type':'application/json; charset=utf-8', ...headers});
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  let body='',bytes=0;
  for await (const chunk of req) {
    bytes+=chunk.length;
    if(bytes>12*1024*1024){const e=new Error('Request too large');e.statusCode=413;throw e}
    body+=chunk;
  }
  return body ? JSON.parse(body) : {};
}
function auth(req) { return verifySession(cookies(req).hr_session); }

async function loadStaff() { return rowsToObjects(await cached('staff', 60, () => sheets.get('Staff!A:AI'))); }
async function loadClock() { return rowsToObjects(await cached('clock', CACHE_SECONDS, () => sheets.get('Clock!A:T'))); }
async function loadOT() { return rowsToObjects(await cached('ot', CACHE_SECONDS, () => sheets.get('OT!A:Y'))); }
async function loadDateDim() { return rowsToObjects(await cached('datedim', 3600, () => sheets.get('DateDim!A1:D1281'))); }
async function loadScheduleRules() { return rowsToObjects(await cached('schedrules', 60, () => sheets.get('HR_ScheduleRules!A1:N500'))); }
async function loadStaffSchedule() { return rowsToObjects(await cached('staffsched', 60, () => sheets.get('HR_StaffSchedule!A1:J1000'))); }

function ymdToDmyLocal(ymd) {
  const m=String(ymd||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}
function shiftYmdLocal(ymd, days) {
  const d=new Date(`${ymd}T12:00:00+08:00`);
  d.setUTCDate(d.getUTCDate()+days);
  return d.toISOString().slice(0,10);
}
function staffClockRowsForDate(clockRows,dateYmd,staffKey) {
  const dmy=ymdToDmyLocal(dateYmd);
  return clockRows.filter(r =>
    String(r.Date||'')===dmy &&
    String(r['Staff Name']||'').trim()===String(staffKey||'').trim()
  );
}
function firstTypeRow(rows,type) {
  return rows
    .filter(r=>String(r.Type||'').trim()===type)
    .sort((a,b)=>String(a.Time||'').localeCompare(String(b.Time||'')))[0] || null;
}
function validateClockSequence({type,dateYmd,staffKey,clockRows}) {
  if(type==='In') return '';

  if(type==='Overnight Out'){
    const sourceDate=shiftYmdLocal(dateYmd,-1);
    const sourceRows=staffClockRowsForDate(clockRows,sourceDate,staffKey);
    const sourceIn=firstTypeRow(sourceRows,'In');
    if(!sourceIn) return `No In record for ${sourceDate}. Overnight Out is not allowed.`;
    if(!isAutoNightShift(sourceDate,sourceIn.Time)) return `The In record for ${sourceDate} is not a Night Shift. Overnight Out is not allowed.`;
    return '';
  }

  const dayRows=staffClockRowsForDate(clockRows,dateYmd,staffKey);
  const inRow=firstTypeRow(dayRows,'In');
  if(!inRow) return `No In record for ${dateYmd}. Please clock In first.`;

  if(type==='Out' && isAutoNightShift(dateYmd,inRow.Time)){
    return 'Night Shift must use Overnight Out on the next day.';
  }

  const requiredPair={
    'Lunch In':'Lunch Out',
    'Extra In':'Extra Out',
    'Outstation In':'Outstation Out'
  }[type];
  if(requiredPair && !firstTypeRow(dayRows,requiredPair)){
    return `No ${requiredPair} record for ${dateYmd}. ${type} is not allowed.`;
  }

  return '';
}
function normalizeClockLocation(location, nowMs=Date.now()) {
  if(!location || typeof location!=='object') throw new Error('Location is required. Please enable Location permission.');
  const latitude=Number(location.latitude);
  const longitude=Number(location.longitude);
  const accuracy=Number(location.accuracy);
  const capturedAt=String(location.capturedAt||'').trim();
  const capturedMs=Date.parse(capturedAt);
  if(!Number.isFinite(latitude)||latitude < -90||latitude > 90) throw new Error('Invalid latitude received from device.');
  if(!Number.isFinite(longitude)||longitude < -180||longitude > 180) throw new Error('Invalid longitude received from device.');
  if(!Number.isFinite(accuracy)||accuracy < 0) throw new Error('Invalid GPS accuracy received from device.');
  if(!Number.isFinite(capturedMs)) throw new Error('Invalid Location capture time.');
  if(capturedMs > nowMs + 2*60*1000 || nowMs - capturedMs > 10*60*1000) throw new Error('Location is outdated. Please allow the app to capture your current location again.');
  return {latitude,longitude,accuracy,capturedAt:new Date(capturedMs).toISOString()};
}
function serializeClockLocation(location, nowMs=Date.now()) {
  const p=normalizeClockLocation(location,nowMs);
  return ['GPS',p.latitude.toFixed(6),p.longitude.toFixed(6),Math.round(p.accuracy),p.capturedAt].join('|');
}
function buildClockKey(date,staffName,type) {
  return String(date||'')+String(staffName||'').trim()+String(type||'').trim();
}
function clockMinutes(value) {
  if(!value) return null;
  const m=String(value).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if(!m) return null;
  return Number(m[1])*60+Number(m[2])+Number(m[3]||0)/60;
}
function durationMinutesLabel(value) {
  if(value==null || !Number.isFinite(value)) return '';
  const mins=Math.max(0,Math.round(value));
  return `${String(Math.floor(mins/60)).padStart(2,'0')}:${String(mins%60).padStart(2,'0')}`;
}
function approvedValue(value) {
  const v=String(value||'').trim().toLowerCase();
  return !!v && !['no','false','rejected','reject','declined','pending'].includes(v) && (v.includes('approv') || ['yes','true','1'].includes(v));
}
function sumOtMinutes(rows) {
  return rows.reduce((sum,r)=>sum+(clockMinutes(r['Estimated Hours of OT'])||0),0);
}
function time12(value) {
  const mins=clockMinutes(value);
  if(mins==null) return String(value||'');
  let hour=Math.floor(mins/60)%24;
  const minute=Math.floor(mins%60);
  const suffix=hour>=12?'PM':'AM';
  hour=hour%12||12;
  return `${hour}:${String(minute).padStart(2,'0')} ${suffix}`;
}
function approvalActor(staff,user){
  return String(
    staff?.Email ||
    staff?.['Email Address'] ||
    staff?.['Work Email'] ||
    staff?.Username ||
    user?.name ||
    user?.staffCode ||
    'Approver'
  ).trim();
}
function approvalByText(action,actor,now=new Date()){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{
    timeZone:'Asia/Kuala_Lumpur',
    year:'numeric',month:'2-digit',day:'2-digit',
    hour:'numeric',minute:'2-digit',second:'2-digit',hour12:true
  }).formatToParts(now).map(x=>[x.type,x.value]));
  const prefix=action==='approve'?'Approve by':'Reject by';
  return `${prefix} ${actor} ${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second} ${String(parts.dayPeriod||'').toUpperCase()}`;
}

function approvalPermission(value){
  return String(value||'').trim().toUpperCase();
}
function sheetColumnLetter(index){
  let n=Number(index)+1,out='';
  while(n>0){const r=(n-1)%26;out=String.fromCharCode(65+r)+out;n=Math.floor((n-1)/26)}
  return out;
}
function canEditStaffRecord(user,editorStaff,targetStaff){
  return approvalPermission(editorStaff?.Permission||user?.permission)==='TOP';
}
function normalizeApprovalItem(r,staffByKey,sheetRow=null){
  const staffCode=String(r['Staff Name']||'');
  const s=staffByKey.get(staffCode)||{};
  return {
    key:r.Key||'',
    sheetRow,
    date:r.Date||'',
    time:r.Time||'',
    staffCode,
    name:r.Name||s['Staff Name']||staffCode,
    department:r.Department||s.Department1||s.Department||'',
    type:r.Type||'',
    remarks:r.Remarks||'',
    adjustment:r.Adjustment||'',
    approval:r.Approval||'',
    approvalBy:r['Approvel By']||'',
    position:r.Position||s.Position||s['Job Title']||s.Department||'',
    permission:r.Permission||s.Permission||'',
    lateTime:r['Late Time']||'',
    lateResult:r['Late Result']||'',
    totalLate:r['Total Late']||''
  };
}
function isLateApprovalCandidate(item){
  const type=String(item.type||'').trim().toUpperCase();
  const lateResult=String(item.lateResult||'').trim().toUpperCase();
  const approval=String(item.approval||'').trim();
  const position=approvalPermission(item.position);
  return type==='IN' &&
    lateResult==='LATE' &&
    !approval &&
    position!=='HOD' &&
    position!=='TOP';
}
function isAdjustmentApprovalCandidate(item){
  const adjustment=String(item.adjustment||'').trim().toUpperCase();
  const approval=String(item.approval||'').trim().toUpperCase();
  return adjustment==='YES' && (!approval || approval==='PENDING');
}
function canAccessAdjustmentApproval(user,approverStaff,item){
  const approverPermission=approvalPermission(approverStaff?.Permission||user?.permission);
  if(approverPermission==='TOP' || approverPermission==='HOD') return true;
  if(approverPermission==='STAFF') return String(item.staffCode||'')===String(user?.staffCode||'');
  return false;
}
function canAccessLateApproval(user,approverStaff,item){
  const approverPermission=approvalPermission(approverStaff?.Permission||user?.permission);
  const approverDepartment=String(approverStaff?.Department1||user?.department||'').trim();
  const targetDepartment=String(item.department||'').trim();
  const targetPermission=approvalPermission(item.permission);

  if(approverPermission==='TOP') return true;
  if(approverPermission==='HOD'){
    return approverDepartment===targetDepartment &&
      (targetPermission.includes('HOD')||targetPermission.includes('STAFF'));
  }
  if(approverPermission==='STAFF'){
    return approverDepartment===targetDepartment &&
      targetPermission.includes('STAFF');
  }
  return false;
}

function saveClockImage(image,staffCode,dateYmd,time){
  if(!image||!image.dataUrl) throw new Error('Clock Image is required');
  const mime=String(image.type||'').toLowerCase();
  const extByMime={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'};
  const ext=extByMime[mime];
  if(!ext) throw new Error('Clock Image must be JPEG, PNG or WebP');
  const m=String(image.dataUrl).match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if(!m||m[1].toLowerCase()!==mime) throw new Error('Invalid Clock Image');
  const buffer=Buffer.from(m[2],'base64');
  if(!buffer.length) throw new Error('Clock Image is required');
  if(buffer.length>8*1024*1024) throw new Error('Clock Image must be 8 MB or smaller');
  fs.mkdirSync(CLOCK_IMAGE_ROOT,{recursive:true});
  const safeStaff=String(staffCode||'staff').replace(/[^A-Za-z0-9_-]/g,'_');
  const name=`${String(dateYmd).replace(/-/g,'')}_${String(time).replace(/:/g,'')}_${safeStaff}_${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(CLOCK_IMAGE_ROOT,name),buffer,{mode:0o600});
  return `clock-images/${name}`;
}
async function routeApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    if (url.searchParams.get('deep') === '1') {
      const rows = await sheets.get('HR_Settings!A1:D20');
      const sourceOk = rows.some(r => String(r[0] || '').trim() === 'SOURCE_OF_TRUTH' && String(r[1] || '').trim() === 'GOOGLE_SHEETS');
      if (!sourceOk) return json(res, 503, {ok:false, service:'tbh-hr-webapp', googleSheets:false});
      return json(res, 200, {ok:true, service:'tbh-hr-webapp', googleSheets:true});
    }
    return json(res, 200, {ok:true, service:'tbh-hr-webapp'});
  }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const {username, password} = await readJson(req);
    const staff = (await loadStaff()).find(s => s.Username === username && s.Password === password && String(s.Status).toLowerCase() === 'active');
    if (!staff) return json(res, 401, {error:'Invalid username or password'});
    const token = signSession({ staffCode: staff.Key, name: staff['Staff Name'], department: staff.Department1 || '', permission: staff.Permission || 'STAFF', exp: Date.now()+12*60*60*1000 });
    return json(res, 200, {ok:true, user:{staffCode:staff.Key,name:staff['Staff Name'],department:staff.Department1||'',permission:staff.Permission}}, {'set-cookie':`hr_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`});
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    return json(res, 200, {ok:true}, {'set-cookie':'hr_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'});
  }
  const user = auth(req);
  if (!user) return json(res, 401, {error:'Unauthenticated'});
  if (req.method === 'GET' && url.pathname === '/api/me') return json(res, 200, {user});
  if (req.method === 'GET' && url.pathname.startsWith('/api/clock-image/')) {
    const name=path.basename(url.pathname.slice('/api/clock-image/'.length));
    const file=path.join(CLOCK_IMAGE_ROOT,name);
    if(!name||!file.startsWith(CLOCK_IMAGE_ROOT)||!fs.existsSync(file)) return json(res,404,{error:'Clock Image not found'});
    const ext=path.extname(file).toLowerCase();
    const types={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp'};
    res.writeHead(200,{'content-type':types[ext]||'application/octet-stream','cache-control':'private, max-age=300'});
    return fs.createReadStream(file).pipe(res);
  }

  if (req.method === 'GET' && url.pathname === '/api/clock/context') {
    const date = url.searchParams.get('date') || new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res,400,{error:'Invalid date'});
    const [staffRows, clockRows, dateDimRows, scheduleRules, scheduleAssignments] = await Promise.all([
      loadStaff(),loadClock(),loadDateDim(),loadScheduleRules(),loadStaffSchedule()
    ]);
    const staff = staffRows.find(s => String(s.Key) === String(user.staffCode));
    if (!staff) return json(res,404,{error:'Staff record not found'});

    const daily = buildDailyAttendance({dateYmd:date,staffRows:[staff],clockRows,dateDimRows,scheduleRules,scheduleAssignments});
    const current = daily.items[0] || {};
    const previousWorkDate = findPreviousScheduledWorkDate({
      dateYmd:date,staff,assignments:scheduleAssignments,rules:scheduleRules,dateDimRows
    });
    let previousIn = '';
    let previousOut = '';
    let missingOut = false;
    if (previousWorkDate) {
      const previous = buildDailyAttendance({dateYmd:previousWorkDate,staffRows:[staff],clockRows,dateDimRows,scheduleRules,scheduleAssignments});
      const previousItem = previous.items[0] || {};
      previousIn = previousItem.clockIn || '';
      previousOut = previousItem.clockOut || '';
      missingOut = isMissingOutFromPrevious(previousItem);
    }
    const dateDmy = ymdToDmyLocal(date);
    const usedTypes = [...new Set(
      clockRows
        .filter(r => String(r.Date || '') === dateDmy && String(r['Staff Name'] || '').trim() === String(staff.Key || '').trim())
        .map(r => String(r.Type || '').trim())
        .filter(Boolean)
    )];
    const overnightSourceDate=shiftYmdLocal(date,-1);
    const overnightSourceRows=staffClockRowsForDate(clockRows,overnightSourceDate,staff.Key);
    const overnightSourceIn=firstTypeRow(overnightSourceRows,'In');
    const overnightOutAllowed=!!overnightSourceIn && isAutoNightShift(overnightSourceDate,overnightSourceIn.Time);
    return json(res,200,{
      date,
      staffCode:staff.Key,
      staffName:staff['Staff Name'] || '',
      department:staff.Department1 || '',
      previousWorkDate,
      missingOut,
      missingIn:!current.clockIn,
      currentIn:current.clockIn || '',
      previousIn,
      previousOut,
      usedTypes,
      overnightSourceDate,
      overnightOutAllowed
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/staff-list') {
    const staffRows=await loadStaff();
    const staffList=staffRows
      .filter(s=>String(s.Key||'').trim()||String(s['Staff Name']||'').trim())
      .map(s=>({
        staffCode:String(s.Key||'').trim(),
        name:String(s['Staff Name']||s.Key||'').trim(),
        department:String(s.Department1||'').trim(),
        position:String(s['Job Title']||s.Department||'').trim(),
        permission:String(s.Permission||'').trim(),
        status:String(s.Status||'').trim(),
        joinDate:String(s['Join Date']||'').trim()
      }))
      .sort((a,b)=>(a.name||'').localeCompare(b.name||'',undefined,{numeric:true,sensitivity:'base'}));
    return json(res,200,{items:staffList});
  }

  if (req.method === 'POST' && url.pathname === '/api/staff-list/update') {
    const body=await readJson(req);
    const staffCode=String(body.staffCode||'').trim();
    const name=String(body.name||'').trim();
    const department=String(body.department||'').trim();
    const position=String(body.position||'').trim();
    const permission=String(body.permission||'').trim().toUpperCase();
    const status=String(body.status||'').trim();
    const joinDate=String(body.joinDate||'').trim();

    if(!staffCode) return json(res,400,{error:'Staff ID is required.'});
    if(!name) return json(res,400,{error:'Staff Name is required.'});
    if(!department) return json(res,400,{error:'Department is required.'});
    if(!position) return json(res,400,{error:'Position is required.'});
    if(!permission) return json(res,400,{error:'Permission is required.'});
    if(!['TOP','HOD','STAFF'].includes(permission)) return json(res,400,{error:'Permission must be TOP, HOD or STAFF.'});
    if(!status) return json(res,400,{error:'Status is required.'});
    if(!['ACTIVE','INACTIVE'].includes(status.toUpperCase())) return json(res,400,{error:'Status must be Active or Inactive.'});
    if(!joinDate) return json(res,400,{error:'Join Date is required.'});
    if(!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(joinDate)&&!/^\d{4}-\d{2}-\d{2}$/.test(joinDate)){
      return json(res,400,{error:'Join Date must use DD/MM/YYYY or YYYY-MM-DD.'});
    }

    const rawRows=await sheets.get('Staff!A:AI');
    const headers=rawRows[0]||[];
    const keyIndex=headers.indexOf('Key');
    const rowIndex=rawRows.findIndex((row,index)=>index>0&&String(row[keyIndex]||'').trim()===staffCode);
    if(keyIndex<0||rowIndex<1) return json(res,404,{error:'Staff record not found.'});

    const record=Object.fromEntries(headers.map((header,index)=>[String(header||''),rawRows[rowIndex]?.[index]||'']));
    const editorRows=await loadStaff();
    const editorStaff=editorRows.find(s=>String(s.Key||'').trim()===String(user.staffCode||'').trim())||{};
    if(!canEditStaffRecord(user,editorStaff,record)){
      return json(res,403,{error:'You are not allowed to edit this staff record.'});
    }

    const requiredHeaders=['Staff Name','Department1','Permission','Status','Join Date','Job Title'];
    const missing=requiredHeaders.filter(header=>headers.indexOf(header)<0);
    if(missing.length) return json(res,500,{error:'Staff sheet is missing required column(s): '+missing.join(', ')});

    const sheetRow=rowIndex+1;
    const updates=[
      ['Staff Name',name],
      ['Department1',department],
      ['Permission',permission],
      ['Status',status[0].toUpperCase()+status.slice(1).toLowerCase()],
      ['Join Date',joinDate],
      ['Job Title',position]
    ];
    for(const [header,value] of updates){
      const column=sheetColumnLetter(headers.indexOf(header));
      await sheets.update(`Staff!${column}${sheetRow}`,[value]);
    }
    cache.delete('staff');

    return json(res,200,{
      ok:true,
      item:{
        staffCode,
        name,
        department,
        position,
        permission,
        status:status[0].toUpperCase()+status.slice(1).toLowerCase(),
        joinDate
      }
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/staff-list/create') {
    const body=await readJson(req);
    const staffCode=String(body.staffCode||'').trim();
    const name=String(body.name||'').trim();
    const department=String(body.department||'').trim();
    const position=String(body.position||'').trim();
    const permission=String(body.permission||'STAFF').trim().toUpperCase();
    const status=String(body.status||'Active').trim();
    const joinDate=String(body.joinDate||'').trim();

    const staffRows=await loadStaff();
    const editorStaff=staffRows.find(s=>String(s.Key||'').trim()===String(user.staffCode||'').trim())||{};
    if(approvalPermission(editorStaff.Permission||user.permission)!=='TOP'){
      return json(res,403,{error:'Only TOP staff can add a new staff record.'});
    }
    if(!staffCode) return json(res,400,{error:'Staff ID is required.'});
    if(!name) return json(res,400,{error:'Staff Name is required.'});
    if(!department) return json(res,400,{error:'Department is required.'});
    if(!position) return json(res,400,{error:'Position is required.'});
    if(!permission) return json(res,400,{error:'Permission is required.'});
    if(!['TOP','HOD','STAFF'].includes(permission)) return json(res,400,{error:'Permission must be TOP, HOD or STAFF.'});
    if(!status) return json(res,400,{error:'Status is required.'});
    if(!['ACTIVE','INACTIVE'].includes(status.toUpperCase())) return json(res,400,{error:'Status must be Active or Inactive.'});
    if(!joinDate) return json(res,400,{error:'Join Date is required.'});
    if(!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(joinDate)&&!/^\d{4}-\d{2}-\d{2}$/.test(joinDate)){
      return json(res,400,{error:'Join Date must use DD/MM/YYYY or YYYY-MM-DD.'});
    }

    const rawRows=await sheets.get('Staff!A:AI');
    const headers=rawRows[0]||[];
    const requiredHeaders=['Key','Staff Name','Department1','Permission','Status','Join Date','Job Title'];
    const missing=requiredHeaders.filter(header=>headers.indexOf(header)<0);
    if(missing.length) return json(res,500,{error:'Staff sheet is missing required column(s): '+missing.join(', ')});
    const keyIndex=headers.indexOf('Key');
    const duplicate=rawRows.slice(1).some(row=>String(row[keyIndex]||'').trim().toLowerCase()===staffCode.toLowerCase());
    if(duplicate) return json(res,409,{error:'Staff ID already exists.'});

    const valuesByHeader={
      Key:staffCode,
      'Staff Name':name,
      Department:department,
      Department1:department,
      Permission:permission,
      Permission1:permission,
      Status:status[0].toUpperCase()+status.slice(1).toLowerCase(),
      'Join Date':joinDate,
      'Job Title':position
    };
    const row=headers.map(header=>Object.prototype.hasOwnProperty.call(valuesByHeader,header)?valuesByHeader[header]:'');
    await sheets.append('Staff!A:AI',row);
    cache.delete('staff');

    return json(res,200,{
      ok:true,
      item:{
        staffCode,
        name,
        department,
        position,
        permission,
        status:status[0].toUpperCase()+status.slice(1).toLowerCase(),
        joinDate
      }
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/attendance/daily') {
    const date = url.searchParams.get('date') || new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const [staffRows, clockRows, dateDimRows, scheduleRules, scheduleAssignments] = await Promise.all([loadStaff(),loadClock(),loadDateDim(),loadScheduleRules(),loadStaffSchedule()]);
    let result = buildDailyAttendance({ dateYmd:date, staffRows, clockRows, dateDimRows, scheduleRules, scheduleAssignments });
    if (String(user.permission).toUpperCase() === 'STAFF') result.items = result.items.filter(x => x.staffCode === user.staffCode);
    return json(res, 200, result);
  }

  if (req.method === 'GET' && url.pathname === '/api/report/day') {
    const date=url.searchParams.get('date') || new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const dateDmy=ymdToDmyLocal(date);
    const [staffRows,clockRows,dateDimRows,scheduleRules,scheduleAssignments,otRows]=await Promise.all([
      loadStaff(),loadClock(),loadDateDim(),loadScheduleRules(),loadStaffSchedule(),loadOT()
    ]);
    const staffByKey=new Map(staffRows.map(x=>[String(x.Key||''),x]));
    const dayDim=dateDimRows.find(x=>String(x.Date||'')===dateDmy)||{};
    let daily=buildDailyAttendance({dateYmd:date,staffRows,clockRows,dateDimRows,scheduleRules,scheduleAssignments});
    if(String(user.permission||'').toUpperCase()==='STAFF') daily.items=daily.items.filter(x=>x.staffCode===user.staffCode);

    let dayOt=otRows.filter(x=>String(x.Date||'')===dateDmy);
    if(String(user.permission||'').toUpperCase()==='STAFF') dayOt=dayOt.filter(x=>String(x['Staff Name']||'')===String(user.staffCode||''));

    const workingHours=daily.items
      .filter(x=>x.eventCount>0)
      .map(x=>{
        const inMin=clockMinutes(x.clockIn);
        let outMin=clockMinutes(x.clockOut);
        const lunchOutMin=clockMinutes(x.lunchOut);
        let lunchInMin=clockMinutes(x.lunchIn);
        let duration=null;
        if(inMin!=null && outMin!=null){
          if(outMin<inMin) outMin+=1440;
          let lunch=0;
          if(lunchOutMin!=null && lunchInMin!=null){
            if(lunchInMin<lunchOutMin) lunchInMin+=1440;
            lunch=Math.max(0,lunchInMin-lunchOutMin);
          }
          duration=Math.max(0,outMin-inMin-lunch);
        }
        let actualOT=null;
        const scheduleEnd=clockMinutes(x.scheduledEnd);
        if(outMin!=null && scheduleEnd!=null){
          let sched=scheduleEnd;
          if(inMin!=null && sched<inMin) sched+=1440;
          actualOT=Math.max(0,outMin-sched);
        }
        const st=staffByKey.get(String(x.staffCode||''))||{};
        const otForStaff=dayOt.filter(o=>String(o['Staff Name']||'')===String(x.staffCode||''));
        const approvedRows=otForStaff.filter(o=>approvedValue(o.Approval));
        const approvalHours=approvedRows.length?durationMinutesLabel(sumOtMinutes(approvedRows)):'00:00';
        const approval=otForStaff.map(o=>String(o.Approval||'').trim()).filter(Boolean).join(', ');
        return {
          date:dateDmy,
          staffCode:x.staffCode,
          name:x.name,
          duration:durationMinutesLabel(duration),
          lateResult:x.lateMinutes>0?'Late':'',
          clockIn:time12(x.clockIn),
          clockOut:time12(x.clockOut),
          actualOTHour:durationMinutesLabel(actualOT),
          otApprovalHours:approvalHours,
          lunchOut:time12(x.lunchOut),
          lunchIn:time12(x.lunchIn),
          otApproval:approval,
          position:st['Job Title']||st.Department||'',
          department:st.Department1||x.department||'',
          shiftVariant:x.shiftVariant||'NORMAL',
          shift:String(x.shiftVariant||'NORMAL').toUpperCase()==='NIGHT'?'Night':'Normal',
          outType:x.clockOutType||'',
          events:[
            x.clockIn?{date:x.clockInDate||dateDmy,type:'In Time',time:time12(x.clockIn)}:null,
            x.lunchOut?{date:x.lunchOutDate||dateDmy,type:'Lunch Out',time:time12(x.lunchOut)}:null,
            x.lunchIn?{date:x.lunchInDate||dateDmy,type:'Lunch In',time:time12(x.lunchIn)}:null,
            x.clockOut?{date:x.clockOutDate||dateDmy,type:x.clockOutType==='Overnight Out'?'Overnight Out':'Out',time:time12(x.clockOut)}:null
          ].filter(Boolean)
        };
      })
      .sort((a,b)=>(a.department||'').localeCompare(b.department||'') || (a.name||'').localeCompare(b.name||''));

    return json(res,200,{date,dateDmy,dayType:dayDim.Day||'',workingHours});
  }

  if (req.method === 'GET' && url.pathname === '/api/approval-center') {
    const [rawClockRows, staffRows] = await Promise.all([sheets.get('Clock!A:T'), loadStaff()]);
    const staffByKey = new Map(staffRows.map(s => [String(s.Key || ''), s]));
    const approverStaff = staffByKey.get(String(user.staffCode || '')) || {};
    const approverPermission = approvalPermission(approverStaff.Permission || user.permission);
    const clockHeaders=rawClockRows[0]||[];
    const allItems=rawClockRows.slice(1).map((row,index)=>{
      const record=Object.fromEntries(clockHeaders.map((header,col)=>[String(header||''),row?.[col]||'']));
      return normalizeApprovalItem(record,staffByKey,index+2);
    }).filter(x=>Object.values(x).some(v=>String(v??'').trim()!=='')).reverse();

    const late = allItems
      .filter(isLateApprovalCandidate)
      .filter(x => canAccessLateApproval(user,approverStaff,x))
      .slice(0,500);

    let adjustmentItems = allItems;
    if (approverPermission === 'STAFF') adjustmentItems = adjustmentItems.filter(x => x.staffCode === user.staffCode);
    const adjustments = adjustmentItems
      .filter(isAdjustmentApprovalCandidate)
      .slice(0,500);

    return json(res,200,{
      late,
      adjustments,
      canApprove:['TOP','HOD','STAFF'].includes(approverPermission)
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/approval-center/late-action') {
    const body=await readJson(req);
    const key=String(body.key||'').trim();
    const requestedRow=Number(body.row||0);
    const action=String(body.action||'').trim().toLowerCase();
    if(!key&&!(Number.isInteger(requestedRow)&&requestedRow>=2)){
      return json(res,400,{error:'Clock record reference is required. Please refresh Approval Center.'});
    }
    if(!['approve','reject'].includes(action)) return json(res,400,{error:'Invalid approval action.'});

    const approvalLockKey=key||('row:'+requestedRow);
    return await withClockSaveLock('late-approval:'+approvalLockKey,async()=>{
      const rawRows=await sheets.get('Clock!A:T');
      let rowIndex=-1;

      if(key){
        rowIndex=rawRows.findIndex((row,index)=>index>0&&String(row[0]||'').trim()===key);
      }else if(Number.isInteger(requestedRow)&&requestedRow>=2&&requestedRow<=rawRows.length){
        rowIndex=requestedRow-1;
      }

      if(rowIndex<1) return json(res,404,{error:'Clock record not found. Please refresh Approval Center and try again.'});

      const sheetRow=rowIndex+1;
      const headers=rawRows[0]||[];
      const rawRecord=Object.fromEntries(headers.map((header,index)=>[String(header||''),rawRows[rowIndex]?.[index]||'']));
      const staffRows=await loadStaff();
      const staffByKey=new Map(staffRows.map(s=>[String(s.Key||''),s]));
      const item=normalizeApprovalItem(rawRecord,staffByKey,sheetRow);
      const approverStaff=staffByKey.get(String(user.staffCode||''))||{};

      if(!key){
        const matchesIdentity=record=>
          String(record.Date||'')===String(body.date||'') &&
          String(record.Time||'')===String(body.time||'') &&
          String(record['Staff Name']||'')===String(body.staffCode||'') &&
          String(record.Type||'')===String(body.type||'');

        if(!matchesIdentity(rawRecord)){
          const identityRows=[];
          for(let index=1;index<rawRows.length;index++){
            const candidate=Object.fromEntries(headers.map((header,col)=>[String(header||''),rawRows[index]?.[col]||'']));
            if(matchesIdentity(candidate)) identityRows.push(index);
          }
          if(identityRows.length!==1){
            return json(res,409,{error:'This Clock row changed after the page was loaded. Please refresh Approval Center and try again.'});
          }
          rowIndex=identityRows[0];
        }
      }

      const resolvedSheetRow=rowIndex+1;
      const resolvedRawRecord=Object.fromEntries(headers.map((header,index)=>[String(header||''),rawRows[rowIndex]?.[index]||'']));
      const resolvedItem=normalizeApprovalItem(resolvedRawRecord,staffByKey,resolvedSheetRow);

      if(!isLateApprovalCandidate(resolvedItem)){
        const currentApproval=String(resolvedItem.approval||'').trim();
        if(currentApproval) return json(res,409,{error:'This Clock Late record is already '+currentApproval+'.'});
        return json(res,409,{error:'This record is not eligible for Clock Late Approval.'});
      }
      if(!canAccessLateApproval(user,approverStaff,resolvedItem)){
        return json(res,403,{error:'You are not allowed to approve or reject this Clock Late record.'});
      }

      const status=action==='approve'?'Approved':'Rejected';
      const approvalBy=approvalByText(action,approvalActor(approverStaff,user));
      await sheets.update(`Clock!I${resolvedSheetRow}:J${resolvedSheetRow}`,[status,approvalBy]);
      cache.delete('clock');
      return json(res,200,{ok:true,key,status,approvalBy,row:resolvedSheetRow});
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/approval-center/adjustment-action') {
    const body=await readJson(req);
    const key=String(body.key||'').trim();
    const requestedRow=Number(body.row||0);
    const action=String(body.action||'').trim().toLowerCase();
    if(!key&&!(Number.isInteger(requestedRow)&&requestedRow>=2)){
      return json(res,400,{error:'Clock record reference is required. Please refresh Approval Center.'});
    }
    if(!['approve','reject'].includes(action)) return json(res,400,{error:'Invalid approval action.'});

    const approvalLockKey=key||('row:'+requestedRow);
    return await withClockSaveLock('adjustment-approval:'+approvalLockKey,async()=>{
      const rawRows=await sheets.get('Clock!A:T');
      let rowIndex=-1;

      if(key){
        rowIndex=rawRows.findIndex((row,index)=>index>0&&String(row[0]||'').trim()===key);
      }else if(Number.isInteger(requestedRow)&&requestedRow>=2&&requestedRow<=rawRows.length){
        rowIndex=requestedRow-1;
      }

      if(rowIndex<1) return json(res,404,{error:'Clock record not found. Please refresh Approval Center and try again.'});

      const headers=rawRows[0]||[];
      const rawRecord=Object.fromEntries(headers.map((header,index)=>[String(header||''),rawRows[rowIndex]?.[index]||'']));
      const staffRows=await loadStaff();
      const staffByKey=new Map(staffRows.map(s=>[String(s.Key||''),s]));
      const approverStaff=staffByKey.get(String(user.staffCode||''))||{};

      if(!key){
        const matchesIdentity=record=>
          String(record.Date||'')===String(body.date||'') &&
          String(record.Time||'')===String(body.time||'') &&
          String(record['Staff Name']||'')===String(body.staffCode||'') &&
          String(record.Type||'')===String(body.type||'');

        if(!matchesIdentity(rawRecord)){
          const identityRows=[];
          for(let index=1;index<rawRows.length;index++){
            const candidate=Object.fromEntries(headers.map((header,col)=>[String(header||''),rawRows[index]?.[col]||'']));
            if(matchesIdentity(candidate)) identityRows.push(index);
          }
          if(identityRows.length!==1){
            return json(res,409,{error:'This Clock row changed after the page was loaded. Please refresh Approval Center and try again.'});
          }
          rowIndex=identityRows[0];
        }
      }

      const resolvedSheetRow=rowIndex+1;
      const resolvedRawRecord=Object.fromEntries(headers.map((header,index)=>[String(header||''),rawRows[rowIndex]?.[index]||'']));
      const resolvedItem=normalizeApprovalItem(resolvedRawRecord,staffByKey,resolvedSheetRow);

      if(!isAdjustmentApprovalCandidate(resolvedItem)){
        const currentApproval=String(resolvedItem.approval||'').trim();
        if(currentApproval && currentApproval.toLowerCase()!=='pending'){
          return json(res,409,{error:'This Clock Adjustment record is already '+currentApproval+'.'});
        }
        return json(res,409,{error:'This record is not eligible for Clock Adjustment Approval.'});
      }
      if(!canAccessAdjustmentApproval(user,approverStaff,resolvedItem)){
        return json(res,403,{error:'You are not allowed to approve or reject this Clock Adjustment record.'});
      }

      const status=action==='approve'?'Approved':'Rejected';
      const approvalBy=approvalByText(action,approvalActor(approverStaff,user));
      await sheets.update(`Clock!I${resolvedSheetRow}:J${resolvedSheetRow}`,[status,approvalBy]);
      cache.delete('clock');
      return json(res,200,{ok:true,key,status,approvalBy,row:resolvedSheetRow});
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/clock') {
    const body=await readJson(req);
    const allowed=new Set(['In','Out','Lunch Out','Lunch In','Extra Out','Extra In','Outstation Out','Outstation In','Overnight Out']);
    if(!allowed.has(body.type)) return json(res,400,{error:'Invalid clock type'});
    if(isDesktopClockRequest(req)) return json(res,403,{error:'Clock In/Out is only available on a mobile device. Please use your phone.'});
    if(body.captureSource!=='camera') return json(res,400,{error:'Clock Image must be taken with the live camera.'});

    const staffRows=await loadStaff();
    const staff=staffRows.find(s=>s.Key===user.staffCode);
    if(!staff) return json(res,404,{error:'Staff record not found'});

    const now=new Date();
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).formatToParts(now);
    const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));
    const todayYmd=`${p.year}-${p.month}-${p.day}`;
    const nowTime=`${p.hour}:${p.minute}:${p.second}`;
    const adjustment=body.adjustment==='Yes'?'Yes':'No';
    const selected=/^\d{4}-\d{2}-\d{2}$/.test(String(body.date||''))?String(body.date):'';

    if(selected&&selected>todayYmd) return json(res,400,{error:'Future date is not allowed'});
    let dateYmd=todayYmd,time=nowTime,remarks=String(body.remarks||'').trim(),approval='';
    if(adjustment==='Yes'){
      if(!selected) return json(res,400,{error:'Adjustment date is required'});
      if(!/^\d{2}:\d{2}(?::\d{2})?$/.test(String(body.time||''))) return json(res,400,{error:'Adjustment time is required'});
      if(!remarks) return json(res,400,{error:'Remarks is required for Adjustment = Yes'});
      dateYmd=selected;
      time=String(body.time).length===5?`${body.time}:00`:String(body.time);
      approval='Pending';
    }else if(selected&&selected!==todayYmd){
      return json(res,400,{error:'Past date is Adjustment only'});
    }

    let locationValue='';
    try{locationValue=serializeClockLocation(body.location,now.getTime())}
    catch(e){return json(res,400,{error:e.message,code:e.code||'LOCATION_REQUIRED'})}

    const date=`${dateYmd.slice(8,10)}/${dateYmd.slice(5,7)}/${dateYmd.slice(0,4)}`;
    const uniqueKey=buildClockKey(date,staff.Key,body.type);

    return await withClockSaveLock(uniqueKey,async()=>{
      const freshClockRows=rowsToObjects(await sheets.get('Clock!A:T'));
      const duplicate=freshClockRows.find(r =>
        String(r.Date||'')===date &&
        String(r['Staff Name']||'').trim()===String(staff.Key||'').trim() &&
        String(r.Type||'').trim()===String(body.type||'').trim()
      );
      if(duplicate) return json(res,409,{
        error:'You have already recorded '+body.type+' for '+dateYmd+'.',
        code:'DUPLICATE_CLOCK_TYPE'
      });

      const sequenceError=validateClockSequence({
        type:body.type,
        dateYmd,
        staffKey:staff.Key,
        clockRows:freshClockRows
      });
      if(sequenceError) return json(res,409,{
        error:sequenceError,
        code:'INVALID_CLOCK_SEQUENCE'
      });

      let imagePath='';
      try{imagePath=saveClockImage(body.image,staff.Key,dateYmd,time)}
      catch(e){return json(res,400,{error:e.message})}

      const today=`${p.day}/${p.month}/${p.year}`;
      const stamp=`${today} ${nowTime}`;
      const row=[uniqueKey,date,time,staff.Key,body.type,locationValue,remarks,adjustment,approval,'',imagePath,stamp,staff.Department1||'',staff['Job Title']||staff.Department||'','','',staff['Staff Name']||'','',''];
      try{await sheets.append('Clock!A:T',row)}
      catch(e){try{fs.unlinkSync(path.join(UPLOAD_ROOT,imagePath))}catch{};throw e}
      cache.delete('clock');
      return json(res,200,{ok:true,key:uniqueKey,date,time,type:body.type,approval,image:imagePath});
    });
  }

  return json(res,404,{error:'Not found'});
}

function staticFile(req,res,url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  rel = path.normalize(rel).replace(/^\.\.(\/|\\|$)/,'');
  const file = path.join(__dirname,'public',rel);
  if (!file.startsWith(path.join(__dirname,'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  const ext = path.extname(file);
  const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png'};
  res.writeHead(200,{'content-type':types[ext]||'application/octet-stream','cache-control':'no-store'});
  fs.createReadStream(file).pipe(res);
}

const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(url.pathname.startsWith('/api/')) return await routeApi(req,res,url);
    return staticFile(req,res,url);
  } catch(e) {
    console.error(e);
    return json(res,e.statusCode||500,{error:e.message||'Internal error'});
  }
});
server.listen(PORT,()=>console.log(`TBH HR listening on :${PORT}`));
