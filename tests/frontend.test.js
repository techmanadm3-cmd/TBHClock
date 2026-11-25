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
assert(app.includes("label.textContent='Missing Out'"), 'Type In Missing Out label missing');
assert(app.includes("field.value=missing?'Yes':'No'"), 'Missing flag Yes/No rendering missing');
assert(app.includes("Please make adjustment for yesterday Out."), 'Missing Out adjustment note missing');
assert(app.includes("Please make adjustment for today In."), 'Missing In adjustment note missing');
console.log('FRONTEND_SELECTOR_TESTS=PASS');
