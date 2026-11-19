const S = globalThis.ReclipShared;
const $ = id => document.getElementById(id);

let tab = null;
let state = { scan: null, streams: [], candidates: [] };
let format = 'video';
let base = S.DEFAULT_SERVER;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = u => { try { const x = new URL(u); return x.hostname + x.pathname; } catch { return u; } };
const send = msg => chrome.runtime.sendMessage(msg);

function showMsg(kind, html) {
  const box = $('msg');
  box.className = `msg ${kind}`;
  box.innerHTML = html;
  box.hidden = false;
}

// --- videos on this page --------------------------------------------------

function alreadyHtml(m) {
  const when = m.status === 'done'
    ? `Ya lo descargaste el ${esc(String(m.at || '').slice(0, 10))}`
    : 'Se está descargando ahora mismo';
  return `${when}: <b>${esc(m.title || short(m.url))}</b>`;
}

const GO_LABELS = { idle: 'Descargar', again: 'Descargar otra vez' };
let watching = null; // id of the job the button is following

function setGo(mode, text) {
  const go = $('go');
  go.className = `primary ${mode}`;
  go.disabled = mode === 'loading' || mode === 'done' || mode === 'none';
  go.innerHTML = mode === 'loading' ? `<span class="spin"></span>${esc(text || 'Descargando…')}`
    : mode === 'done' ? `<span class="tick">✓</span>Descargado` : esc(text);
}

const fmtDuration = s => {
  s = Math.round(Number(s) || 0);
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

function renderPreview(info) {
  const box = $('preview');
  if (!info || !info.title) { box.hidden = true; return; }
  const meta = [info.uploader, fmtDuration(info.duration)].filter(Boolean).map(esc).join(' · ');
  box.hidden = false;
  box.innerHTML = `
    ${info.thumbnail ? `<span class="shot" style="background-image:url('${esc(info.thumbnail)}')">${info.duration ? `<b>${esc(fmtDuration(info.duration))}</b>` : ''}</span>` : ''}
    <span class="ptitle">${esc(info.title)}</span>
    ${meta ? `<span class="pmeta">${meta}</span>` : ''}`;
}

function renderCandidates() {
  const list = state.candidates;
  if (watching) return;
  if (!list.length) { setGo('none', 'Nada que descargar aquí'); return; }
  if (state.seen) {
    setGo('again', GO_LABELS.again);
    showMsg('seen', alreadyHtml(state.seen));
  } else {
    setGo('idle', GO_LABELS.idle);
  }
}

async function loadPreview() {
  if (!state.candidates.length || !tab) return;
  renderPreview(await send({ type: 'preview', tabId: tab.id, candidates: state.candidates }));
}

async function download(candidates, force) {
  setGo('loading', 'Preguntando…');
  $('msg').hidden = true;
  const result = await send({
    type: 'send',
    candidates,
    options: {
      format, force,
      pageTitle: (state.scan && (state.scan.ogTitle || state.scan.title)) || (tab && tab.title) || '',
      pageUrl: (tab && tab.url) || '',
    },
  });
  if (result.ok) {
    watching = result.jobId;
    setGo('loading', 'Descargando…');
  } else if (result.already) {
    state.seen = result.already;
    renderCandidates();
  } else {
    setGo('again', 'Reintentar');
    showMsg('error', esc(result.error || 'No se pudo'));
  }
  refreshJobs();
}

// Follow the job the button started: spinner while it runs, green tick when it is done
function followWatched(jobs) {
  if (!watching) return;
  const job = jobs.find(j => j.id === watching);
  if (!job || job.status === 'error') {
    const err = job && job.error;
    watching = null;
    setGo('again', 'Reintentar');
    showMsg('error', esc(err || 'La descarga ha fallado'));
  } else if (job.status === 'done') {
    watching = null;
    setGo('done');
    $('msg').hidden = true;
  } else {
    setGo('loading', S.progressText(job.progress) || 'Descargando…');
  }
}

$('go').onclick = () => download(state.candidates, Boolean(state.seen));

for (const pill of document.querySelectorAll('.pill')) {
  pill.onclick = () => {
    format = pill.dataset.format;
    document.querySelectorAll('.pill').forEach(p => p.classList.toggle('active', p === pill));
  };
}

// --- ReClip's downloads (same list as the page) ------------------------------

const RECENT = 5;
const STATE_LABELS = { downloading: 'Descargando…', done: 'Hecho', error: 'Error' };

async function refreshJobs() {
  let data;
  try {
    const res = await fetch(`${base}/api/jobs?limit=15`);
    data = await res.json();
  } catch {
    $('jobs').innerHTML = `<li class="empty">ReClip no responde en ${esc(base)}</li>`;
    return;
  }
  const jobs = data.jobs || [];
  followWatched(jobs);
  if (!jobs.length) {
    $('jobs').innerHTML = '<li class="empty">Nada todavía</li>';
    return;
  }
  const shown = jobs.slice(0, RECENT);
  $('jobs').innerHTML = shown.map((j, i) => `
    <li title="${esc(j.error || j.url)}">
      <span class="thumb" ${j.thumbnail ? `style="background-image:url('${esc(j.thumbnail)}')"` : ''}></span>
      <span class="title">${esc(j.title || short(j.url))}
        <span class="sub">${j.status === 'downloading'
          ? esc(S.progressText(j.progress) || STATE_LABELS.downloading)
          : `<span class="state ${esc(j.status)}">${esc(STATE_LABELS[j.status] || j.status)}</span>`}${j.duration ? ' · ' + esc(fmtDuration(j.duration)) : ''}</span>
        ${j.status === 'downloading' && j.progress ? `<span class="bar"><i style="width:${Number(j.progress.percent) || 0}%"></i></span>` : ''}
      </span>
      <a class="small" href="#" data-p="${i}" title="Abrir la página">↗</a>
      ${j.status === 'done' ? `<button class="small" data-j="${i}">Guardar</button>` : ''}
    </li>`).join('');
  $('jobs').onclick = async e => {
    const t = e.target.closest('[data-p],[data-j]');
    if (!t) return;
    e.preventDefault();
    if (t.dataset.p !== undefined) {
      const j = shown[Number(t.dataset.p)];
      chrome.tabs.create({ url: S.isHttp(j.page) ? j.page : j.url });
      return;
    }
    const res = await send({ type: 'save', job: shown[Number(t.dataset.j)] });
    if (!res.ok) showMsg('error', esc(res.error));
  };
}

// --- links ---------------------------------------------------------------

$('open').onclick = $('history').onclick = e => { e.preventDefault(); chrome.tabs.create({ url: `${base}/` }); };
$('settings').onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

// --- start -----------------------------------------------------------------

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  base = await send({ type: 'server' });
  refreshJobs();
  setInterval(refreshJobs, 2000);
  if (tab && S.isHttp(tab.url)) {
    state = await send({ type: 'state', tabId: tab.id });
  }
  renderCandidates();
  loadPreview();
})();
