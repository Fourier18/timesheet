const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const DATA_FILE = path.join(app.getPath('userData'), 'timesheet.json');
const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
const DEFAULT_DATA = { version: 2, activeTask: null, sessions: [] };

// ---- atomic JSON read/write -------------------------------------------------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// temp-file + rename so a crash mid-write can never corrupt the real file
function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---- window state -----------------------------------------------------------

function loadWindowState() {
  const s = readJson(WINDOW_STATE_FILE, null);
  if (s && Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  return { width: 980, height: 720 };
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  writeJsonAtomic(WINDOW_STATE_FILE, b);
}

// ---- single instance lock ---------------------------------------------------

let mainWindow = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(createWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function createWindow() {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 720,
    minHeight: 520,
    title: 'Timesheet',
    backgroundColor: '#1e1f26',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  let saveTimer = null;
  const queueStateSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(mainWindow), 300);
  };
  mainWindow.on('resize', queueStateSave);
  mainWindow.on('move', queueStateSave);
  mainWindow.on('close', () => saveWindowState(mainWindow));
}

// ---- IPC --------------------------------------------------------------------

ipcMain.handle('data:load', () => readJson(DATA_FILE, DEFAULT_DATA));

ipcMain.handle('data:save', (_evt, data) => {
  writeJsonAtomic(DATA_FILE, data);
  return { ok: true };
});

ipcMain.handle('export:csv', async (_evt, csv, defaultName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export timesheet to CSV',
    defaultPath: defaultName || 'timesheet.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  fs.writeFileSync(filePath, csv, 'utf8');
  return { ok: true, filePath };
});

ipcMain.handle('backup:json', async (_evt, json, defaultName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Back up timesheet data',
    defaultPath: defaultName || 'timesheet-backup.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  fs.writeFileSync(filePath, json, 'utf8');
  return { ok: true, filePath };
});

ipcMain.handle('app:dataPath', () => DATA_FILE);
