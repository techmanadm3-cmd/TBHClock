const fs = require('fs');
const assert = require('assert');

const app = fs.readFileSync('public/app.js','utf8');
const lines = app.split(/\r?\n/).map(x=>x.trim());

assert(!lines.some(x=>x.startsWith("$('[data-view]').forEach")), 'data-view must use $$() for NodeList iteration');
assert(!lines.some(x=>x.includes(";$('[data-report-panel]').forEach")), 'data-report-panel must use $$() for NodeList iteration');
assert(lines.some(x=>x.includes("$$('[data-view]').forEach")), 'data-view iterator missing');
assert(lines.some(x=>x.includes("$$('[data-report-panel]').forEach")), 'data-report-panel iterator missing');

console.log('FRONTEND_SELECTOR_TESTS=PASS');
