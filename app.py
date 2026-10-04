import glob
import json
import logging
import os
import re
import subprocess
import threading
import urllib.error
import urllib.request
import uuid
from urllib.parse import quote, urlparse

from flask import Flask, jsonify, render_template, request, send_file

app = Flask(__name__)
DOWNLOAD_DIR = os.path.join(os.path.dirname(__file__), "downloads")
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] [reclip] %(levelname)s %(message)s")
log = logging.getLogger("reclip")

# Public API that mirrors tweets X hides from logged-out clients (sensitive media).
# Used only as a fallback when yt-dlp can't get a video out of an X/Twitter post.
FXTWITTER_API = os.environ.get("RECLIP_FXTWITTER_API", "https://api.fxtwitter.com").rstrip("/")
FXTWITTER_ENABLED = os.environ.get("RECLIP_FXTWITTER", "1") != "0"

# Browser to impersonate (needs curl_cffi) when a site blocks yt-dlp's plain client.
IMPERSONATE_TARGET = os.environ.get("RECLIP_IMPERSONATE", "chrome")
IMPERSONATE_HINTS = ("http error 403", "http error 503", "cloudflare", "impersonat", "captcha")

TWEET_RE = re.compile(
    r"^https?://(?:www\.|mobile\.)?(?:twitter|x|fxtwitter|vxtwitter|fixupx|fixvx)\.com/"
    r"(?:(?P<user>[^/?#]+)/(?:web/)?status|statuses)/(?P<id>\d+)"
    r"(?:/(?:video|photo)/(?P<index>\d+))?",
    re.IGNORECASE,
)

jobs = {}


def parse_ytdlp_json(stdout):
    """Parse yt-dlp JSON output.

    With ``-j`` yt-dlp prints one JSON object per line. Some extractors
    emit multiple videos even with ``--no-playlist``, so stdout contains
    several objects and a plain ``json.loads`` raises "Extra data".
    Return the first valid object.
    """
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        return json.loads(line)
    raise ValueError("yt-dlp returned no data")


def error_line(stderr):
    """Most useful line of yt-dlp's stderr: the last ERROR, else the last line."""
    lines = [line.strip() for line in stderr.strip().splitlines() if line.strip()]
    errors = [line for line in lines if line.startswith("ERROR:")]
    if errors:
        return errors[-1]
    return lines[-1] if lines else "yt-dlp failed"


def needs_impersonation(stderr):
    text = stderr.lower()
    return any(hint in text for hint in IMPERSONATE_HINTS)


def run_ytdlp(args, timeout):
    """Run yt-dlp; if the site looks like it blocked us, retry once as a real browser."""
    result = subprocess.run(["yt-dlp", *args], capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0 and IMPERSONATE_TARGET and needs_impersonation(result.stderr):
        log.info("retrying with --impersonate %s: %s", IMPERSONATE_TARGET, error_line(result.stderr))
        result = subprocess.run(
            ["yt-dlp", "--impersonate", IMPERSONATE_TARGET, *args],
            capture_output=True, text=True, timeout=timeout,
        )
    return result


# --- X/Twitter fallback via fxtwitter -------------------------------------


class FxError(ValueError):
    """The post was found, but it has nothing downloadable at that position."""


def parse_tweet_url(url):
    """Return (user, tweet_id, media_index or None) for an X/Twitter post URL."""
    m = TWEET_RE.match(url.strip())
    if not m:
        return None
    index = int(m.group("index")) if m.group("index") else None
    return (m.group("user") or "i", m.group("id"), index)


def fx_fetch(user, tweet_id):
    api_url = f"{FXTWITTER_API}/{quote(user, safe='')}/status/{tweet_id}"
    req = urllib.request.Request(api_url, headers={"User-Agent": "reclip"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        try:
            message = json.load(e).get("message")
        except Exception:
            message = None
        raise ValueError(f"fxtwitter: {message or e}") from e
    tweet = data.get("tweet")
    if not tweet:
        raise ValueError(f"fxtwitter: {data.get('message') or 'no tweet in response'}")
    return tweet


def fx_media(tweet):
    """All media of the post, in X's order (the N in /video/N counts photos too).

    Like yt-dlp, fall back to the quoted post when the post itself has none.
    """
    media = (tweet.get("media") or {}).get("all") or []
    if not media:
        media = ((tweet.get("quote") or {}).get("media") or {}).get("all") or []
    return media


def is_video(media):
    return media.get("type") in ("video", "gif")


def is_twimg(url):
    return urlparse(url).hostname == "video.twimg.com"


def fx_variants(media):
    """Progressive MP4s of one video, best first, one per height."""
    variants = []
    for f in media.get("formats") or media.get("variants") or []:
        url = f.get("url") or ""
        if "mp4" not in (f.get("container") or f.get("content_type") or ""):
            continue
        if not is_twimg(url):
            continue
        size = re.search(r"/(\d+)x(\d+)/", url)
        height = int(size.group(2)) if size else None
        variants.append({"url": url, "height": height, "bitrate": f.get("bitrate") or 0})
    if not variants and is_twimg(media.get("url") or ""):
        variants.append({"url": media["url"], "height": media.get("height"), "bitrate": 0})

    variants.sort(key=lambda v: (v["height"] or 0, v["bitrate"]), reverse=True)
    best = {}
    for v in variants:
        best.setdefault(v["height"], v)
    return list(best.values())


def fx_select(url):
    """Resolve an X post URL to (tweet, media, variants) through fxtwitter."""
    user, tweet_id, index = parse_tweet_url(url)
    tweet = fx_fetch(user, tweet_id)
    media = fx_media(tweet)
    if index is None:
        videos = [m for m in media if is_video(m)]
        if not videos:
            raise FxError("This post has no video (only images or text)")
        selected = videos[0]
    else:
        if index < 1 or index > len(media):
            raise FxError(f"Media #{index} not found in this post")
        selected = media[index - 1]
        if not is_video(selected):
            raise FxError(f"Media #{index} is not a video")
    variants = fx_variants(selected)
    if not variants:
        raise FxError("No downloadable video found in this post")
    return tweet, selected, variants


def fx_info(url):
    tweet, media, variants = fx_select(url)
    author = tweet.get("author") or {}
    formats = []
    for v in variants:
        if v["height"]:
            formats.append({"id": f"fx-{v['height']}", "label": f"{v['height']}p", "height": v["height"]})
    return {
        "title": (tweet.get("text") or "").strip() or f"Post {tweet.get('id', '')}".strip(),
        "thumbnail": media.get("thumbnail_url") or "",
        "duration": media.get("duration"),
        "uploader": author.get("name") or author.get("screen_name") or "",
        "formats": formats,
        "source": "fxtwitter",
    }


def fx_direct_url(url, format_id):
    """Direct video.twimg.com MP4 for a post, at the height in ``fx-<height>`` if present."""
    _, _, variants = fx_select(url)
    if format_id and format_id.startswith("fx-"):
        wanted = format_id[3:]
        for v in variants:
            if str(v["height"]) == wanted:
                return v["url"]
    return variants[0]["url"]


def fallback_allowed(url):
    return FXTWITTER_ENABLED and parse_tweet_url(url) is not None


# --- Downloads -------------------------------------------------------------


def download_args(url, out_template, format_choice, format_id):
    args = ["--no-playlist", "-o", out_template]
    if format_choice == "audio":
        args += ["-x", "--audio-format", "mp3"]
    elif format_id:
        # Middle option: a format that already has audio (HLS sites) when there is no
        # separate audio to merge; otherwise "/best" would ignore the chosen quality.
        args += ["-f", f"{format_id}+bestaudio/{format_id}/best", "--merge-output-format", "mp4"]
    else:
        args += ["-f", "bestvideo+bestaudio/best", "--merge-output-format", "mp4"]
    args.append(url)
    return args


def run_download(job_id, url, format_choice, format_id):
    job = jobs[job_id]
    out_template = os.path.join(DOWNLOAD_DIR, f"{job_id}.%(ext)s")

    try:
        via_fx = bool(format_id and format_id.startswith("fx-"))
        if not via_fx:
            result = run_ytdlp(download_args(url, out_template, format_choice, format_id), timeout=300)
            if result.returncode != 0:
                error = error_line(result.stderr)
                log.warning("download failed url=%s: %s", url, error)
                if not fallback_allowed(url):
                    job["status"] = "error"
                    job["error"] = error
                    return
                via_fx = True

        if via_fx:
            try:
                direct = fx_direct_url(url, format_id)
            except Exception as e:
                log.warning("fxtwitter fallback failed url=%s: %s", url, e)
                job["status"] = "error"
                job["error"] = str(e)
                return
            log.info("downloading via fxtwitter url=%s", url)
            # A single progressive MP4 with audio: "bestvideo+bestaudio/best" just picks it.
            result = run_ytdlp(download_args(direct, out_template, format_choice, None), timeout=300)
            if result.returncode != 0:
                job["status"] = "error"
                job["error"] = error_line(result.stderr)
                log.warning("download failed url=%s: %s", direct, job["error"])
                return

        files = glob.glob(os.path.join(DOWNLOAD_DIR, f"{job_id}.*"))
        if not files:
            job["status"] = "error"
            job["error"] = "Download completed but no file was found"
            return

        if format_choice == "audio":
            target = [f for f in files if f.endswith(".mp3")]
            chosen = target[0] if target else files[0]
        else:
            target = [f for f in files if f.endswith(".mp4")]
            chosen = target[0] if target else files[0]

        for f in files:
            if f != chosen:
                try:
                    os.remove(f)
                except OSError:
                    pass

        job["status"] = "done"
        job["file"] = chosen
        ext = os.path.splitext(chosen)[1]
        title = job.get("title", "").strip()
        # Sanitize title for filename
        if title:
            safe_title = "".join(c for c in title if c not in '\\/:*?"<>|\n\r\t').strip()[:100].strip()
            job["filename"] = f"{safe_title}{ext}" if safe_title else os.path.basename(chosen)
        else:
            job["filename"] = os.path.basename(chosen)
    except subprocess.TimeoutExpired:
        job["status"] = "error"
        job["error"] = "Download timed out (5 min limit)"
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/info", methods=["POST"])
def get_info():
    data = request.json
    url = data.get("url", "").strip()
    if not url:
        return jsonify({"error": "No URL provided"}), 400

    try:
        result = run_ytdlp(["--no-playlist", "-j", url], timeout=60)
        if result.returncode != 0:
            error = error_line(result.stderr)
            log.warning("info failed url=%s: %s", url, error)
            if fallback_allowed(url):
                try:
                    info = fx_info(url)
                    log.info("info via fxtwitter url=%s", url)
                    return jsonify(info)
                except FxError as e:
                    error = str(e)
                except Exception as e:
                    log.warning("fxtwitter fallback failed url=%s: %s", url, e)
            return jsonify({"error": error}), 400

        info = parse_ytdlp_json(result.stdout)

        # Build quality options — keep best format per resolution
        best_by_height = {}
        for f in info.get("formats", []):
            height = f.get("height")
            if height and f.get("vcodec", "none") != "none":
                tbr = f.get("tbr") or 0
                if height not in best_by_height or tbr > (best_by_height[height].get("tbr") or 0):
                    best_by_height[height] = f

        formats = []
        for height, f in best_by_height.items():
            formats.append({
                "id": f["format_id"],
                "label": f"{height}p",
                "height": height,
            })
        formats.sort(key=lambda x: x["height"], reverse=True)

        return jsonify({
            "title": info.get("title", ""),
            "thumbnail": info.get("thumbnail", ""),
            "duration": info.get("duration"),
            "uploader": info.get("uploader", ""),
            "formats": formats,
        })
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Timed out fetching video info"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/expand", methods=["POST"])
def expand_url():
    """Split an X post with several videos into one URL per video (/video/N).

    Anything else, or any failure, comes back unchanged as a single URL.
    """
    data = request.json
    url = data.get("url", "").strip()
    if not url:
        return jsonify({"error": "No URL provided"}), 400

    ref = parse_tweet_url(url)
    if not FXTWITTER_ENABLED or not ref or ref[2] is not None:
        return jsonify({"urls": [url]})
    try:
        tweet = fx_fetch(ref[0], ref[1])
    except Exception as e:
        log.info("expand skipped url=%s: %s", url, e)
        return jsonify({"urls": [url]})

    positions = [n for n, m in enumerate(fx_media(tweet), 1) if is_video(m)]
    if len(positions) <= 1:
        return jsonify({"urls": [url]})
    user = (tweet.get("author") or {}).get("screen_name") or ref[0]
    base = f"https://x.com/{user}/status/{ref[1]}"
    return jsonify({"urls": [f"{base}/video/{n}" for n in positions]})


@app.route("/api/playlist", methods=["POST"])
def get_playlist_info():
    data = request.json
    url = data.get("url", "").strip()
    if not url:
        return jsonify({"error": "No URL provided"}), 400

    cmd = ["yt-dlp", "--flat-playlist", "-J", url]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            return jsonify({"error": result.stderr.strip().split("\n")[-1]}), 400

        info = json.loads(result.stdout)
        entries = info.get("entries", [])
        urls = [entry.get("url") for entry in entries if entry.get("url")]
        return jsonify({"urls": urls})
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Timed out fetching playlist info"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/download", methods=["POST"])
def start_download():
    data = request.json
    url = data.get("url", "").strip()
    format_choice = data.get("format", "video")
    format_id = data.get("format_id")
    title = data.get("title", "")

    if not url:
        return jsonify({"error": "No URL provided"}), 400

    job_id = uuid.uuid4().hex[:10]
    jobs[job_id] = {"status": "downloading", "url": url, "title": title}

    thread = threading.Thread(target=run_download, args=(job_id, url, format_choice, format_id))
    thread.daemon = True
    thread.start()

    return jsonify({"job_id": job_id})


@app.route("/api/status/<job_id>")
def check_status(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    return jsonify({
        "status": job["status"],
        "error": job.get("error"),
        "filename": job.get("filename"),
    })


@app.route("/api/file/<job_id>")
def download_file(job_id):
    job = jobs.get(job_id)
    if not job or job["status"] != "done":
        return jsonify({"error": "File not ready"}), 404
    return send_file(job["file"], as_attachment=True, download_name=job["filename"])


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8899))
    host = os.environ.get("HOST", "127.0.0.1")
    app.run(host=host, port=port)
