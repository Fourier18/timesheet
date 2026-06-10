# Timesheet

A local, offline desktop **time-tracking app** for Windows. Clock in with an hourly rate, take breaks, clock out — the app tracks your hours and computes earnings. All data lives in a single JSON file on your own machine. No server, no account, no network.

Built with Electron. Styled as a green-phosphor CRT terminal set into a Nostromo green industrial-steel panel.

## What it does

- **Clock in / break / resume / clock out** — a simple state machine. One clock-in→clock-out cycle is a *task*; breaks split it into *sessions*.
- **Per-clock-in hourly rate** — prompted each time you clock in (always blank, never prefilled). Earnings = hours × rate, summed across sessions.
- **Flexible views** — see your time by **Days** (with a Day / 3-day / 7-day / 14-day / 31-day total selector), a custom **Range** (up to 31 days), or **All** recorded days.
- **Per-session notes**, plus add/edit of past entries with validation (no overlapping sessions, end-after-start, etc.).
- **Export** — CSV (one row per session) or a full JSON backup, via native save dialogs.

## Data & privacy

Everything is stored locally in a single file:

```
%APPDATA%\timesheet\timesheet.json
```

Writes are atomic (temp file + rename) so a crash mid-save can't corrupt your data. Timestamps are stored in local-offset ISO format, which is DST-safe and stays readable in wall-clock time. Nothing is ever sent off the machine.

Security posture: the Electron renderer has no direct Node/filesystem access — it talks to the main process through a small, explicit `window.api` bridge (`contextIsolation: true`, `nodeIntegration: false`).

## Install

Grab the installer (`Timesheet Setup 1.0.0.exe`) from a build, or build it yourself (below). It's a one-click NSIS installer: double-click and it installs per-user to `%LOCALAPPDATA%\Programs\Timesheet`, adds Start-Menu and desktop shortcuts, and launches. Uninstall via Add/Remove Programs.

## Run from source

No reinstall needed to test changes:

```bash
npm install
npm start        # runs the live source as the real app
```

`npm start` uses the same `timesheet.json` as an installed copy, so data is shared. Only one instance runs at a time — close the installed copy first.

## Build an installer

```bash
npm install
npm run build    # generates the icon, then runs electron-builder --win
```

Outputs to `dist/`:
- `Timesheet Setup 1.0.0.exe` — the NSIS installer (~82 MB)
- `win-unpacked/Timesheet.exe` — the unpacked, runnable app

> **Build note:** electron-builder may fail extracting `winCodeSign` on Windows because that archive contains macOS symlinks. The fix is to enable Windows Developer Mode (grants symlink privilege), run from an elevated terminal, or use the cache workaround — all documented in [`HANDOFF.md`](HANDOFF.md) §9.

## Project layout

| Path | Role |
|---|---|
| `main.js` | Electron main process — window, single-instance lock, IPC, atomic JSON load/save, export dialogs |
| `preload.js` | `contextBridge` exposing `window.api` to the renderer |
| `src/index.html` · `src/renderer.js` · `src/styles.css` | The UI, all renderer logic, and the CRT/steel theme |
| `scripts/gen-icon.js` | Procedurally draws the app icon using only Node built-ins (no image libraries) |
| [`HANDOFF.md`](HANDOFF.md) | Full technical log — the *why* behind every decision |

For anything deeper — the data schema, the clock state machine, theming rules, build internals — see **[`HANDOFF.md`](HANDOFF.md)**, which is the engineering source of truth.

## Design constraint

The theme deliberately uses **no orange, yellow, or amber anywhere** — including break and warning states. Paused/standby uses a grey-green tone; true alerts use red. Keep it that way if you restyle.

## Credits

- **Creative Director:** Joshua ([@Fourier18](https://github.com/Fourier18)) — concept, the clock/break/rate behavior, the views and totals design, the CRT/steel aesthetic, and sign-off
- **Engineer:** Claude (Anthropic) — Electron app, persistence layer, UI and theme, procedural icon generator, and build setup

## License

MIT
