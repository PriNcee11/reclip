import pytest
import yt_dlp
from yt_dlp.utils import ExtractorError
from yt_dlp_plugins.extractor import embedorigin

EMBED = "https://video.playerrecord.cfd/e/y6x41rf4woaj"
HLS = "https://o3.cdn.example/file/1/tok/uuid/master.m3u8"

API_DATA = {
    "duration": 830, "file_code": "y6x41rf4woaj", "hls": HLS, "mp4": "",
    "poster": "https://img.streamorigin.cc/img/y6x41rf4woaj/splash1.jpg",
    "title": "kbj test clip", "views": 269, "ads": [{"content": "https://ads.example/x"}],
}


def test_valid_url_and_embed_regex():
    assert embedorigin.EmbedOriginReclipIE.suitable(EMBED)
    assert embedorigin.EmbedOriginReclipIE.suitable("https://streamorigin.cc/e/abcdef123456")
    assert not embedorigin.EmbedOriginReclipIE.suitable("https://evil.example/e/abcdef123456")
    html = (f'<iframe src="{EMBED}" frameborder="0"></iframe>'
            '<iframe src="javascript:window.location.replace(this.frameElement.dataset.link)"></iframe>'
            '<IFRAME SRC=https://evil.example/e/abcdef123456></IFRAME>')
    found = list(embedorigin.EmbedOriginReclipIE._extract_embed_urls("https://blog.example/post", html))
    assert found == [EMBED]


def test_mark_video_only_with_separate_audio():
    video = {"format_id": "hls-17076", "vcodec": None, "acodec": None}
    audio = {"format_id": "hls-audio", "vcodec": "none", "acodec": None}
    embedorigin.mark_video_only([video, audio])
    assert video["acodec"] == "none" and audio["acodec"] is None


def test_mark_video_only_leaves_muxed_streams():
    muxed = {"format_id": "hls-1", "vcodec": None, "acodec": None}
    embedorigin.mark_video_only([muxed])
    assert muxed["acodec"] is None


@pytest.fixture
def ie(monkeypatch):
    extractor = embedorigin.EmbedOriginReclipIE(yt_dlp.YoutubeDL({"quiet": True}))
    extractor.data = dict(API_DATA)
    extractor.calls = []

    def fake_json(url, video_id, note=None, headers=None, **kw):
        extractor.calls.append(("json", url, headers))
        return extractor.data

    def fake_m3u8(url, video_id, *args, headers=None, **kw):
        extractor.calls.append(("m3u8", url, headers))
        return [{"format_id": "hls-17076", "vcodec": None, "acodec": None},
                {"format_id": "hls-audio", "vcodec": "none"}]

    monkeypatch.setattr(extractor, "_download_json", fake_json)
    monkeypatch.setattr(extractor, "_extract_m3u8_formats", fake_m3u8)
    return extractor


def test_extract_info(ie):
    info = ie._real_extract(EMBED)
    headers = {"Referer": "https://video.playerrecord.cfd/", "Origin": "https://video.playerrecord.cfd"}
    assert ie.calls == [("json", "https://embedorigin.cc/app/v1/play/y6x41rf4woaj?embed=1", headers),
                        ("m3u8", HLS, headers)]
    assert info["id"] == "y6x41rf4woaj"
    assert info["title"] == "kbj test clip"
    assert info["duration"] == 830.0 and info["view_count"] == 269
    assert info["thumbnail"].endswith("splash1.jpg")
    assert [f["format_id"] for f in info["formats"]] == ["hls-17076", "hls-audio"]
    assert info["formats"][0]["acodec"] == "none"
    assert info["http_headers"] == headers


def test_extract_mp4_only_and_title_fallback(ie):
    ie.data.update(hls="", mp4="https://cdn.example/v.mp4", title="")
    info = ie._real_extract(EMBED)
    assert [f["format_id"] for f in info["formats"]] == ["mp4"]
    assert info["title"] == "y6x41rf4woaj"


def test_extract_without_stream_is_a_clear_error(ie):
    ie.data.update(hls="", mp4="")
    with pytest.raises(ExtractorError, match="no stream"):
        ie._real_extract(EMBED)
