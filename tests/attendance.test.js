const assert=require('assert');
const {buildDailyAttendance,findPreviousScheduledWorkDate,isAutoNightShift,isMissingOutFromPrevious}=require('../src/attendance');
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

assert.equal(isAutoNightShift('2026-11-23','18:00:00'),false);
assert.equal(isAutoNightShift('2026-11-23','18:01:00'),true);
assert.equal(isAutoNightShift('2026-11-28','19:00:00'),false);

const nightBase={
  dateYmd:'2026-11-23',
  staffRows:[{Key:'TBH1','Staff Name':'Night Test','Department1':'PROD',Department:'OPERATOR',Status:'Active'}],
  scheduleAssignments:[{'Staff Code':'TBH1','Schedule ID':'PROD_STD','Shift Variant':'NORMAL','Effective From':'2026-01-01',Active:'TRUE',Priority:'10'}],
  scheduleRules:[
    {'Schedule ID':'PROD_STD','Schedule Name':'Production Standard','Shift Variant':'NORMAL','Day Rule':'MON-FRI','Start Time':'08:00','End Time':'18:00',Active:'TRUE'},
    {'Schedule ID':'PROD_STD','Schedule Name':'Production Standard','Shift Variant':'NIGHT','Day Rule':'MON-FRI','Start Time':'20:00','End Time':'06:00','Ends Next Day':'TRUE',Active:'TRUE'}
  ],
  dateDimRows:[{Date:'23/11/2026',Day:'WD'},{Date:'24/11/2026',Day:'WD'}]
};

const nightOnTime=buildDailyAttendance({
  ...nightBase,
  clockRows:[
    {Date:'23/11/2026',Time:'19:30:00','Staff Name':'TBH1',Type:'In'},
    {Date:'24/11/2026',Time:'06:00:00','Staff Name':'TBH1',Type:'Overnight Out'}
  ]
});
assert.equal(nightOnTime.items[0].isNightShift,true);
assert.equal(nightOnTime.items[0].schedule,'Working Hour Night Shift');
assert.equal(nightOnTime.items[0].scheduledStart,'20:00');
assert.equal(nightOnTime.items[0].scheduledEnd,'06:00');
assert.equal(nightOnTime.items[0].clockOut,'06:00:00');
assert.equal(nightOnTime.items[0].clockOutType,'Overnight Out');
assert.equal(nightOnTime.items[0].lateMinutes,0);
assert.equal(nightOnTime.items[0].status,'Complete');

const nightLate=buildDailyAttendance({
  ...nightBase,
  clockRows:[
    {Date:'23/11/2026',Time:'20:15:00','Staff Name':'TBH1',Type:'In'},
    {Date:'24/11/2026',Time:'06:10:00','Staff Name':'TBH1',Type:'Overnight Out'}
  ]
});
assert.equal(nightLate.items[0].lateMinutes,15);
assert.equal(nightLate.items[0].status,'Late');

const nightCrossDay=buildDailyAttendance({
  ...nightBase,
  clockRows:[
    {Date:'23/11/2026',Time:'20:00:00','Staff Name':'TBH1',Type:'In'},
    {Date:'24/11/2026',Time:'01:00:00','Staff Name':'TBH1',Type:'Lunch Out'},
    {Date:'24/11/2026',Time:'01:30:00','Staff Name':'TBH1',Type:'Lunch In'},
    {Date:'24/11/2026',Time:'06:05:00','Staff Name':'TBH1',Type:'Out'}
  ]
});
assert.equal(nightCrossDay.items[0].lunchOut,'01:00:00');
assert.equal(nightCrossDay.items[0].lunchIn,'01:30:00');
assert.equal(nightCrossDay.items[0].clockOut,'06:05:00');
assert.equal(nightCrossDay.items[0].clockOutType,'Out');
assert.equal(nightCrossDay.items[0].clockOutDate,'24/11/2026');
assert.equal(nightCrossDay.items[0].status,'Complete');
assert.equal(nightCrossDay.items[0].eventCount,4);

const nightIgnoresNextEveningOut=buildDailyAttendance({
  ...nightBase,
  clockRows:[
    {Date:'23/11/2026',Time:'20:00:00','Staff Name':'TBH1',Type:'In'},
    {Date:'24/11/2026',Time:'06:00:00','Staff Name':'TBH1',Type:'Overnight Out'},
    {Date:'24/11/2026',Time:'18:00:00','Staff Name':'TBH1',Type:'Out'}
  ]
});
assert.equal(nightIgnoresNextEveningOut.items[0].clockOut,'06:00:00');
assert.equal(nightIgnoresNextEveningOut.items[0].clockOutType,'Overnight Out');

console.log('night shift tests PASS');


const techmanLikeStaff={Key:'TECHMAN','Staff Name':'Techman','Department1':'IT',Status:'Active'};
const defaultNormalWorkday=findPreviousScheduledWorkDate({
  dateYmd:'2026-11-25',
  staff:techmanLikeStaff,
  assignments:[],
  rules:[],
  dateDimRows:[
    {Date:'24/11/2026',Day:'TUE'},
    {Date:'25/11/2026',Day:'WED'}
  ]
});
assert.equal(defaultNormalWorkday,'2026-11-24','active unassigned staff must still have a normal Mon-Fri workday');
assert.equal(isMissingOutFromPrevious({clockIn:'08:00:00',clockOut:''}),true,'normal workday In without Out must be Missing Out');
assert.equal(isMissingOutFromPrevious({clockIn:'08:00:00',clockOut:'17:45:00'}),false,'normal workday with Out must not be Missing Out');
assert.equal(isMissingOutFromPrevious({clockIn:'',clockOut:''}),true,'normal workday without In and Out still requires Out; In must be corrected first');
console.log('missing out condition tests PASS');


const saturdayAssignedStaff={Key:'SAT1','Staff Name':'Saturday Staff','Department1':'OPS',Status:'Active'};
const saturdayAssignments=[{'Staff Code':'SAT1','Schedule ID':'SAT_STD','Shift Variant':'NORMAL','Effective From':'2026-01-01',Active:'TRUE',Priority:'10'}];
const saturdayRules=[
  {'Schedule ID':'SAT_STD','Schedule Name':'Saturday Ops','Shift Variant':'NORMAL','Day Rule':'SAT','Start Time':'08:00','End Time':'16:30',Active:'TRUE'}
];
assert.equal(findPreviousScheduledWorkDate({
  dateYmd:'2026-11-30',
  staff:saturdayAssignedStaff,
  assignments:saturdayAssignments,
  rules:saturdayRules,
  dateDimRows:[
    {Date:'28/11/2026',Day:'SAT'},
    {Date:'29/11/2026',Day:'SUN'},
    {Date:'30/11/2026',Day:'MON'}
  ]
}),'2026-11-28','explicit Saturday schedule must override Mon-Fri fallback');
console.log('schedule-driven previous workday tests PASS');
