const S = globalThis.ReclipShared;
const $ = id => document.getElementById(id);

chrome.storage.sync.get({ server: S.DEFAULT_SERVER, altServer: S.DEFAULT_ALT_SERVER }).then(s => {
  $('server').value = s.server;
  $('altServer').value = s.altServer;
});

async function check(url) {
  try {
    const res = await fetch(`${url}/api/jobs?limit=1`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

$('save').onclick = async () => {
  const server = $('server').value.trim().replace(/\/+$/, '') || S.DEFAULT_SERVER;
  const altServer = $('altServer').value.trim().replace(/\/+$/, '');
  if (![server, altServer].filter(Boolean).every(S.isHttp)) {
    $('status').className = 'state error';
    $('status').textContent = 'Las direcciones deben empezar por http:// o https://';
    return;
  }
  await chrome.storage.sync.set({ server, altServer });
  $('status').className = 'state';
  $('status').textContent = 'Guardado. Comprobando…';
  const ok = await check(server);
  $('status').className = `state ${ok ? 'done' : 'error'}`;
  $('status').textContent = ok ? 'Guardado. ReClip responde.' : 'Guardado, pero el servidor principal no responde.';
};
