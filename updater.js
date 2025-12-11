// updater.js (modificado — descarga todo el repo si no hay release_zip y aplica update)
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

// extra helpers
function parseRemoteBase(remoteBase) {
  // expected: https://raw.githubusercontent.com/OWNER/REPO/BRANCH
  try {
    const u = new URL(remoteBase);
    const parts = u.pathname.split('/').filter(Boolean); // ["OWNER","REPO","BRANCH"]
    if (parts.length >= 3) {
      return { owner: parts[0], repo: parts[1], branch: parts[2] };
    }
  } catch (e) {}
  return null;
}

// download to file with progress callback
async function downloadToFileWithProgress(url, destPath, opts = {}) {
  const { logger = console, progress = null } = opts;
  const dl = await axios.get(url, { responseType: 'stream', validateStatus: null, maxContentLength: Infinity, maxBodyLength: Infinity });
  if (dl.status !== 200) throw new Error(`HTTP ${dl.status} downloading ${url}`);
  const total = dl.headers && dl.headers['content-length'] ? parseInt(dl.headers['content-length'], 10) : null;
  await fs.mkdirp(path.dirname(destPath));
  const writer = fs.createWriteStream(destPath);
  let received = 0;
  await new Promise((resolve, reject) => {
    dl.data.on('data', (chunk) => {
      received += chunk.length;
      try {
        if (typeof progress === 'function') progress({ stage: 'downloading_zip', url, receivedBytes: received, totalBytes: total, percent: total ? (received / total * 100) : null });
      } catch (e) {}
      writer.write(chunk);
    });
    dl.data.on('end', () => {
      writer.end();
      resolve();
    });
    dl.data.on('error', (err) => {
      writer.end();
      reject(err);
    });
  });
  logger.log('[updater] saved', destPath);
  return destPath;
}

async function checkForUpdates(opts = {}) {
  const { appRoot = __dirname, userDataPath = path.join(os.homedir(), '.multi-game-inc-launcher'), logger = console, progress = null } = opts;

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
    const releaseZip = remote.release_zip; // opcional
    logger.log('[updater] remoteVersion=', remoteVersion, ' release_zip=', releaseZip);

    const cmp = compareSemver(remoteVersion, localVersion || '0.0.0');
    if (cmp <= 0) return { updateAvailable: false, remoteVersion, localVersion };

    // Determinar URL del ZIP a descargar:
    let zipUrl = null;
    if (releaseZip) {
      zipUrl = `${REMOTE_BASE_RAW}/${String(releaseZip).replace(/^\/+/, '')}`;
      if (/^https?:\/\//i.test(releaseZip)) zipUrl = releaseZip;
    } else {
      const repoParts = parseRemoteBase(REMOTE_BASE_RAW);
      if (!repoParts) {
        logger.warn('[updater] no se puede inferir owner/repo/branch desde REMOTE_BASE_RAW; no hay release_zip.');
        return { updateAvailable: true, remoteVersion, localVersion, reason: 'no_zip' };
      }
      zipUrl = `https://codeload.github.com/${repoParts.owner}/${repoParts.repo}/zip/refs/heads/${repoParts.branch}`;
      logger.log('[updater] no release_zip en JSON, usando repo zip ->', zipUrl);
    }

    // download zip with stream progress (forward to progress callback)
    const tmpBase = path.join(os.tmpdir(), `mg_launcher_update_${Date.now()}`);
    await fs.mkdirp(tmpBase);
    const tmpZipPath = path.join(tmpBase, path.basename(zipUrl).split('?')[0] || `release_${Date.now()}.zip`);
    logger.log('[updater] downloading zip from', zipUrl);

    try {
      await downloadToFileWithProgress(zipUrl, tmpZipPath, { logger, progress });
    } catch (dlErr) {
      logger.warn('[updater] fallo al descargar zip, err=', dlErr && dlErr.message ? dlErr.message : dlErr);
      return { updateAvailable: true, remoteVersion, localVersion, reason: 'zip_download_failed', status: dlErr && dlErr.message ? dlErr.message : dlErr };
    }

    logger.log('[updater] zip guardado en', tmpZipPath);

    const extractDir = path.join(tmpBase, 'extracted');
    await fs.mkdirp(extractDir);
    try {
      const zip = new AdmZip(tmpZipPath);
      // can't measure adm-zip progress easily, but notify stages
      if (typeof progress === 'function') progress({ stage: 'extracting_zip', tmpZipPath });
      zip.extractAllTo(extractDir, true);
    } catch (e) {
      logger.error('[updater] fallo extrayendo zip', e && e.message ? e.message : e);
      return { updateAvailable: true, remoteVersion, localVersion, reason: 'zip_extract_failed', error: e };
    }

    // Normalmente el zip de GitHub contiene una carpeta raíz owner-repo-branch; buscar la carpeta correcta
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

    return { updateAvailable: true, remoteVersion, localVersion, releaseZipUrl: zipUrl, tmpZipPath, tmpExtractDir: extractDir, tmpBase };
  } catch (err) {
    logger.error('[updater] checkForUpdates error', err && err.message ? err.message : err);
    return { updateAvailable: false, reason: 'exception', error: err };
  }
}

/**
 * Aplica actualización desde tmpExtractDir a targetDir
 * - No sobrescribe app_version.json (en su lugar escribe la version remota).
 * - Hace copia de seguridad antes de aplicar (backupDir).
 * - Opcional: si opts.removeObsolete === true, elimina archivos en target que no están en el extract.
 * - Opcional: opts.progress callback recibe {stage, currentFile, index, totalFiles, percent, message}
 */
async function applyUpdate(tmpExtractDir, targetDir, opts = {}) {
  const { remoteVersion = null, removeObsolete = true, logger = console, progress = null } = opts;
  try {
    // 1) backup
    const backupDir = path.join(os.tmpdir(), `mg_launcher_backup_${Date.now()}`);
    try {
      await fs.mkdirp(backupDir);
      await fs.copy(targetDir, backupDir);
      logger.log('[updater] backup creado en', backupDir);
      if (typeof progress === 'function') progress({ stage: 'backup_created', backupDir });
    } catch (e) {
      logger.warn('[updater] no se pudo crear backup (continuando):', e && e.message ? e.message : e);
      if (typeof progress === 'function') progress({ stage: 'backup_failed', message: e && e.message ? e.message : String(e) });
    }

    // 2) recopilar lista de archivos extraídos (relativos)
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
    const totalFiles = extractedFilesFull.length;
    if (typeof progress === 'function') progress({ stage: 'apply_start', totalFiles });

    // crear set de paths relativos desde tmpExtractDir
    const extractedRelSet = new Set(extractedFilesFull.map(f => path.relative(tmpExtractDir, f).replace(/\\/g, '/')));

    // 3) copiar cada archivo del extract hacia target, respetando estructura
    let copied = 0;
    for (const fullPath of extractedFilesFull) {
      const rel = path.relative(tmpExtractDir, fullPath).replace(/\\/g, '/');
      const dest = path.join(targetDir, rel);
      const destDir = path.dirname(dest);
      // saltar app_version.json para no sobreescribirlo directamente
      if (rel.toLowerCase() === 'app_version.json') {
        logger.log('[updater] saltando app_version.json (se actualizará por version remota).');
        copied++;
        if (typeof progress === 'function') progress({ stage: 'skipped', currentFile: rel, index: copied, totalFiles, percent: Math.round((copied/totalFiles)*100) });
        continue;
      }
      await fs.mkdirp(destDir);
      await fs.copy(fullPath, dest, { overwrite: true });
      copied++;
      if (typeof progress === 'function') progress({ stage: 'copying', currentFile: rel, index: copied, totalFiles, percent: Math.round((copied/totalFiles)*100) });
      logger.log('[updater] copiado ->', rel);
    }

    // 4) escribir app_version.json con remoteVersion (si remoteVersion dado)
    let wroteVersionFile = false;
    if (remoteVersion) {
      try {
        const verFile = path.join(targetDir, 'app_version.json');
        await fs.writeJson(verFile, { version: String(remoteVersion) }, { spaces: 2 });
        wroteVersionFile = true;
        logger.log('[updater] app_version.json actualizado a', remoteVersion);
        if (typeof progress === 'function') progress({ stage: 'version_written', remoteVersion });
      } catch (e) {
        logger.warn('[updater] fallo escribir app_version.json:', e && e.message ? e.message : e);
        if (typeof progress === 'function') progress({ stage: 'version_write_failed', message: e && e.message ? e.message : String(e) });
      }
    }

    // 5) opcional: eliminar archivos en target que ya no están en el extract
    if (removeObsolete) {
      const preserve = new Set(['app_version.json', '.git', 'userData', 'node_modules']);
      const targetFilesFull = await walkFiles(targetDir);
      let totalTarget = targetFilesFull.length;
      let removedCount = 0;
      for (const tf of targetFilesFull) {
        const rel = path.relative(targetDir, tf).replace(/\\/g, '/');
        if (preserve.has(rel) || Array.from(preserve).some(p => rel.startsWith(p + '/'))) {
          continue;
        }
        if (!extractedRelSet.has(rel)) {
          try {
            await fs.remove(tf);
            removedCount++;
            if (typeof progress === 'function') progress({ stage: 'removing_obsolete', currentFile: rel, removedCount, totalTarget });
            logger.log('[updater] eliminado archivo obsoleto ->', rel);
          } catch (e) {
            logger.warn('[updater] no se pudo eliminar obsoleto', rel, e && e.message ? e.message : e);
            if (typeof progress === 'function') progress({ stage: 'remove_failed', currentFile: rel, message: e && e.message ? e.message : String(e) });
          }
        }
      }
      if (typeof progress === 'function') progress({ stage: 'obsolete_cleanup_done', removedCount });
    }

    return { ok: true, wroteVersionFile, backupDir };
  } catch (e) {
    if (typeof progress === 'function') progress({ stage: 'apply_error', message: e && e.message ? e.message : String(e) });
    return { ok: false, error: e };
  }
}

module.exports = {
  checkForUpdates,
  applyUpdate,
  getLocalVersion,
  compareSemver
};
