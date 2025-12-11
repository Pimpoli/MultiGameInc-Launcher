// main.js
/* Main process for Multi Game Inc Launcher
   - Eliminada dependencia externa 'electron-is-dev' para evitar empaquetado accidental.
*/

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const { installVersionHandler, applyDownloads, runJarInstaller, cleanupTmp, launchMinecraftLauncher, listInstallersFromRepo } = require('./installer');
const { spawn } = require('child_process');

// Updater module (archivo updater.js junto a main.js)
let updater = null;
try {
  updater = require('./updater');
} catch (e) {
  console.warn('[main] updater module not available:', e && e.message ? e.message : e);
}

let mainWindow = null;

// Local isDev detection (no depende de paquete externo)
const isDev = (() => {
  try {
    if (process.env.ELECTRON_IS_DEV === '1') return true;
    if (process.env.NODE_ENV === 'development') return true;
    if (process.defaultApp) return true;
    if (typeof app !== 'undefined' && typeof app.isPackaged === 'boolean') {
      return !app.isPackaged;
    }
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
    width: 1250,
    height: 720,
    minWidth: 1250,
    minHeight: 720,
    resizable: true,
    // usar assets des-empaquetados / extraResources
    icon: path.join(__dirname, 'assets', 'multigameinc.png'),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  const startUrl = process.env.ELECTRON_START_URL || `file://${path.join(__dirname, 'index.html')}`;
  if (process.env.ELECTRON_START_URL) {
    mainWindow.loadURL(startUrl).catch(() => mainWindow.loadFile('index.html'));
  } else {
    if (fs.existsSync(path.join(__dirname, 'index.html'))) mainWindow.loadFile(path.join(__dirname, 'index.html'));
    else mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<h2>No se encontró index.html</h2>'));
  }

  if (isDev && process.env.ELECTRON_SHOW_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

/* IPC handlers */
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

async function tryLaunchTLauncherOrFallback(installPath) {
  const home = os.homedir();
  const candidates = [];

  if (process.platform === 'win32') {
    candidates.push(path.join(process.env['ProgramFiles'] || 'C:\\Program Files','TLauncher','TLauncher.exe'));
    candidates.push(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)','TLauncher','TLauncher.exe'));
    candidates.push(path.join(home,'AppData','Roaming','.tlauncher','TLauncher.exe'));
    candidates.push(path.join('C:\\','TLauncher','TLauncher.exe'));
    candidates.push(path.join(home,'TLauncher.exe'));
    candidates.push(path.join(process.env['ProgramFiles'] || 'C:\\Program Files','Minecraft Launcher','MinecraftLauncher.exe'));
    candidates.push(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)','Minecraft Launcher','MinecraftLauncher.exe'));
    candidates.push(path.join(process.env['ProgramFiles'] || 'C:\\Program Files','Minecraft Launcher','launcher.exe'));
    candidates.push(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)','Mojang','MinecraftLauncher.exe'));
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/TLauncher.app');
    candidates.push(path.join(home,'Applications','TLauncher.app'));
    candidates.push('/Applications/Minecraft.app');
    candidates.push(path.join(home,'Applications','Minecraft.app'));
  } else {
    candidates.push(path.join(home,'.tlauncher','TLauncher'));
    candidates.push('/usr/bin/tlauncher');
    candidates.push('/usr/local/bin/tlauncher');
    candidates.push('/usr/bin/minecraft-launcher');
    candidates.push('/usr/local/bin/minecraft-launcher');
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        try {
          if (process.platform === 'darwin') spawn('open', ['-a', c], { detached: true, stdio: 'ignore' }).unref();
          else spawn(c, [], { detached: true, stdio: 'ignore' }).unref();
          return true;
        } catch (e) {
          console.warn('[main] could not spawn candidate', c, e && e.message ? e.message : e);
        }
      }
    } catch (e) {
      console.warn('[main] check candidate failed', c, e && e.message ? e.message : e);
    }
  }

  try {
    await launchMinecraftLauncher().catch(()=>{});
    return false;
  } catch (e) {
    console.warn('[main] fallback protocol failed', e && e.message ? e.message : e);
    return false;
  }
}

ipcMain.handle('install-version', async (ev, payload) => {
  try {
    const progressSender = (progressObj) => {
      try {
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('install-progress', progressObj);
      } catch (e) { console.warn('[main] progressSender failed', e && e.message ? e.message : e); }
    };

    const downloadRes = await installVersionHandler(payload, progressSender);

    if (downloadRes.status === 'missing_critical') {
      const missing = downloadRes.missingCritical || [];
      const choice = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Continuar sin esos archivos', 'Cancelar instalación'],
        defaultId: 0,
        cancelId: 1,
        message: `Faltan archivos críticos: ${missing.join(', ')}. ¿Deseas continuar instalando lo que se logró descargar? (Se instalará lo descargado)`
      });
      if (choice.response === 1) {
        await cleanupTmp(downloadRes.tmpDir).catch(()=>{});
        return { ok: false, error: 'Instalación cancelada por usuario (faltan archivos críticos).' };
      }
      const applyRes = await applyDownloads(downloadRes.tmpDir, payload.installPath);
      if (applyRes.installerPath && payload.askInstallLoader) {
        const ask = await dialog.showMessageBox({
          type: 'question',
          buttons: ['Sí, instalar loader', 'No, omitir'],
          defaultId: 0,
          cancelId: 1,
          message: 'Se detectó un instalador del mod loader. ¿Quieres ejecutar el instalador ahora?'
        });
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
        const ask = await dialog.showMessageBox({
          type: 'question',
          buttons: ['Sí, instalar loader', 'No, omitir'],
          defaultId: 0,
          cancelId: 1,
          message: 'Se detectó un instalador del mod loader. ¿Quieres ejecutar el instalador ahora?'
        });
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

/* Updater check */
ipcMain.handle('check-for-updates', async () => {
  if (!updater || typeof updater.checkForUpdates !== 'function') return { ok: false, error: 'updater_unavailable' };
  const userDataPath = app.getPath('userData');
  const appRoot = __dirname;
  const res = await updater.checkForUpdates({ appRoot, userDataPath, logger: console });
  return { ok: true, result: res };
});

app.whenReady().then(async () => {
  try {
    createWindow();
    autoUpdater.checkForUpdatesAndNotify();

    if (updater && typeof updater.checkForUpdates === 'function') {
      (async () => {
        try {
          const userDataPath = app.getPath('userData');
          const appRoot = __dirname;
          const check = await updater.checkForUpdates({ appRoot, userDataPath, logger: console });
          if (check && check.updateAvailable) {
            if (check.reason && ['no_zip','zip_download_failed','zip_extract_failed'].includes(check.reason)) {
              dialog.showMessageBox({
                type: 'info',
                title: 'Actualización disponible',
                message: `Hay una nueva versión disponible (${check.remoteVersion}). No fue posible descargar el paquete automáticamente. Puedes visitar el repositorio para descargarlo manualmente.`,
                buttons: ['Abrir repo', 'Cerrar']
              }).then(res => { if (res.response === 0) shell.openExternal('https://github.com/Pimpoli/MultiGameInc-Launcher'); });
              return;
            }

            if (check && check.tmpExtractDir) {
              const ans = await dialog.showMessageBox({
                type: 'question',
                title: 'Actualizar launcher',
                message: `Se detectó una actualización del launcher: ${check.remoteVersion} (tienes ${check.localVersion || 'desconocida'}). ¿Deseas aplicar la actualización ahora? (se sobrescribirán archivos del launcher)`,
                buttons: ['Sí, actualizar ahora', 'No, más tarde']
              });
              if (ans.response === 0) {
                const targetDir = __dirname;
                try {
                  const testPath = path.join(targetDir, `.updater_test_${Date.now()}`);
                  await fs.outputFile(testPath, 'test').catch(()=>{ throw new Error('no_write'); });
                  await fs.remove(testPath).catch(()=>{});
                  const applyRes = await updater.applyUpdate(check.tmpExtractDir, targetDir, { remoteVersion: check.remoteVersion });
                  if (applyRes && applyRes.ok) {
                    await dialog.showMessageBox({
                      type: 'info',
                      title: 'Actualización aplicada',
                      message: `Actualización ${check.remoteVersion} aplicada correctamente. Se relanzará el launcher ahora.`,
                      buttons: ['Aceptar']
                    });
                    app.relaunch();
                    app.exit(0);
                  } else throw applyRes && applyRes.error ? applyRes.error : new Error('apply_failed');
                } catch (e) {
                  console.warn('[main] apply update failed:', e && e.message ? e.message : e);
                  dialog.showMessageBox({
                    type: 'error',
                    title: 'No fue posible actualizar automáticamente',
                    message: 'No se pudo aplicar la actualización automáticamente (problema de permisos o empaquetado). Se abrirá el repositorio para descargar la actualización manualmente.',
                    buttons: ['Abrir repo', 'Cerrar']
                  }).then(r=>{ if (r.response === 0) shell.openExternal('https://github.com/Pimpoli/MultiGameInc-Launcher'); });
                }
              }
            } else {
              dialog.showMessageBox({
                type: 'info',
                title: 'Actualización disponible',
                message: `Hay una nueva versión disponible (${check.remoteVersion}). Visita el repositorio para actualizar.`,
                buttons: ['Abrir repo', 'Cerrar']
              }).then(r=>{ if (r.response === 0) shell.openExternal('https://github.com/Pimpoli/MultiGameInc-Launcher'); });
            }
          }
        } catch (err) {
          console.warn('[main] checkForUpdates error', err && err.message ? err.message : err);
        }
      })();
    }
  } catch (e) {
    console.error('app.whenReady error', e);
    try { createWindow(); } catch (e2) { console.error('createWindow fallback failed', e2); }
  }
});
