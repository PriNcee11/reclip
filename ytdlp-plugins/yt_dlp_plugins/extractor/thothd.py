"""yt-dlp plugin: thothd.com (KVS player 7.x with plain video_url / video_alt_url).

yt-dlp's KVS extractor looks for a variable called ``flashvars``; this site names it
differently (``t57b31ee539``...) so the generic fallback fails with "Unable to extract
flashvars". The page carries the mp4 URLs unobfuscated in the player's settings object
(``video_url`` = 480p, ``video_alt_url`` = 720p, ``video_alt_urlN`` for more), so this
extractor reads them straight from the page. Other KVS sites with the same layout can be
added to _DOMAINS.
"""

import re

from yt_dlp.extractor.common import InfoExtractor
from yt_dlp.utils import ExtractorError, int_or_none

_DOMAINS = r"(?:thothd\.com)"


def video_sources(webpage):
    """[(url, label)] from the player settings: video_url, video_alt_url, video_alt_url2..."""
    sources = []
    for m in re.finditer(r"\bvideo_(?P<key>url|alt_url\d*)\s*:\s*'(?P<url>https?://[^']+)'", webpage):
        label = re.search(rf"\bvideo_{m.group('key')}_text\s*:\s*'([^']*)'", webpage)
        sources.append((m.group("url"), label.group(1) if label else None))
    return sources


class ThotHDReclipIE(InfoExtractor):
    IE_NAME = "thothd:reclip"
    _VALID_URL = rf"https?://(?:www\.)?{_DOMAINS}/(?:[a-z]{{2}}/)?(?:videos|embed)/(?P<id>\d+)"

    def _real_extract(self, url):
        video_id = self._match_id(url)
        webpage = self._download_webpage(url, video_id)
        sources = video_sources(webpage)
        if not sources:
            raise ExtractorError("No video_url in the player (removed video or new page layout?)", expected=True)

        origin = re.match(r"https?://[^/]+", url).group(0)
        headers = {"Referer": f"{origin}/"}
        formats = []
        for src, label in sources:
            height = int_or_none((re.match(r"(\d+)p", label or "") or [None, None])[1])
            formats.append({
                "url": src,
                "format_id": label or f"mp4-{len(formats)}",
                "height": height,
                "ext": "mp4",
                "http_headers": headers,
            })

        title = (self._search_regex(r"\bvideo_title\s*:\s*'([^']+)'", webpage, "title", default=None)
                 or self._og_search_title(webpage, default=None)
                 or self._html_extract_title(webpage, default=None) or video_id)
        return {
            "id": video_id,
            "title": title.strip(),
            "thumbnail": self._search_regex(r"\bpreview_url\s*:\s*'([^']+)'", webpage, "thumbnail", default=None),
            "formats": formats,
            "http_headers": headers,
        }
