// Finds the videos of the page: embedded players (big iframes), <video> elements with a
// real URL and og:video. Reports changes to the service worker (for the badge) and, when
// injected by the popup, returns the scan as the script's value.
(() => {
  const { isHttp, isPlayerFrame } = globalThis.ReclipShared;

  function scan() {
    const players = [];
    for (const f of document.querySelectorAll('iframe')) {
      const r = f.getBoundingClientRect();
      for (const src of [f.src, f.dataset.src, f.dataset.lazySrc]) {
        if (isPlayerFrame({ src, width: r.width, height: r.height }) && !players.includes(src)) players.push(src);
      }
    }
    const videos = [];
    const addVideo = u => { if (isHttp(u) && !videos.includes(u)) videos.push(u); };
    for (const v of document.querySelectorAll('video')) {
      addVideo(v.currentSrc || v.src);
      for (const s of v.querySelectorAll('source')) addVideo(s.src);
    }
    for (const m of document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]')) {
      addVideo(m.content);
    }
    return { url: location.href, title: document.title, players, videos };
  }

  if (!window.__reclipWatching) {
    window.__reclipWatching = true;
    let timer = null;
    let last = '';
    const report = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const data = scan();
        const key = JSON.stringify(data);
        if (key === last) return;
        last = key;
        chrome.runtime.sendMessage({ type: 'scan', scan: data }).catch(() => {});
      }, 800);
    };
    report();
    new MutationObserver(report).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['src'],
    });
    window.addEventListener('load', report);
  }

  return scan();
})();
