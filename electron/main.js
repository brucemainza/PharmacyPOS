import { app, BrowserWindow, ipcMain, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import { createSyncEngine } from '../sync-engine/index.js';
import { createHttpTransport } from '../sync-engine/httpTransport.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;
const PORT = 8001;
// Entity types the sync engine pulls remote changes for. Grows as Phase 3 features land
// (price-list updates, stock transfers, formulary updates, ...).
const SYNC_ENTITY_TYPES = ['products', 'categories'];

let mainWindow = null;
let stopServer = null;
let syncEngine = null;

function getUserDataPaths() {
  const root = path.join(app.getPath('userData'), 'POS');
  return {
    root,
    dbDir: path.join(root, 'backend', 'databases'),
    dbFile: path.join(root, 'backend', 'databases', 'pos.sqlite'),
    uploads: path.join(root, 'uploads'),
    localConfig: path.join(root, 'local-config.json'),
  };
}

function ensureDirs(paths) {
  fs.mkdirSync(paths.dbDir, { recursive: true });
  fs.mkdirSync(paths.uploads, { recursive: true });
}

function readLocalConfig(paths) {
  const defaults = {
    mode: 'Standalone Point of Sale',
    serverIp: '',
    till: 1,
    apiPort: PORT,
    cloudSyncUrl: 'http://127.0.0.1:8787',
  };
  try {
    if (fs.existsSync(paths.localConfig)) {
      return { ...defaults, ...JSON.parse(fs.readFileSync(paths.localConfig, 'utf8')) };
    }
  } catch {
    /* ignore */
  }
  return defaults;
}

function writeLocalConfig(paths, config) {
  ensureDirs(paths);
  fs.writeFileSync(paths.localConfig, JSON.stringify(config, null, 2));
}

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

function shouldStartServer(mode) {
  return (
    mode === 'Standalone Point of Sale' ||
    mode === 'Network Point of Sale Server'
  );
}

async function startApiServer(paths, mode) {
  if (!shouldStartServer(mode)) {
    return null;
  }

  const { createServer } = await import('../backend/index.js');
  const host = mode === 'Network Point of Sale Server' ? '0.0.0.0' : '127.0.0.1';
  const expressApp = await createServer({
    dbPath: paths.dbFile,
    uploadsPath: paths.uploads,
    jwtSecret: app.getPath('userData') + '-store-pos-jwt',
  });

  const httpServer = await new Promise((resolve, reject) => {
    const server = expressApp.listen(PORT, host, () => {
      console.log(`POS API listening on ${host}:${PORT}`);
      resolve(server);
    });
    server.on('error', reject);
  });

  return () =>
    new Promise((resolve) => {
      httpServer.close(() => resolve());
    });
}

// Only meaningful once a local db exists, i.e. the same modes that run a local API server
// (Standalone/Server) — a Network Terminal has no local db and relies on its LAN server.
async function startSyncEngine(mode, cloudSyncUrl) {
  if (!shouldStartServer(mode)) return null;

  const { getDb } = await import('../backend/db.js');
  const engine = createSyncEngine({
    db: getDb(),
    transport: createHttpTransport(cloudSyncUrl),
    entityTypes: SYNC_ENTITY_TYPES,
  });
  engine.start();
  return engine;
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const iconPath = fs.existsSync(path.join(__dirname, '..', 'build', 'icon.ico'))
    ? path.join(__dirname, '..', 'build', 'icon.ico')
    : path.join(__dirname, '..', 'public', 'favicon.ico');
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.maximize();
  mainWindow.show();

  if (isDev) {
    mainWindow.loadURL('http://127.0.0.1:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('get-paths', () => {
  const paths = getUserDataPaths();
  return {
    uploads: paths.uploads,
    userData: paths.root,
  };
});

ipcMain.handle('get-local-config', () => {
  const paths = getUserDataPaths();
  return readLocalConfig(paths);
});

ipcMain.handle('set-local-config', (_event, config) => {
  const paths = getUserDataPaths();
  const current = readLocalConfig(paths);
  const next = { ...current, ...config };
  writeLocalConfig(paths, next);
  return next;
});

ipcMain.handle('get-lan-ip', () => getLanIp());

ipcMain.handle('get-api-info', () => {
  const paths = getUserDataPaths();
  const config = readLocalConfig(paths);
  const isTerminal = config.mode === 'Network Point of Sale Terminal';
  const host = isTerminal ? config.serverIp || '127.0.0.1' : '127.0.0.1';
  return {
    baseUrl: `http://${host}:${config.apiPort || PORT}/api`,
    healthUrl: `http://${host}:${config.apiPort || PORT}/`,
    mode: config.mode,
    serverIp: config.serverIp,
    till: config.till,
    lanIp: getLanIp(),
    localServerRunning: shouldStartServer(config.mode),
  };
});

ipcMain.handle('get-sync-status', () => {
  if (!syncEngine) {
    return { enabled: false, online: false, syncing: false, pendingCount: 0, lastResult: null, lastError: null };
  }
  return { enabled: true, ...syncEngine.getStatus() };
});

ipcMain.on('app-quit', () => {
  app.quit();
});

ipcMain.on('app-reload', () => {
  if (mainWindow) mainWindow.reload();
});

app.whenReady().then(async () => {
  const paths = getUserDataPaths();
  ensureDirs(paths);
  const config = readLocalConfig(paths);
  writeLocalConfig(paths, config);

  try {
    stopServer = await startApiServer(paths, config.mode);
  } catch (err) {
    console.error('Failed to start API server', err);
  }

  try {
    syncEngine = await startSyncEngine(config.mode, config.cloudSyncUrl);
  } catch (err) {
    console.error('Failed to start sync engine', err);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', async () => {
  if (syncEngine) {
    syncEngine.stop();
    syncEngine = null;
  }
  if (stopServer) {
    await stopServer();
    stopServer = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  if (syncEngine) {
    syncEngine.stop();
    syncEngine = null;
  }
  if (stopServer) {
    await stopServer();
    stopServer = null;
  }
});
