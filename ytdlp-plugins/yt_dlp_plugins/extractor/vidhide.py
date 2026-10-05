"""yt-dlp plugin: VidHide-style embeds (jwplayer behind a p,a,c,k,e,d packer).

Hosts like playrecord.biz serve an /embed/<12 chars> page whose packed script holds
``var links={"hls2": ..., "hls4": ...}``; the player plays the first of hls4/hls3/hls2.
yt-dlp has no extractor for them, so pages that iframe one fail with "Unsupported URL".
With this plugin yt-dlp's generic extractor finds the iframe and this extractor returns
the HLS formats.

StreamWish (sfastwish.com, flaswish.com...) and FileLions (VidHide's old name) use the
same player. Their domains change often and redirect to each other, so any host named
vidhide*, filelions* or *wish* is accepted. Add other mirrors to _DOMAINS (tested against
live pages: playrecord.biz, recordplay.biz, sfastwish.com, filelions.to).

Their HLS segments are disguised as images: a tiny PNG glued in front of the real
MPEG-TS. yt-dlp would concatenate PNG+TS+PNG+TS... into an unplayable file, so this
module also patches yt-dlp's fragment downloader to drop such a leading PNG (see
strip_fake_png; real media fragments never start with a PNG signature).
"""

import re
import struct

from yt_dlp.downloader.fragment import FragmentFD
from yt_dlp.extractor.common import InfoExtractor
from yt_dlp.utils import ExtractorError, decode_packed_codes, float_or_none, urljoin

_DOMAINS = (r"(?:playrecord\.biz|recordplay\.biz"
            r"|(?:vidhide|filelions?)[a-z0-9-]*\.[a-z]{2,10}"
            r"|[a-z0-9-]*wish[a-z0-9-]*\.[a-z]{2,10})")
_PATH = r"/(?:embed|e|v)/(?P<id>[0-9a-z]{12})"

# Order the player itself uses: links.hls4 || links.hls3 || links.hls2
LINK_KEYS = ("hls4", "hls3", "hls2")


def unpack(webpage):
    """The page's player script, unpacked if it is packed."""
    if "eval(function(p,a,c,k,e,d)" in webpage:
        return decode_packed_codes(webpage)
    return webpage


def stream_urls(script, base_url):
    """HLS master URLs from ``var links={...}``, in the player's order, made absolute."""
    m = re.search(r"var\s+links\s*=\s*(\{[^}]*\})", script)
    if not m:
        return []
    links = {k: v for k, v in re.findall(r'"(\w+)"\s*:\s*"([^"]+)"', m.group(1))}
    return [urljoin(base_url, links[k]) for k in LINK_KEYS if links.get(k)]


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
TS_SYNC = 0x47
TS_PACKET = 188


def strip_fake_png(data):
    """Drop a PNG glued in front of an MPEG-TS fragment; anything else comes back unchanged."""
    if not isinstance(data, bytes) or not data.startswith(PNG_SIGNATURE):
        return data
    pos = len(PNG_SIGNATURE)
    while pos + 8 <= len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        pos += 12 + length  # length + type + data + CRC
        if kind == b"IEND":
            break
    else:
        return data
    rest = data[pos:]
    if not rest or rest[0] != TS_SYNC or (len(rest) > TS_PACKET and rest[TS_PACKET] != TS_SYNC):
        return data
    return rest


if not getattr(FragmentFD, "_reclip_png_patch", False):
    _append_fragment = FragmentFD._append_fragment

    def _append_unwrapped_fragment(self, ctx, frag_content):
        return _append_fragment(self, ctx, strip_fake_png(frag_content))

    FragmentFD._append_fragment = _append_unwrapped_fragment
    FragmentFD._reclip_png_patch = True


class VidHideReclipIE(InfoExtractor):
    IE_NAME = "vidhide:reclip"
    _VALID_URL = rf"https?://(?:www\.)?{_DOMAINS}{_PATH}"
    _EMBED_REGEX = [rf"(?i)<iframe[^>]+?\bsrc\s*=\s*[\"']?(?P<url>https?://(?:www\.)?{_DOMAINS}{_PATH})"]

    def _real_extract(self, url):
        video_id = self._match_id(url)
        webpage, urlh = self._download_webpage_handle(url, video_id)
        url = urlh.url  # these hosts redirect between mirrors; the last one serves the video
        script = unpack(webpage)
        streams = stream_urls(script, url)
        if not streams:
            raise ExtractorError("No stream links in the player (removed video or new page layout?)", expected=True)

        origin = re.match(r"https?://[^/]+", url).group(0)
        headers = {"Referer": f"{origin}/", "Origin": origin}
        formats = []
        for stream in streams:
            formats = self._extract_m3u8_formats(
                stream, video_id, "mp4", m3u8_id="hls", fatal=False, headers=headers)
            if formats:
                break
        if not formats:
            raise ExtractorError("None of the stream links worked", expected=True)

        title = (self._html_search_meta("description", webpage, default=None)
                 or self._html_extract_title(webpage, default=None))
        if not title or title.strip().lower() == "embed":
            title = video_id
        return {
            "id": video_id,
            "title": title.strip(),
            "thumbnail": self._search_regex(r'\bimage\s*:\s*"([^"]+)"', script, "thumbnail", default=None),
            "duration": float_or_none(self._search_regex(
                r'\bduration\s*:\s*"?([\d.]+)', script, "duration", default=None)),
            "formats": formats,
            "http_headers": headers,
        }
