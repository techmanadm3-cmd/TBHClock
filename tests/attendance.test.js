const assert=require('assert');
const {buildDailyAttendance,findPreviousScheduledWorkDate}=require('../src/attendance');
const out=buildDailyAttendance({
 dateYmd:'2026-11-24',
 staffRows:[{Key:'TBH1','Staff Name':'Test','Department1':'PROD',Department:'OPERATOR',Status:'Active'}],
 clockRows:[{Date:'24/11/2026',Time:'08:07:00','Staff Name':'TBH1',Type:'In'},{Date:'24/11/2026',Time:'18:01:00','Staff Name':'TBH1',Type:'Out'}],
 scheduleAssignments:[{'Staff Code':'TBH1','Schedule ID':'PROD_STD','Shift Variant':'NORMAL','Effective From':'2026-01-01',Active:'TRUE',Priority:'10'}],
 scheduleRules:[{'Schedule ID':'PROD_STD','Schedule Name':'Production Standard','Shift Variant':'NORMAL','Day Rule':'MON-FRI','Start Time':'08:00','End Time':'18:00',Active:'TRUE'}],
 dateDimRows:[{Date:'24/11/2026',Day:'WD'}]
});
assert.equal(out.items[0].status,'Late');
assert.equal(out.items[0].lateMinutes,7);
assert.equal(out.kpi.late,1);
console.log('attendance tests PASS');

const staff={Key:'TBH1','Staff Name':'Test','Department1':'PROD',Department:'OPERATOR',Status:'Active'};
const assignments=[{'Staff Code':'TBH1','Schedule ID':'PROD_STD','Shift Variant':'NORMAL','Effective From':'2026-01-01',Active:'TRUE',Priority:'10'}];
const rules=[{'Schedule ID':'PROD_STD','Schedule Name':'Production Standard','Shift Variant':'NORMAL','Day Rule':'MON-FRI','Start Time':'08:00','End Time':'18:00',Active:'TRUE'}];
assert.equal(findPreviousScheduledWorkDate({
 dateYmd:'2026-11-30',staff,assignments,rules,
 dateDimRows:[
  {Date:'27/11/2026',Day:'WD'},{Date:'28/11/2026',Day:'WD'},{Date:'29/11/2026',Day:'SUN'},{Date:'30/11/2026',Day:'WD'}
 ]
}),'2026-11-27');
assert.equal(findPreviousScheduledWorkDate({
 dateYmd:'2026-12-01',staff,assignments,rules,
 dateDimRows:[
  {Date:'27/11/2026',Day:'WD'},{Date:'28/11/2026',Day:'WD'},{Date:'29/11/2026',Day:'SUN'},{Date:'30/11/2026',Day:'PH'},{Date:'1/12/2026',Day:'WD'}
 ]
}),'2026-11-27');
console.log('previous scheduled work date tests PASS');
