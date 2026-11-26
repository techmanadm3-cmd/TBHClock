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

function resolveAssignedSchedule(staff, dateYmd, assignments, rules) {
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
  return null;
}

function resolveSchedule(staff, dateYmd, assignments, rules, clockRows) {
  const assigned = resolveAssignedSchedule(staff, dateYmd, assignments, rules);
  if (assigned) return assigned;
  const inRow = clockRows.find(r => r.Type === 'In' && r['Late Time']);
  if (inRow) return { source: 'Clock Late Time', assignment: null, rule: { 'Start Time': inRow['Late Time'], 'End Time': '', 'Schedule Name': 'Legacy Clock Rule' } };
  return null;
}

function shiftYmd(ymd, days) {
  const d = new Date(`${ymd}T12:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0,10);
}

function isExplicitNonWorkingDay(dim) {
  const day = String(dim?.Day || '').trim().toUpperCase();
  return ['PH','PUBLIC HOLIDAY','REST DAY','OFF','OFF DAY'].includes(day);
}

function hasApplicableAssignment(staff, dateYmd, assignments) {
  return assignments.some(a =>
    String(a['Staff Code']).trim() === String(staff.Key).trim() &&
    String(a.Active).toUpperCase() !== 'FALSE' &&
    (!a['Effective From'] || a['Effective From'] <= dateYmd) &&
    (!a['Effective To'] || a['Effective To'] >= dateYmd)
  );
}

function isDefaultNormalWorkDate(dateYmd, dim) {
  if (isExplicitNonWorkingDay(dim)) return false;
  const day = new Date(`${dateYmd}T12:00:00+08:00`).getDay();
  return day >= 1 && day <= 5;
}

function findPreviousScheduledWorkDate({dateYmd, staff, assignments, rules, dateDimRows, maxDays=21}) {
  for (let i=1; i<=maxDays; i++) {
    const candidate = shiftYmd(dateYmd, -i);
    const candidateDmy = ymdToDmy(candidate);
    const dim = dateDimRows.find(r => String(r.Date) === candidateDmy);

    // A normal working day is schedule-driven. Public holiday / explicit off
    // days are excluded before checking the staff schedule.
    if (isExplicitNonWorkingDay(dim)) continue;

    if (hasApplicableAssignment(staff, candidate, assignments)) {
      if (resolveAssignedSchedule(staff, candidate, assignments, rules)) return candidate;
      continue;
    }

    // Active staff without an explicit schedule assignment follow the normal
    // office fallback: Monday-Friday.
    if (isDefaultNormalWorkDate(candidate, dim)) return candidate;
  }
  return '';
}

function isMissingOutFromPrevious(item) {
  // previousWorkDate is already confirmed as a normal working day.
  // Therefore an Out is required even when the In record is also missing.
  return !item?.clockOut;
}

function isAutoNightShift(dateYmd, inTime) {
  const inMin = parseTime(inTime);
  if (inMin == null || inMin <= 18 * 60) return false;
  const day = new Date(`${dateYmd}T12:00:00+08:00`).getDay();
  return day >= 1 && day <= 5;
}

function buildDailyAttendance({dateYmd, staffRows, clockRows, scheduleAssignments, scheduleRules, dateDimRows}) {
  const dateDmy = ymdToDmy(dateYmd);
  const nextDateYmd = shiftYmd(dateYmd, 1);
  const nextDateDmy = ymdToDmy(nextDateYmd);
  const activeStaff = staffRows.filter(s => String(s.Status).toLowerCase() === 'active');
  const dayClock = clockRows.filter(r => r.Date === dateDmy);
  const nextDayClock = clockRows.filter(r => r.Date === nextDateDmy);
  const dateDim = dateDimRows.find(r => r.Date === dateDmy) || null;

  const items = activeStaff.map(staff => {
    const staffKey = String(staff.Key).trim();
    const events = dayClock.filter(r => String(r['Staff Name']).trim() === staffKey);
    const nextEvents = nextDayClock.filter(r => String(r['Staff Name']).trim() === staffKey);
    const firstIn = events.filter(r => r.Type === 'In').sort((a,b) => String(a.Time).localeCompare(String(b.Time)))[0] || null;
    const normalOut = events.filter(r => r.Type === 'Out').sort((a,b) => String(b.Time).localeCompare(String(a.Time)))[0] || null;
    const dayLunchOut = events.filter(r => r.Type === 'Lunch Out').sort((a,b) => String(a.Time).localeCompare(String(b.Time)))[0] || null;
    const dayLunchIn = events.filter(r => r.Type === 'Lunch In').sort((a,b) => String(b.Time).localeCompare(String(a.Time)))[0] || null;

    const autoNightShift = !!firstIn && isAutoNightShift(dateYmd, firstIn.Time);
    const nightContinuation = autoNightShift
      ? nextEvents.filter(r => {
          const mins = parseTime(r.Time);
          return ['Lunch Out','Lunch In','Out','Overnight Out'].includes(r.Type) &&
            mins != null && mins <= 12 * 60;
        })
      : [];
    const nightLunchOut = nightContinuation.filter(r => r.Type === 'Lunch Out').sort((a,b) => String(a.Time).localeCompare(String(b.Time)))[0] || null;
    const nightLunchIn = nightContinuation.filter(r => r.Type === 'Lunch In').sort((a,b) => String(b.Time).localeCompare(String(a.Time)))[0] || null;
    const nightOut = nightContinuation
      .filter(r => r.Type === 'Out' || r.Type === 'Overnight Out')
      .sort((a,b) => String(a.Time).localeCompare(String(b.Time)))[0] || null;
    const overnightOut = nightContinuation.filter(r => r.Type === 'Overnight Out').sort((a,b) => String(a.Time).localeCompare(String(b.Time)))[0] || null;
    const lunchOut = autoNightShift ? nightLunchOut : dayLunchOut;
    const lunchIn = autoNightShift ? nightLunchIn : dayLunchIn;
    const schedule = autoNightShift
      ? {
          source: 'Auto Night Shift',
          assignment: null,
          rule: {
            'Schedule Name': 'Working Hour Night Shift',
            'Shift Variant': 'NIGHT',
            'Day Rule': 'MON-FRI',
            'Start Time': '20:00',
            'End Time': '06:00',
            'Ends Next Day': 'TRUE'
          }
        }
      : resolveSchedule(staff, dateYmd, scheduleAssignments, scheduleRules, events);

    const selectedOut = autoNightShift ? nightOut : normalOut;
    const scheduledStart = schedule?.rule?.['Start Time'] || '';
    const inMin = parseTime(firstIn?.Time);
    const startMin = parseTime(scheduledStart);
    const lateMinutes = inMin != null && startMin != null ? Math.max(0, Math.round(inMin - startMin)) : null;

    let status = 'Absent';
    if (firstIn && selectedOut) status = lateMinutes > 0 ? 'Late' : 'Complete';
    else if (firstIn && !selectedOut) status = 'Missing Out';
    else if (!firstIn && selectedOut) status = 'Missing In';
    else if (dateDim?.Day === 'PH') status = 'Public Holiday';
    else if (dateDim?.Day === 'SUN') status = 'Rest Day';

    return {
      staffCode: staff.Key,
      name: staff['Staff Name'],
      department: staff.Department1 || '',
      position: staff['Job Title'] || staff.Department || '',
      schedule: schedule?.rule?.['Schedule Name'] || '',
      scheduleSource: schedule?.source || 'Unassigned',
      shiftVariant: autoNightShift ? 'NIGHT' : (schedule?.rule?.['Shift Variant'] || 'NORMAL'),
      isNightShift: autoNightShift,
      scheduledStart,
      scheduledEnd: schedule?.rule?.['End Time'] || '',
      clockIn: firstIn?.Time || '',
      lunchOut: lunchOut?.Time || '',
      lunchIn: lunchIn?.Time || '',
      clockOut: selectedOut?.Time || '',
      clockOutType: selectedOut?.Type || '',
      clockOutDate: selectedOut ? (autoNightShift ? nextDateDmy : dateDmy) : '',
      overnightOut: overnightOut?.Time || '',
      lateMinutes,
      late: lateMinutes == null ? '' : minutesLabel(lateMinutes),
      status,
      eventCount: events.length + (autoNightShift ? nightContinuation.length : 0)
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

module.exports = { rowsToObjects, buildDailyAttendance, parseTime, ymdToDmy, findPreviousScheduledWorkDate, isAutoNightShift, isMissingOutFromPrevious };
