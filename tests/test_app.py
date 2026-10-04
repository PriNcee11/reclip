import json
import os
import subprocess

import pytest

import app as reclip

VID = "https://video.twimg.com/amplify_video/1/vid/avc1/{w}x{h}/abc.mp4?tag=14"


def video(n=1, sizes=((320, 568), (720, 1280))):
    return {
        "type": "video",
        "url": VID.format(w=sizes[-1][0], h=sizes[-1][1]),
        "thumbnail_url": f"https://pbs.twimg.com/thumb{n}.jpg",
        "duration": 10.5,
        "formats": [{"url": "https://video.twimg.com/amplify_video/1/pl/x.m3u8", "container": "m3u8"}]
        + [{"url": VID.format(w=w, h=h), "container": "mp4", "bitrate": w * 1000} for w, h in sizes],
    }


PHOTO = {"type": "photo", "url": "https://pbs.twimg.com/media/p.jpg"}


def tweet(*media, text="hello"):
    return {"id": "123", "text": text, "author": {"name": "Pixy", "screen_name": "pixy"}, "media": {"all": list(media)}}


class Proc:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(reclip, "DOWNLOAD_DIR", str(tmp_path))
    reclip.jobs.clear()
    return reclip.app.test_client()


@pytest.fixture
def fx(monkeypatch):
    """Fake fxtwitter: set fx.tweet; calls are recorded."""
    class Fx:
        tweet = None
        calls = []

    def fake_fetch(user, tweet_id):
        Fx.calls.append((user, tweet_id))
        if Fx.tweet is None:
            raise ValueError("fxtwitter: down")
        return Fx.tweet

    monkeypatch.setattr(reclip, "fx_fetch", fake_fetch)
    return Fx


def fake_ytdlp(monkeypatch, handler):
    calls = []

    def run(cmd, **kwargs):
        calls.append(cmd)
        return handler(cmd)

    monkeypatch.setattr(reclip.subprocess, "run", run)
    return calls


# --- helpers ---------------------------------------------------------------


@pytest.mark.parametrize("url,expected", [
    ("https://x.com/PixyDoodlee/status/2105383672908329402/video/1", ("PixyDoodlee", "2105383672908329402", 1)),
    ("https://twitter.com/a/status/5", ("a", "5", None)),
    ("https://mobile.twitter.com/a/status/5/photo/2?s=20", ("a", "5", 2)),
    ("https://fixupx.com/a/status/5", ("a", "5", None)),
    ("https://x.com/i/web/status/5", ("i", "5", None)),
    ("https://www.youtube.com/watch?v=x", None),
    ("https://x.com/a", None),
])
def test_parse_tweet_url(url, expected):
    assert reclip.parse_tweet_url(url) == expected


def test_error_line_prefers_last_error():
    stderr = "WARNING: a\nERROR: first\nERROR: [twitter] 1: No video could be found in this tweet\n  File x\n"
    assert reclip.error_line(stderr) == "ERROR: [twitter] 1: No video could be found in this tweet"
    assert reclip.error_line("just text\n") == "just text"
    assert reclip.error_line("") == "yt-dlp failed"


def test_fx_variants_best_first_mp4_only_one_per_height():
    v = video(sizes=((320, 568), (720, 1280), (480, 852)))
    v["formats"].append({"url": VID.format(w=720, h=1280) + "&dup", "container": "mp4", "bitrate": 1})
    v["formats"].append({"url": "https://evil.example/720x1280/x.mp4", "container": "mp4", "bitrate": 9e9})
    heights = [x["height"] for x in reclip.fx_variants(v)]
    assert heights == [1280, 852, 568]
    assert all(x["url"].startswith("https://video.twimg.com/") for x in reclip.fx_variants(v))


def test_fx_variants_gif_without_formats_uses_media_url():
    gif = {"type": "gif", "url": "https://video.twimg.com/tweet_video/g.mp4", "height": 300}
    assert reclip.fx_variants(gif) == [{"url": gif["url"], "height": 300, "bitrate": 0}]


def test_run_ytdlp_retries_with_impersonation_only_when_blocked(monkeypatch):
    calls = fake_ytdlp(monkeypatch, lambda cmd: Proc(0) if "--impersonate" in cmd
                       else Proc(1, stderr="ERROR: HTTP Error 403: Forbidden"))
    assert reclip.run_ytdlp(["-j", "u"], timeout=5).returncode == 0
    assert calls == [["yt-dlp", "-j", "u"], ["yt-dlp", "--impersonate", "chrome", "-j", "u"]]

    calls = fake_ytdlp(monkeypatch, lambda cmd: Proc(1, stderr="ERROR: Unsupported URL"))
    assert reclip.run_ytdlp(["-j", "u"], timeout=5).returncode == 1
    assert len(calls) == 1


# --- /api/info -------------------------------------------------------------

TWEET_URL = "https://x.com/pixy/status/123/video/1"


def test_info_uses_ytdlp_when_it_works(client, monkeypatch, fx):
    data = {"title": "t", "formats": [{"format_id": "a", "height": 720, "vcodec": "avc1", "tbr": 1}]}
    fake_ytdlp(monkeypatch, lambda cmd: Proc(0, stdout=json.dumps(data) + "\n"))
    res = client.post("/api/info", json={"url": TWEET_URL})
    assert res.status_code == 200
    assert res.json["formats"] == [{"id": "a", "label": "720p", "height": 720}]
    assert fx.calls == []


def test_info_falls_back_to_fxtwitter_for_hidden_tweets(client, monkeypatch, fx):
    fake_ytdlp(monkeypatch, lambda cmd: Proc(1, stderr="ERROR: [twitter] 123: Video #1 is unavailable"))
    fx.tweet = tweet(video())
    res = client.post("/api/info", json={"url": TWEET_URL})
    assert res.status_code == 200
    body = res.json
    assert body["source"] == "fxtwitter"
    assert body["title"] == "hello" and body["uploader"] == "Pixy" and body["duration"] == 10.5
    assert [f["id"] for f in body["formats"]] == ["fx-1280", "fx-568"]


def test_info_fx_index_counts_photos_like_ytdlp(client, monkeypatch, fx):
    fake_ytdlp(monkeypatch, lambda cmd: Proc(1, stderr="ERROR: nope"))
    fx.tweet = tweet(PHOTO, video(2))
    res = client.post("/api/info", json={"url": "https://x.com/pixy/status/123/video/2"})
    assert res.json["thumbnail"].endswith("thumb2.jpg")

    res = client.post("/api/info", json={"url": "https://x.com/pixy/status/123/photo/1"})
    assert res.status_code == 400 and res.json["error"] == "Media #1 is not a video"


def test_info_photo_only_tweet_says_so(client, monkeypatch, fx):
    fake_ytdlp(monkeypatch, lambda cmd: Proc(1, stderr="ERROR: No video could be found in this tweet"))
    fx.tweet = tweet(PHOTO)
    res = client.post("/api/info", json={"url": "https://x.com/pixy/status/123"})
    assert res.status_code == 400
    assert res.json["error"] == "This post has no video (only images or text)"


def test_info_keeps_ytdlp_error_when_fxtwitter_is_down(client, monkeypatch, fx):
    fake_ytdlp(monkeypatch, lambda cmd: Proc(1, stderr="ERROR: Video #1 is unavailable"))
    res = client.post("/api/info", json={"url": TWEET_URL})
    assert res.status_code == 400 and res.json["error"] == "ERROR: Video #1 is unavailable"


def test_info_no_fallback_for_other_sites(client, monkeypatch, fx):
    fake_ytdlp(monkeypatch, lambda cmd: Proc(1, stderr="ERROR: Unsupported URL"))
    res = client.post("/api/info", json={"url": "https://example.com/v"})
    assert res.status_code == 400 and fx.calls == []


def test_info_fallback_can_be_disabled(client, monkeypatch, fx):
    monkeypatch.setattr(reclip, "FXTWITTER_ENABLED", False)
    fake_ytdlp(monkeypatch, lambda cmd: Proc(1, stderr="ERROR: Video #1 is unavailable"))
    assert client.post("/api/info", json={"url": TWEET_URL}).status_code == 400
    assert fx.calls == []


# --- /api/expand -----------------------------------------------------------


def test_expand_splits_multi_video_posts(client, fx):
    fx.tweet = tweet(video(1), PHOTO, video(3))
    res = client.post("/api/expand", json={"url": "https://twitter.com/whoever/status/123?s=20"})
    assert res.json["urls"] == ["https://x.com/pixy/status/123/video/1", "https://x.com/pixy/status/123/video/3"]


@pytest.mark.parametrize("url", ["https://x.com/pixy/status/123/video/1", "https://youtube.com/watch?v=1"])
def test_expand_leaves_other_urls_alone(client, fx, url):
    fx.tweet = tweet(video(), video())
    assert client.post("/api/expand", json={"url": url}).json["urls"] == [url]
    assert fx.calls == []


def test_expand_single_video_or_failure_unchanged(client, fx):
    url = "https://x.com/pixy/status/123"
    fx.tweet = tweet(video())
    assert client.post("/api/expand", json={"url": url}).json["urls"] == [url]
    fx.tweet = None
    assert client.post("/api/expand", json={"url": url}).json["urls"] == [url]


# --- downloads -------------------------------------------------------------


def writes_file(ext):
    def handler(cmd):
        out = cmd[cmd.index("-o") + 1]
        with open(out.replace("%(ext)s", ext), "w") as f:
            f.write("x")
        return Proc(0)
    return handler


def run_job(url, format_choice="video", format_id=None, title="t"):
    reclip.jobs["j1"] = {"status": "downloading", "url": url, "title": title}
    reclip.run_download("j1", url, format_choice, format_id)
    return reclip.jobs["j1"]


def test_download_args_keep_chosen_quality_for_formats_with_audio():
    args = reclip.download_args("u", "o", "video", "hls-2116")
    assert args[args.index("-f") + 1] == "hls-2116+bestaudio/hls-2116/best"


def test_download_fx_format_goes_straight_to_direct_url(client, monkeypatch, fx):
    fx.tweet = tweet(video())
    calls = fake_ytdlp(monkeypatch, writes_file("mp4"))
    job = run_job(TWEET_URL, format_id="fx-568", title="a/b\nc")
    assert job["status"] == "done" and job["filename"] == "abc.mp4"
    assert len(calls) == 1 and calls[0][-1] == VID.format(w=320, h=568)


def test_download_falls_back_when_ytdlp_fails_on_tweet(client, monkeypatch, fx):
    fx.tweet = tweet(video())

    def handler(cmd):
        if cmd[-1].startswith("https://video.twimg.com/"):
            return writes_file("mp3")(cmd)
        return Proc(1, stderr="ERROR: Video #1 is unavailable")

    calls = fake_ytdlp(monkeypatch, handler)
    job = run_job(TWEET_URL, format_choice="audio")
    assert job["status"] == "done" and job["file"].endswith(".mp3")
    assert calls[-1][-1] == VID.format(w=720, h=1280) and "-x" in calls[-1]


def test_download_error_reported_for_other_sites(client, monkeypatch, fx):
    fake_ytdlp(monkeypatch, lambda cmd: Proc(1, stderr="ERROR: boom\n"))
    job = run_job("https://example.com/v")
    assert job == {**job, "status": "error", "error": "ERROR: boom"}
    assert fx.calls == []


def test_download_timeout(client, monkeypatch, fx):
    def handler(cmd):
        raise subprocess.TimeoutExpired(cmd, 300)

    fake_ytdlp(monkeypatch, handler)
    assert run_job("https://example.com/v")["error"] == "Download timed out (5 min limit)"
    assert not os.listdir(reclip.DOWNLOAD_DIR)
