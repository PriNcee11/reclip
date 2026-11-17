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

// Badge: how many videos the page has. Green: there is something new to download.
// Orange: this page or its video is already downloaded (or downloading right now).
const BADGE_NEW = '#2d8a4e';
const BADGE_SEEN = '#e85d2a';

async function updateBadge(tabId) {
  const [scan, streams, seen] = await Promise.all([getTab('scan', tabId), getTab('streams', tabId), getTab('seen', tabId)]);
  const match = seen && seen.match;
  const n = S.videoCount(scan, streams || []);
  const text = n ? String(n) : match ? '✓' : '';
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: match ? BADGE_SEEN : BADGE_NEW });
    await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
    await chrome.action.setBadgeText({ tabId, text });
  } catch {} // the tab is gone
}

async function clearTab(tabId) {
  await chrome.storage.session.remove([tabKey('scan', tabId), tabKey('streams', tabId), tabKey('seen', tabId), tabKey('preview', tabId)]);
}

/** Ask ReClip (cheap, no yt-dlp) whether one of these links was downloaded or is downloading. */
async function lookup(urls) {
  const list = [...new Set(urls.filter(S.isHttp))];
  if (!list.length) return null;
  const { data } = await api('/api/lookup', { urls: list });
  return data.match || null;
}

/** The page's own links: its address and its players and videos (not the captured streams). */
function pageLinks(url, scan) {
  return [url, scan && scan.url, ...((scan && scan.players) || []), ...((scan && scan.videos) || [])];
}

/** Keep the tab's "already downloaded" mark up to date (asks again only when its links change). */
async function checkSeen(tabId, { again = false } = {}) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return null; }
  if (!S.isHttp(tab.url)) return null;
  const urls = pageLinks(tab.url, await getTab('scan', tabId));
  const key = JSON.stringify(urls);
  const old = await getTab('seen', tabId);
  if (!again && old && old.key === key) return old;
  let match;
  try { match = await lookup(urls); } catch { return old; } // ReClip unreachable: keep what we had
  const seen = { key, match };
  await chrome.storage.session.set({ [tabKey('seen', tabId)]: seen });
  await updateBadge(tabId);
  return seen;
}

/** After a download starts or ends, refresh the mark of the tabs it may concern. */
async function recheckTabs() {
  const all = await chrome.storage.session.get(null);
  const ids = Object.keys(all)
    .filter(k => k.startsWith('scan:') || k.startsWith('seen:'))
    .map(k => Number(k.split(':')[1]));
  for (const id of new Set(ids)) checkSeen(id, { again: true });
}

function alreadyText(m) {
  return m.status === 'done'
    ? `Ya lo descargaste el ${String(m.at || '').slice(0, 10)}`
    : 'Se está descargando ahora mismo';
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

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url) {
    // In-page navigation (YouTube and the like): forget the old mark first
    chrome.storage.session.remove(tabKey('seen', tabId)).then(() => checkSeen(tabId));
  } else if (change.status === 'complete') {
    checkSeen(tabId);
  }
});

// --- downloading ---------------------------------------------------------

const GENERIC_TITLES = /^(master|index|playlist|video|manifest|chunklist|embed|untitled)?$/i;

/**
 * Try the candidates in order: the first one ReClip can read gets downloaded.
 * Without `force`, a page or video already downloaded (or downloading) is reported instead.
 */
async function sendCandidates(candidates, { format = 'video', pageTitle = '', pageUrl = '', force = false } = {}) {
  const errors = [];
  if (!force) {
    let match = null;
    try {
      match = await lookup([pageUrl, ...candidates.map(c => c.url)]);
    } catch (e) {
      return { ok: false, error: `No se puede hablar con ReClip (${e.message})` };
    }
    if (match) return { ok: false, already: match, candidate: candidates[0] };
  }
  for (const c of candidates) {
    let info;
    try {
      ({ data: info } = await api('/api/info', { url: c.url, headers: c.headers || {} }));
    } catch (e) {
      return { ok: false, error: `No se puede hablar con ReClip (${e.message})` };
    }
    if (info.error) { errors.push({ candidate: c, error: info.error }); continue; }
    if (info.downloaded && !force) return { ok: false, already: { ...info.downloaded, status: 'done' }, candidate: c };

    let title = (info.title || '').trim();
    if (c.kind === 'stream' || GENERIC_TITLES.test(title)) title = pageTitle || title;
    const { data } = await api('/api/download', {
      url: c.url, headers: c.headers || {}, format, title,
      thumbnail: info.thumbnail || '', uploader: info.uploader || '', duration: info.duration,
      source: 'extension', page: S.isHttp(pageUrl) ? pageUrl : '',
    });
    if (data.error) return { ok: false, error: data.error };
    await track(data.job_id);
    recheckTabs();
    return { ok: true, jobId: data.job_id, title, candidate: c };
  }
  return { ok: false, error: errors.length ? errors[errors.length - 1].error : 'No hay ningún vídeo que probar', errors };
}

/** Title, thumbnail and length of the video this tab would download (first candidate ReClip can read). Cached per tab. */
async function previewTab(tabId, candidates) {
  const key = JSON.stringify(candidates.map(c => c.url));
  const old = await getTab('preview', tabId);
  if (old && old.key === key) return old.info;
  let info = null;
  for (const c of candidates) {
    try {
      const { data } = await api('/api/info', { url: c.url, headers: c.headers || {} });
      if (!data.error) { info = { title: data.title || '', thumbnail: data.thumbnail || '', duration: data.duration || null, uploader: data.uploader || '' }; break; }
    } catch { return null; }
  }
  await chrome.storage.session.set({ [tabKey('preview', tabId)]: { key, info } });
  return info;
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
    if (ended.length) recheckTabs();
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
  const seen = await checkSeen(tabId);
  updateBadge(tabId);
  return { scan, streams, candidates: S.buildCandidates(scan, streams), seen: (seen && seen.match) || null };
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
  // A specific link is its own video: the page it sits on says nothing about it
  const pageUrl = info.linkUrl ? '' : tab.url;
  const result = await sendCandidates(list, { pageTitle: (scan && scan.title) || tab.title, pageUrl });
  if (result.ok) notify('Enviado a ReClip', result.title || result.candidate.url);
  else if (result.already) notify(alreadyText(result.already), `${result.already.title || ''}. Desde el icono puedes bajarlo otra vez.`);
  else notify('ReClip no pudo con este vídeo', result.error);
});

// --- messages from the content script and the popup ----------------------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'scan' && sender.tab) {
    const tabId = sender.tab.id;
    tabQueue(() => chrome.storage.session.set({ [tabKey('scan', tabId)]: msg.scan }).then(() => updateBadge(tabId)))
      .then(() => checkSeen(tabId));
    return false;
  }
  if (msg.type === 'state') {
    tabState(msg.tabId).then(reply);
    return true;
  }
  if (msg.type === 'preview') {
    previewTab(msg.tabId, msg.candidates).then(reply, () => reply(null));
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
