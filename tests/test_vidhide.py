import io
import re
import types

import pytest
import yt_dlp
from yt_dlp.downloader.fragment import FragmentFD
from yt_dlp.utils import ExtractorError
from yt_dlp_plugins.extractor import vidhide

EMBED = "https://playrecord.biz/embed/abcdef123456"


def pack(js):
    """Minimal p,a,c,k,e,d packer: every word becomes its base-36 index."""
    words = list(dict.fromkeys(re.findall(r"\b\w+\b", js)))
    assert len(words) < 36 * 36

    def b36(n):
        digits = "0123456789abcdefghijklmnopqrstuvwxyz"
        return (b36(n // 36) if n >= 36 else "") + digits[n % 36]

    packed = re.sub(r"\b\w+\b", lambda m: b36(words.index(m.group(0))), js)
    return (
        "eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp('\\\\b'+c.toString(a)+'\\\\b','g'),"
        f"k[c]);return p}}('{packed}',36,{len(words)},'{'|'.join(words)}'.split('|')))"
    )


PLAYER = (
    'var links={"hls2":"https://cdn.example/hls2/01/x_,l,n,.urlset/master.m3u8?t=tok&s=1","hls4":"/stream/aa/bb/1/2/master.m3u8"};'
    'jwplayer("vplayer").setup({sources:[{file:links.hls4||links.hls3||links.hls2,type:"hls"}],'
    'image:"https://img.example/abcdef123456_xt.jpg",duration:"683.57"});'
)


def page(script=PLAYER, description="kbj test clip"):
    return (f'<html><head><meta name="description" content="{description}"><title>Embed</title></head>'
            f"<body><script>{pack(script)}</script></body></html>")


# --- player script ---------------------------------------------------------


def test_unpack_and_stream_urls_follow_player_order():
    script = vidhide.unpack(page())
    assert "var links=" in script
    assert vidhide.stream_urls(script, EMBED) == [
        "https://playrecord.biz/stream/aa/bb/1/2/master.m3u8",
        "https://cdn.example/hls2/01/x_,l,n,.urlset/master.m3u8?t=tok&s=1",
    ]


def test_stream_urls_without_links():
    assert vidhide.stream_urls(vidhide.unpack("<html>nothing</html>"), EMBED) == []


# --- fake PNG in front of the TS fragments ---------------------------------

PNG = (vidhide.PNG_SIGNATURE + b"\x00\x00\x00\x0dIHDR" + b"\x00" * 13 + b"crc!"
       + b"\x00\x00\x00\x00IEND" + b"\xae\x42\x60\x82")
TS = (b"\x47" + b"\x11" * 187) * 3


@pytest.mark.parametrize("data,expected", [
    (PNG + TS, TS),
    (TS, TS),
    (PNG, PNG),                         # a real image, nothing after it
    (PNG + b"not a ts stream" * 20, None),
    (PNG[:30], PNG[:30]),               # truncated PNG
    ("text", "text"),                   # e.g. subtitles
])
def test_strip_fake_png(data, expected):
    assert vidhide.strip_fake_png(data) == (data if expected is None else expected)


def test_fragment_downloader_writes_unwrapped_ts():
    out = io.BytesIO()
    with yt_dlp.YoutubeDL({"quiet": True}) as ydl:
        fd = FragmentFD(ydl, {"keep_fragments": True, "_no_ytdl_file": True})
        fd._append_fragment({"dest_stream": out, "fragment_filename_sanitized": "x", "live": False,
                              "tmpfilename": "-"}, PNG + TS)
    assert out.getvalue() == TS


# --- extractor -------------------------------------------------------------


def test_embed_regex_finds_iframes_any_case():
    html = (f'<IFRAME SRC="{EMBED}" FRAMEBORDER=0></IFRAME>'
            "<iframe src=https://vidhidepro.com/e/zzzzzz999999 ></iframe>"
            '<iframe src="https://recordplay.biz/e/icpg81x5osfz" frameborder="0"></iframe>'
            '<IFRAME SRC="https://sfastwish.com/e/goindev9r6rc" FRAMEBORDER=0></IFRAME>'
            '<IFRAME SRC="https://filelions.to/v/5d1k1rlpcdeb" FRAMEBORDER=0></IFRAME>'
            '<iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>'
            '<iframe src="https://evil.example/embed/abcdef123456"></iframe>')
    found = list(vidhide.VidHideReclipIE._extract_embed_urls("https://blog.example/post", html))
    assert found == [EMBED, "https://vidhidepro.com/e/zzzzzz999999", "https://recordplay.biz/e/icpg81x5osfz",
                     "https://sfastwish.com/e/goindev9r6rc", "https://filelions.to/v/5d1k1rlpcdeb"]


@pytest.fixture
def ie(monkeypatch):
    ydl = yt_dlp.YoutubeDL({"quiet": True})
    extractor = vidhide.VidHideReclipIE(ydl)
    extractor.page = page()
    extractor.m3u8_calls = []
    extractor.m3u8_results = {}

    def fake_m3u8(url, video_id, *args, headers=None, **kwargs):
        extractor.m3u8_calls.append((url, headers))
        return extractor.m3u8_results.get(url, [])

    extractor.final_url = None

    def fake_page(url, video_id, **kw):
        return extractor.page, types.SimpleNamespace(url=extractor.final_url or url)

    monkeypatch.setattr(extractor, "_download_webpage_handle", fake_page)
    monkeypatch.setattr(extractor, "_extract_m3u8_formats", fake_m3u8)
    return extractor


def test_extract_info(ie):
    fmt = {"format_id": "hls-2116", "height": 480}
    ie.m3u8_results["https://playrecord.biz/stream/aa/bb/1/2/master.m3u8"] = [fmt]
    info = ie._real_extract(EMBED)
    assert info["id"] == "abcdef123456"
    assert info["title"] == "kbj test clip"
    assert info["thumbnail"] == "https://img.example/abcdef123456_xt.jpg"
    assert info["duration"] == 683.57
    assert info["formats"] == [fmt]
    assert info["http_headers"] == {"Referer": "https://playrecord.biz/", "Origin": "https://playrecord.biz"}
    assert len(ie.m3u8_calls) == 1


def test_extract_falls_back_to_next_link(ie):
    fmt = {"format_id": "hls-1", "height": 720}
    ie.m3u8_results["https://cdn.example/hls2/01/x_,l,n,.urlset/master.m3u8?t=tok&s=1"] = [fmt]
    ie.page = page(description="")
    info = ie._real_extract(EMBED)
    assert info["formats"] == [fmt] and len(ie.m3u8_calls) == 2
    assert info["title"] == "abcdef123456"  # "Embed" is not a title


def test_extract_follows_mirror_redirects(ie):
    ie.final_url = "https://callistanise.com/v/abcdef123456"
    ie.m3u8_results["https://callistanise.com/stream/aa/bb/1/2/master.m3u8"] = [{"format_id": "hls-1"}]
    info = ie._real_extract("https://filelions.to/v/abcdef123456")
    assert info["http_headers"]["Referer"] == "https://callistanise.com/"
    assert ie.m3u8_calls[0][1]["Origin"] == "https://callistanise.com"


def test_extract_without_links_is_a_clear_error(ie):
    ie.page = "<html><title>File not found</title></html>"
    with pytest.raises(ExtractorError, match="No stream links"):
        ie._real_extract(EMBED)
