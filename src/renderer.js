'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  data: { version: 2, activeTask: null, sessions: [] },
  scope: 'week',                 // 'week' | 'range' | 'all'
  showIntervals: true,
  spanDays: 7,                   // configurable day count for the 'week' view (1..MAX_RANGE_DAYS)
  weekAnchorEnd: startOfDay(new Date()),
  rangeStart: startOfDay(addDays(new Date(), -6)),
  rangeEnd: startOfDay(new Date()),
  editingId: null
};

const MAX_RANGE_DAYS = 31;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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

// Split a session into per-local-day pieces at midnight boundaries.
function splitByDay(s) {
  const start = sessStart(s);
  const end = sessEndOrNow(s);
  const pieces = [];
  let cursor = start, guard = 0;
  while (cursor < end && guard++ < 400) {
    const dayStart = startOfDay(cursor);
    const nextMidnight = addDays(dayStart, 1);
    const to = end < nextMidnight ? end : nextMidnight;
    pieces.push({ key: dayKey(dayStart), dayStart, from: cursor, to, ms: to - cursor, open: isOpen(s) && to.getTime() === end.getTime() });
    cursor = nextMidnight;
  }
  if (pieces.length === 0) {
    const dayStart = startOfDay(start);
    pieces.push({ key: dayKey(dayStart), dayStart, from: start, to: end, ms: 0, open: isOpen(s) });
  }
  return pieces;
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

async function clockInNewTask(rate, notes = '') {
  const now = new Date();
  const task = { id: crypto.randomUUID(), rate, startedAt: toLocalISO(now) };
  state.data.activeTask = task;
  state.data.sessions.push({ id: crypto.randomUUID(), taskId: task.id, start: toLocalISO(now), end: null, notes, rate });
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
  state.data.sessions.push({ id: crypto.randomUUID(), taskId: t.id, start: toLocalISO(new Date()), end: null, notes: '', rate: t.rate });
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
  } else if (state.data.sessions.some(s => isOpen(s) && s.id !== exceptId)) {
    return 'Another session is still open.';
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
}

function renderActiveBar() {
  const bar = document.getElementById('activeBar');
  const st = clockState();
  if (st === 'idle') { bar.innerHTML = ''; return; }
  const task = state.data.activeTask;
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

// dayKey -> { dayStart, totalMs, totalEarn, pieces:[{piece, session}] }
function buildDayMap() {
  const map = new Map();
  for (const s of state.data.sessions) {
    for (const piece of splitByDay(s)) {
      let e = map.get(piece.key);
      if (!e) { e = { dayStart: piece.dayStart, totalMs: 0, totalEarn: 0, pieces: [] }; map.set(piece.key, e); }
      e.totalMs += piece.ms;
      e.totalEarn += hoursOf(piece.ms) * (s.rate || 0);
      e.pieces.push({ piece, session: s });
    }
  }
  for (const e of map.values()) e.pieces.sort((a, b) => a.piece.from - b.piece.from);
  return map;
}

function renderList() {
  const list = document.getElementById('list');
  const map = buildDayMap();
  list.innerHTML = '';

  let dayList; // [{ key, dayStart }]
  if (state.scope === 'week') {
    dayList = [];
    for (let i = 0; i < state.spanDays; i++) { const d = addDays(state.weekAnchorEnd, -i); dayList.push({ key: dayKey(d), dayStart: d }); }
    const totals = sumDays(map, dayList), live = anyLive(map, dayList);
    const opts = [1,3,7,14,31].map(n =>
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
    const hasLive = entry && entry.pieces.some(p => p.piece.open);

    const dayEl = document.createElement('div');
    dayEl.className = 'day';
    const head = document.createElement('div');
    head.className = 'day-head';
    head.innerHTML = `
      <div><span class="date">${dk.key}</span><span class="dow">${DOW[dk.dayStart.getDay()]}</span></div>
      <div class="total ${hasLive ? 'live' : ''}" ${hasLive ? `data-live-day="${dk.key}"` : ''}>${formatHM(total)} · ${formatMoney(earn)}</div>`;
    dayEl.appendChild(head);

    if (state.showIntervals && entry) {
      const wrap = document.createElement('div');
      wrap.className = 'intervals';
      let runMs = 0, runEarn = 0;
      for (const { piece, session } of entry.pieces) {
        runMs += piece.ms;
        runEarn += hoursOf(piece.ms) * (session.rate || 0);
        wrap.appendChild(intervalRow(piece, session, runMs, runEarn));
      }
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
  return dayList.some(dk => (map.get(dk.key)?.pieces || []).some(p => p.piece.open));
}
function appendTotalHeader(list, label, totals, live) {
  const wt = document.createElement('div');
  wt.className = 'week-total';
  wt.innerHTML = `<span>${label}</span><b data-live-total>${formatHM(totals.ms)} · ${formatMoney(totals.earn)}${live ? ' ·' : ''}</b>`;
  list.appendChild(wt);
}

function intervalRow(piece, session, runMs, runEarn) {
  const row = document.createElement('div');
  row.className = 'row';
  const startedPrevDay = piece.from.getTime() === piece.dayStart.getTime() && sessStart(session).getTime() < piece.dayStart.getTime();
  const continuesNextDay = !piece.open && piece.to.getTime() === addDays(piece.dayStart, 1).getTime() && sessEndOrNow(session).getTime() > piece.to.getTime();
  const toTxt = piece.open ? `<span class="open">now</span>` : fmtTime(piece.to);
  let tag = '';
  if (startedPrevDay) tag = `<span class="split-tag">cont</span>`;
  else if (continuesNextDay) tag = `<span class="split-tag">next</span>`;
  const pieceEarn = hoursOf(piece.ms) * (session.rate || 0);

  row.innerHTML = `
    <div class="time">${fmtTime(piece.from)} – ${toTxt}${tag}</div>
    <div class="dur ${piece.open ? 'live' : ''}" ${piece.open ? 'data-live-piece' : ''} title="Running: ${formatHM(runMs)} · ${formatMoney(runEarn)}">${formatHM(piece.ms)}</div>
    <div class="money">${formatMoney(pieceEarn)}</div>
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
function tick() {
  const now = new Date();
  document.getElementById('liveClock').textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const st = clockState();
  if (st === 'idle') return;

  const task = state.data.activeTask;
  const { ms, earn } = taskTotals(task.id);
  const liveTask = document.querySelector('[data-live-task]');
  if (liveTask) liveTask.textContent = `${formatHM(ms)} · ${formatMoney(earn)}`;

  if (st !== 'working') return;

  if (state.showIntervals && document.querySelector('[data-live-piece]')) { render(); return; }
  const map = buildDayMap();
  document.querySelectorAll('[data-live-day]').forEach(node => {
    const e = map.get(node.getAttribute('data-live-day'));
    node.textContent = `${formatHM(e?.totalMs || 0)} · ${formatMoney(e?.totalEarn || 0)}`;
  });
  const totalNode = document.querySelector('[data-live-total]');
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

// ---------------------------------------------------------------------------
// Rate prompt (new task)
// ---------------------------------------------------------------------------
const rateDlg = document.getElementById('rateDialog');
function openRatePrompt() {
  document.getElementById('rateInput').value = '';   // always blank for a new task
  document.getElementById('rateNote').value = '';
  document.getElementById('rateError').hidden = true;
  rateDlg.showModal();
  setTimeout(() => document.getElementById('rateInput').focus(), 30);
}
async function confirmRate() {
  const rate = parseRate(document.getElementById('rateInput').value);
  if (rate === null) {
    const e = document.getElementById('rateError'); e.textContent = 'Enter a rate (a number ≥ 0).'; e.hidden = false;
    return;
  }
  const notes = document.getElementById('rateNote').value.trim();
  rateDlg.close();
  await clockInNewTask(rate, notes);
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
    document.getElementById('notes').value = session.notes || '';
  } else {
    document.getElementById('startDate').value = dayKey(now);
    document.getElementById('startTime').value = fmtTime(now);
    document.getElementById('endDate').value = dayKey(now);
    document.getElementById('endTime').value = '';
    document.getElementById('rate').value = '';
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
  if (state.editingId) {
    const s = state.data.sessions.find(x => x.id === state.editingId);
    s.start = toLocalISO(start);
    s.end = end ? toLocalISO(end) : null;
    s.rate = rate; s.notes = notes;
  } else {
    state.data.sessions.push({ id: crypto.randomUUID(), taskId: crypto.randomUUID(), start: toLocalISO(start), end: end ? toLocalISO(end) : null, rate, notes });
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
    if (e.target.id === 'spanSelect') { state.spanDays = parseInt(e.target.value, 10) || 7; render(); return; }
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
  ['rateInput', 'rateNote'].forEach(id => document.getElementById(id)
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
  render();
  tick();
  setInterval(tick, 1000);
})();
