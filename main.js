// main.js
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const axios = require('axios');
const AdmZip = require('adm-zip');

const { installVersionHandler, applyDownloads, runJarInstaller, cleanupTmp, launchMinecraftLauncher, listInstallersFromRepo } = require('./installer');
let updater = null;
try { updater = require('./updater'); } catch (e) { console.warn('[main] updater module not available:', e && e.message ? e.message : e); }

let mainWindow = null;

const isDev = (() => {
  try {
    if (process.env.ELECTRON_IS_DEV === '1') return true;
    if (process.env.NODE_ENV === 'development') return true;
    if (process.defaultApp) return true;
    if (typeof app !== 'undefined' && typeof app.isPackaged === 'boolean') return !app.isPackaged;
  } catch (e) {}
  return false;
})();

function defaultMinecraftPathForPlatform() {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Roaming', '.minecraft');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'minecraft');
  return path.join(home, '.minecraft');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1250, height: 720, minWidth: 1250, minHeight: 720, resizable: true,
    icon: path.join(__dirname, 'assets', 'multigameinc.png'),
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });

  const startUrl = process.env.ELECTRON_START_URL || `file://${path.join(__dirname, 'index.html')}`;
  if (process.env.ELECTRON_START_URL) mainWindow.loadURL(startUrl).catch(()=>mainWindow.loadFile('index.html'));
  else {
    if (fs.existsSync(path.join(__dirname, 'index.html'))) mainWindow.loadFile(path.join(__dirname, 'index.html'));
    else mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<h2>No se encontró index.html</h2>'));
  }

  if (isDev && process.env.ELECTRON_SHOW_DEVTOOLS === '1') mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ------------------------
   Utilities for version status
   ------------------------ */
function formatDateString(input) {
  try {
    if (!input) return null;
    const d = new Date(input);
    if (!isNaN(d.getTime())) {
      const dd = String(d.getDate()).padStart(2,'0');
      const mm = String(d.getMonth()+1).padStart(2,'0');
      const yyyy = d.getFullYear();
      return `${dd}/${mm}/${yyyy}`;
    }
    const m = String(input).match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    return String(input);
  } catch (e) { return String(input); }
}

async function getLauncherVersionInfo() {
  const appRoot = __dirname;
  const userDataPath = app.getPath('userData');
  let localVersion = null;
  try {
    if (updater && typeof updater.getLocalVersion === 'function') localVersion = await updater.getLocalVersion(appRoot, userDataPath);
  } catch (e) { console.warn('[main] updater.getLocalVersion error', e && e.message ? e.message : e); }
  if (!localVersion) {
    try {
      const p = path.join(__dirname, 'app_version.json');
      if (await fs.pathExists(p)) {
        const j = await fs.readJson(p);
        localVersion = j && j.version ? String(j.version) : null;
      }
    } catch(e) { console.warn('[main] read app_version.json failed', e && e.message ? e.message : e); }
  }
  if (!localVersion) localVersion = '0.0.0';

  let remoteVersion = null, remoteDate = null;
  try {
    const remoteUrl = 'https://raw.githubusercontent.com/Pimpoli/MultiGameInc-Launcher/main/launcher-version.json';
    const r = await axios.get(remoteUrl, { responseType: 'json', timeout: 6000, validateStatus: null });
    if (r && r.status === 200 && r.data) {
      if (r.data.version) remoteVersion = String(r.data.version);
      if (r.data.date) remoteDate = String(r.data.date);
      if (!remoteDate && r.data.published_at) remoteDate = String(r.data.published_at);
    }
  } catch (e) { /* ignore */ }

  if (!remoteVersion && updater && typeof updater.checkForUpdates === 'function') {
    try {
      const chk = await updater.checkForUpdates({ appRoot, userDataPath, logger: console });
      if (chk && chk.remoteVersion) remoteVersion = String(chk.remoteVersion);
      if (chk && chk.remoteDate) remoteDate = String(chk.remoteDate);
    } catch (e) {}
  }

  let showDate = null;
  if (remoteDate) showDate = formatDateString(remoteDate);
  else {
    try {
      const p = path.join(__dirname, 'app_version.json');
      if (await fs.pathExists(p)) {
        const st = await fs.stat(p);
        if (st && st.mtime) showDate = formatDateString(st.mtime.toISOString());
      }
    } catch (e) {}
  }
  if (!showDate) showDate = formatDateString(new Date().toISOString());

  // compare semver (naive)
  let isOutdated = false;
  if (remoteVersion) {
    const parse = s => String(s).split('.').map(n => parseInt(n,10) || 0);
    const ra = parse(remoteVersion), la = parse(localVersion);
    for (let i=0;i<Math.max(ra.length,la.length);i++) {
      const rn = ra[i]||0, ln = la[i]||0;
      if (rn > ln) { isOutdated = true; break; }
      if (rn < ln) { isOutdated = false; break; }
    }
  }

  return { localVersion, remoteVersion, date: showDate, isOutdated };
}

/* ------------------------
   IPC: expose version info and auto-update trigger
   ------------------------ */
ipcMain.handle('get-launcher-version', async () => {
  return await getLauncherVersionInfo();
});

/**
 * trigger-auto-update:
 * - intenta descargar zip/extraer (le pide al updater.checkForUpdates)
 * - si updater devolvió tmpExtractDir, lo aplica
 * - si updater devolvió releaseZipUrl pero no descargó, el main lo intentará manualmente como fallback
 * - envía eventos 'auto-update-progress' a renderer con { stage, msg, percent }
 */
ipcMain.handle('trigger-auto-update', async () => {
  const sendProgress = (obj) => {
    try { if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('auto-update-progress', obj); } catch(e){}
  };

  const appRoot = __dirname;
  const userDataPath = app.getPath('userData');

  sendProgress({ stage: 'checking', msg: 'Comprobando actualización...' });
  try {
    if (!updater || typeof updater.checkForUpdates !== 'function') {
      sendProgress({ stage: 'no_updater', msg: 'Módulo updater no disponible', percent: 0 });
      return { ok: false, error: 'updater_unavailable' };
    }

    const check = await updater.checkForUpdates({ appRoot, userDataPath, logger: console });
    if (!check || !check.updateAvailable) {
      sendProgress({ stage: 'uptodate', msg: 'No hay actualización disponible', percent: 100 });
      return { ok: true, applied: false, reason: 'no_update' };
    }

    sendProgress({ stage: 'update_found', msg: `Actualización detectada: ${check.remoteVersion}`, percent: 0 });

    // if updater already extracted tmpExtractDir, apply it
    if (check.tmpExtractDir) {
      sendProgress({ stage: 'applying', msg: 'Aplicando actualización descargada...', percent: 10 });
      try {
        const applyRes = await updater.applyUpdate(check.tmpExtractDir, appRoot, { remoteVersion: check.remoteVersion, removeObsolete: true, logger: console });
        if (applyRes && applyRes.ok) {
          sendProgress({ stage: 'applied', msg: 'Actualización aplicada. Relanzando...', percent: 100 });
          // relaunch
          setTimeout(()=> { app.relaunch(); app.exit(0); }, 600);
          return { ok: true, applied: true };
        } else {
          sendProgress({ stage: 'apply_failed', msg: 'Error aplicando actualización automáticamente', percent: 0 });
          return { ok: false, error: applyRes && applyRes.error ? applyRes.error : 'apply_failed' };
        }
      } catch (e) {
        sendProgress({ stage: 'apply_exception', msg: `Error aplicando actualización: ${e && e.message ? e.message : e}`, percent: 0 });
        return { ok: false, error: e && e.message ? e.message : e };
      }
    }

    // fallback: if check.releaseZipUrl exists, attempt manual download+extract here
    if (check.releaseZipUrl) {
      sendProgress({ stage: 'download_zip', msg: 'Descargando paquete de actualización (fallback)...', percent: 5 });
      try {
        const tmpBase = path.join(os.tmpdir(), `mg_launcher_update_${Date.now()}`);
        await fs.mkdirp(tmpBase);
        const tmpZipPath = path.join(tmpBase, `release_${Date.now()}.zip`);
        const dl = await axios.get(check.releaseZipUrl, { responseType: 'arraybuffer', validateStatus: null, maxContentLength: Infinity, maxBodyLength: Infinity, timeout: 120000 });
        if (dl.status !== 200) {
          sendProgress({ stage: 'zip_download_failed', msg: `Error descargando zip: HTTP ${dl.status}`, percent: 0 });
          return { ok: false, error: `zip_http_${dl.status}` };
        }
        await fs.writeFile(tmpZipPath, Buffer.from(dl.data));
        sendProgress({ stage: 'zip_saved', msg: 'Zip guardado localmente, extrayendo...', percent: 30 });

        const extractDir = path.join(tmpBase, 'extracted');
        await fs.mkdirp(extractDir);
        try {
          const zip = new AdmZip(tmpZipPath);
          zip.extractAllTo(extractDir, true);
        } catch (e) {
          sendProgress({ stage: 'zip_extract_failed', msg: `Fallo extrayendo zip: ${e && e.message ? e.message : e}`, percent: 0 });
          return { ok: false, error: 'zip_extract_failed' };
        }

        // Normalizar carpeta raíz si es owner-repo-branch inside zip
        const entries = await fs.readdir(extractDir);
        if (entries.length === 1) {
          const maybeRoot = path.join(extractDir, entries[0]);
          if ((await fs.stat(maybeRoot)).isDirectory()) {
            const tmpReal = path.join(tmpBase, 'extracted_root');
            await fs.mkdirp(tmpReal);
            await fs.copy(maybeRoot, tmpReal);
            await fs.remove(extractDir);
            await fs.move(tmpReal, extractDir);
          }
        }

        // aplicar update
        sendProgress({ stage: 'applying', msg: 'Aplicando actualización (fallback)...', percent: 70 });
        const applyRes = await updater.applyUpdate(extractDir, appRoot, { remoteVersion: check.remoteVersion, removeObsolete: true, logger: console });
        if (applyRes && applyRes.ok) {
          sendProgress({ stage: 'applied', msg: 'Actualización aplicada. Relanzando...', percent: 100 });
          setTimeout(()=> { app.relaunch(); app.exit(0); }, 600);
          return { ok: true, applied: true };
        } else {
          sendProgress({ stage: 'apply_failed', msg: 'No se pudo aplicar actualización (fallback)', percent: 0 });
          return { ok: false, error: applyRes && applyRes.error ? applyRes.error : 'apply_failed' };
        }
      } catch (e) {
        sendProgress({ stage: 'fallback_failed', msg: `Fallback failed: ${e && e.message ? e.message : e}`, percent: 0 });
        return { ok: false, error: e && e.message ? e.message : e };
      }
    }

    // nothing to do
    sendProgress({ stage: 'no_zip', msg: 'No se encontró paquete descargable automáticamente.', percent: 0 });
    return { ok: false, error: 'no_zip' };

  } catch (err) {
    sendProgress({ stage: 'error', msg: `Error en updater: ${err && err.message ? err.message : err}`, percent: 0 });
    return { ok: false, error: err && err.message ? err.message : err };
  }
});

/* ---------------------------
   Otros IPCs y handlers existentes
   --------------------------- */
ipcMain.handle('select-install-path', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (res.canceled) return null;
  return res.filePaths[0];
});

ipcMain.handle('get-default-minecraft-path', async () => defaultMinecraftPathForPlatform());

ipcMain.handle('list-installers', async (ev, manifestUrl) => {
  try {
    const items = await listInstallersFromRepo(manifestUrl, null);
    return { ok: true, items };
  } catch (err) {
    console.error('list-installers error:', err);
    return { ok: false, error: err.message || String(err), items: [] };
  }
});

ipcMain.handle('install-version', async (ev, payload) => {
  try {
    const progressSender = (progressObj) => {
      try { if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('install-progress', progressObj); } catch(e){}
    };
    const downloadRes = await installVersionHandler(payload, progressSender);
    if (downloadRes.status === 'missing_critical') {
      const missing = downloadRes.missingCritical || [];
      const choice = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Continuar sin esos archivos', 'Cancelar instalación'],
        defaultId: 0, cancelId: 1,
        message: `Faltan archivos críticos: ${missing.join(', ')}. ¿Deseas continuar instalando lo que se logró descargar? (Se instalará lo descargado)`
      });
      if (choice.response === 1) { await cleanupTmp(downloadRes.tmpDir).catch(()=>{}); return { ok: false, error: 'Instalación cancelada por usuario (faltan archivos críticos).' }; }
      const applyRes = await applyDownloads(downloadRes.tmpDir, payload.installPath);
      if (applyRes.installerPath && payload.askInstallLoader) {
        const ask = await dialog.showMessageBox({ type:'question', buttons:['Sí, instalar loader','No, omitir'], defaultId:0, cancelId:1, message:'Se detectó un instalador del mod loader. ¿Quieres ejecutar el instalador ahora?'});
        if (ask.response === 0) {
          const execResult = await runJarInstaller(applyRes.installerPath, payload.installPath, applyRes.installerArgs || []);
          if (payload.runAfterInstall) await tryLaunchTLauncherOrFallback(payload.installPath).catch(()=>{});
          return { ok: true, installedLoader: true, execResult, backupDir: applyRes.backupDir || null, missingInstallers: applyRes.missingInstallers || [] };
        }
      }
      if (payload.runAfterInstall) await tryLaunchTLauncherOrFallback(payload.installPath).catch(()=>{});
      return { ok: true, installedLoader: false, backupDir: applyRes.backupDir || null, missingInstallers: applyRes.missingInstallers || [] };
    }

    if (downloadRes.backupDir !== undefined) {
      const res = downloadRes;
      if (res.installerPath && payload.askInstallLoader) {
        const ask = await dialog.showMessageBox({ type:'question', buttons:['Sí, instalar loader','No, omitir'], defaultId:0, cancelId:1, message:'Se detectó un instalador del mod loader. ¿Quieres ejecutar el instalador ahora?'});
        if (ask.response === 0) {
          const execResult = await runJarInstaller(res.installerPath, payload.installPath, res.installerArgs || []);
          if (payload.runAfterInstall) await tryLaunchTLauncherOrFallback(payload.installPath).catch(()=>{});
          return { ok: true, installedLoader: true, execResult, backupDir: res.backupDir || null, missingInstallers: res.missingInstallers || [] };
        }
      }
      if (payload.runAfterInstall) await tryLaunchTLauncherOrFallback(payload.installPath).catch(()=>{});
      return { ok: true, installedLoader: false, backupDir: res.backupDir || null, missingInstallers: res.missingInstallers || [] };
    }

    return { ok: true, installedLoader: false, backupDir: null, missingInstallers: downloadRes.missingInstallers || [] };
  } catch (err) {
    console.error('install-version error:', err);
    return { ok: false, error: err.message || String(err) };
  }
});

/* Updater check wrapper for legacy usage (ipcMain 'check-for-updates' exists) */
ipcMain.handle('check-for-updates', async () => {
  if (!updater || typeof updater.checkForUpdates !== 'function') return { ok: false, error: 'updater_unavailable' };
  const userDataPath = app.getPath('userData');
  const appRoot = __dirname;
  const res = await updater.checkForUpdates({ appRoot, userDataPath, logger: console });
  return { ok: true, result: res };
});

/* App lifecycle */
app.whenReady().then(async () => {
  try {
    createWindow();

    // cuando la ventana haya cargado, enviar inmediatamente la info de versión
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const info = await getLauncherVersionInfo();
        mainWindow.webContents.send('launcher-version-info', info);
        // lanzar intento automático de actualización (no bloqueante)
        try {
          // fire and forget, renderer recibirá progresos via 'auto-update-progress'
          const p = await ipcMain.handle ? null : null; // no-op (compat placeholder)
        } catch(e){}
        // ahora solicitamos que el main ejecute el trigger (no bloqueante)
        (async () => {
          try {
            // llamar internamente la función que ya implementamos via IPC:
            const res = await ipcMain.invoke ? null : null;
          } catch(e){}
          // en vez de invocar por IPC desde main, simplemente llamamos la misma lógica:
          try {
            // llama al handler trigger-auto-update manualmente
            const result = await (async () => { return await require('electron').ipcMain ? null : null; })();
          } catch(e){}
          // para evitar complejidad, delegamos: pedimos a renderer que dispare triggerAutoUpdate.
          // renderer al recibir launcher-version-info hará window.api.triggerAutoUpdate() automáticamente.
        })();
      } catch(e) { console.warn('[main] failed send launcher-version-info', e && e.message ? e.message : e); }
    });

    autoUpdater.checkForUpdatesAndNotify();

    // mantener comportamiento previo: check de actualizaciones más detallado (no necesario duplicar)
    if (updater && typeof updater.checkForUpdates === 'function') {
      (async () => {
        try {
          const userDataPath = app.getPath('userData');
          const appRoot = __dirname;
          // no abrimos diálogos automáticos aquí: el flow automático se maneja por trigger-auto-update
          await updater.checkForUpdates({ appRoot, userDataPath, logger: console }).catch(()=>{});
        } catch (err) {
          console.warn('[main] background checkForUpdates error', err && err.message ? err.message : err);
        }
      })();
    }
  } catch (e) {
    console.error('app.whenReady error', e);
    try { createWindow(); } catch (e2) { console.error('createWindow fallback failed', e2); }
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (mainWindow === null) createWindow(); });
