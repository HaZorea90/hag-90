'use strict';

/* CONFIG-START
 * Published-sheet CSV links, one per tab (File › Share › Publish to web › <tab> › CSV).
 * Keep this block valid JSON: scripts/fetch-data.js reads it from here.
 * While any tab URL is empty, the page shows the data.json snapshot.
 */
const CONFIG = {
  "sheetId": "",
  "tabs": {
    "settings": "",
    "program": "",
    "participants": "",
    "team": "",
    "thanks": "",
    "lyrics": ""
  },
  "timeoutMs": 4000,
  "fallbackUrl": "data.json"
};
/* CONFIG-END */

const TEAM_GROUPS = ['צוות החג', 'תפאורה ואביזרים', 'תאורה והגברה'];
const LINK_SECTION = 'קטעי קישור';
const SETTINGS_KEYS = ['title', 'subtitle', 'date', 'time', 'place', 'thanks_title'];
const TYPE_CLASSES = [
  ['סרט', 'film'],
  ['שיר', 'song'],
  ['ריקוד', 'dance'],
  ['ראפ', 'rap'],
  ['הצג', 'play'],
];
const SIZE_LABELS = ['רגיל', 'גדול', 'גדול מאוד'];

/* ---------- CSV ---------- */

// RFC 4180 parser: quoted fields, escaped quotes, commas and newlines inside quotes, BOM, CRLF.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/^﻿/, '');

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row);
      row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Rows → objects keyed by header name. Missing columns become '', fully empty rows are dropped.
function toRecords(text) {
  const rows = parseCSV(text || '');
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const records = [];
  for (const cells of rows.slice(1)) {
    const rec = {};
    header.forEach((h, i) => { if (h) rec[h] = (cells[i] || '').replace(/\r\n?/g, '\n').trim(); });
    if (Object.values(rec).some(Boolean)) records.push(rec);
  }
  return records;
}

/* ---------- Data model ---------- */

function buildModel(tabs) {
  const get = (rec, key) => (rec && rec[key]) || '';

  const settings = {};
  for (const rec of toRecords(tabs.settings)) {
    const key = get(rec, 'key');
    if (SETTINGS_KEYS.includes(key)) settings[key] = get(rec, 'value');
  }

  const program = toRecords(tabs.program)
    .filter((r) => get(r, 'title'))
    .map((r, idx) => ({
      order: get(r, 'order'),
      sortKey: Number.isFinite(parseFloat(get(r, 'order'))) ? parseFloat(get(r, 'order')) : Infinity,
      idx,
      title: get(r, 'title'),
      type: get(r, 'type'),
      leads: get(r, 'leads'),
      song: get(r, 'song'),
      description: get(r, 'description'),
    }))
    .sort((a, b) => a.sortKey - b.sortKey || a.idx - b.idx);

  // Participants grouped by section, ordered like the program, link segments last.
  const bySection = new Map();
  for (const r of toRecords(tabs.participants)) {
    const name = get(r, 'name');
    if (!name) continue;
    const section = get(r, 'section') || LINK_SECTION;
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push({ name, role: get(r, 'role') });
  }
  const programOrder = program.map((p) => p.title);
  const rank = (s) => {
    if (s === LINK_SECTION) return Infinity;
    const i = programOrder.indexOf(s);
    return i === -1 ? programOrder.length : i;
  };
  const programByTitle = new Map(program.map((p) => [p.title, p]));
  const participants = [...bySection.entries()]
    .map(([section, people], idx) => {
      const item = programByTitle.get(section); // gives the group its program number and type color
      return { section, people, idx, order: item ? item.order : '', type: item ? item.type : '' };
    })
    .sort((a, b) => rank(a.section) - rank(b.section) || a.idx - b.idx);

  // Team: the three known groups in fixed order, anything else appended.
  const byGroup = new Map(TEAM_GROUPS.map((g) => [g, []]));
  for (const r of toRecords(tabs.team)) {
    const name = get(r, 'name');
    if (!name) continue;
    const group = get(r, 'group') || TEAM_GROUPS[0];
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push({ name, role: get(r, 'role') });
  }
  const team = [...byGroup.entries()]
    .filter(([, people]) => people.length)
    .map(([group, people]) => ({ group, people }));

  const thanks = toRecords(tabs.thanks).map((r) => get(r, 'text')).filter(Boolean);

  const lyrics = toRecords(tabs.lyrics)
    .filter((r) => get(r, 'song'))
    .map((r) => ({ song: get(r, 'song'), credits: get(r, 'credits'), lyrics: get(r, 'lyrics') }));

  return { settings, program, participants, team, thanks, lyrics };
}

/* ---------- Loading ---------- */

function looksLikeCSV(text) {
  const t = (text || '').trim();
  return t.length > 0 && !t.startsWith('<');
}

async function loadFromSheet() {
  const names = Object.keys(CONFIG.tabs);
  if (names.some((n) => !CONFIG.tabs[n])) throw new Error('Sheet URLs not configured');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.timeoutMs);
  try {
    const texts = await Promise.all(names.map(async (n) => {
      const res = await fetch(CONFIG.tabs[n], { cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) throw new Error(`${n}: HTTP ${res.status}`);
      const text = await res.text();
      if (!looksLikeCSV(text)) throw new Error(`${n}: not CSV`);
      return text;
    }));
    return Object.fromEntries(names.map((n, i) => [n, texts[i]]));
  } finally {
    clearTimeout(timer);
  }
}

async function loadFallback() {
  const res = await fetch(CONFIG.fallbackUrl, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`fallback: HTTP ${res.status}`);
  const json = await res.json();
  return json.tabs || {};
}

async function loadData() {
  // No sheet linked yet: data.json is the source itself, not a fallback.
  if (Object.values(CONFIG.tabs).some((url) => !url)) {
    return { tabs: await loadFallback(), fromFallback: false };
  }
  try {
    return { tabs: await loadFromSheet(), fromFallback: false };
  } catch (err) {
    console.warn('Sheet load failed, using snapshot:', err.message);
    return { tabs: await loadFallback(), fromFallback: true };
  }
}

/* ---------- Rendering ---------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function typeKey(type) {
  const match = TYPE_CLASSES.find(([word]) => (type || '').includes(word));
  return match ? match[1] : 'other';
}

function typeClass(type) {
  return `tag tag--${typeKey(type)}`;
}

// Program number ("01"), colored by the item's type.
function programNum(className, order, type) {
  return el('span', `${className} num--${typeKey(type)}`, order ? String(order).padStart(2, '0') : '');
}

function personText(p) {
  return p.role ? `${p.name} – ${p.role}` : p.name;
}

// Builds an accordion card: <li><hN><button aria-expanded>head</button></hN><div panel hidden/></li>.
// If panel is null the card is static (no button).
let uid = 0;
function accordionCard(headContent, panel, className) {
  const li = el('li', `card ${className || ''}`.trim());
  const heading = el('h3', 'card-heading');
  if (panel) {
    const id = `panel-${++uid}`;
    const btn = el('button', 'card-toggle');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', id);
    btn.append(headContent, el('span', 'chevron'));
    heading.append(btn);
    panel.id = id;
    panel.classList.add('card-panel');
    panel.hidden = true;
    li.append(heading, panel);
  } else {
    const head = el('div', 'card-static');
    head.append(headContent);
    heading.append(head);
    li.append(heading);
  }
  return li;
}

function renderHeader(settings) {
  const set = (id, value) => { if (value) document.getElementById(id).textContent = value; };
  set('hero-title', settings.title);
  set('hero-subtitle', settings.subtitle);
  set('hero-date', settings.date);
  set('hero-time', settings.time);
  set('hero-place', settings.place);
  if (settings.thanks_title) document.getElementById('thanks-h').textContent = settings.thanks_title;
  if (settings.title || settings.subtitle) {
    document.title = [settings.title, settings.subtitle].filter(Boolean).join(' – ');
  }
}

function renderProgram(program) {
  const list = document.getElementById('program-list');
  for (const item of program) {
    const head = el('span', 'program-head');
    head.append(programNum('program-num', item.order, item.type));
    const main = el('span', 'program-main');
    main.append(el('span', 'card-title', item.title));
    const meta = el('span', 'program-meta');
    if (item.type) meta.append(el('span', typeClass(item.type), item.type));
    if (item.leads) meta.append(el('span', 'program-leads', item.leads));
    if (meta.childNodes.length) main.append(meta);
    if (item.song) {
      const song = el('span', 'program-song');
      song.append(el('span', 'visually-hidden', 'שיר: '), document.createTextNode(`♪ ${item.song}`));
      main.append(song);
    }
    head.append(main);

    const panel = item.description ? el('div', null) : null;
    if (panel) panel.append(el('p', 'program-desc', item.description));
    list.append(accordionCard(head, panel, 'program-card'));
  }
  return program.length > 0;
}

function renderParticipants(participants) {
  const list = document.getElementById('participants-list');
  for (const group of participants) {
    const head = el('span', 'participants-head');
    head.append(programNum('participants-num', group.order, group.type)); // empty for link segments, keeps titles aligned
    head.append(el('span', 'card-title', group.section));
    const count = el('span', 'count', String(group.people.length));
    count.setAttribute('aria-label', `${group.people.length} משתתפים`);
    head.append(count);

    const panel = el('div', null);
    const ul = el('ul', 'name-list');
    for (const p of group.people) ul.append(el('li', null, personText(p)));
    panel.append(ul);
    list.append(accordionCard(head, panel, 'participants-card'));
  }
  return participants.length > 0;
}

function renderTeam(team) {
  const wrap = document.getElementById('team-list');
  for (const { group, people } of team) {
    const box = el('div', 'card team-group');
    box.append(el('h3', 'team-title', group));
    const ul = el('ul', 'name-list');
    for (const p of people) {
      const li = el('li', null, p.name);
      if (p.role) li.append(el('span', 'role', ` – ${p.role}`));
      ul.append(li);
    }
    box.append(ul);
    wrap.append(box);
  }
  return team.length > 0;
}

function renderThanks(thanks) {
  const body = document.getElementById('thanks-body');
  for (const line of thanks) body.append(el('p', null, line));
  return thanks.length > 0;
}

function renderLyrics(lyrics) {
  const list = document.getElementById('lyrics-list');
  for (const song of lyrics) {
    const head = el('span', 'lyrics-head');
    head.append(el('span', 'card-title', song.song));
    if (song.credits) head.append(el('span', 'lyrics-credits', song.credits));

    let panel = null;
    if (song.lyrics) {
      panel = el('div', 'lyrics-body');
      for (const stanza of song.lyrics.split(/\n[ \t]*\n+/)) {
        if (stanza.trim()) panel.append(el('p', 'stanza', stanza.trim()));
      }
    }
    list.append(accordionCard(head, panel, 'lyrics-card'));
  }
  return lyrics.length > 0;
}

function showSection(id, hasContent) {
  document.getElementById(id).hidden = !hasContent;
  const link = document.querySelector(`#nav-links a[href="#${id}"]`);
  if (link) link.parentElement.hidden = !hasContent;
}

function render(model) {
  renderHeader(model.settings);
  showSection('program', renderProgram(model.program));
  showSection('participants', renderParticipants(model.participants));
  showSection('team', renderTeam(model.team));
  showSection('thanks', renderThanks(model.thanks));
  showSection('lyrics', renderLyrics(model.lyrics));
}

/* ---------- UI behaviour ---------- */

function storeGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function storeSet(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* private mode */ } }

function initAccordions() {
  document.getElementById('main').addEventListener('click', (e) => {
    const btn = e.target.closest('.card-toggle');
    if (!btn) return;
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    document.getElementById(btn.getAttribute('aria-controls')).hidden = !open;
  });
}

function initTheme() {
  const root = document.documentElement;
  const btn = document.getElementById('theme-toggle');
  const meta = document.querySelector('meta[name="theme-color"]');
  const apply = (theme) => {
    root.dataset.theme = theme;
    btn.setAttribute('aria-label', theme === 'dark' ? 'מעבר למצב בהיר' : 'מעבר למצב כהה');
    meta.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim() || '#0d141b');
  };
  apply(storeGet('hz90-theme') === 'light' ? 'light' : 'dark');
  btn.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    apply(next);
    storeSet('hz90-theme', next);
  });
}

function initTextSize() {
  const root = document.documentElement;
  const btn = document.getElementById('size-toggle');
  const apply = (level) => {
    root.dataset.size = String(level);
    const next = SIZE_LABELS[(level + 1) % SIZE_LABELS.length];
    btn.setAttribute('aria-label', `גודל טקסט: ${SIZE_LABELS[level]}. לחצו למעבר ל${next}`);
  };
  const saved = Number(storeGet('hz90-size'));
  apply([0, 1, 2].includes(saved) ? saved : 0);
  btn.addEventListener('click', () => {
    const level = (Number(root.dataset.size) + 1) % SIZE_LABELS.length;
    apply(level);
    storeSet('hz90-size', String(level));
  });
}

// Highlights the tab of the section being read: the last section whose heading has passed
// under the top bar, or the last section once the page is scrolled to the end.
function initScrollSpy() {
  const nav = document.getElementById('nav-links');
  const topbar = document.querySelector('.topbar');
  const links = new Map([...nav.querySelectorAll('a')].map((a) => [a.getAttribute('href').slice(1), a]));
  const sections = [...document.querySelectorAll('main > section')]
    .filter((s) => links.has(s.id) && !s.hidden);
  if (!sections.length) return;

  let current = null;
  let pinned = false; // after a tab tap, keep that tab lit until the reader scrolls by hand
  const setCurrent = (id) => {
    if (id === current) return;
    current = id;
    links.forEach((a, key) => {
      if (key === id) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    });
  };
  const update = () => {
    if (pinned) return;
    const line = topbar.getBoundingClientRect().bottom + 32;
    let id = sections[0].id;
    for (const s of sections) if (s.getBoundingClientRect().top <= line) id = s.id;
    const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    setCurrent(atEnd ? sections[sections.length - 1].id : id);
  };

  nav.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    setCurrent(a.getAttribute('href').slice(1));
    pinned = true;
  });
  for (const type of ['wheel', 'touchstart', 'keydown', 'mousedown']) {
    window.addEventListener(type, () => { pinned = false; }, { passive: true });
  }
  let queued = false;
  window.addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; update(); });
  }, { passive: true });
  window.addEventListener('resize', update);
  update();
}

/* ---------- Boot ---------- */

async function main() {
  initTheme();
  initTextSize();
  initAccordions();

  const loading = document.getElementById('loading');
  try {
    const { tabs, fromFallback } = await loadData();
    render(buildModel(tabs));
    document.getElementById('notice').hidden = !fromFallback;
    loading.remove();
  } catch (err) {
    console.error(err);
    loading.textContent = 'לא הצלחנו לטעון את התוכנייה. נסו לרענן את העמוד.';
    loading.classList.add('loading--error');
    return;
  }
  initScrollSpy();

  // Re-apply a #hash jump now that the sections exist.
  if (location.hash) {
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (target && !target.hidden) target.scrollIntoView();
  }
}

if (typeof document !== 'undefined') main();
