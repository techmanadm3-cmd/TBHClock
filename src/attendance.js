function indexByHeader(rows) {
  const headers = rows[0] || [];
  return Object.fromEntries(headers.map((h, i) => [String(h).trim(), i]));
}

function rowsToObjects(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map(v => String(v || '').trim());
  return rows.slice(1).filter(r => r.some(v => String(v || '').trim() !== '')).map(r => {
    const o = {};
    headers.forEach((h, i) => { if (h) o[h] = r[i] ?? ''; });
    return o;
  });
}

function ymdToDmy(ymd) {
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y}`;
}

function parseTime(t) {
  if (!t) return null;
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]) + Number(m[3] || 0) / 60;
}

function minutesLabel(mins) {
  if (mins == null || !Number.isFinite(mins)) return '';
  const sign = mins < 0 ? '-' : '';
  const abs = Math.round(Math.abs(mins));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return h ? `${sign}${h}h ${m}m` : `${sign}${m}m`;
}

function matchesDayRule(rule, date) {
  const day = date.getDay(); // 0 Sun .. 6 Sat
  if (rule === 'MON-FRI') return day >= 1 && day <= 5;
  if (rule === 'TUE-FRI') return day >= 2 && day <= 5;
  if (rule === 'MON_OR_FIRST') return day === 1;
  if (rule === 'SAT') return day === 6;
  if (rule === 'SUN') return day === 0;
  return true;
}

function resolveSchedule(staff, dateYmd, assignments, rules, clockRows) {
  const date = new Date(`${dateYmd}T12:00:00+08:00`);
  const applicable = assignments
    .filter(a => String(a['Staff Code']).trim() === String(staff.Key).trim())
    .filter(a => String(a.Active).toUpperCase() !== 'FALSE')
    .filter(a => !a['Effective From'] || a['Effective From'] <= dateYmd)
    .filter(a => !a['Effective To'] || a['Effective To'] >= dateYmd)
    .sort((a,b) => Number(b.Priority || 0) - Number(a.Priority || 0));

  for (const a of applicable) {
    const rule = rules.find(r => r['Schedule ID'] === a['Schedule ID'] &&
      (r['Shift Variant'] || 'NORMAL') === (a['Shift Variant'] || 'NORMAL') &&
      String(r.Active).toUpperCase() !== 'FALSE' && matchesDayRule(r['Day Rule'], date));
    if (rule) return { source: 'HR_StaffSchedule', assignment: a, rule };
  }

  const inRow = clockRows.find(r => r.Type === 'In' && r['Late Time']);
  if (inRow) return { source: 'Clock Late Time', assignment: null, rule: { 'Start Time': inRow['Late Time'], 'End Time': '', 'Schedule Name': 'Legacy Clock Rule' } };
  return null;
}

function buildDailyAttendance({dateYmd, staffRows, clockRows, scheduleAssignments, scheduleRules, dateDimRows}) {
  const dateDmy = ymdToDmy(dateYmd);
  const activeStaff = staffRows.filter(s => String(s.Status).toLowerCase() === 'active');
  const dayClock = clockRows.filter(r => r.Date === dateDmy);
  const dateDim = dateDimRows.find(r => r.Date === dateDmy) || null;

  const items = activeStaff.map(staff => {
    const events = dayClock.filter(r => String(r['Staff Name']).trim() === String(staff.Key).trim());
    const firstIn = events.filter(r => r.Type === 'In').sort((a,b) => String(a.Time).localeCompare(String(b.Time)))[0] || null;
    const lastOut = events.filter(r => r.Type === 'Out').sort((a,b) => String(b.Time).localeCompare(String(a.Time)))[0] || null;
    const lunchOut = events.filter(r => r.Type === 'Lunch Out').sort((a,b) => String(a.Time).localeCompare(String(b.Time)))[0] || null;
    const lunchIn = events.filter(r => r.Type === 'Lunch In').sort((a,b) => String(b.Time).localeCompare(String(a.Time)))[0] || null;
    const schedule = resolveSchedule(staff, dateYmd, scheduleAssignments, scheduleRules, events);
    const scheduledStart = schedule?.rule?.['Start Time'] || '';
    const inMin = parseTime(firstIn?.Time);
    const startMin = parseTime(scheduledStart);
    const lateMinutes = inMin != null && startMin != null ? Math.max(0, Math.round(inMin - startMin)) : null;

    let status = 'Absent';
    if (firstIn && lastOut) status = lateMinutes > 0 ? 'Late' : 'Complete';
    else if (firstIn && !lastOut) status = 'Missing Out';
    else if (!firstIn && lastOut) status = 'Missing In';
    else if (dateDim?.Day === 'PH') status = 'Public Holiday';
    else if (dateDim?.Day === 'SUN') status = 'Rest Day';

    return {
      staffCode: staff.Key,
      name: staff['Staff Name'],
      department: staff.Department1 || '',
      position: staff['Job Title'] || staff.Department || '',
      schedule: schedule?.rule?.['Schedule Name'] || '',
      scheduleSource: schedule?.source || 'Unassigned',
      scheduledStart,
      scheduledEnd: schedule?.rule?.['End Time'] || '',
      clockIn: firstIn?.Time || '',
      lunchOut: lunchOut?.Time || '',
      lunchIn: lunchIn?.Time || '',
      clockOut: lastOut?.Time || '',
      lateMinutes,
      late: lateMinutes == null ? '' : minutesLabel(lateMinutes),
      status,
      eventCount: events.length
    };
  });

  const kpi = {
    total: items.length,
    present: items.filter(x => ['Complete','Late','Missing Out'].includes(x.status)).length,
    late: items.filter(x => x.status === 'Late').length,
    missing: items.filter(x => ['Missing In','Missing Out'].includes(x.status)).length,
    absent: items.filter(x => x.status === 'Absent').length,
    unassignedSchedule: items.filter(x => x.scheduleSource === 'Unassigned').length
  };
  return { date: dateYmd, dayType: dateDim?.Day || '', holiday: dateDim?.PH || '', kpi, items };
}

module.exports = { rowsToObjects, buildDailyAttendance, parseTime, ymdToDmy };
