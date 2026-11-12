// Logic shared by the content script, the service worker, the popup and the tests.
// A classic script (content scripts can't be modules): it fills globalThis.ReclipShared.
(() => {
  const DEFAULT_SERVER = 'http://192.168.1.21:5018';
  // i7 over Tailscale, for when the LAN address doesn't answer
  const DEFAULT_ALT_SERVER = 'http://100.98.169.38:5018';

  // Embedded frames smaller than this are not players (buttons, trackers, banners)
  const MIN_W = 200;
  const MIN_H = 150;
  // Standard ad banner sizes that pass the minimum
  const AD_SIZES = new Set(['300x250', '336x280', '300x600', '320x480', '250x250']);
  const AD_HOSTS = /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|adnxs\.com|taboola\.com|outbrain\.com|exoclick\.com|juicyads\.com|trafficjunky\.net|adsterra\.com|amazon-adsystem\.com)$/i;

  const isHttp = u => typeof u === 'string' && /^https?:\/\//i.test(u);
  const hostOf = u => { try { return new URL(u).hostname; } catch { return ''; } };

  /** Whether an iframe (src and its rendered size) looks like a video player. */
  function isPlayerFrame({ src, width, height }) {
    if (!isHttp(src)) return false;
    if (width < MIN_W || height < MIN_H) return false;
    if (AD_SIZES.has(`${Math.round(width)}x${Math.round(height)}`)) return false;
    return !AD_HOSTS.test(hostOf(src));
  }

  // Requests seen by the extension that are a whole video or its playlist.
  // Segments (.ts, .m4s...) and subtitle/key files are pieces, never the video.
  const PLAYLIST_RE = /\.(m3u8|mpd)(?:[?#]|$)/i;
  const FILE_RE = /\.(mp4|webm|m4v|mov|mkv)(?:[?#]|$)/i;
  const SEGMENT_RE = /\.(ts|m4s|aac|m4a|vtt|srt|key|jpg|png|webp)(?:[?#]|$)/i;

  /** 'hls' | 'dash' | 'file' | null for one network request. */
  function classifyRequest(url, type) {
    if (!isHttp(url) || SEGMENT_RE.test(url)) return null;
    const m = url.match(PLAYLIST_RE);
    if (m) return m[1].toLowerCase() === 'm3u8' ? 'hls' : 'dash';
    if (FILE_RE.test(url) && (type === 'media' || type === 'xmlhttprequest' || type === 'other')) return 'file';
    return null;
  }

  /** Referer/Origin/User-Agent out of a webRequest requestHeaders list. */
  function pickHeaders(requestHeaders) {
    const wanted = { referer: 'Referer', origin: 'Origin', 'user-agent': 'User-Agent' };
    const out = {};
    for (const h of requestHeaders || []) {
      const name = wanted[(h.name || '').toLowerCase()];
      if (name && h.value) out[name] = h.value;
    }
    return out;
  }

  /** Streams worth offering: the first playlist seen is usually the master one. */
  function rankStreams(streams) {
    const score = s => (s.kind === 'file' ? 2 : 0) + (/master|playlist|index/i.test(s.url) ? -1 : 0);
    return [...streams].sort((a, b) => score(a) - score(b) || a.seen - b.seen);
  }

  /**
   * What to try, in order: the players on the page (yt-dlp knows many of them),
   * the page itself (YouTube, X...), then the captured streams with their headers.
   */
  function buildCandidates(scan, streams) {
    const out = [];
    const seen = new Set();
    const add = c => { if (isHttp(c.url) && !seen.has(c.url)) { seen.add(c.url); out.push(c); } };
    for (const url of (scan && scan.players) || []) add({ kind: 'player', url });
    for (const url of (scan && scan.videos) || []) add({ kind: 'video', url });
    if (scan && scan.url) add({ kind: 'page', url: scan.url });
    for (const s of rankStreams(streams || [])) add({ kind: 'stream', url: s.url, headers: s.headers || {}, type: s.kind });
    return out;
  }

  /** Videos found on the page (for the badge): players, direct videos, captured streams. */
  function videoCount(scan, streams) {
    const page = ((scan && scan.players) || []).length + ((scan && scan.videos) || []).length;
    return page || ((streams || []).length ? 1 : 0);
  }

  const KIND_LABELS = { player: 'Reproductor', video: 'Vídeo', page: 'Página', stream: 'Stream' };

  /** A file name Chrome accepts (no path separators or reserved characters). */
  function safeFilename(name, fallback) {
    const clean = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
    return clean.slice(0, 150) || fallback;
  }

  /** "45% · 3.2 MB/s · 2:10" from a job's progress (null: nothing to show yet). */
  function progressText(p) {
    if (!p) return '';
    const out = [];
    if (p.percent != null) out.push(`${Math.floor(p.percent)}%`);
    if (p.part > 1) out.push(`parte ${p.part}`);
    if (p.speed) out.push(p.speed >= 1048576 ? `${(p.speed / 1048576).toFixed(1)} MB/s` : `${Math.round(p.speed / 1024)} KB/s`);
    if (p.eta != null && p.percent != null && p.percent < 100) {
      const m = Math.floor(p.eta / 60);
      out.push(m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}:${String(p.eta % 60).padStart(2, '0')}`);
    }
    if (!out.length && p.bytes) out.push(`${(p.bytes / 1048576).toFixed(0)} MB`);
    return out.join(' · ');
  }

  globalThis.ReclipShared = {
    DEFAULT_SERVER, DEFAULT_ALT_SERVER, KIND_LABELS,
    isHttp, isPlayerFrame, classifyRequest, pickHeaders, rankStreams, buildCandidates, videoCount, safeFilename,
    progressText,
  };
})();
