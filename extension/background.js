// Service worker: captures video streams per tab, keeps the badge, sends videos to
// ReClip and saves the finished files with chrome.downloads.
import './shared.js';

const S = globalThis.ReclipShared;
const MAX_STREAMS = 20;
const POLL_MS = 3000;

// --- settings and server --------------------------------------------------

async function settings() {
  const s = await chrome.storage.sync.get({ server: S.DEFAULT_SERVER, altServer: S.DEFAULT_ALT_SERVER });
  return { server: s.server.replace(/\/+$/, ''), altServer: (s.altServer || '').replace(/\/+$/, '') };
}

async function reachable(base) {
  try {
    const res = await fetch(`${base}/api/jobs?limit=1`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** The server that answers: the main one, else the alternative (Tailscale). Cached 1 min. */
async function serverBase() {
  const cached = (await chrome.storage.session.get('base')).base;
  if (cached && Date.now() - cached.at < 60000) return cached.url;
  const { server, altServer } = await settings();
  let url = server;
  if (!(await reachable(server)) && altServer && (await reachable(altServer))) url = altServer;
  await chrome.storage.session.set({ base: { url, at: Date.now() } });
  return url;
}

async function api(path, body) {
  const base = await serverBase();
  const res = await fetch(base + path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data;
  try { data = await res.json(); } catch { data = { error: `ReClip respondió ${res.status}` }; }
  return { base, data };
}

// --- per-tab state: page scan and captured streams ------------------------

const tabKey = (kind, tabId) => `${kind}:${tabId}`;

// storage is read-modify-write: run those one after another so no update gets lost
function makeQueue() {
  let tail = Promise.resolve();
  return fn => (tail = tail.then(fn, fn));
}
const tabQueue = makeQueue();
const pendingQueue = makeQueue();

async function getTab(kind, tabId) {
  return (await chrome.storage.session.get(tabKey(kind, tabId)))[tabKey(kind, tabId)];
}

async function updateBadge(tabId) {
  const [scan, streams] = await Promise.all([getTab('scan', tabId), getTab('streams', tabId)]);
  const n = S.videoCount(scan, streams || []);
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#e85d2a' });
    await chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
  } catch {} // the tab is gone
}

async function clearTab(tabId) {
  await chrome.storage.session.remove([tabKey('scan', tabId), tabKey('streams', tabId)]);
}

chrome.webRequest.onBeforeRequest.addListener(
  d => { if (d.tabId >= 0) tabQueue(() => clearTab(d.tabId).then(() => updateBadge(d.tabId))); },
  { urls: ['<all_urls>'], types: ['main_frame'] },
);

chrome.webRequest.onSendHeaders.addListener(
  d => {
    if (d.tabId < 0) return;
    const kind = S.classifyRequest(d.url, d.type);
    if (!kind) return;
    tabQueue(async () => {
      const key = tabKey('streams', d.tabId);
      const streams = (await chrome.storage.session.get(key))[key] || [];
      if (streams.some(s => s.url === d.url)) return;
      streams.push({ url: d.url, kind, headers: S.pickHeaders(d.requestHeaders), seen: Date.now() });
      await chrome.storage.session.set({ [key]: streams.slice(-MAX_STREAMS) });
      await updateBadge(d.tabId);
    });
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] },
  ['requestHeaders', 'extraHeaders'],
);

chrome.tabs.onRemoved.addListener(tabId => { tabQueue(() => clearTab(tabId)); });

// --- downloading ---------------------------------------------------------

const GENERIC_TITLES = /^(master|index|playlist|video|manifest|chunklist|embed|untitled)?$/i;

/**
 * Try the candidates in order: the first one ReClip can read gets downloaded.
 * Without `force`, a video already in ReClip's history is reported, not downloaded.
 */
async function sendCandidates(candidates, { format = 'video', pageTitle = '', force = false } = {}) {
  const errors = [];
  for (const c of candidates) {
    let info;
    try {
      ({ data: info } = await api('/api/info', { url: c.url, headers: c.headers || {} }));
    } catch (e) {
      return { ok: false, error: `No se puede hablar con ReClip (${e.message})` };
    }
    if (info.error) { errors.push({ candidate: c, error: info.error }); continue; }
    if (info.downloaded && !force) return { ok: false, already: info.downloaded, candidate: c, info };

    let title = (info.title || '').trim();
    if (c.kind === 'stream' || GENERIC_TITLES.test(title)) title = pageTitle || title;
    const { data } = await api('/api/download', {
      url: c.url, headers: c.headers || {}, format, title,
      thumbnail: info.thumbnail || '', uploader: info.uploader || '', duration: info.duration,
      source: 'extension',
    });
    if (data.error) return { ok: false, error: data.error };
    await track(data.job_id);
    return { ok: true, jobId: data.job_id, title, candidate: c };
  }
  return { ok: false, error: errors.length ? errors[errors.length - 1].error : 'No hay ningún vídeo que probar', errors };
}

// Jobs this extension started and still has to save: { jobId: true }
async function pending() {
  return (await chrome.storage.local.get({ pending: {} })).pending;
}

async function track(jobId) {
  await pendingQueue(async () => {
    const p = await pending();
    p[jobId] = true;
    await chrome.storage.local.set({ pending: p });
  });
  chrome.alarms.create('poll', { periodInMinutes: 0.5 });
  pollSoon();
}

let pollTimer = null;
function pollSoon() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollJobs, POLL_MS);
}

async function saveJob(base, job) {
  await chrome.downloads.download({
    url: `${base}/api/file/${job.id}`,
    filename: S.safeFilename(job.filename, `${job.id}.mp4`),
    conflictAction: 'uniquify',
  });
}

let polling = false;

async function pollJobs() {
  if (polling) return;
  polling = true;
  try {
    const ids = Object.keys(await pending());
    if (!ids.length) { chrome.alarms.clear('poll'); return; }
    let base, data;
    try {
      ({ base, data } = await api('/api/jobs?limit=200'));
    } catch {
      pollSoon();
      return;
    }
    const byId = Object.fromEntries((data.jobs || []).map(j => [j.id, j]));
    // Gone from the server (it restarted) or finished: stop tracking it
    const ended = ids.filter(id => !byId[id] || byId[id].status !== 'downloading');
    const left = await pendingQueue(async () => {
      const p = await pending();
      ended.forEach(id => delete p[id]);
      await chrome.storage.local.set({ pending: p });
      return Object.keys(p).length;
    });
    for (const job of ended.map(id => byId[id]).filter(Boolean)) {
      if (job.status === 'done') {
        try { await saveJob(base, job); } catch (e) { notify('No se pudo guardar', `${job.title || job.url}: ${e.message}`); }
      } else {
        notify('Descarga fallida', [job.title || job.url, job.error || ''].join('\n'));
      }
    }
    if (left) pollSoon(); else chrome.alarms.clear('poll');
  } finally {
    polling = false;
  }
}

chrome.alarms.onAlarm.addListener(a => { if (a.name === 'poll') pollJobs(); });
chrome.runtime.onStartup.addListener(() => pollJobs());

function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message: message.slice(0, 300) });
}

// --- page scan (from the content script, or injected on demand) ----------

async function scanTab(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, files: ['shared.js', 'content.js'] });
    if (res && res.result) {
      await chrome.storage.session.set({ [tabKey('scan', tabId)]: res.result });
      return res.result;
    }
  } catch {} // chrome:// pages, the Web Store...
  return (await getTab('scan', tabId)) || null;
}

async function tabState(tabId) {
  const scan = await scanTab(tabId);
  const streams = (await getTab('streams', tabId)) || [];
  updateBadge(tabId);
  return { scan, streams, candidates: S.buildCandidates(scan, streams) };
}

// --- context menu --------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'reclip-send',
    title: 'Enviar a ReClip',
    contexts: ['link', 'video', 'audio', 'frame', 'page'],
  });
  pollJobs();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const first = [info.linkUrl, info.srcUrl, info.frameUrl].find(S.isHttp);
  const { scan, candidates } = await tabState(tab.id);
  const list = first ? [{ kind: info.linkUrl ? 'page' : 'player', url: first }, ...candidates] : candidates;
  const result = await sendCandidates(list, { pageTitle: (scan && scan.title) || tab.title });
  if (result.ok) notify('Enviado a ReClip', result.title || result.candidate.url);
  else if (result.already) notify('Ya estaba descargado', `${result.info.title || ''} (${result.already.at.slice(0, 10)}). Desde el icono puedes bajarlo otra vez.`);
  else notify('ReClip no pudo con este vídeo', result.error);
});

// --- messages from the content script and the popup ----------------------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'scan' && sender.tab) {
    const tabId = sender.tab.id;
    tabQueue(() => chrome.storage.session.set({ [tabKey('scan', tabId)]: msg.scan }).then(() => updateBadge(tabId)));
    return false;
  }
  if (msg.type === 'state') {
    tabState(msg.tabId).then(reply);
    return true;
  }
  if (msg.type === 'send') {
    sendCandidates(msg.candidates, msg.options).then(reply, e => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'save') {
    serverBase().then(base => saveJob(base, msg.job)).then(() => reply({ ok: true }), e => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'server') {
    serverBase().then(reply);
    return true;
  }
  return false;
});

// Server settings changed: forget the cached choice
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.server || changes.altServer)) chrome.storage.session.remove('base');
});
