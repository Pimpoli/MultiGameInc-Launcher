// updater.js (modificado — intenta descarga desde raw y si falla intenta GitHub Releases)
// Requisitos: axios, fs-extra, adm-zip (los tienes ya en dependencies)
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');

const REMOTE_BASE_RAW = 'https://raw.githubusercontent.com/Pimpoli/MultiGameInc-Launcher/main';
const REMOTE_VERSION_URL = `${REMOTE_BASE_RAW}/launcher-version.json`;

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
  } catch (e) {}
  return null;
}

function parseRemoteBase(remoteBase) {
  try {
    const u = new URL(remoteBase);
    const parts = u.pathname.split('/').filter(Boolean); // ["OWNER","REPO","BRANCH"]
    if (parts.length >= 3) {
      return { owner: parts[0], repo: parts[1], branch: parts[2] };
    }
  } catch (e) {}
  return null;
}

async function downloadBufferWithRetries(urls = [], logger = console) {
  // intenta descargar de cada URL en orden hasta obtener 200
  for (const url of urls) {
    try {
      logger.log('[updater] intentando descargar desde', url);
      const dl = await axios.get(url, { responseType: 'arraybuffer', validateStatus: null, maxContentLength: Infinity, maxBodyLength: Infinity, timeout: 30000 });
      if (dl.status === 200) {
        logger.log('[updater] descarga OK desde', url);
        return { ok: true, buffer: Buffer.from(dl.data), url };
      } else {
        logger.warn('[updater] status', dl.status, 'desde', url);
      }
    } catch (e) {
      logger.warn('[updater] fallo descarga desde', url, e && e.message ? e.message : e);
    }
  }
  return { ok: false };
}

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
    const releaseZip = remote.release_zip; // opcional (puede ser URL absoluta o ruta relativa)
    logger.log('[updater] remoteVersion=', remoteVersion, ' release_zip=', releaseZip);

    const cmp = compareSemver(remoteVersion, localVersion || '0.0.0');
    if (cmp <= 0) return { updateAvailable: false, remoteVersion, localVersion };

    // construir posibles URLs para descargar el zip
    const repoParts = parseRemoteBase(REMOTE_BASE_RAW);
    const candidateUrls = [];

    if (releaseZip) {
      if (/^https?:\/\//i.test(String(releaseZip))) {
        candidateUrls.push(String(releaseZip));
      } else {
        // intento directo a raw (si el autor lo puso así)
        candidateUrls.push(`${REMOTE_BASE_RAW}/${String(releaseZip).replace(/^\/+/, '')}`);
      }
    }

    // si no releaseZip, añadimos codeload de la rama
    if (!releaseZip && repoParts) {
      candidateUrls.push(`https://codeload.github.com/${repoParts.owner}/${repoParts.repo}/zip/refs/heads/${repoParts.branch}`);
    }

    // además: intentar URL de GitHub Releases si tenemos owner/repo y releaseZip (o asset basename)
    if (repoParts && remoteVersion) {
      const baseName = releaseZip ? path.basename(String(releaseZip)) : `launcher-${remoteVersion}.zip`;
      // probar etiquetas con 'v' y sin 'v'
      candidateUrls.push(`https://github.com/${repoParts.owner}/${repoParts.repo}/releases/download/v${remoteVersion}/${baseName}`);
      candidateUrls.push(`https://github.com/${repoParts.owner}/${repoParts.repo}/releases/download/${remoteVersion}/${baseName}`);
    }

    logger.log('[updater] candidateUrls:', candidateUrls);

    // intentar descargar buffer desde las URLs candidatas en orden
    const dlRes = await downloadBufferWithRetries(candidateUrls, logger);
    if (!dlRes.ok) {
      logger.warn('[updater] fallo al descargar zip desde todas las urls candidatas');
      return { updateAvailable: true, remoteVersion, localVersion, reason: 'zip_download_failed', status: 404 };
    }

    // guardar zip temporal
    const tmpBase = path.join(os.tmpdir(), `mg_launcher_update_${Date.now()}`);
    await fs.mkdirp(tmpBase);
    const safeName = path.basename(new URL(dlRes.url, 'http://example.com').pathname);
    const tmpZipPath = path.join(tmpBase, safeName || `release_${Date.now()}.zip`);
    await fs.writeFile(tmpZipPath, dlRes.buffer);
    logger.log('[updater] zip guardado en', tmpZipPath);

    const extractDir = path.join(tmpBase, 'extracted');
    await fs.mkdirp(extractDir);
    try {
      const zip = new AdmZip(tmpZipPath);
      zip.extractAllTo(extractDir, true);
    } catch (e) {
      logger.error('[updater] fallo extrayendo zip', e && e.message ? e.message : e);
      return { updateAvailable: true, remoteVersion, localVersion, reason: 'zip_extract_failed', error: e };
    }

    // si el zip contiene una carpeta raíz owner-repo-branch, normalizarla
    const extractedEntries = await fs.readdir(extractDir);
    if (extractedEntries.length === 1) {
      const maybeRoot = path.join(extractDir, extractedEntries[0]);
      if ((await fs.stat(maybeRoot)).isDirectory()) {
        logger.log('[updater] ajustando extractDir a subfolder', maybeRoot);
        const tmpReal = path.join(tmpBase, 'extracted_root');
        await fs.mkdirp(tmpReal);
        await fs.copy(maybeRoot, tmpReal);
        await fs.remove(extractDir);
        await fs.move(tmpReal, extractDir);
      }
    }

    return { updateAvailable: true, remoteVersion, localVersion, releaseZipUrl: dlRes.url, tmpZipPath, tmpExtractDir: extractDir, tmpBase };
  } catch (err) {
    logger.error('[updater] checkForUpdates error', err && err.message ? err.message : err);
    return { updateAvailable: false, reason: 'exception', error: err };
  }
}

async function applyUpdate(tmpExtractDir, targetDir, opts = {}) {
  const { remoteVersion = null, removeObsolete = true, logger = console } = opts;
  try {
    const backupDir = path.join(os.tmpdir(), `mg_launcher_backup_${Date.now()}`);
    try {
      await fs.mkdirp(backupDir);
      await fs.copy(targetDir, backupDir);
      logger.log('[updater] backup creado en', backupDir);
    } catch (e) {
      logger.warn('[updater] no se pudo crear backup (continuando):', e && e.message ? e.message : e);
    }

    async function walkFiles(dir) {
      const out = [];
      async function walk(current) {
        const items = await fs.readdir(current);
        for (const it of items) {
          const full = path.join(current, it);
          const st = await fs.stat(full);
          if (st.isDirectory()) await walk(full);
          else out.push(full);
        }
      }
      await walk(dir);
      return out;
    }

    const extractedFilesFull = await walkFiles(tmpExtractDir);
    const extractedRelSet = new Set(extractedFilesFull.map(f => path.relative(tmpExtractDir, f).replace(/\\/g, '/')));

    for (const fullPath of extractedFilesFull) {
      const rel = path.relative(tmpExtractDir, fullPath);
      const dest = path.join(targetDir, rel);
      const destDir = path.dirname(dest);
      if (rel.replace(/\\/g, '/').toLowerCase() === 'app_version.json') {
        logger.log('[updater] saltando app_version.json (se actualizará por version remota).');
        continue;
      }
      await fs.mkdirp(destDir);
      await fs.copy(fullPath, dest, { overwrite: true });
      logger.log('[updater] copiado ->', rel);
    }

    let wroteVersionFile = false;
    if (remoteVersion) {
      try {
        const verFile = path.join(targetDir, 'app_version.json');
        await fs.writeJson(verFile, { version: String(remoteVersion) }, { spaces: 2 });
        wroteVersionFile = true;
        logger.log('[updater] app_version.json actualizado a', remoteVersion);
      } catch (e) {
        logger.warn('[updater] fallo escribir app_version.json:', e && e.message ? e.message : e);
      }
    }

    if (removeObsolete) {
      const preserve = new Set(['app_version.json', '.git', 'userData', 'node_modules']);
      const targetFilesFull = await walkFiles(targetDir);
      for (const tf of targetFilesFull) {
        const rel = path.relative(targetDir, tf).replace(/\\/g, '/');
        if (preserve.has(rel) || Array.from(preserve).some(p => rel.startsWith(p + '/'))) continue;
        if (!extractedRelSet.has(rel)) {
          try {
            await fs.remove(tf);
            logger.log('[updater] eliminado archivo obsoleto ->', rel);
          } catch (e) {
            logger.warn('[updater] no se pudo eliminar obsoleto', rel, e && e.message ? e.message : e);
          }
        }
      }
    }

    return { ok: true, wroteVersionFile, backupDir };
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
