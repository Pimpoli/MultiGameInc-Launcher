// installer.js
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const axios = require('axios');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { spawn } = require('child_process');

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function downloadToBuffer(url, token, onProgress) {
  const headers = token ? { Authorization: `token ${token}` } : {};
  console.log('[installer] descargando ->', url);
  try {
    const res = await axios.get(url, { responseType: 'stream', headers, validateStatus: null });
    if (res.status !== 200) {
      if (res.status === 404) throw new Error('404 Not Found');
      const arr = await axios.get(url, { responseType: 'arraybuffer', headers });
      return Buffer.from(arr.data);
    }

    const total = res.headers && res.headers['content-length'] ? parseInt(res.headers['content-length'], 10) : null;
    const chunks = [];
    let received = 0;
    return await new Promise((resolve, reject) => {
      res.data.on('data', (chunk) => {
        chunks.push(chunk);
        received += chunk.length;
        if (typeof onProgress === 'function') {
          try { onProgress({ type: 'download', url, received, total }); } catch (e) {}
        }
      });
      res.data.on('end', () => {
        try { resolve(Buffer.concat(chunks)); } catch (e) { reject(e); }
      });
      res.data.on('error', (err) => reject(err));
    });
  } catch (err) {
    try {
      const res2 = await axios.get(url, { responseType: 'arraybuffer', headers });
      return Buffer.from(res2.data);
    } catch (err2) {
      throw err;
    }
  }
}

function runJarInstaller(installerPath, installPath, args = []) {
  return new Promise((resolve, reject) => {
    const java = 'java';
    const spawnArgs = ['-jar', installerPath, ...args];

    const child = spawn(java, spawnArgs, {
      cwd: installPath,
      shell: false
    });

    let stderr = '';
    child.stdout.on('data', (d) => console.log('[installer stdout]', d.toString()));
    child.stderr.on('data', (d) => { stderr += d.toString(); console.error('[installer stderr]', d.toString()); });

    child.on('error', (err) => reject(new Error(`Falló al iniciar java: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true, code });
      else reject(new Error(`Installer finalizó con código ${code}. stderr: ${stderr}`));
    });
  });
}

function launchMinecraftLauncher() {
  return new Promise((resolve) => {
    try {
      if (process.platform === 'win32') {
        const child = spawn('cmd', ['/c', 'start', '', 'minecraft://'], { stdio: 'ignore', detached: true });
        child.unref();
        resolve(true);
      } else if (process.platform === 'darwin') {
        const child = spawn('open', ['minecraft://'], { stdio: 'ignore', detached: true });
        child.unref();
        resolve(true);
      } else {
        const child = spawn('xdg-open', ['minecraft://'], { stdio: 'ignore', detached: true });
        child.unref();
        resolve(true);
      }
    } catch (e) {
      console.warn('[installer] no se pudo abrir launcher automáticamente:', e && e.message ? e.message : e);
      resolve(false);
    }
  });
}

async function listGithubDirFiles(owner, repo, dirPath, token) {
  try {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}`;
    const headers = token ? { Authorization: `token ${token}`, 'User-Agent': 'MultiGameInc-Launcher' } : { 'User-Agent': 'MultiGameInc-Launcher' };
    const res = await axios.get(url, { headers, validateStatus: null });
    if (res.status === 200 && Array.isArray(res.data)) {
      return res.data.filter(i => i.type === 'file').map(i => ({ name: i.name, download_url: i.download_url }));
    } else {
      console.warn('[installer] listGithubDirFiles: status', res.status, 'for', dirPath);
      return [];
    }
  } catch (err) {
    console.warn('[installer] listGithubDirFiles error:', err.message || err, 'for', dirPath);
    return [];
  }
}

function getRepoPathPartsFromManifestUrl(manifestUrl) {
  try {
    const u = new URL(manifestUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 4) return null;
    const owner = parts[0], repo = parts[1];
    const repoPathParts = parts.slice(3, parts.length - 1);
    const repoPath = repoPathParts.join('/');
    return { owner, repo, repoPath };
  } catch (e) {
    return null;
  }
}

async function listInstallersFromRepo(manifestUrl, token = null) {
  const repoInfo = getRepoPathPartsFromManifestUrl(manifestUrl);
  if (!repoInfo) return [];
  const { owner, repo, repoPath } = repoInfo;
  const installersPath = repoPath ? `${repoPath}/assets/installers` : 'assets/installers';
  const items = await listGithubDirFiles(owner, repo, installersPath, token);
  return items;
}

async function applyDownloads(tmpDir, installPath, progress = null) {
  if (!installPath) throw new Error('installPath requerido para aplicar descargas');
  const metaPath = path.join(tmpDir, 'meta.json');
  if (!await fs.pathExists(metaPath)) throw new Error('meta.json no encontrado en tmpDir');
  const metaObj = await fs.readJson(metaPath);
  return await applyDownloadsInternal(tmpDir, installPath, metaObj, progress);
}

async function applyDownloadsInternal(tmpDir, installPath, metaObj, progress = null) {
  const modsDir = path.join(installPath, 'mods');
  const shadersDir = path.join(installPath, 'shaderpacks');
  const resourcepacksDir = path.join(installPath, 'resourcepacks');
  const installersDir = path.join(installPath, 'launcher_installers');

  await fs.mkdirp(modsDir);
  await fs.mkdirp(shadersDir);
  await fs.mkdirp(resourcepacksDir);
  await fs.mkdirp(installersDir);

  let installerPath = null;
  let installerArgs = null;
  const filesMeta = metaObj.filesMeta || [];

  try {
    await fs.emptyDir(modsDir);
    if (typeof progress === 'function') progress({ stage: 'clearing_mods', message: 'Vaciando carpeta mods', modsDir });
    console.log('[installer] carpeta mods vaciada (eliminados mods previos).');
  } catch (e) {
    console.warn('[installer] no se pudo vaciar modsDir:', e.message || e);
  }

  for (const [i, fm] of filesMeta.entries()) {
    const tmpPath = path.join(tmpDir, fm.tmpName);
    if (!await fs.pathExists(tmpPath)) {
      console.warn('[installer] archivo temporal no existe, saltando:', fm.tmpName);
      continue;
    }

    try {
      const cat = fm.category ? String(fm.category).toLowerCase() : '';

      if (cat === 'installers') {
        const dest = path.join(installersDir, fm.name || fm.tmpName);
        if (typeof progress === 'function') progress({ stage: 'moving_installer', currentFile: fm.tmpName, index: i+1, total: filesMeta.length, status: 'moving' });
        await fs.move(tmpPath, dest, { overwrite: true });
        if (metaObj.selectedInstallerName && (fm.name === metaObj.selectedInstallerName || fm.tmpName === metaObj.selectedInstallerName)) {
          installerPath = dest;
          installerArgs = Array.isArray(fm.installerArgs) ? fm.installerArgs.map(a => a.replace('%INSTALL_DIR%', installPath)) : [];
        }
        if (typeof progress === 'function') progress({ stage: 'moved_installer', currentFile: fm.tmpName, status: 'done' });
        console.log('[installer] movido instalador:', path.basename(dest));
      } else if (cat === 'mods') {
        if ((fm.tmpName || '').toLowerCase().endsWith('.zip')) {
          if (typeof progress === 'function') progress({ stage: 'extracting', currentFile: fm.tmpName, status: 'extracting' });
          const extractFolder = path.join(tmpDir, `extract_${path.basename(fm.tmpName, '.zip')}_${Date.now()}`);
          await fs.mkdirp(extractFolder);
          const zip = new AdmZip(path.join(tmpDir, fm.tmpName));
          zip.extractAllTo(extractFolder, true);

          const maybeMods = path.join(extractFolder, 'mods');
          let source = extractFolder;
          if (await fs.pathExists(maybeMods)) source = maybeMods;

          const entries = await fs.readdir(source);
          for (const e of entries) {
            const srcEntry = path.join(source, e);
            const destEntry = path.join(modsDir, e);
            if (typeof progress === 'function') progress({ stage: 'copying', currentFile: e, status: 'copying' });
            await fs.copy(srcEntry, destEntry, { overwrite: true });
            if (typeof progress === 'function') progress({ stage: 'copied', currentFile: e, status: 'done' });
            console.log('[installer] copiado desde zip a mods:', e);
          }

          await fs.remove(extractFolder).catch(()=>{});
          await fs.remove(path.join(tmpDir, fm.tmpName)).catch(()=>{});
        } else {
          const targetName = fm.name || fm.tmpName;
          const dest = path.join(modsDir, targetName);
          if (typeof progress === 'function') progress({ stage: 'moving_mod', currentFile: targetName, status: 'moving' });
          await fs.move(path.join(tmpDir, fm.tmpName), dest, { overwrite: true });
          if (typeof progress === 'function') progress({ stage: 'moved_mod', currentFile: targetName, status: 'done' });
          console.log('[installer] movido mod a modsDir:', targetName);
        }
      } else if (cat === 'shaders') {
        const dest = path.join(shadersDir, fm.name || fm.tmpName);
        if (await fs.pathExists(dest)) {
          console.log('[installer] shader ya existe, se salta (no sobreescribe):', fm.name || fm.tmpName);
          await fs.remove(path.join(tmpDir, fm.tmpName)).catch(()=>{});
        } else {
          if (typeof progress === 'function') progress({ stage: 'moving_shader', currentFile: fm.tmpName, status: 'moving' });
          await fs.move(path.join(tmpDir, fm.tmpName), dest, { overwrite: false }).catch(async (e)=>{ console.warn('[installer] mover shader error', e.message || e); await fs.remove(path.join(tmpDir, fm.tmpName)).catch(()=>{}); });
          if (typeof progress === 'function') progress({ stage: 'moved_shader', currentFile: fm.tmpName, status: 'done' });
          console.log('[installer] movido shader (nuevo):', fm.name || fm.tmpName);
        }
      } else if (cat === 'resourcepacks' || cat === 'resourcepack' || cat === 'texturepacks' || cat === 'textures') {
        const dest = path.join(resourcepacksDir, fm.name || fm.tmpName);
        if (await fs.pathExists(dest)) {
          console.log('[installer] resourcepack/textura ya existe, se salta (no sobreescribe):', fm.name || fm.tmpName);
          await fs.remove(path.join(tmpDir, fm.tmpName)).catch(()=>{});
        } else {
          if (typeof progress === 'function') progress({ stage: 'moving_resourcepack', currentFile: fm.tmpName, status: 'moving' });
          await fs.move(path.join(tmpDir, fm.tmpName), dest, { overwrite: false }).catch(async (e)=>{ console.warn('[installer] mover resourcepack error', e.message || e); await fs.remove(path.join(tmpDir, fm.tmpName)).catch(()=>{}); });
          if (typeof progress === 'function') progress({ stage: 'moved_resourcepack', currentFile: fm.tmpName, status: 'done' });
          console.log('[installer] movido resourcepack/textura (nuevo):', fm.name || fm.tmpName);
        }
      } else {
        const dest = path.join(installersDir, fm.name || fm.tmpName);
        if (typeof progress === 'function') progress({ stage: 'moving_misc', currentFile: fm.tmpName, status: 'moving' });
        await fs.move(path.join(tmpDir, fm.tmpName), dest, { overwrite: true });
        if (typeof progress === 'function') progress({ stage: 'moved_misc', currentFile: fm.tmpName, status: 'done' });
        console.log('[installer] movido archivo sin categorizar a installersDir:', fm.name || fm.tmpName);
      }
    } catch (err) {
      console.error('[installer] error aplicando archivo', fm.tmpName, err.message || err);
    }
  }

  try { await fs.remove(tmpDir); } catch(e){ console.warn('No se pudo limpiar tmpDir', e.message || e); }

  return { backupDir: null, installerPath, installerArgs, missingInstallers: metaObj.missingInstallers || [] };
}

async function installVersionHandler(payload, progress = null) {
  const { manifestUrl, versionId, token, selectedInstallerName } = payload;
  console.log('[installer] installVersionHandler: manifestUrl=', manifestUrl, 'versionId=', versionId);
  const manifestRes = await axios.get(manifestUrl);
  const manifest = manifestRes.data;
  const version = manifest.versions.find(v => v.id === versionId);
  if (!version) throw new Error('Versión no encontrada en manifest');

  const tmpDir = path.join(os.tmpdir(), `launcher_tmp_${Date.now()}`);
  await fs.mkdirp(tmpDir);

  const filesDeclared = Array.isArray(version.files) ? version.files.slice() : [];

  const repoInfo = getRepoPathPartsFromManifestUrl(manifestUrl);
  let owner = null, repo = null, repoBasePath = null;
  if (repoInfo) {
    owner = repoInfo.owner; repo = repoInfo.repo; repoBasePath = repoInfo.repoPath;
  }

  const meta = [];
  const missingInstallers = [];
  const missingCritical = [];

  let bytesDownloadedTotal = 0;

  async function processDeclaredFiles() {
    for (let idx = 0; idx < filesDeclared.length; idx++) {
      const f = filesDeclared[idx];
      let fileUrl = f.url || f.path || f.file;
      if (!fileUrl) {
        console.warn('[installer] entrada declarada sin url:', f);
        continue;
      }

      if (owner && repo && /TU_USER\/LAUNCHERMODPACK/.test(fileUrl)) {
        fileUrl = fileUrl.replace(/TU_USER\/LAUNCHERMODPACK/g, `${owner}/${repo}`);
      }

      if (!/^https?:\/\//i.test(fileUrl)) {
        const manifestBase = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);
        try {
          fileUrl = new URL(fileUrl, manifestBase).href;
        } catch (e) {
          fileUrl = manifestBase + fileUrl.replace(/^\/+/, '');
        }
      }

      const tmpName = f.name || path.basename(fileUrl);
      const tmpPath = path.join(tmpDir, tmpName);

      try {
        if (typeof progress === 'function') progress({ stage: 'starting_download', currentFile: tmpName, fileIndex: idx+1, fileCount: filesDeclared.length });
        const buf = await downloadToBuffer(fileUrl, token, (evt) => {
          if (typeof progress === 'function') {
            progress({
              stage: 'downloading',
              currentFile: tmpName,
              fileIndex: idx+1,
              fileCount: filesDeclared.length,
              downloadedBytes: evt.received,
              totalBytes: evt.total
            });
          }
        });

        if (f.sha256) {
          const sum = sha256Buffer(buf);
          if (sum !== f.sha256) throw new Error('Checksum mismatch');
        }

        await fs.writeFile(tmpPath, buf);
        meta.push({ name: f.name || tmpName, category: f.category, tmpName, resolvedUrl: fileUrl, installerArgs: f.installerArgs || null, original: f });
        if (typeof progress === 'function') progress({ stage: 'downloaded', currentFile: tmpName, fileIndex: idx+1, fileCount: filesDeclared.length, status: 'done' });

        bytesDownloadedTotal += buf.length;
      } catch (err) {
        const isInstaller = (f.category === 'installers' || (f.category && String(f.category).toLowerCase() === 'installers'));
        const isCritical = ['mods','shaders','resourcepacks','resourcepack','textures','texturepacks'].includes(String(f.category).toLowerCase());
        const name = f.name || path.basename(fileUrl);
        if (isInstaller) {
          console.warn('[installer] no se pudo descargar instalador declarado:', name, err.message || err);
          missingInstallers.push(name);
          continue;
        }
        if (isCritical) {
          console.warn('[installer] falta archivo crítico declarado:', name, err.message || err);
          missingCritical.push(name);
          continue;
        }
        console.warn('[installer] archivo declarado no descargado (no-critical):', name, err.message || err);
        missingInstallers.push(name);
      }
    }
  }

  async function fetchAssetsFromRepoIfMissing() {
    if (!owner || !repo || !repoBasePath) return;
    const folders = [
      { rel: 'assets/installers', category: 'installers' },
      { rel: 'assets/mods', category: 'mods' },
      { rel: 'assets/shaders', category: 'shaders' },
      { rel: 'assets/resourcepacks', category: 'resourcepacks' }
    ];

    const hasDeclared = (cat) => filesDeclared.some(f => f.category && String(f.category).toLowerCase() === cat);

    for (const fldr of folders) {
      if (hasDeclared(fldr.category)) {
        if (fldr.category !== 'installers') continue;
      }
      const targetDir = repoBasePath ? `${repoBasePath}/${fldr.rel}` : fldr.rel;
      const items = await listGithubDirFiles(owner, repo, targetDir, token);
      if (!items || items.length === 0) {
        console.log('[installer] no items found in repo path:', targetDir);
        continue;
      }
      for (const it of items) {
        try {
          if (typeof progress === 'function') progress({ stage: 'starting_repo_download', currentFile: it.name, repoPath: targetDir });
          const buf = await downloadToBuffer(it.download_url, token, (evt) => {
            if (typeof progress === 'function') progress({
              stage: 'downloading_repo',
              currentFile: it.name,
              downloadedBytes: evt.received,
              totalBytes: evt.total
            });
          });
          const tmpName = it.name;
          const tmpPath = path.join(tmpDir, tmpName);
          await fs.writeFile(tmpPath, buf);
          meta.push({ name: tmpName, category: fldr.category, tmpName, resolvedUrl: it.download_url, installerArgs: null, original: { autoFromRepo: true } });
          if (typeof progress === 'function') progress({ stage: 'downloaded_repo', currentFile: it.name, status: 'done' });
          console.log('[installer] descargado desde repo:', targetDir, '->', tmpName);
        } catch (err) {
          console.warn('[installer] fallo descargar desde repo:', it.download_url, err.message || err);
          if (fldr.category === 'mods') missingCritical.push(it.name);
          else {
            console.warn('[installer] recurso no descargado (shaders/installers/resourcepacks):', it.name);
          }
        }
      }
    }
  }

  await processDeclaredFiles();
  await fetchAssetsFromRepoIfMissing();

  const manifestId = manifest.id || (manifest.name ? manifest.name.replace(/\s+/g,'_').toLowerCase() : 'manifest');
  const metaObj = { manifestUrl, versionId, filesMeta: meta, missingInstallers, missingCritical, selectedInstallerName };
  await fs.writeJson(path.join(tmpDir, 'meta.json'), metaObj, { spaces: 2 });

  if (missingCritical.length > 0) {
    if (typeof progress === 'function') progress({ stage: 'missing_critical', missingCritical });
    return { status: 'missing_critical', tmpDir, missingInstallers, missingCritical, manifestId };
  }

  if (typeof progress === 'function') progress({ stage: 'applying', tmpDir });
  const applyRes = await applyDownloadsInternal(tmpDir, payload.installPath, metaObj, progress);
  return applyRes;
}

async function cleanupTmp(tmpDir) {
  try { if (tmpDir && await fs.pathExists(tmpDir)) await fs.remove(tmpDir); } catch (e) { console.warn('cleanupTmp error', e.message || e); }
  return true;
}

module.exports = {
  installVersionHandler,
  applyDownloads,
  runJarInstaller,
  cleanupTmp,
  launchMinecraftLauncher,
  listInstallersFromRepo
};
