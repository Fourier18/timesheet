'use strict';
// Browser-preview fallback ONLY. In the packaged Electron app the preload
// script defines window.api first, so this whole block is skipped.
if (!window.api) {
  const KEY = 'timesheet-preview-data';

  function seed() {
    const now = new Date();
    const iso = (d) => d.toISOString();
    const at = (dayOffset, h, m) => {
      const d = new Date(now);
      d.setDate(d.getDate() + dayOffset);
      d.setHours(h, m, 0, 0);
      return d;
    };
    return {
      version: 2,
      activeTask: { id: 'tB', rate: 60, startedAt: localIso(at(0, 8, 30)) },
      sessions: [
        { id: 'p1', taskId: 'tA', rate: 45, start: localIso(at(-1, 9, 2)),  end: localIso(at(-1, 12, 15)), notes: 'client work' },
        { id: 'p2', taskId: 'tA', rate: 45, start: localIso(at(-1, 13, 0)), end: localIso(at(-1, 17, 48)), notes: 'admin + email' },
        { id: 'p3', taskId: 'tB', rate: 60, start: localIso(at(0, 8, 30)),  end: localIso(at(0, 11, 5)),   notes: 'deep work' },
        { id: 'p4', taskId: 'tB', rate: 60, start: localIso(at(0, 12, 30)), end: null, notes: 'afternoon block' }
      ]
    };
  }

  function localIso(d) {
    const p = (n, l = 2) => String(n).padStart(l, '0');
    const off = -d.getTimezoneOffset();
    const s = off >= 0 ? '+' : '-';
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
           `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}` +
           `${s}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.api = {
    async load() {
      const raw = localStorage.getItem(KEY);
      if (raw) return JSON.parse(raw);
      const d = seed();
      localStorage.setItem(KEY, JSON.stringify(d));
      return d;
    },
    async save(data) { localStorage.setItem(KEY, JSON.stringify(data)); return { ok: true }; },
    async exportCsv(csv, name) { download(name, csv, 'text/csv'); return { ok: true }; },
    async backupJson(json, name) { download(name, json, 'application/json'); return { ok: true }; },
    async dataPath() { return '[preview] localStorage'; }
  };
}
