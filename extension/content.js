// Finds the videos of the page: embedded players (big iframes), <video> elements with a
// real URL and og:video. Reports changes to the service worker (for the badge) and, when
// injected by the popup, returns the scan as the script's value. It also remembers what
// was last right-clicked, so "Enviar a ReClip" can name the video after it.
(() => {
  const { isHttp, isPlayerFrame } = globalThis.ReclipShared;
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const CLICK_TTL = 20000;

  // The title of what was right-clicked: the post that holds it (X and the like),
  // the link's text, the element's own label or the nearest caption or heading.
  function titleNear(el) {
    if (!(el instanceof Element)) return '';
    const post = el.closest('article');
    if (post) {
      const text = post.querySelector('[data-testid="tweetText"], h1, h2, h3');
      if (text && clean(text.innerText)) return clean(text.innerText);
    }
    const link = el.closest('a[href]');
    if (link) {
      const img = link.querySelector('img[alt]');
      const t = clean(link.getAttribute('aria-label') || link.getAttribute('title') || link.innerText) || clean(img && img.alt);
      if (t) return t;
    }
    for (let node = el, depth = 0; node && node !== document.body && depth < 5; node = node.parentElement, depth++) {
      const own = clean(node.getAttribute('aria-label') || node.getAttribute('title'));
      if (own) return own;
      const cap = node.querySelector('figcaption, h1, h2, h3');
      if (cap && clean(cap.innerText)) return clean(cap.innerText);
    }
    return '';
  }

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
    const og = document.querySelector('meta[property="og:title"]');
    return { url: location.href, title: document.title, ogTitle: clean(og && og.content), players, videos };
  }

  if (!window.__reclipWatching) {
    window.__reclipWatching = true;
    document.addEventListener('contextmenu', e => {
      window.__reclipClicked = { title: titleNear(e.target).slice(0, 300), at: Date.now() };
    }, true);
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

  const clicked = window.__reclipClicked;
  return { ...scan(), clicked: clicked && Date.now() - clicked.at < CLICK_TTL ? clicked.title : '' };
})();
