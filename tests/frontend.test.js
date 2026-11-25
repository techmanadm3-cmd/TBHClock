const fs = require('fs');
const assert = require('assert');

const app = fs.readFileSync('public/app.js','utf8');
const lines = app.split(/\r?\n/).map(x=>x.trim());

assert(!lines.some(x=>x.startsWith("$('[data-view]').forEach")), 'data-view must use $$() for NodeList iteration');
assert(!lines.some(x=>x.includes(";$('[data-report-panel]').forEach")), 'data-report-panel must use $$() for NodeList iteration');
assert(lines.some(x=>x.includes("$$('[data-view]').forEach")), 'data-view iterator missing');
assert(lines.some(x=>x.includes("$$('[data-report-panel]').forEach")), 'data-report-panel iterator missing');

assert(app.includes("$('#adjustment button').forEach"), 'Adjustment buttons must use NodeList helper');
assert(!app.includes("$('#clockStaff').value"), 'Clock form must not submit a selectable staff value');
assert(app.includes("Previous Day Out"), 'Type In previous-day Out check missing');
assert(app.includes("'Missing Out'"), 'Type In Missing Out status missing');
assert(app.includes("'Missing In'"), 'Type Out Missing In status missing');
console.log('FRONTEND_SELECTOR_TESTS=PASS');
