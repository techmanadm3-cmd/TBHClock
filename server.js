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

async function loadStaff() { return rowsToObjects(await cached('staff', 60, () => sheets.get('Staff!A1:AI1000'))); }
async function loadClock() { return rowsToObjects(await cached('clock', CACHE_SECONDS, () => sheets.get('Clock!A1:T70021'))); }
async function loadDateDim() { return rowsToObjects(await cached('datedim', 3600, () => sheets.get('DateDim!A1:D1281'))); }
async function loadScheduleRules() { return rowsToObjects(await cached('schedrules', 60, () => sheets.get('HR_ScheduleRules!A1:N500'))); }
async function loadStaffSchedule() { return rowsToObjects(await cached('staffsched', 60, () => sheets.get('HR_StaffSchedule!A1:J1000'))); }

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

  if (req.method === 'POST' && url.pathname === '/api/clock') {
    const body = await readJson(req);
    const allowed = new Set(['In','Out','Lunch Out','Lunch In']);
    if (!allowed.has(body.type)) return json(res,400,{error:'Invalid clock type'});
    const staffRows = await loadStaff();
    const staff = staffRows.find(s => s.Key === user.staffCode);
    if (!staff) return json(res,404,{error:'Staff record not found'});
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).formatToParts(now);
    const p = Object.fromEntries(parts.map(x=>[x.type,x.value]));
    const date = `${p.day}/${p.month}/${p.year}`;
    const time = `${p.hour}:${p.minute}:${p.second}`;
    const stamp = `${date} ${time}`;
    const row = ['',date,time,staff.Key,body.type,body.location||'',body.remarks||'','No','','','',stamp,staff.Department1||'',staff.Department||'','','',staff['Staff Name']||'','',''];
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
  const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
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
