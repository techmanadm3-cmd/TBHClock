const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { GoogleSheetsClient } = require('./src/googleSheets');
const { rowsToObjects, buildDailyAttendance, findPreviousScheduledWorkDate, isMissingOutFromPrevious } = require('./src/attendance');

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
      dateYmd:date,staff,assignments:scheduleAssignments,rules:scheduleRules,dateDimRows,clockRows
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
      usedTypes
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
    let dayClock=clockRows.filter(x=>String(x.Date||'')===dateDmy);
    if(String(user.permission||'').toUpperCase()==='STAFF') dayClock=dayClock.filter(x=>String(x['Staff Name']||'')===String(user.staffCode||''));

    const clockMaster=dayClock
      .map(r=>{
        const staffCode=String(r['Staff Name']||'');
        const st=staffByKey.get(staffCode)||{};
        return {
          key:r.Key||'',
          date:r.Date||dateDmy,
          time:time12(r.Time||''),
          rawTime:r.Time||'',
          staffCode,
          name:r.Name||st['Staff Name']||staffCode,
          type:r.Type||'',
          department:r.Department||st.Department1||'',
          lateResult:(()=>{
            if(r.Type==='In'){
              const mins=clockMinutes(r.Time);
              const weekday=new Date(`${date}T12:00:00+08:00`).getDay();
              if(weekday>=1&&weekday<=5&&mins!=null&&mins>18*60) return mins>20*60?'Late':'';
            }
            return r['Late Result']||'';
          })(),
          dayType:dayDim.Day||''
        };
      })
      .sort((x,y)=>(x.department||'').localeCompare(y.department||'') || (x.name||'').localeCompare(y.name||'') || (clockMinutes(x.rawTime)||0)-(clockMinutes(y.rawTime)||0));

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
          outType:x.clockOutType||''
        };
      })
      .sort((a,b)=>(a.department||'').localeCompare(b.department||'') || (a.name||'').localeCompare(b.name||''));

    return json(res,200,{date,dateDmy,dayType:dayDim.Day||'',clockMaster,workingHours});
  }

  if (req.method === 'GET' && url.pathname === '/api/approval-center') {
    const [clockRows, staffRows] = await Promise.all([loadClock(), loadStaff()]);
    const staffByKey = new Map(staffRows.map(s => [String(s.Key || ''), s]));
    const isStaff = String(user.permission || '').toUpperCase() === 'STAFF';
    const normalize = r => {
      const staffCode = String(r['Staff Name'] || '');
      const s = staffByKey.get(staffCode) || {};
      return {
        key: r.Key || '',
        date: r.Date || '',
        time: r.Time || '',
        staffCode,
        name: r.Name || s['Staff Name'] || staffCode,
        department: r.Department || s.Department1 || s.Department || '',
        type: r.Type || '',
        remarks: r.Remarks || '',
        adjustment: r.Adjustment || '',
        approval: r.Approval || '',
        approvalBy: r['Approvel By'] || '',
        lateTime: r['Late Time'] || '',
        lateResult: r['Late Result'] || '',
        totalLate: r['Total Late'] || ''
      };
    };
    let items = clockRows.slice().reverse().map(normalize);
    if (isStaff) items = items.filter(x => x.staffCode === user.staffCode);
    const hasLate = x => {
      const lateText = String(x.lateTime || '').trim();
      const lateResult = String(x.lateResult || '').trim().toLowerCase();
      const totalLate = Number(String(x.totalLate || '').replace(/[^0-9.-]/g,'')) || 0;
      return totalLate > 0 || (!!lateText && lateText !== '0' && lateText !== '00:00' && lateText !== '00:00:00') || ['late','yes','true'].includes(lateResult);
    };
    const late = items.filter(hasLate).slice(0,500);
    const adjustments = items.filter(x => String(x.adjustment || '').trim().toLowerCase() === 'yes').slice(0,500);
    return json(res,200,{late,adjustments});
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

    const date=`${dateYmd.slice(8,10)}/${dateYmd.slice(5,7)}/${dateYmd.slice(0,4)}`;
    const uniqueKey=[dateYmd,staff.Key,body.type].join('|');

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

      let imagePath='';
      try{imagePath=saveClockImage(body.image,staff.Key,dateYmd,time)}
      catch(e){return json(res,400,{error:e.message})}

      const today=`${p.day}/${p.month}/${p.year}`;
      const stamp=`${today} ${nowTime}`;
      const row=[uniqueKey,date,time,staff.Key,body.type,body.location||'',remarks,adjustment,approval,'',imagePath,stamp,staff.Department1||'',staff['Job Title']||staff.Department||'','','',staff['Staff Name']||'','',''];
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
