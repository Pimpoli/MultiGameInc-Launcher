// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectInstallPath: () => ipcRenderer.invoke('select-install-path'),
  installVersion: (payload) => ipcRenderer.invoke('install-version', payload),
  getDefaultMinecraftPath: () => ipcRenderer.invoke('get-default-minecraft-path'),
  listInstallers: (manifestUrl) => ipcRenderer.invoke('list-installers', manifestUrl),

  // Permite que el renderer se suscriba a eventos de progreso enviados desde main
  // Uso en renderer: const sub = window.api.onInstallProgress(cb);
  // sub.off() para desuscribir.
  onInstallProgress: (cb) => {
    if (typeof cb !== 'function') return { off: () => {} };
    const listener = (ev, payload) => {
      try { cb(payload); } catch (e) { console.warn('onInstallProgress callback error', e); }
    };
    ipcRenderer.on('install-progress', listener);
    return {
      off: () => {
        try { ipcRenderer.removeListener('install-progress', listener); } catch(e) {}
      }
    };
  }
});
