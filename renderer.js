// renderer.js  (archivo completo - VERSION CORREGIDA)
// Fixes principales:
//  - Robustez al cargar index.json remoto: intenta parsear texto, limpia comentarios/trailing-commas antes de JSON.parse
//  - Fallback local mejorado: prueba rutas relativas ('index.json', './index.json', './assets/index.json')
//  - Si todo falla, no lanza excepción crítica: deja indexData vacío y muestra mensajes amigables en UI/logs
//  - Mantiene compatibilidad con window.api expuesto por preload (selectInstallPath, installVersion, getDefaultMinecraftPath, listInstallers, onInstallProgress)
//  - Añadida: muestra versión local/remota y fecha en la consola del launcher (UI). Marca en rojo si está desactualizado.
//  - Corregido: función formatDateString (antes faltante)

/* ---------------------------
   Constants / DOM refs
   --------------------------- */
const INDEX_URL = 'https://raw.githubusercontent.com/Pimpoli/LauncherModPack/main/index.json';
const packSelect = document.getElementById('packSelect');
const loaderSelect = document.getElementById('loaderSelect');
const btnPlay = document.getElementById('btnPlay');
const btnSelectPath = document.getElementById('btnSelectPath');
const installPathText = document.getElementById('installPathText');
const statusText = document.getElementById('statusText');
const logsEl = document.getElementById('logs');
const chkAskInstall = document.getElementById('chkAskInstall');
const runModeRun = document.getElementById('runModeRun');

let installPath = null;
let currentManifest = null;
let currentManifestUrl = null;
let indexData = [];
let selectedVersionId = null;

/* ---------------------------
   Inject nicer scrollbars + minor CSS for modals
   --------------------------- */
(function injectUIStyles() {
  const css = `
    /* custom scrollbar (webkit) */
    ::-webkit-scrollbar { height:10px; width:10px; }
    ::-webkit-scrollbar-thumb {
      background: linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.03));
      border-radius: 8px;
      border: 2px solid rgba(0,0,0,0.06);
      min-height: 20px;
    }
    ::-webkit-scrollbar-track {
      background: rgba(255,255,255,0.01);
      border-radius: 8px;
    }

    /* firefox */
    * { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.08) rgba(0,0,0,0.02); }

    /* modal backdrop & centered card */
.mg-backdrop {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  /* Fondo oscuro OPACO que bloquea totalmente el contenido debajo */
  background: rgba(2,6,10,0.96) !important;
  pointer-events: auto;
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
}

.mg-card {
  width: 640px;
  max-width: calc(100% - 32px);
  /* tarjeta sólida (no transparencia) */
  background: #071827 !important;
  border-radius: 12px;
  padding: 18px;
  box-shadow: 0 28px 80px rgba(0,0,0,0.7);
  color: var(--text);
  /* asegurar que la tarjeta capture clicks */
  pointer-events: auto;
}

/* small helpers */
.mg-row { display:flex; gap:10px; align-items:center; justify-content:space-between; }
.mg-title { font-size:18px; margin:0 0 6px 0; }
.mg-sub { color: #9aa4b2; margin:0 0 10px 0; font-size:13px; }
.mg-actions { display:flex; gap:10px; justify-content:flex-end; margin-top:14px; }

    /* progress bar */
    .mg-progress { height:12px; background: rgba(255,255,255,0.03); border-radius:8px; overflow:hidden; position:relative; }
    .mg-progress .bar { height:100%; width:0%; background: linear-gradient(90deg,#2dd4bf,#10b981); transition: width .18s linear; }

    /* spinner fallback */
    .mg-spinner { width:36px; height:36px; border-radius:50%; border:4px solid rgba(255,255,255,0.06); border-top-color: #2dd4bf; animation:spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* file list */
    .mg-filelist { max-height:200px; overflow:auto; margin-top:10px; border-radius:8px; background: rgba(255,255,255,0.015); padding:8px; font-family: monospace; font-size:13px; }
    .mg-file { display:flex; justify-content:space-between; gap:8px; padding:6px 8px; border-radius:6px; align-items:center; }
    .mg-file .name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color: #dff8f0; }
    .mg-file .meta { color:#9aa4b2; font-size:12px; min-width:100px; text-align:right; }

    /* small labels */
    .mg-label { font-size:12px; color:#9aa4b2; }

    /* splash */
.mg-splash {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9998;
  flex-direction: column;
  gap: 12px;
  color: var(--text);
  background: #031018 !important;
}
  `;
  const s = document.createElement('style');
  s.textContent = css;
  document.head.appendChild(s);
})();

/* ---------------------------
   Logging with colored lines
   --------------------------- */
function appendLogLine(text, cls = 'info') {
  const el = document.createElement('div');
  el.style.margin = '4px 0';
  el.style.whiteSpace = 'pre-wrap';
  const time = new Date().toLocaleTimeString();
  if (cls === 'ok') el.style.color = '#7ee787';       // green
  else if (cls === 'warn') el.style.color = '#ffc66b';// orange
  else if (cls === 'err') el.style.color = '#ff7b7b'; // red
  else el.style.color = '#cfece6';                    // default
  el.textContent = `[${time}] ${text}`;
  logsEl.appendChild(el);
  logsEl.scrollTop = logsEl.scrollHeight;
  // also console
  if (cls === 'err') console.error(text); else if (cls === 'warn') console.warn(text); else console.log(text);
}
function logInfo(...a){ appendLogLine(a.join(' '), 'info'); }
function logOk(...a){ appendLogLine(a.join(' '), 'ok'); }
function logWarn(...a){ appendLogLine(a.join(' '), 'warn'); }
function logErr(...a){ appendLogLine(a.join(' '), 'err'); }

/* ---------------------------
   Splash screen
   --------------------------- */
let splashEl = null;
function showSplash(msg = 'Cargando launcher...') {
  if (splashEl) return;
  splashEl = document.createElement('div');
  splashEl.className = 'mg-splash';
  splashEl.innerHTML = `
    <div class="logo">MG</div>
    <div class="msg" id="mg-splash-msg">${escapeHtml(msg)}</div>
  `;
  document.body.appendChild(splashEl);
}
function updateSplash(msg) {
  const m = document.getElementById('mg-splash-msg');
  if (m) m.textContent = msg;
}
function hideSplash() {
  if (!splashEl) return;
  splashEl.style.transition = 'opacity .18s ease';
  splashEl.style.opacity = '0';
  setTimeout(()=>{ splashEl && splashEl.remove(); splashEl = null; }, 220);
}

/* ---------------------------
   Confirm modal (darkens background) - returns promise
   --------------------------- */
function showConfirm(title, message, confirmText = 'Sí', cancelText = 'No') {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'mg-backdrop';
    const card = document.createElement('div');
    card.className = 'mg-card';
    card.innerHTML = `
      <h3 class="mg-title">${escapeHtml(title)}</h3>
      <div class="mg-sub">${escapeHtml(message)}</div>
      <div class="mg-actions" style="justify-content:flex-end">
        <button class="mg-cancel" style="background:transparent;border:1px solid rgba(255,255,255,0.06);padding:8px 12px;border-radius:8px;color:var(--muted);"> ${escapeHtml(cancelText)} </button>
        <button class="mg-confirm" style="background: linear-gradient(180deg,#10b981,#059669); border:none; padding:8px 12px;border-radius:8px;color:#05241a;margin-left:8px;"> ${escapeHtml(confirmText)} </button>
      </div>
    `;
    back.appendChild(card);
    document.body.appendChild(back);
    card.querySelector('.mg-cancel').addEventListener('click', ()=>{ back.remove(); resolve(false); });
    card.querySelector('.mg-confirm').addEventListener('click', ()=>{ back.remove(); resolve(true); });
  });
}

/* ---------------------------
   Progress modal (same as before)
   --------------------------- */
let progressModal = null;
let progressSubscription = null; // if using external events
let fallbackTicker = null;

function createProgressModal(initialTitle = 'Instalando...') {
  if (progressModal) return progressModal;
  const back = document.createElement('div');
  back.className = 'mg-backdrop';
  back.style.zIndex = 9997; // below splash if any
  const card = document.createElement('div');
  card.className = 'mg-card';
  card.innerHTML = `
    <h3 class="mg-title" id="mg-progress-title">${escapeHtml(initialTitle)}</h3>
    <div class="mg-sub" id="mg-progress-sub">Preparando...</div>

    <div style="display:flex; gap:12px; align-items:center; margin-top:8px;">
      <div style="flex:1;">
        <div class="mg-progress" id="mg-progress-bar"><div class="bar" style="width:0%"></div></div>
      </div>
      <div style="min-width:110px; text-align:right;">
        <div class="mg-label" id="mg-progress-percent">0%</div>
        <div class="mg-label" id="mg-progress-speed">—</div>
      </div>
    </div>

    <div style="display:flex; gap:12px; align-items:center; margin-top:10px;">
      <div style="flex:1;">
        <div class="mg-label">Actividad:</div>
        <div id="mg-progress-activity" style="margin-top:6px; color:#dff8f0;">—</div>
      </div>
      <div style="width:160px;">
        <div class="mg-label">Total:</div>
        <div id="mg-progress-total" style="color:#9aa4b2;margin-top:6px;">—</div>
      </div>
    </div>

    <div class="mg-filelist" id="mg-filelist" style="margin-top:12px;">No hay archivos listados.</div>

    <div class="mg-actions" style="margin-top:12px; justify-content:flex-end;">
      <button id="mg-progress-close" style="background:transparent;border:1px solid rgba(255,255,255,0.06);padding:8px 12px;border-radius:8px;color:var(--muted);">Cerrar</button>
    </div>
  `;
  back.appendChild(card);
  document.body.appendChild(back);

  card.querySelector('#mg-progress-close').addEventListener('click', ()=>{
    back.style.display = 'none';
  });

  progressModal = { back, card,
    setTitle: (t)=>{ card.querySelector('#mg-progress-title').textContent = t; },
    setSub: (s)=>{ card.querySelector('#mg-progress-sub').textContent = s; },
    setPercent: (p)=>{ const bar = card.querySelector('.bar'); bar.style.width = `${Math.max(0, Math.min(100, p))}%`; card.querySelector('#mg-progress-percent').textContent = `${Math.round(p)}%`; },
    setSpeed: (bps)=>{ const el = card.querySelector('#mg-progress-speed'); if (!bps && bps !== 0) el.textContent = '—'; else el.textContent = `${formatBytes(bps)}/s`; },
    setTotal: (txt)=>{ card.querySelector('#mg-progress-total').textContent = txt; },
    setActivity: (txt)=>{ card.querySelector('#mg-progress-activity').textContent = txt; },
    setFileList: (items)=>{ const cont = card.querySelector('#mg-filelist'); cont.innerHTML = ''; if (!items || items.length === 0) { cont.textContent = 'No hay archivos listados.'; return; } for (const it of items) { const row = document.createElement('div'); row.className = 'mg-file'; row.innerHTML = `<div class="name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</div><div class="meta">${escapeHtml(it.status ? it.status : (it.percent ? (Math.round(it.percent)+'%') : ''))}</div>`; cont.appendChild(row); } },
    close: ()=>{ if (!progressModal) return; try { progressModal.back.remove(); } catch(e){} progressModal = null; }
  };

  return progressModal;
}

function showProgressModal(initialTitle) {
  const m = createProgressModal(initialTitle || 'Instalando...');
  m.back.style.display = 'flex';
  m.setTitle(initialTitle || 'Instalando...');
  m.setSub('Preparando...');
  m.setPercent(0);
  m.setSpeed(null);
  m.setTotal('—');
  m.setActivity('—');
  m.setFileList([]);
  m.back.style.display = 'flex';
  return m;
}

function hideProgressModal() {
  if (!progressModal) return;
  progressModal.close();
  progressModal = null;
}

/* ---------------------------
   Util helpers
   --------------------------- */
function formatBytes(bytes) {
  if (bytes == null || bytes === undefined || Number.isNaN(bytes)) return '—';
  const b = Number(bytes);
  if (b < 1024) return `${b} B`;
  if (b < 1024*1024) return `${(b/1024).toFixed(1)} KB`;
  if (b < 1024*1024*1024) return `${(b/1024/1024).toFixed(1)} MB`;
  return `${(b/1024/1024/1024).toFixed(2)} GB`;
}
function escapeHtml(s) { return String(s||'').replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// --- small semver compare used by UI
function compareSemver(a, b) {
  if (!a || !b) return 0;
  const pa = String(a).split('.').map(n => parseInt(n,10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n,10) || 0);
  for (let i=0;i<Math.max(pa.length,pb.length);i++){
    const na = pa[i]||0, nb = pb[i]||0;
    if (na>nb) return 1;
    if (na<nb) return -1;
  }
  return 0;
}

// Format date string to dd/mm/yyyy (handles ISO and common formats). Added to fix missing function error.
function formatDateString(input) {
  try {
    if (!input) return null;
    const d = new Date(input);
    if (!isNaN(d.getTime())) {
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yyyy = d.getFullYear();
      return `${dd}/${mm}/${yyyy}`;
    }
    // fallback: try YYYY-MM-DD substring
    const m = String(input).match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    return String(input);
  } catch (e) {
    return String(input);
  }
}

/* ---------------------------
   Installed heuristics (localStorage)
   --------------------------- */
function installedKeyFor(manifestUrl, versionId) { return `installed:${manifestUrl}::${versionId}`; }
function markInstalled(manifestUrl, versionId) { try { localStorage.setItem(installedKeyFor(manifestUrl, versionId), '1'); } catch(e) {} }
function isMarkedInstalled(manifestUrl, versionId) { try { return localStorage.getItem(installedKeyFor(manifestUrl, versionId)) === '1'; } catch(e) { return false; } }

/* ---------------------------
   fetch helper with logs + robust JSON parsing
   --------------------------- */
async function fetchJsonWithDetails(url) {
  logInfo('Intentando fetch:', url);
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      const txt = await res.text().catch(()=>'<no-body>');
      throw new Error(`HTTP ${res.status} ${res.statusText} - body: ${txt}`);
    }

    const text = await res.text();
    try {
      const j = JSON.parse(text);
      logOk('Fetch OK (JSON parse):', url);
      return j;
    } catch (parseErr) {
      // Intenta sanitizar el JSON (quitar comentarios y trailing-commas) y parsear de nuevo
      logWarn('JSON parse failed, intentando sanitizar texto:', parseErr.message || parseErr);
      const sanitized = sanitizeJsonText(text);
      try {
        const j2 = JSON.parse(sanitized);
        logOk('Fetch OK (JSON sanitized parse):', url);
        return j2;
      } catch (parseErr2) {
        // proveer más contexto en el error
        const snippet = text.substring(0, 512).replace(/\n/g,'\\n');
        throw new Error(`JSON parse error after sanitize: ${parseErr2.message}. Original snippet: ${snippet}`);
      }
    }
  } catch (err) {
    logErr('Fetch failed for', url, '->', err.message || err);
    err.message = `Fetch failed for ${url} -> ${err.message}`;
    throw err;
  }
}

function sanitizeJsonText(txt) {
  if (!txt || typeof txt !== 'string') return txt;
  let s = txt;
  // remove BOM
  s = s.replace(/^\uFEFF/, '');
  // remove // line comments
  s = s.replace(/(^|\n)\s*\/\/.*(?=\n|$)/g, '\n');
  // remove /* */ block comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  // remove trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, '$1');
  // trim
  s = s.trim();
  return s;
}

/* ---------------------------
   Show version status in the UI logs (calls main via preload)
   --------------------------- */
async function showVersionStatusInUI() {
  try {
    if (!window.api || typeof window.api.checkForUpdates !== 'function') {
      logWarn('checkForUpdates no disponible en preload (IPC).');
      return;
    }
    const chk = await window.api.checkForUpdates();
    if (!chk || !chk.ok) {
      logWarn('checkForUpdates falló o devolvió error:', chk && chk.error ? chk.error : '(sin detalles)');
      // still try to fetch local app_version.json via fetch (from app files packaged in renderer)
      let localV = '0.0.0';
      try {
        const res = await fetch('./app_version.json', { cache: 'no-store' });
        if (res.ok) {
          const j = await res.json();
          if (j && j.version) localV = String(j.version);
        }
      } catch (e) {}
      logInfo(`Version ${localV} (no se pudo verificar remoto)`);
      return;
    }

    const res = chk.result || {};
    const localVersion = res.localVersion || '0.0.0';
    const remoteVersion = res.remoteVersion || null;

    // try to fetch launcher-version.json for date (if present)
    let remoteMeta = null;
    try {
      remoteMeta = await fetchJsonWithDetails('https://raw.githubusercontent.com/Pimpoli/MultiGameInc-Launcher/main/launcher-version.json');
    } catch (e) {
      remoteMeta = null;
    }
    const remoteDateRaw = remoteMeta && (remoteMeta.date || remoteMeta.published_at) ? (remoteMeta.date || remoteMeta.published_at) : null;
    const showDate = remoteDateRaw ? formatDateString(remoteDateRaw) : formatDateString(new Date().toISOString());

    if (remoteVersion && compareSemver(remoteVersion, localVersion) > 0) {
      // outdated
      logErr(`Version ${localVersion} ->Esta Desactualizada`);
      logErr(`Fecha: ${showDate}`);
    } else {
      // up-to-date or cannot determine
      logOk(`Version ${localVersion}`);
      logOk(`Fecha: ${showDate}`);
    }
  } catch (e) {
    logWarn('showVersionStatusInUI error:', e && e.message ? e.message : e);
  }
}

/* ---------------------------
   Initialization: splash + load index + default path
   --------------------------- */
async function init() {
  try {
    showSplash('Cargando launcher...');
    updateSplash('Cargando lista de modpacks...');

    // load index: intenta remoto, luego rutas relativas locales (sin usar file:// absoluto)
    try {
      indexData = await fetchJsonWithDetails(INDEX_URL);
      logOk('INDEX cargado desde remote:', INDEX_URL);
    } catch (remoteErr) {
      logWarn('Error cargando INDEX remoto:', remoteErr.message || remoteErr);
      // intentar rutas relativas: ./index.json, index.json, ./assets/index.json
      const localCandidates = ['./index.json','index.json','./assets/index.json'];
      let loaded = false;
      for (const c of localCandidates) {
        try {
          indexData = await fetchJsonWithDetails(c);
          logOk('INDEX cargado desde local:', c);
          loaded = true;
          break;
        } catch (le) {
          logWarn('No se pudo cargar index local', c, '->', le.message || le);
        }
      }
      if (!loaded) {
        logWarn('No se pudo cargar ningún index.json (remote ni local). Se usará lista vacía.');
        indexData = [];
      }
    }

    // populate pack select (placeholder ya en HTML)
    packSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Elige el ModPack';
    placeholder.disabled = true;
    placeholder.selected = true;
    packSelect.appendChild(placeholder);

    if (Array.isArray(indexData) && indexData.length > 0) {
      for (const p of indexData) {
        const opt = document.createElement('option');
        opt.value = p.manifest;
        opt.textContent = p.name || p.manifest || '(sin nombre)';
        packSelect.appendChild(opt);
      }
    } else {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No se cargaron modpacks (ver logs)';
      opt.disabled = true;
      packSelect.appendChild(opt);
    }

    updateSplash('Cargando ruta por defecto de .minecraft...');
    try {
      if (window.api && typeof window.api.getDefaultMinecraftPath === 'function') {
        installPath = await window.api.getDefaultMinecraftPath();
        installPathText.textContent = installPath;
        logOk('Default minecraft path:', installPath);
      } else {
        installPathText.textContent = 'No disponible (preload no expone API)';
        logWarn('getDefaultMinecraftPath no disponible en preload');
      }
    } catch (e) {
      installPathText.textContent = 'No disponible';
      logWarn('getDefaultMinecraftPath error:', e && e.message ? e.message : e);
    }

    updateSplash('Listo');
    await new Promise(r => setTimeout(r, 350));
    hideSplash();
    setStatus('Listo');

    // show version status in the UI logs
    try { await showVersionStatusInUI(); } catch(e){ /* ignore */ }
  } catch (e) {
    hideSplash();
    setStatus('Error cargando launcher');
    logErr('INIT error:', e && e.message ? e.message : e);
    // No mostrar alert intrusivo en init, el log ya contiene info
  }
}

/* ---------------------------
   Populate manifest when selecting pack (version auto)
   --------------------------- */
packSelect.addEventListener('change', ()=>{ if (packSelect.value) loadManifestFor(packSelect.value); });

async function loadManifestFor(manifestPath) {
  setStatus('Cargando manifest...');
  const manifestUrlMain = `https://raw.githubusercontent.com/Pimpoli/LauncherModPack/main/${manifestPath}`;
  const manifestUrlMaster = `https://raw.githubusercontent.com/Pimpoli/LauncherModPack/master/${manifestPath}`;
  const localManifestUrl = `./${manifestPath}`;
  currentManifestUrl = manifestUrlMain;
  currentManifest = null;
  selectedVersionId = null;

  loaderSelect.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Cargando instaladores...';
  loaderSelect.appendChild(placeholder);
  loaderSelect.disabled = true;

  async function tryFetch(url) {
    try {
      const manifest = await fetchJsonWithDetails(url);
      return { ok: true, manifest, url };
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  try {
    let attempt = await tryFetch(manifestUrlMain);
    if (!attempt.ok) {
      logWarn('No se pudo cargar manifest desde main:', attempt.error && attempt.error.message ? attempt.error.message : attempt.error);
      attempt = await tryFetch(manifestUrlMaster);
      if (attempt.ok) {
        currentManifest = attempt.manifest;
        currentManifestUrl = manifestUrlMaster;
        logOk(`Manifest ${currentManifest.name || currentManifest.id} cargado desde remote (master).`);
      } else {
        logWarn('No se pudo cargar manifest desde master:', attempt.error && attempt.error.message ? attempt.error.message : attempt.error);
        const localAttempt = await tryFetch(localManifestUrl);
        if (localAttempt.ok) {
          currentManifest = localAttempt.manifest;
          currentManifestUrl = localManifestUrl;
          logOk(`Manifest ${currentManifest.name || currentManifest.id} cargado desde local (${localManifestUrl}).`);
        } else {
          throw new Error(`No se encontró manifest en las rutas probadas: ${manifestUrlMain}, ${manifestUrlMaster}, ${localManifestUrl}`);
        }
      }
    } else {
      currentManifest = attempt.manifest;
      currentManifestUrl = manifestUrlMain;
      logOk(`Manifest ${currentManifest.name || currentManifest.id} cargado desde remote (main).`);
    }

    // pick recommended or first
    if (Array.isArray(currentManifest.versions) && currentManifest.versions.length > 0) {
      if (currentManifest.recommended) {
        const rec = currentManifest.versions.find(v=>v.id===currentManifest.recommended);
        selectedVersionId = rec ? rec.id : currentManifest.versions[0].id;
      } else selectedVersionId = currentManifest.versions[0].id;
    } else selectedVersionId = null;

    await populateLoaderOptions();

    const marked = isMarkedInstalled(currentManifestUrl, selectedVersionId);
    setPlayAsInstalled(Boolean(marked));
    logInfo(`Estado (heurístico) instalado=${marked} para manifest=${currentManifestUrl} version=${selectedVersionId}`);

    setStatus('Manifest cargado');
  } catch (e) {
    setStatus('Error cargando manifest');
    logErr('Error manifest:', e && e.message ? e.message : e);
    alert('Error cargando manifest. Revisa logs - revisa que el archivo manifest exista en el repo y que index.json apunte a la ruta correcta.');
    loaderSelect.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No hay instaladores (error manifest)';
    loaderSelect.appendChild(opt);
    loaderSelect.disabled = true;
  }
}

/* ---------------------------
   Populate loader options: listInstallers fallback to manifest entries
   --------------------------- */
async function populateLoaderOptions() {
  loaderSelect.innerHTML = '';
  loaderSelect.disabled = true;
  if (!currentManifest) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Elige un ModPack para ver instaladores';
    loaderSelect.appendChild(opt); loaderSelect.disabled = true; return;
  }

  try {
    if (window.api && typeof window.api.listInstallers === 'function') {
      const listRes = await window.api.listInstallers(currentManifestUrl);
      if (listRes && listRes.ok && Array.isArray(listRes.items) && listRes.items.length > 0) {
        for (const it of listRes.items) {
          const opt = document.createElement('option');
          opt.value = it.name || it.download_url;
          opt.dataset.url = it.download_url;
          opt.textContent = it.name;
          loaderSelect.appendChild(opt);
        }
        // preferir Forge antes que Fabric
        let defaultIndex = 0;
        if (loaderSelect.options.length > 1) {
          const idxForge = Array.from(loaderSelect.options).findIndex(o => /forge/i.test(o.value));
          const idxFabric = Array.from(loaderSelect.options).findIndex(o => /fabric/i.test(o.value));
          if (idxForge >= 0) defaultIndex = idxForge; else if (idxFabric >= 0) defaultIndex = idxFabric;
        }
        loaderSelect.selectedIndex = defaultIndex;
        loaderSelect.disabled = false;
        logOk(`Se encontraron ${loaderSelect.options.length} instaladores desde repo.`);
        return;
      }
    }
  } catch (err) {
    logWarn('listInstallers falló:', err && err.message ? err.message : err);
  }

  // fallback: from manifest version files
  const version = (currentManifest.versions || []).find(v=>v.id===selectedVersionId);
  const installers = (version && version.files) ? (version.files || []).filter(f => f.category && String(f.category).toLowerCase() === 'installers') : [];
  if (!installers || installers.length === 0) {
    const opt = document.createElement('option'); opt.value=''; opt.textContent='No se encontraron instaladores'; loaderSelect.appendChild(opt); loaderSelect.disabled = true; logWarn('No se encontraron instaladores declarados en el manifest.'); return;
  }
  for (const inst of installers) {
    const opt = document.createElement('option');
    opt.value = inst.name || inst.url || inst.path || inst.file || inst;
    opt.textContent = inst.displayName || inst.name || inst.url || opt.value;
    loaderSelect.appendChild(opt);
  }
  // elegir por defecto prefiriendo forge
  let preferred = 0;
  if (loaderSelect.options.length > 1) {
    const idxForge = Array.from(loaderSelect.options).findIndex(o => /forge/i.test(o.value));
    const idxFabric = Array.from(loaderSelect.options).findIndex(o => /fabric/i.test(o.value));
    if (idxForge >= 0) preferred = idxForge; else if (idxFabric >= 0) preferred = idxFabric;
  }
  loaderSelect.selectedIndex = preferred;
  loaderSelect.disabled = false;
  logOk(`Se agregaron ${installers.length} instaladores desde manifest (fallback).`);
}

/* ---------------------------
   UI helpers
   --------------------------- */
function setStatus(t) { statusText.textContent = t; }
function setPlayAsInstalled(isInstalled) {
  const label = isInstalled ? 'Jugar' : 'Instalar';
  const subtitle = isInstalled ? 'ModPack detectado' : 'Faltan archivos';
  document.querySelector('.play-text').textContent = label.toUpperCase();
  if (isInstalled) {
    btnPlay.classList.remove('install');
    btnPlay.style.background = '';
  } else {
    btnPlay.classList.add('install');
  }
  setStatus(subtitle);
}

/* ---------------------------
   Select install path
   --------------------------- */
btnSelectPath.addEventListener('click', async () => {
  try {
    if (!window.api || typeof window.api.selectInstallPath !== 'function') {
      logWarn('selectInstallPath no disponible (preload)');
      return;
    }
    const p = await window.api.selectInstallPath();
    if (p) { installPath = p; installPathText.textContent = installPath; logInfo('Install path seleccionado:', installPath); }
  } catch (e) {
    logWarn('selectInstallPath error:', e && e.message ? e.message : e);
  }
});

/* ---------------------------
   Show confirm modal and install flow
   --------------------------- */
btnPlay.addEventListener('click', async () => {
  if (!currentManifestUrl || !currentManifest) return alert('Selecciona un modpack primero.');
  if (!installPath) return alert('Selecciona la carpeta .minecraft antes de instalar.');

  const versionId = selectedVersionId;
  const selectedInstallerName = (loaderSelect && loaderSelect.value) ? loaderSelect.value : null;
  const runAfter = runModeRun.checked;

  const isInstalled = isMarkedInstalled(currentManifestUrl, versionId);

  const title = isInstalled ? `Reinstalar ${currentManifest.name || currentManifest.id}?` : `Instalar ${currentManifest.name || currentManifest.id}?`;
  const message = isInstalled ? `El ModPack ya parece instalado (marcado por el launcher). ¿Deseas reinstalar o actualizar?` : `Se instalarán los archivos del ModPack en la carpeta seleccionada. ¿Deseas continuar?`;
  const wants = await showConfirm(title, message, isInstalled ? 'Reinstalar' : 'Instalar', 'Cancelar');
  if (!wants) { logInfo('Usuario canceló instalación'); return; }

  await runInstallation({
    manifestUrl: currentManifestUrl,
    versionId,
    installPath,
    token: null,
    askInstallLoader: chkAskInstall.checked,
    selectedInstallerName,
    runAfterInstall: runAfter
  });
});

/* ---------------------------
   Installation flow
   --------------------------- */
async function runInstallation(payload) {
  const pm = showProgressModal(`Instalando ${currentManifest && (currentManifest.name || currentManifest.id) || ''}`);
  pm.setSub('Inicializando...');
  pm.setActivity('Preparando descargas...');
  pm.setTotal('—');

  const supportsProgress = (window.api && typeof window.api.onInstallProgress === 'function');
  if (supportsProgress) {
    logInfo('Subscribing to install progress from main/preload.');
    if (progressSubscription && typeof progressSubscription.off === 'function') {
      try { progressSubscription.off(); } catch(e){}
    }
    try {
      progressSubscription = window.api.onInstallProgress((evt) => {
        try {
          if (!progressModal) return;
          const pct = evt.overallPercent != null ? evt.overallPercent : (evt.totalBytes && evt.downloadedBytes ? (evt.downloadedBytes / Math.max(1, evt.totalBytes) * 100) : null);
          if (pct != null) progressModal.setPercent(pct);
          progressModal.setSub(evt.stage ? (`${evt.stage}`) : (evt.fileStatus || 'Procesando...'));
          progressModal.setActivity(evt.currentFile ? `${evt.currentFile} (${evt.fileIndex || ''}/${evt.fileCount || ''})` : (evt.activity || '—'));
          progressModal.setSpeed(evt.speedBytesPerSec != null ? evt.speedBytesPerSec : null);
          if (evt.totalBytes) progressModal.setTotal(`${formatBytes(evt.totalBytes)}`);
          if (Array.isArray(evt.items)) progressModal.setFileList(evt.items.map(i=>({ name: i.name, status: i.status || (i.percent ? Math.round(i.percent)+'%' : ''), percent: i.percent })));
        } catch (uiErr) {
          console.warn('progress event UI error', uiErr);
        }
      });
    } catch (e) {
      logWarn('onInstallProgress subscription failed:', e && e.message ? e.message : e);
    }
  } else {
    let fake = 0;
    pm.setSub('Descargando (modo indeterminado)');
    pm.setActivity('Esperando respuesta del instalador...');
    pm.setSpeed(null);
    pm.setTotal('—');
    if (fallbackTicker) { clearInterval(fallbackTicker); fallbackTicker = null; }
    fallbackTicker = setInterval(()=>{
      fake = (fake + (Math.random()*6 + 2));
      if (fake > 85) fake = 85;
      pm.setPercent(fake);
    }, 700);
  }

  setStatus('Iniciando instalación...');
  btnPlay.disabled = true;
  btnPlay.style.opacity = '0.6';
  logInfo('Instalando pack:', payload.manifestUrl, 'version:', payload.versionId, 'installer:', payload.selectedInstallerName, 'runAfter:', payload.runAfterInstall);

  let resp = null;
  try {
    resp = await window.api.installVersion(payload);
    if (fallbackTicker) { clearInterval(fallbackTicker); fallbackTicker = null; }
    if (progressSubscription && typeof progressSubscription.off === 'function') {
      try { progressSubscription.off(); } catch(e){}
      progressSubscription = null;
    }
    if (!resp || !resp.ok) {
      logErr('Error en instalación:', resp && resp.error ? resp.error : 'sin respuesta ok');
      pm.setSub('Error');
      pm.setActivity(resp && resp.error ? resp.error : 'Error desconocido');
      pm.setPercent(0);
      alert('Error: ' + (resp && resp.error ? resp.error : 'Falló la instalación'));
      setStatus('Error: ' + (resp && resp.error ? resp.error : 'Falló la instalación'));
    } else {
      if (resp.installedLoader) {
        logOk('Loader instalado (ejecutado). Resultado:', resp.execResult || '(sin detalles)');
        pm.setSub('Loader instalado');
        pm.setActivity('Finalizando...');
      } else {
        logOk('Instalación completada correctamente.');
        pm.setSub('Instalación completada');
        pm.setActivity('Completado');
      }
      try { markInstalled(payload.manifestUrl, payload.versionId); setPlayAsInstalled(true); } catch(e) { logWarn('No se pudo marcar instalado en localStorage:', e && e.message ? e.message : e); }
      setStatus('Instalación completada');
      pm.setPercent(100);
      pm.setSpeed(null);
      pm.setTotal(resp && resp.backupDir ? 'Realizado' : '—');
      alert('Instalación completada. Revisa logs y carpeta mods.');
    }
  } catch (e) {
    if (fallbackTicker) { clearInterval(fallbackTicker); fallbackTicker = null; }
    logErr('Exception durante instalación:', e && e.message ? e.message : e);
    pm.setSub('Error inesperado');
    pm.setActivity(e && e.message ? e.message : String(e));
    setStatus('Error inesperado');
    alert('Error inesperado: ' + (e && e.message ? e.message : String(e)));
  } finally {
    setTimeout(()=> {
      try { hideProgressModal(); } catch(e){}
      btnPlay.disabled = false; btnPlay.style.opacity = '1';
    }, 900);
  }
}

/* ---------------------------
   Startup
   --------------------------- */
init();

/* ---------------------------
   Expose a tiny debug helper to window for dev console
   --------------------------- */
window.__mg_debug = {
  showSplash, hideSplash, showProgressModal, hideProgressModal, createProgressModal
};
