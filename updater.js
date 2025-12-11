// updater.js
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');

const REMOTE_BASE_RAW = 'https://raw.githubusercontent.com/Pimpoli/MultiGameInc-Launcher/main';
const REMOTE_VERSION_URL = `${REMOTE_BASE_RAW}/launcher-version.json`;

/**
 * compareSemver(a,b)
 * retorna 1 si a>b, 0 si igual, -1 si a<b
 */
function compareSemver(a, b) {
  if (!a || !b) return 0;
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * getLocalVersion(appRoot, userDataPath)
 * - intenta leer app_version.json en la raíz del app (appRoot)
 * - si no existe, intenta userData/launcher-version.json
 */
async function getLocalVersion(appRoot, userDataPath) {
  try {
    const p1 = path.join(appRoot, 'app_version.json');
    if (await fs.pathExists(p1)) {
      const j = await fs.readJson(p1);
      return (j && j.version) ? j.version : null;
    }
    const p2 = path.join(userDataPath, 'launcher-version.json');
    if (await fs.pathExists(p2)) {
      const j = await fs.readJson(p2);
      return (j && j.version) ? j.version : null;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

/**
 * checkForUpdates(options)
 * - options: { appRoot, userDataPath, logger } 
 * - retorna { updateAvailable, remoteVersion, localVersion, releaseZipUrl, tmpZipPath, tmpExtractDir } 
 */
async function checkForUpdates(opts = {}) {
  const { appRoot = __dirname, userDataPath = path.join(os.homedir(), '.multi-game-inc-launcher'), logger = console } = opts;

  try {
    const localVersion = await getLocalVersion(appRoot, userDataPath);
    logger.log('[updater] localVersion=', localVersion);

    const res = await axios.get(REMOTE_VERSION_URL, { responseType: 'json', validateStatus: null });
    if (res.status !== 200) {
      logger.warn('[updater] no se pudo obtener launcher-version.json, status', res.status);
      return { updateAvailable: false, reason: 'no_remote' };
    }
    const remote = res.data;
    if (!remote || !remote.version) {
      logger.warn('[updater] launcher-version.json no tiene version');
      return { updateAvailable: false, reason: 'no_remote_version' };
    }
    const remoteVersion = remote.version;
    const releaseZip = remote.release_zip; // ejemplo: releases/launcher-1.0.1.zip
    logger.log('[updater] remoteVersion=', remoteVersion, ' release_zip=', releaseZip);

    const cmp = compareSemver(remoteVersion, localVersion || '0.0.0');
    if (cmp <= 0) return { updateAvailable: false, remoteVersion, localVersion };

    if (!releaseZip) return { updateAvailable: true, remoteVersion, localVersion, reason: 'no_zip' };

    // download zip from raw github path
    const zipUrl = `${REMOTE_BASE_RAW}/${releaseZip.replace(/^\/+/,'')}`;
    logger.log('[updater] will download zip from', zipUrl);

    const tmpBase = path.join(os.tmpdir(), `mg_launcher_update_${Date.now()}`);
    await fs.mkdirp(tmpBase);
    const tmpZipPath = path.join(tmpBase, path.basename(releaseZip));
    const dl = await axios.get(zipUrl, { responseType: 'arraybuffer', validateStatus: null });
    if (dl.status !== 200) {
      logger.warn('[updater] fallo al descargar zip, status', dl.status);
      return { updateAvailable: true, remoteVersion, localVersion, reason: 'zip_download_failed', status: dl.status };
    }
    await fs.writeFile(tmpZipPath, Buffer.from(dl.data));
    // extract
    const extractDir = path.join(tmpBase, 'extracted');
    await fs.mkdirp(extractDir);
    try {
      const zip = new AdmZip(tmpZipPath);
      zip.extractAllTo(extractDir, true);
    } catch (e) {
      logger.error('[updater] fallo extrayendo zip', e && e.message ? e.message : e);
      return { updateAvailable: true, remoteVersion, localVersion, reason: 'zip_extract_failed', error: e };
    }

    return { updateAvailable: true, remoteVersion, localVersion, releaseZipUrl: zipUrl, tmpZipPath, tmpExtractDir: extractDir, tmpBase };
  } catch (err) {
    logger.error('[updater] checkForUpdates error', err && err.message ? err.message : err);
    return { updateAvailable: false, reason: 'exception', error: err };
  }
}

/**
 * applyUpdate(tmpExtractDir, targetDir, opts)
 * - copia (sobrescribe) tmpExtractDir -> targetDir
 * - opts.remoteVersion (opcional): si se proporciona, escribe app_version.json con esa versión
 * - devuelve { ok, error, wroteVersionFile }
 */
async function applyUpdate(tmpExtractDir, targetDir, opts = {}) {
  try {
    // copiar recursivamente sobrescribiendo
    await fs.copy(tmpExtractDir, targetDir, { overwrite: true, recursive: true, errorOnExist: false });

    let wroteVersionFile = false;
    try {
      if (opts && opts.remoteVersion) {
        const verFile = path.join(targetDir, 'app_version.json');
        await fs.writeJson(verFile, { version: String(opts.remoteVersion) }, { spaces: 2 });
        wroteVersionFile = true;
      }
    } catch (e) {
      // no queremos fallar la actualización solo por no poder escribir el version file
      wroteVersionFile = false;
    }

    return { ok: true, wroteVersionFile };
  } catch (e) {
    return { ok: false, error: e };
  }
}

module.exports = {
  checkForUpdates,
  applyUpdate,
  getLocalVersion,
  compareSemver
};
