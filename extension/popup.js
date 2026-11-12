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

function renderCandidates() {
  const list = state.candidates;
  const found = list.filter(c => c.kind !== 'page').length;
  const go = $('go');
  go.disabled = !list.length;
  go.textContent = found ? `Descargar vídeo de esta página (${found})` : list.length ? 'Descargar esta página' : 'Nada que descargar aquí';
  if (state.seen && list.length) {
    go.textContent = 'Descargar otra vez';
    showMsg('seen', alreadyHtml(state.seen));
  }
  $('candidates').innerHTML = list.map((c, i) => `
    <li title="${esc(c.url)}">
      <span class="kind">${esc(S.KIND_LABELS[c.kind] || c.kind)}${c.type ? ' ' + esc(c.type.toUpperCase()) : ''}</span>
      <span class="url">${esc(short(c.url))}</span>
      <button class="small" data-i="${i}">↓</button>
    </li>`).join('');
}

async function download(candidates, force) {
  $('go').disabled = true;
  showMsg('', 'Preguntando a ReClip…');
  const result = await send({
    type: 'send',
    candidates,
    options: {
      format, force,
      pageTitle: (state.scan && state.scan.title) || (tab && tab.title) || '',
      pageUrl: (tab && tab.url) || '',
    },
  });
  $('go').disabled = false;
  if (result.ok) {
    showMsg('ok', `Descargando <b>${esc(result.title || short(result.candidate.url))}</b>. Se guardará solo al terminar.`);
  } else if (result.already) {
    state.seen = result.already;
    showMsg('seen', `${alreadyHtml(result.already)}<br>
      <button class="small" id="again">Descargar otra vez</button>`);
    $('again').onclick = () => download(state.candidates, true);
  } else {
    showMsg('error', esc(result.error || 'No se pudo'));
  }
  refreshJobs();
}

// Known as downloaded: the button itself means "again" (the notice is already shown)
$('go').onclick = () => download(state.candidates, Boolean(state.seen));
$('candidates').onclick = e => {
  const i = e.target.dataset && e.target.dataset.i;
  if (i !== undefined) download([state.candidates[Number(i)]], true);
};

for (const pill of document.querySelectorAll('.pill')) {
  pill.onclick = () => {
    format = pill.dataset.format;
    document.querySelectorAll('.pill').forEach(p => p.classList.toggle('active', p === pill));
  };
}

// --- ReClip's downloads (same list as the page) ------------------------------

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
  if (!jobs.length) {
    $('jobs').innerHTML = '<li class="empty">Nada todavía</li>';
    return;
  }
  $('jobs').innerHTML = jobs.map((j, i) => `
    <li title="${esc(j.error || j.url)}">
      <span class="thumb" ${j.thumbnail ? `style="background-image:url('${esc(j.thumbnail)}')"` : ''}></span>
      <span class="title">${esc(j.title || short(j.url))}
        ${j.status === 'downloading' && j.progress ? `<span class="bar"><i style="width:${Number(j.progress.percent) || 0}%"></i></span>` : ''}
      </span>
      ${j.status === 'done'
        ? `<button class="small" data-j="${i}">Guardar</button>`
        : `<span class="state ${esc(j.status)}">${esc((j.status === 'downloading' && S.progressText(j.progress)) || STATE_LABELS[j.status] || j.status)}</span>`}
    </li>`).join('');
  $('jobs').onclick = async e => {
    const i = e.target.dataset && e.target.dataset.j;
    if (i === undefined) return;
    const res = await send({ type: 'save', job: jobs[Number(i)] });
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
})();
