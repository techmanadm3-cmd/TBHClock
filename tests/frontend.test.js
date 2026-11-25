const fs = require('fs');
const assert = require('assert');

const app = fs.readFileSync('public/app.js','utf8');
const html = fs.readFileSync('public/index.html','utf8');
const server = fs.readFileSync('server.js','utf8');
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

assert(!html.includes('type="file"'), 'Clock image must not expose a file upload control');
assert(html.includes('id="clockCamera"'), 'Live camera video element missing');
assert(html.includes('No gallery or file upload'), 'Camera-only guidance missing');
assert(app.includes('navigator.mediaDevices.getUserMedia'), 'Live camera getUserMedia flow missing');
assert(app.includes("captureSource:'camera'"), 'Camera-only payload marker missing');
assert(app.includes('isDesktopClockDevice'), 'Desktop clock UI guard missing');
assert(server.includes('isDesktopClockRequest'), 'Desktop clock server guard missing');
assert(server.includes("body.captureSource!=='camera'"), 'Live camera server validation missing');
assert(server.includes('DUPLICATE_CLOCK_TYPE'), 'Duplicate type server validation missing');
assert(server.includes("const uniqueKey=[dateYmd,staff.Key,body.type].join('|')"), 'Date + Staff + Type key missing');
assert(server.includes("rowsToObjects(await sheets.get('Clock!A:T'))"), 'Duplicate validation must read fresh Clock data');
assert(server.includes('withClockSaveLock(uniqueKey'), 'Duplicate validation must be save-lock protected');
console.log('FRONTEND_SELECTOR_TESTS=PASS');
