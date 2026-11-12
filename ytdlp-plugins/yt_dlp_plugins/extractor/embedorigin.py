"""yt-dlp plugin: Stream Origin embeds (video.playerrecord.cfd/e/<12 chars>).

The embed page is a Next.js app with a JW Player; the player asks a public JSON API
(embedorigin.cc/app/v1/play/<id>?embed=1) for a signed HLS master that expires after
a few hours. yt-dlp has no extractor for it ("Unsupported URL"), so this one calls the
API directly. The API is not behind Cloudflare even when the page that embeds the
player is.

The HLS master lists the video and the audio as separate renditions without codecs,
so yt-dlp can't tell the video carries no audio. The video formats are marked
video-only here; otherwise "bestvideo+bestaudio" would keep a silent file.

The domains change; add new ones to _DOMAINS (tested 2026-11-12 against
video.playerrecord.cfd).
"""

import re

from yt_dlp.extractor.common import InfoExtractor
from yt_dlp.utils import ExtractorError, float_or_none, int_or_none, url_or_none

_DOMAINS = r"(?:[a-z0-9-]+\.)*(?:playerrecord|streamorigin|embedorigin)\.[a-z]{2,10}"
_PATH = r"/(?:e|embed|v|d)/(?P<id>[0-9a-z]{12})"
API = "https://embedorigin.cc/app/v1/play/{id}?embed=1"


def mark_video_only(formats):
    """With a separate audio rendition, the video renditions have no audio of their own."""
    has_audio = any(f.get("vcodec") == "none" for f in formats)
    if has_audio:
        for f in formats:
            if f.get("vcodec") != "none" and not f.get("acodec"):
                f["acodec"] = "none"
    return formats


class EmbedOriginReclipIE(InfoExtractor):
    IE_NAME = "embedorigin:reclip"
    _VALID_URL = rf"https?://{_DOMAINS}{_PATH}"
    _EMBED_REGEX = [rf"(?i)<iframe[^>]+?\bsrc\s*=\s*[\"']?(?P<url>https?://{_DOMAINS}{_PATH})"]

    def _real_extract(self, url):
        video_id = self._match_id(url)
        origin = re.match(r"https?://[^/]+", url).group(0)
        headers = {"Referer": f"{origin}/", "Origin": origin}
        data = self._download_json(API.format(id=video_id), video_id, "Downloading player API JSON",
                                   headers=headers)

        formats = []
        hls = url_or_none(data.get("hls"))
        if hls:
            formats += mark_video_only(self._extract_m3u8_formats(
                hls, video_id, "mp4", m3u8_id="hls", fatal=False, headers=headers))
        mp4 = url_or_none(data.get("mp4"))
        if mp4:
            formats.append({"url": mp4, "format_id": "mp4", "ext": "mp4", "http_headers": headers})
        if not formats:
            raise ExtractorError("The player API returned no stream (removed video or new API?)",
                                 expected=True)

        return {
            "id": video_id,
            "title": (data.get("title") or "").strip() or video_id,
            "thumbnail": url_or_none(data.get("poster")),
            "duration": float_or_none(data.get("duration")),
            "view_count": int_or_none(data.get("views")),
            "formats": formats,
            "http_headers": headers,
        }
