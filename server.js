const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { GoogleSheetsClient } = require('./src/googleSheets');
const { rowsToObjects, buildDailyAttendance } = require('./src/attendance');

const PORT = Number(process.env.PORT || 8080);
const APP_SECRET = process.env.APP_SECRET || 'dev-secret-change-me';
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || '1VY4ZK4Upd6XBT-gdXxfd2ZbgfAlr5MdveDVoIeAGhTI';
const CACHE_SECONDS = Number(process.env.CLOCK_CACHE_SECONDS || 120);
const credentialsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) : null;
const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'secrets/google-service-account.json');
const sheets = new GoogleSheetsClient({ spreadsheetId: SPREADSHEET_ID, credentialsPath, credentialsJson });

const cache = new Map();
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
  let body=''; for await (const chunk of req) body += chunk;
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
    const token = signSession({ staffCode: staff.Key, name: staff['Staff Name'], permission: staff.Permission || 'STAFF', exp: Date.now()+12*60*60*1000 });
    return json(res, 200, {ok:true, user:{staffCode:staff.Key,name:staff['Staff Name'],permission:staff.Permission}}, {'set-cookie':`hr_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`});
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    return json(res, 200, {ok:true}, {'set-cookie':'hr_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'});
  }
  const user = auth(req);
  if (!user) return json(res, 401, {error:'Unauthenticated'});
  if (req.method === 'GET' && url.pathname === '/api/me') return json(res, 200, {user});

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
          lateResult:r['Late Result']||'',
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
          department:st.Department1||x.department||''
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
    const body = await readJson(req);
    const allowed = new Set(['In','Out','Lunch Out','Lunch In','Extra Out','Extra In','Outstation Out','Outstation In','Overnight Out']);
    if (!allowed.has(body.type)) return json(res,400,{error:'Invalid clock type'});
    const staffRows = await loadStaff();
    const canSelectStaff=String(user.permission||'').toUpperCase()!=='STAFF';
    const targetStaffCode=canSelectStaff && body.staffCode ? body.staffCode : user.staffCode;
    const staff=staffRows.find(s=>s.Key===targetStaffCode);
    if (!staff) return json(res,404,{error:'Staff record not found'});
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).formatToParts(now);
    const p = Object.fromEntries(parts.map(x=>[x.type,x.value]));
    const today = `${p.day}/${p.month}/${p.year}`;
    const selected=/^\d{4}-\d{2}-\d{2}$/.test(String(body.date||''))?String(body.date):'';
    const date=selected?`${selected.slice(8,10)}/${selected.slice(5,7)}/${selected.slice(0,4)}`:today;
    const time = `${p.hour}:${p.minute}:${p.second}`;
    const stamp = `${today} ${time}`;
    const adjustment=body.adjustment==='Yes'?'Yes':'No';
    const row = [crypto.randomUUID(),date,time,staff.Key,body.type,body.location||'',body.remarks||'',adjustment,'','','',stamp,staff.Department1||'',staff['Job Title']||staff.Department||'','','',staff['Staff Name']||'','',''];
    await sheets.append('Clock!A:T', row);
    cache.delete('clock');
    return json(res,200,{ok:true,date,time,type:body.type});
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
    return json(res,500,{error:e.message||'Internal error'});
  }
});
server.listen(PORT,()=>console.log(`TBH HR listening on :${PORT}`));
