// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const isDev = require('electron-is-dev');
const fs = require('fs');
const os = require('os');
const { installVersionHandler, applyDownloads, runJarInstaller, cleanupTmp, launchMinecraftLauncher, listInstallersFromRepo } = require('./installer');
const { spawn } = require('child_process');

let mainWindow = null; // <- expose globally for progress events

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
    mainWindow.loadURL(startUrl).catch(()=>mainWindow.loadFile('index.html'));
  } else {
    if (fs.existsSync(path.join(__dirname, 'index.html'))) mainWindow.loadFile(path.join(__dirname, 'index.html'));
    else mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<h2>No se encontró index.html</h2>'));
  }

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(createWindow);

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

/**
 * Try to find a TLauncher executable in common locations and run it.
 * If not found, try to find the Official Minecraft Launcher executable (common paths).
 * Final fallback: open minecraft:// protocol.
 */
async function tryLaunchTLauncherOrFallback(installPath) {
  const home = os.homedir();
  const candidates = [];

  if (process.platform === 'win32') {
    // TLauncher common locations
    candidates.push(path.join(process.env['ProgramFiles'] || 'C:\\Program Files','TLauncher','TLauncher.exe'));
    candidates.push(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)','TLauncher','TLauncher.exe'));
    candidates.push(path.join(home,'AppData','Roaming','.tlauncher','TLauncher.exe'));
    candidates.push(path.join('C:\\','TLauncher','TLauncher.exe'));
    candidates.push(path.join(home,'TLauncher.exe'));

    // Official Minecraft Launcher common locations (try before using protocol to avoid Bedrock fallback)
    candidates.push(path.join(process.env['ProgramFiles'] || 'C:\\Program Files','Minecraft Launcher','MinecraftLauncher.exe'));
    candidates.push(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)','Minecraft Launcher','MinecraftLauncher.exe'));
    candidates.push(path.join(process.env['ProgramFiles'] || 'C:\\Program Files','Minecraft Launcher','launcher.exe'));
    // older Mojang paths
    candidates.push(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)','Mojang','MinecraftLauncher.exe'));
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/TLauncher.app');
    candidates.push(path.join(home,'Applications','TLauncher.app'));
    // official launcher
    candidates.push('/Applications/Minecraft.app');
    candidates.push(path.join(home,'Applications','Minecraft.app'));
  } else {
    // linux
    candidates.push(path.join(home,'.tlauncher','TLauncher'));
    candidates.push('/usr/bin/tlauncher');
    candidates.push('/usr/local/bin/tlauncher');
    // official
    candidates.push('/usr/bin/minecraft-launcher');
    candidates.push('/usr/local/bin/minecraft-launcher');
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        console.log('[main] Found launcher candidate at', c);
        try {
          if (process.platform === 'darwin') {
            spawn('open', ['-a', c], { detached: true, stdio: 'ignore' }).unref();
          } else {
            spawn(c, [], { detached: true, stdio: 'ignore' }).unref();
          }
          return true;
        } catch (e) {
          console.warn('[main] could not spawn candidate', c, e.message || e);
        }
      }
    } catch (e) {
      console.warn('[main] check candidate failed', c, e.message || e);
    }
  }

  // fallback: try protocol
  try {
    console.log('[main] No launcher found in common paths, opening protocol minecraft:// as fallback');
    await launchMinecraftLauncher().catch(()=>{});
    return false;
  } catch (e) {
    console.warn('[main] fallback protocol failed', e.message || e);
    return false;
  }
}

/**
 * Flujo principal:
 * Ahora PASAMOS una función progressSender a installVersionHandler para que emita eventos.
 */
ipcMain.handle('install-version', async (ev, payload) => {
  try {
    // progressSender envía eventos a la ventana principal
    const progressSender = (progressObj) => {
      try {
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('install-progress', progressObj);
        }
      } catch (e) {
        console.warn('[main] progressSender failed', e && e.message ? e.message : e);
      }
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
          if (payload.runAfterInstall) {
            await tryLaunchTLauncherOrFallback(payload.installPath).catch(()=>{});
          }
          return { ok: true, installedLoader: true, execResult, backupDir: applyRes.backupDir || null, missingInstallers: applyRes.missingInstallers || [] };
        }
      }
      if (payload.runAfterInstall) {
        await tryLaunchTLauncherOrFallback(payload.installPath).catch(()=>{});
      }
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
          if (payload.runAfterInstall) {
            await tryLaunchTLauncherOrFallback(payload.installPath).catch(()=>{});
          }
          return { ok: true, installedLoader: true, execResult, backupDir: res.backupDir || null, missingInstallers: res.missingInstallers || [] };
        }
      }
      if (payload.runAfterInstall) {
        await tryLaunchTLauncherOrFallback(payload.installPath).catch(()=>{});
      }
      return { ok: true, installedLoader: false, backupDir: res.backupDir || null, missingInstallers: res.missingInstallers || [] };
    }

    return { ok: true, installedLoader: false, backupDir: null, missingInstallers: downloadRes.missingInstallers || [] };
  } catch (err) {
    console.error('install-version error:', err);
    return { ok: false, error: err.message || String(err) };
  }
});
