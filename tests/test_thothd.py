import pytest
import yt_dlp
from yt_dlp.utils import ExtractorError
from yt_dlp_plugins.extractor import thothd

URL = "https://thothd.com/es/videos/10312/some-slug/"
PAGE = """<html><script>
 video_id: '10312', video_title: 'Clip de prueba',
 video_url: 'https://thothd.com/es/get_file/1/aa/10000/10312/10312.mp4/?v-acctoken=x',
 video_url_text: '480p',
 video_alt_url: 'https://thothd.com/es/get_file/1/bb/10000/10312/10312_720p.mp4/?v-acctoken=y',
 video_alt_url_text: '720p',
 preview_url: 'https://thothd.com/contents/videos_screenshots/10000/10312/preview.jpg',
</script></html>"""


def test_video_sources_in_page_order_with_labels():
    assert thothd.video_sources(PAGE) == [
        ("https://thothd.com/es/get_file/1/aa/10000/10312/10312.mp4/?v-acctoken=x", "480p"),
        ("https://thothd.com/es/get_file/1/bb/10000/10312/10312_720p.mp4/?v-acctoken=y", "720p"),
    ]


def test_no_sources():
    assert thothd.video_sources("<html></html>") == []


def test_extract_returns_both_qualities(monkeypatch):
    ie = thothd.ThotHDReclipIE(yt_dlp.YoutubeDL({"quiet": True}))
    monkeypatch.setattr(ie, "_download_webpage", lambda *a, **k: PAGE)
    info = ie._real_extract(URL)
    assert info["id"] == "10312" and info["title"] == "Clip de prueba"
    assert [(f["format_id"], f["height"]) for f in info["formats"]] == [("480p", 480), ("720p", 720)]
    assert info["formats"][0]["http_headers"]["Referer"] == "https://thothd.com/"


def test_extract_without_player_fails_cleanly(monkeypatch):
    ie = thothd.ThotHDReclipIE(yt_dlp.YoutubeDL({"quiet": True}))
    monkeypatch.setattr(ie, "_download_webpage", lambda *a, **k: "<html></html>")
    with pytest.raises(ExtractorError):
        ie._real_extract(URL)


@pytest.mark.parametrize("url", [URL, "https://thothd.com/videos/10312/x/", "https://www.thothd.com/es/embed/10312"])
def test_url_match(url):
    assert thothd.ThotHDReclipIE.suitable(url)
