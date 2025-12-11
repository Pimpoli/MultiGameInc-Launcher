// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectInstallPath: () => ipcRenderer.invoke('select-install-path'),
  installVersion: (payload) => ipcRenderer.invoke('install-version', payload),
  getDefaultMinecraftPath: () => ipcRenderer.invoke('get-default-minecraft-path'),
  listInstallers: (manifestUrl) => ipcRenderer.invoke('list-installers', manifestUrl),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),

  // new: get launcher version info (local+remote+date)
  getLauncherVersion: () => ipcRenderer.invoke('get-launcher-version'),

  // new: trigger automatic update flow in main
  triggerAutoUpdate: () => ipcRenderer.invoke('trigger-auto-update'),

  onInstallProgress: (cb) => {
    if (typeof cb !== 'function') return { off: () => {} };
    const listener = (ev, payload) => { try { cb(payload); } catch (e) { console.warn('onInstallProgress callback error', e); } };
    ipcRenderer.on('install-progress', listener);
    return { off: () => { try { ipcRenderer.removeListener('install-progress', listener); } catch(e){} } };
  },

  // new: auto update progress
  onAutoUpdateProgress: (cb) => {
    if (typeof cb !== 'function') return { off: () => {} };
    const listener = (ev, payload) => { try { cb(payload); } catch (e) { console.warn('onAutoUpdateProgress error', e); } };
    ipcRenderer.on('auto-update-progress', listener);
    return { off: () => { try { ipcRenderer.removeListener('auto-update-progress', listener); } catch(e){} } };
  }
});
