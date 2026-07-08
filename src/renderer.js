'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  data: { version: 2, activeTask: null, sessions: [] },
  scope: 'week',                 // 'week' | 'range' | 'all'
  showIntervals: true,
  spanDays: 1,                   // configurable day count for the 'week' view (1..MAX_RANGE_DAYS)
  weekAnchorEnd: startOfDay(new Date()),
  rangeStart: startOfDay(addDays(new Date(), -6)),
  rangeEnd: startOfDay(new Date()),
  editingId: null,
  lastPurgeDay: null            // dayKey of the last project-name purge sweep
};

const MAX_RANGE_DAYS = 31;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Project names are kept only for "today" + "yesterday" (by clock-in date),
// then purged from disk and memory entirely — see purgeExpiredProjects().
const PROJECT_RETENTION_DAYS = 2;

// ---------------------------------------------------------------------------
// Time / format helpers
// ---------------------------------------------------------------------------
function pad(n, l = 2) { return String(n).padStart(l, '0'); }

function toLocalISO(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
         `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function dayKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function fmtTime(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function parseDayKey(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }

function parseDateTime(dateStr, timeStr) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  const tm = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((timeStr || '').trim());
  if (!dm || !tm) return null;
  return new Date(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2], 0, 0);
}

function parseRate(str) {
  const v = parseFloat(String(str).replace(/[^0-9.]/g, ''));
  return Number.isFinite(v) && v >= 0 ? v : null;
}

function sessStart(s) { return new Date(s.start); }
function sessEndOrNow(s) { return s.end ? new Date(s.end) : new Date(); }
function isOpen(s) { return !s.end; }
function durMs(s) { return Math.max(0, sessEndOrNow(s) - sessStart(s)); }
function hoursOf(ms) { return ms / 3600000; }

function formatHM(ms) {
  const mins = Math.round(ms / 60000);
  return `${Math.floor(mins / 60)}h ${pad(mins % 60)}m`;
}
function decimalHours(ms) { return (ms / 3600000).toFixed(2); }
function formatMoney(x) {
  return '$' + x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ---------------------------------------------------------------------------
// Clock state machine
// ---------------------------------------------------------------------------
function openSession() { return state.data.sessions.find(s => isOpen(s)); }
function clockState() {
  if (openSession()) return 'working';
  if (state.data.activeTask) return 'onbreak';
  return 'idle';
}
function taskSessions(taskId) { return state.data.sessions.filter(s => s.taskId === taskId); }
function taskTotals(taskId) {
  let ms = 0;
  for (const s of taskSessions(taskId)) ms += durMs(s);
  const rate = state.data.activeTask ? state.data.activeTask.rate : 0;
  return { ms, earn: hoursOf(ms) * rate };
}

async function clockInNewTask(rate, project = '', notes = '') {
  const now = new Date();
  const task = { id: crypto.randomUUID(), rate, project, startedAt: toLocalISO(now) };
  state.data.activeTask = task;
  state.data.sessions.push({ id: crypto.randomUUID(), taskId: task.id, start: toLocalISO(now), end: null, notes, rate, project });
  await persist(); render();
}
async function goOnBreak() {
  const s = openSession();
  if (s) s.end = toLocalISO(new Date());
  await persist(); render();
}
async function resume() {
  const t = state.data.activeTask;
  if (!t) return;
  state.data.sessions.push({ id: crypto.randomUUID(), taskId: t.id, start: toLocalISO(new Date()), end: null, notes: '', rate: t.rate, project: t.project || '' });
  await persist(); render();
}
async function finalClockOut() {
  const s = openSession();
  if (s) s.end = toLocalISO(new Date());
  state.data.activeTask = null;
  await persist(); render();
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function validate(candidate, exceptId) {
  if (!candidate.start) return 'Start date/time is invalid.';
  if (candidate.end !== null) {
    if (!candidate.end) return 'End date/time is invalid.';
    if (candidate.end <= candidate.start) return 'Clock-out must be after clock-in.';
  } else {
    if (!state.data.activeTask) return 'Cannot reopen a completed session — use Clock In to start a new one.';
    if (state.data.sessions.some(s => isOpen(s) && s.id !== exceptId)) return 'Another session is still open.';
  }
  if (candidate.rate === null) return 'Rate is required (a number ≥ 0).';
  const aStart = candidate.start.getTime();
  const aEnd = candidate.end ? candidate.end.getTime() : Infinity;
  for (const s of state.data.sessions) {
    if (s.id === exceptId) continue;
    const bStart = sessStart(s).getTime();
    const bEnd = s.end ? new Date(s.end).getTime() : Infinity;
    if (aStart < bEnd && bStart < aEnd) return `Overlaps an existing session (${fmtRange(s)}).`;
  }
  return null;
}
function fmtRange(s) {
  const a = sessStart(s), b = s.end ? new Date(s.end) : null;
  return `${dayKey(a)} ${fmtTime(a)}–${b ? fmtTime(b) : 'open'}`;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Project-name privacy: names live only for "today" + "yesterday" (by the
// session's clock-in date), then are deleted from disk and memory entirely.
// Hours/earnings/notes are untouched — only the `project` field is dropped.
// ---------------------------------------------------------------------------
function projectCutoff() { return addDays(startOfDay(new Date()), -(PROJECT_RETENTION_DAYS - 1)); }

function purgeExpiredProjects() {
  const cutoff = projectCutoff();
  let changed = false;
  for (const s of state.data.sessions) {
    if (s.project && sessStart(s) < cutoff) { delete s.project; changed = true; }
  }
  return changed;
}

function recentProjectNames() {
  const cutoff = projectCutoff();
  const names = new Set();
  for (const s of state.data.sessions) {
    if (s.project && sessStart(s) >= cutoff) names.add(s.project);
  }
  if (state.data.activeTask && state.data.activeTask.project) names.add(state.data.activeTask.project);
  return [...names].sort((a, b) => a.localeCompare(b));
}

function populateProjectList() {
  document.getElementById('projectList').innerHTML =
    recentProjectNames().map(n => `<option value="${escapeAttr(n)}"></option>`).join('');
}

async function persist() { await window.api.save(state.data); }
async function load() {
  const data = await window.api.load();
  if (data && Array.isArray(data.sessions)) {
    state.data = { version: 2, activeTask: data.activeTask || null, sessions: data.sessions };
  }
  document.getElementById('dataPath').textContent = 'Data: ' + (await window.api.dataPath());
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  renderActiveBar();
  renderClockControls();
  renderControls();
  renderList();
  populateProjectList();
}

function renderActiveBar() {
  const bar = document.getElementById('activeBar');
  const st = clockState();
  if (st === 'idle') { bar.innerHTML = ''; return; }
  const task = state.data.activeTask;
  // Orphaned open session (edit cleared end time without setting activeTask) — treat as idle.
  if (!task) { bar.innerHTML = ''; return; }
  const { ms, earn } = taskTotals(task.id);

  if (st === 'working') {
    const cur = openSession();
    bar.innerHTML = `
      <div class="card working">
        <div>
          <span class="pulse"></span>
          <span class="since">Working · since <b>${fmtTime(sessStart(cur))}</b> · ${formatMoney(task.rate)}/hr</span>
        </div>
        <div class="elapsed" data-live-task>${formatHM(ms)} · ${formatMoney(earn)}</div>
      </div>`;
  } else {
    bar.innerHTML = `
      <div class="card onbreak">
        <div>
          <span class="pausebars"><i></i><i></i></span>
          <span class="since break">On break · task so far · ${formatMoney(task.rate)}/hr</span>
        </div>
        <div class="elapsed break" data-live-task>${formatHM(ms)} · ${formatMoney(earn)}</div>
      </div>`;
  }
}

function renderClockControls() {
  const el = document.getElementById('clockControls');
  const st = clockState();
  if (st === 'idle') {
    el.innerHTML = `<button id="bClockIn" class="clock-btn">Clock In</button>`;
    document.getElementById('bClockIn').onclick = openRatePrompt;
  } else if (st === 'working') {
    el.innerHTML = `
      <button id="bBreak" class="clock-btn break-btn">Break</button>
      <button id="bOut" class="clock-btn out">Clock Out</button>`;
    document.getElementById('bBreak').onclick = goOnBreak;
    document.getElementById('bOut').onclick = finalClockOut;
  } else {
    el.innerHTML = `
      <button id="bResume" class="clock-btn">Resume</button>
      <button id="bOut" class="clock-btn out">Clock Out</button>`;
    document.getElementById('bResume').onclick = resume;
    document.getElementById('bOut').onclick = finalClockOut;
  }
}

function renderControls() {
  document.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.scope === state.scope));
  document.getElementById('intervalsToggle').checked = state.showIntervals;
  document.getElementById('weekNav').style.display = state.scope === 'week' ? '' : 'none';
  document.getElementById('rangeNav').style.display = state.scope === 'range' ? '' : 'none';

  if (state.scope === 'week') {
    const end = state.weekAnchorEnd, start = addDays(end, -(state.spanDays - 1));
    document.getElementById('weekLabel').textContent = state.spanDays === 1
      ? dayKey(end)
      : `${dayKey(start)} → ${dayKey(end)}`;
    document.getElementById('weekNext').disabled = end.getTime() >= startOfDay(new Date()).getTime();
  } else if (state.scope === 'range') {
    document.getElementById('rangeStart').value = dayKey(state.rangeStart);
    document.getElementById('rangeEnd').value = dayKey(state.rangeEnd);
    const days = Math.round((state.rangeEnd - state.rangeStart) / 86400000) + 1;
    document.getElementById('rangeNote').textContent = `${days} day${days === 1 ? '' : 's'} (max ${MAX_RANGE_DAYS})`;
  }
}

// Group sessions into "session blocks" (one clock-in -> clock-out task each),
// then bucket each *whole* block under the calendar day it started on.
// Deliberately not split at midnight (Option A): an 11:30pm-1:00am task is one
// unbroken block with one running total, shown entirely under its start day.
//
// dayKey -> { dayStart, totalMs, totalEarn, blocks:[{taskId, project, sessions, ms, earn, open, start}] }
function buildDayBlocks() {
  const taskMap = new Map();
  for (const s of state.data.sessions) {
    let t = taskMap.get(s.taskId);
    if (!t) { t = { taskId: s.taskId, sessions: [] }; taskMap.set(s.taskId, t); }
    t.sessions.push(s);
  }

  const map = new Map();
  for (const t of taskMap.values()) {
    t.sessions.sort((a, b) => sessStart(a) - sessStart(b));
    const start = sessStart(t.sessions[0]);
    let ms = 0, earn = 0;
    for (const s of t.sessions) { const d = durMs(s); ms += d; earn += hoursOf(d) * (s.rate || 0); }
    const open = t.sessions.some(isOpen);
    const project = (t.sessions.find(s => s.project) || {}).project || '';
    const key = dayKey(start);
    let e = map.get(key);
    if (!e) { e = { dayStart: startOfDay(start), totalMs: 0, totalEarn: 0, blocks: [] }; map.set(key, e); }
    e.totalMs += ms;
    e.totalEarn += earn;
    e.blocks.push({ taskId: t.taskId, project, sessions: t.sessions, ms, earn, open, start });
  }
  for (const e of map.values()) e.blocks.sort((a, b) => a.start - b.start);
  return map;
}

function renderList() {
  const list = document.getElementById('list');
  const map = buildDayBlocks();
  list.innerHTML = '';

  let dayList; // [{ key, dayStart }]
  if (state.scope === 'week') {
    dayList = [];
    for (let i = 0; i < state.spanDays; i++) { const d = addDays(state.weekAnchorEnd, -i); dayList.push({ key: dayKey(d), dayStart: d }); }
    const totals = sumDays(map, dayList), live = anyLive(map, dayList);
    const opts = Array.from({ length: MAX_RANGE_DAYS }, (_, i) => i + 1).map(n =>
      `<option value="${n}"${n===state.spanDays?' selected':''}>${n === 1 ? 'Day' : n + '-day'} total</option>`
    ).join('');
    const wt = document.createElement('div');
    wt.className = 'week-total';
    wt.innerHTML = `<select id="spanSelect" class="span-select">${opts}</select><b data-live-total>${formatHM(totals.ms)} · ${formatMoney(totals.earn)}${live ? ' ·' : ''}</b>`;
    list.appendChild(wt);
  } else if (state.scope === 'range') {
    dayList = [];
    const span = Math.round((state.rangeEnd - state.rangeStart) / 86400000);
    for (let i = 0; i <= span; i++) { const d = addDays(state.rangeEnd, -i); dayList.push({ key: dayKey(d), dayStart: d }); }
    appendTotalHeader(list, `Range total · ${dayKey(state.rangeStart)} → ${dayKey(state.rangeEnd)}`, sumDays(map, dayList), anyLive(map, dayList));
  } else {
    dayList = [...map.values()].sort((a, b) => b.dayStart - a.dayStart).map(e => ({ key: dayKey(e.dayStart), dayStart: e.dayStart }));
  }

  if (dayList.length === 0) {
    list.innerHTML = `<div class="empty"><div class="big">No entries yet</div>Click <b>Clock In</b> to start, or <b>+ Add</b> for a past session.</div>`;
    return;
  }

  for (const dk of dayList) {
    const entry = map.get(dk.key);
    const total = entry ? entry.totalMs : 0;
    const earn = entry ? entry.totalEarn : 0;
    const hasLive = entry && entry.blocks.some(b => b.open);

    const dayEl = document.createElement('div');
    dayEl.className = 'day';
    const head = document.createElement('div');
    head.className = 'day-head';
    head.innerHTML = `
      <div><span class="date">${dk.key}</span><span class="dow">${DOW[dk.dayStart.getDay()]}</span></div>
      <div class="total ${hasLive ? 'live' : ''}" ${hasLive ? `data-live-day="${dk.key}"` : ''}>${formatHM(total)} · ${formatMoney(earn)}</div>`;
    dayEl.appendChild(head);

    if (entry) {
      const wrap = document.createElement('div');
      wrap.className = 'blocks';
      for (const block of entry.blocks) wrap.appendChild(blockEl(block));
      dayEl.appendChild(wrap);
    }
    list.appendChild(dayEl);
  }
}

function sumDays(map, dayList) {
  let ms = 0, earn = 0;
  for (const dk of dayList) { const e = map.get(dk.key); if (e) { ms += e.totalMs; earn += e.totalEarn; } }
  return { ms, earn };
}
function anyLive(map, dayList) {
  return dayList.some(dk => (map.get(dk.key)?.blocks || []).some(b => b.open));
}
function appendTotalHeader(list, label, totals, live) {
  const wt = document.createElement('div');
  wt.className = 'week-total';
  wt.innerHTML = `<span>${label}</span><b data-live-total>${formatHM(totals.ms)} · ${formatMoney(totals.earn)}${live ? ' ·' : ''}</b>`;
  list.appendChild(wt);
}

// One "session" in the user's vocabulary = one clock-in -> clock-out block.
// Its header carries the project name and a running total across all of its
// break-segments; the segments themselves render as interval rows beneath.
function blockEl(block) {
  const wrap = document.createElement('div');
  wrap.className = 'block';

  const last = block.sessions[block.sessions.length - 1];
  const rangeTxt = block.open
    ? `${fmtTime(block.start)} – <span class="open">now</span>`
    : `${fmtTime(block.start)} – ${fmtTime(sessEndOrNow(last))}`;
  const projTxt = block.project
    ? `<span class="proj">${escapeAttr(block.project)}</span>`
    : `<span class="proj unlabeled">· no project ·</span>`;

  const head = document.createElement('div');
  head.className = 'block-head';
  head.innerHTML = `
    <div>${projTxt}<span class="block-range">${rangeTxt}</span></div>
    <div class="block-total ${block.open ? 'live' : ''}" ${block.open ? `data-live-block="${block.taskId}"` : ''}>${formatHM(block.ms)} · ${formatMoney(block.earn)}</div>`;
  wrap.appendChild(head);

  if (state.showIntervals) {
    const body = document.createElement('div');
    body.className = 'block-body';
    for (const session of block.sessions) body.appendChild(intervalRow(session));
    wrap.appendChild(body);
  }
  return wrap;
}

function intervalRow(session) {
  const row = document.createElement('div');
  row.className = 'row';
  const open = isOpen(session);
  const ms = durMs(session);
  const earn = hoursOf(ms) * (session.rate || 0);
  const toTxt = open ? `<span class="open">now</span>` : fmtTime(sessEndOrNow(session));

  row.innerHTML = `
    <div class="time">${fmtTime(sessStart(session))} – ${toTxt}</div>
    <div class="dur ${open ? 'live' : ''}" ${open ? `data-live-piece="${session.id}"` : ''}>${formatHM(ms)}</div>
    <div class="money" ${open ? `data-live-money="${session.id}"` : ''}>${formatMoney(earn)}</div>
    <input class="note-input" data-note="${session.id}" value="${escapeAttr(session.notes || '')}" placeholder="notes…" />
    <div class="actions">
      <button data-edit="${session.id}" title="Edit">Edit</button>
      <button data-del="${session.id}" title="Delete">Del</button>
    </div>`;
  return row;
}

function escapeAttr(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Live tick
// ---------------------------------------------------------------------------
// Re-purge once per calendar-day rollover (e.g. an overnight session pushes an
// older entry past the retention window while the app stays open).
function maybePurgeOnRollover() {
  const todayStart = startOfDay(new Date());
  const today = dayKey(todayStart);
  if (state.lastPurgeDay === today) return;

  // If the day view was anchored on what was "today" before this rollover
  // (i.e. the user hadn't navigated away to an older day), advance the
  // anchor so the new day — and any live session now bucketed under it —
  // comes into view automatically instead of staying parked on yesterday.
  if (state.scope === 'week' && dayKey(state.weekAnchorEnd) === state.lastPurgeDay) {
    state.weekAnchorEnd = todayStart;
  }

  state.lastPurgeDay = today;
  const purged = purgeExpiredProjects();
  if (purged) persist();
  render();
}

// Runs every second. Deliberately never calls render() on the working path —
// a full re-render destroys and rebuilds the span-select dropdown each time,
// which is what made it impossible to pick an option while clocked in. Instead
// we update only the live text nodes directly, leaving the DOM (and any open
// dropdown) untouched.
function tick() {
  const now = new Date();
  document.getElementById('liveClock').textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  maybePurgeOnRollover();

  const st = clockState();
  if (st === 'idle') return;

  const task = state.data.activeTask;
  const { ms: taskMs, earn: taskEarn } = taskTotals(task.id);
  const liveTask = document.querySelector('[data-live-task]');
  if (liveTask) liveTask.textContent = `${formatHM(taskMs)} · ${formatMoney(taskEarn)}`;

  if (st !== 'working') return;

  const cur = openSession();
  if (!cur) return;
  const ms = durMs(cur);
  const earn = hoursOf(ms) * (cur.rate || 0);

  const durNode = document.querySelector(`[data-live-piece="${cur.id}"]`);
  if (durNode) durNode.textContent = formatHM(ms);
  const moneyNode = document.querySelector(`[data-live-money="${cur.id}"]`);
  if (moneyNode) moneyNode.textContent = formatMoney(earn);

  const blockNode = document.querySelector(`[data-live-block="${cur.taskId}"]`);
  if (blockNode) blockNode.textContent = `${formatHM(taskMs)} · ${formatMoney(taskEarn)}`;

  // The active block is bucketed under its clock-in day (Option A — never
  // split at midnight), so at most one day total can be live at a time.
  const blockDayKey = dayKey(new Date(task.startedAt));
  const dayNode = document.querySelector(`[data-live-day="${blockDayKey}"]`);
  const totalNode = document.querySelector('[data-live-total]');
  if (dayNode || totalNode) {
    const map = buildDayBlocks();
    if (dayNode) {
      const e = map.get(blockDayKey);
      dayNode.textContent = `${formatHM(e?.totalMs || 0)} · ${formatMoney(e?.totalEarn || 0)}`;
    }
    if (totalNode) {
      let dayList = [];
      if (state.scope === 'week') for (let i = 0; i < state.spanDays; i++) dayList.push({ key: dayKey(addDays(state.weekAnchorEnd, -i)) });
      else if (state.scope === 'range') {
        const span = Math.round((state.rangeEnd - state.rangeStart) / 86400000);
        for (let i = 0; i <= span; i++) dayList.push({ key: dayKey(addDays(state.rangeEnd, -i)) });
      }
      if (dayList.length) { const t = sumDays(map, dayList); totalNode.textContent = `${formatHM(t.ms)} · ${formatMoney(t.earn)} ·`; }
    }
  }
}

// ---------------------------------------------------------------------------
// Rate prompt (new task)
// ---------------------------------------------------------------------------
const rateDlg = document.getElementById('rateDialog');
function openRatePrompt() {
  document.getElementById('rateInput').value = '';   // always blank for a new task
  document.getElementById('rateProject').value = '';
  document.getElementById('rateNote').value = '';
  document.getElementById('rateError').hidden = true;
  rateDlg.showModal();
  setTimeout(() => document.getElementById('rateProject').focus(), 30);
}
async function confirmRate() {
  const rate = parseRate(document.getElementById('rateInput').value);
  if (rate === null) {
    const e = document.getElementById('rateError'); e.textContent = 'Enter a rate (a number ≥ 0).'; e.hidden = false;
    return;
  }
  const project = document.getElementById('rateProject').value.trim();
  const notes = document.getElementById('rateNote').value.trim();
  rateDlg.close();
  await clockInNewTask(rate, project, notes);
}

// ---------------------------------------------------------------------------
// Add / edit dialog
// ---------------------------------------------------------------------------
const dlg = document.getElementById('editDialog');
function openDialog(session) {
  state.editingId = session ? session.id : null;
  document.getElementById('dlgTitle').textContent = session ? 'Edit entry' : 'Add entry';
  document.getElementById('formError').hidden = true;
  document.getElementById('deleteBtn').hidden = !session;

  const editingOpen = !!(session && isOpen(session));
  document.getElementById('openRow').hidden = !editingOpen;
  document.getElementById('openCheck').checked = editingOpen;

  const now = new Date();
  if (session) {
    const a = sessStart(session);
    document.getElementById('startDate').value = dayKey(a);
    document.getElementById('startTime').value = fmtTime(a);
    if (session.end) {
      const b = new Date(session.end);
      document.getElementById('endDate').value = dayKey(b);
      document.getElementById('endTime').value = fmtTime(b);
    } else {
      document.getElementById('endDate').value = dayKey(now);
      document.getElementById('endTime').value = '';
    }
    document.getElementById('rate').value = session.rate != null ? session.rate : '';
    document.getElementById('entryProject').value = session.project || '';
    document.getElementById('notes').value = session.notes || '';
  } else {
    document.getElementById('startDate').value = dayKey(now);
    document.getElementById('startTime').value = fmtTime(now);
    document.getElementById('endDate').value = dayKey(now);
    document.getElementById('endTime').value = '';
    document.getElementById('rate').value = '';
    document.getElementById('entryProject').value = '';
    document.getElementById('notes').value = '';
  }
  syncOpenCheck();
  dlg.showModal();
}
function syncOpenCheck() {
  const open = document.getElementById('openCheck').checked && !document.getElementById('openRow').hidden;
  document.getElementById('endRow').classList.toggle('disabled', open);
  document.getElementById('endDate').disabled = open;
  document.getElementById('endTime').disabled = open;
}
async function saveDialog() {
  const start = parseDateTime(document.getElementById('startDate').value, document.getElementById('startTime').value);
  const leaveOpen = document.getElementById('openCheck').checked && !document.getElementById('openRow').hidden;
  const end = leaveOpen ? null : parseDateTime(document.getElementById('endDate').value, document.getElementById('endTime').value);
  const rate = parseRate(document.getElementById('rate').value);

  const err = validate({ start, end: leaveOpen ? null : end, rate }, state.editingId);
  if (err) { const e = document.getElementById('formError'); e.textContent = err; e.hidden = false; return; }

  const notes = document.getElementById('notes').value.trim();
  const project = document.getElementById('entryProject').value.trim();
  if (state.editingId) {
    const s = state.data.sessions.find(x => x.id === state.editingId);
    s.start = toLocalISO(start);
    s.end = end ? toLocalISO(end) : null;
    s.rate = rate; s.notes = notes; s.project = project;
  } else {
    state.data.sessions.push({ id: crypto.randomUUID(), taskId: crypto.randomUUID(), start: toLocalISO(start), end: end ? toLocalISO(end) : null, rate, notes, project });
  }
  await persist(); dlg.close(); render();
}
async function deleteSession() {
  if (!state.editingId) return;
  state.data.sessions = state.data.sessions.filter(s => s.id !== state.editingId);
  await persist(); dlg.close(); render();
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function csvCell(v) { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
async function exportCsv() {
  const rows = [['date', 'clock_in', 'clock_out', 'duration_hours', 'rate', 'earnings', 'notes']];
  const sorted = [...state.data.sessions].sort((a, b) => sessStart(a) - sessStart(b));
  for (const s of sorted) {
    const a = sessStart(s);
    const clockIn = `${dayKey(a)} ${fmtTime(a)}`;
    if (s.end) {
      const b = new Date(s.end);
      const hrs = decimalHours(b - a);
      rows.push([dayKey(a), clockIn, `${dayKey(b)} ${fmtTime(b)}`, hrs, (s.rate ?? 0).toFixed(2), (hrs * (s.rate || 0)).toFixed(2), s.notes || '']);
    } else {
      rows.push([dayKey(a), clockIn, '', '', (s.rate ?? 0).toFixed(2), '', s.notes || '']);
    }
  }
  const csv = rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  await window.api.exportCsv(csv, `timesheet-${dayKey(new Date())}.csv`);
}
async function backup() {
  const n = new Date();
  const name = `timesheet-backup-${dayKey(n)}-${pad(n.getHours())}${pad(n.getMinutes())}${pad(n.getSeconds())}.json`;
  await window.api.backupJson(JSON.stringify(state.data, null, 2), name);
}

// ---------------------------------------------------------------------------
// Range pickers
// ---------------------------------------------------------------------------
function onRangeChange() {
  const s = parseDayKey(document.getElementById('rangeStart').value);
  const e = parseDayKey(document.getElementById('rangeEnd').value);
  if (!s || !e) return;
  let start = s, end = e;
  if (end < start) [start, end] = [end, start];
  const span = Math.round((end - start) / 86400000) + 1;
  if (span > MAX_RANGE_DAYS) end = addDays(start, MAX_RANGE_DAYS - 1);
  state.rangeStart = start; state.rangeEnd = end;
  render();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function wire() {
  document.querySelectorAll('.seg-btn').forEach(b => b.addEventListener('click', () => { state.scope = b.dataset.scope; render(); }));
  document.getElementById('intervalsToggle').addEventListener('change', e => { state.showIntervals = e.target.checked; render(); });

  document.getElementById('weekPrev').addEventListener('click', () => { state.weekAnchorEnd = addDays(state.weekAnchorEnd, -state.spanDays); render(); });
  document.getElementById('weekNext').addEventListener('click', () => {
    state.weekAnchorEnd = addDays(state.weekAnchorEnd, state.spanDays);
    const today = startOfDay(new Date());
    if (state.weekAnchorEnd > today) state.weekAnchorEnd = today;
    render();
  });
  document.getElementById('rangeStart').addEventListener('change', onRangeChange);
  document.getElementById('rangeEnd').addEventListener('change', onRangeChange);

  document.getElementById('addBtn').addEventListener('click', () => openDialog(null));
  document.getElementById('csvBtn').addEventListener('click', exportCsv);
  document.getElementById('backupBtn').addEventListener('click', backup);

  const list = document.getElementById('list');
  list.addEventListener('click', e => {
    const editId = e.target.getAttribute('data-edit');
    const delId = e.target.getAttribute('data-del');
    if (editId) openDialog(state.data.sessions.find(s => s.id === editId));
    if (delId) { state.editingId = delId; deleteSession(); }
  });
  // inline notes: save on change (blur / enter), no re-render to preserve focus
  list.addEventListener('change', async e => {
    if (e.target.id === 'spanSelect') { state.spanDays = parseInt(e.target.value, 10) || 1; render(); return; }
    const id = e.target.getAttribute && e.target.getAttribute('data-note');
    if (!id) return;
    const s = state.data.sessions.find(x => x.id === id);
    if (s) { s.notes = e.target.value.trim(); await persist(); }
  });
  list.addEventListener('keydown', e => {
    if (e.target.classList && e.target.classList.contains('note-input') && e.key === 'Enter') e.target.blur();
  });

  // rate prompt
  document.getElementById('rateStart').addEventListener('click', confirmRate);
  document.getElementById('rateCancel').addEventListener('click', () => rateDlg.close());
  ['rateProject', 'rateInput', 'rateNote'].forEach(id => document.getElementById(id)
    .addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); confirmRate(); } }));
  rateDlg.addEventListener('cancel', e => { e.preventDefault(); rateDlg.close(); });

  // edit dialog
  document.getElementById('openCheck').addEventListener('change', syncOpenCheck);
  document.getElementById('saveBtn').addEventListener('click', saveDialog);
  document.getElementById('cancelBtn').addEventListener('click', () => dlg.close());
  document.getElementById('deleteBtn').addEventListener('click', deleteSession);
  dlg.addEventListener('cancel', e => { e.preventDefault(); dlg.close(); });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function boot() {
  wire();
  await load();
  state.lastPurgeDay = dayKey(startOfDay(new Date()));
  if (purgeExpiredProjects()) await persist();
  render();
  tick();
  setInterval(tick, 1000);
})();
