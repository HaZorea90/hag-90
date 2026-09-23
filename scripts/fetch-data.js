#!/usr/bin/env node
// Refreshes data.json (the offline fallback) from the published Google Sheet.
// Usage: node scripts/fetch-data.js   (Node 18+, no dependencies)
// Reads the tab URLs from the CONFIG block in app.js, so links live in one place.
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const match = appSource.match(/const CONFIG = (\{[\s\S]*?\});\s*\/\* CONFIG-END \*\//);
if (!match) {
  console.error('CONFIG block not found in app.js');
  process.exit(1);
}
const CONFIG = JSON.parse(match[1]);

async function main() {
  const names = Object.keys(CONFIG.tabs);
  const missing = names.filter((n) => !CONFIG.tabs[n]);
  if (missing.length) {
    console.error(`Missing CSV links in app.js CONFIG.tabs: ${missing.join(', ')}`);
    process.exit(1);
  }

  const tabs = {};
  for (const name of names) {
    const res = await fetch(CONFIG.tabs[name], { cache: 'no-store' });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const text = await res.text();
    if (!text.trim() || text.trim().startsWith('<')) {
      throw new Error(`${name}: response is not CSV (is the sheet published?)`);
    }
    tabs[name] = text;
    const rows = text.split(/\r?\n/).filter((l) => l.trim()).length;
    console.log(`✓ ${name.padEnd(12)} ${rows} lines`);
  }

  const out = { generatedAt: new Date().toISOString(), tabs };
  fs.writeFileSync(path.join(root, 'data.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`data.json updated (${out.generatedAt})`);
}

main().catch((err) => {
  console.error(`Failed: ${err.message}\ndata.json was not changed.`);
  process.exit(1);
});
