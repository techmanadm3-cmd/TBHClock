const fs = require('fs');
const assert = require('assert');

const app = fs.readFileSync('public/app.js','utf8');

assert(!app.includes("$('[data-view]').forEach"), 'data-view must use $$() for NodeList iteration');
assert(!app.includes("$('[data-report-panel]').forEach"), 'data-report-panel must use $$() for NodeList iteration');
assert(app.includes("$$('[data-view]').forEach"), 'data-view iterator missing');
assert(app.includes("$$('[data-report-panel]').forEach"), 'data-report-panel iterator missing');

console.log('FRONTEND_SELECTOR_TESTS=PASS');
