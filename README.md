# ReClip

A self-hosted, open-source video and audio downloader with a clean web UI. Paste links from YouTube, TikTok, Instagram, Twitter/X, and 1000+ other sites — download as MP4 or MP3.

![Python](https://img.shields.io/badge/python-3.8+-blue)
![License](https://img.shields.io/badge/license-MIT-green)

https://github.com/user-attachments/assets/419d3e50-c933-444b-8cab-a9724986ba05

![ReClip MP3 Mode](assets/preview-mp3.png)

## Cambios de este fork (PriNcee11)

Fork de [averygan/reclip](https://github.com/averygan/reclip) para el homelab.
Imagen: `ghcr.io/princee11/reclip:latest` (amd64, la publica CI en cada push a `main`).

- **Plan B para X/Twitter vía [fxtwitter](https://github.com/FixTweet/FxTwitter).**
  X oculta a los visitantes sin sesión los posts marcados como sensibles y yt-dlp
  no ve su vídeo. Si yt-dlp falla con un enlace de X, ReClip pide el post a
  `api.fxtwitter.com` y descarga el MP4 directo de `video.twimg.com`. Sin cuenta ni
  cookies. Se desactiva con `RECLIP_FXTWITTER=0`; la API se cambia con
  `RECLIP_FXTWITTER_API`.
- **Posts con varios vídeos:** al pegar el enlace se separa en una tarjeta por
  vídeo (`/video/N`, con la misma numeración que X y yt-dlp: las fotos cuentan).
- **Páginas difíciles:** la imagen trae `curl_cffi` y deno
  (`yt-dlp[default,curl-cffi,deno]`). Si un sitio responde 403/503, Cloudflare o
  captcha, se reintenta una vez con `--impersonate chrome`
  (`RECLIP_IMPERSONATE`, vacío para no reintentar).
- **Embeds VidHide (plugin de yt-dlp).** `ytdlp-plugins/` lleva un extractor para
  reproductores tipo VidHide (`playrecord.biz`, `recordplay.biz`, `vidhide*.com` y StreamWish: cualquier dominio con "wish", p. ej. `sfastwish.com`): páginas que
  los incrustan en un `<iframe>` pasan de "Unsupported URL" a descargarse con su
  selector de calidad. Esos hosts disfrazan los trozos HLS de imagen (un PNG pegado
  delante del MPEG-TS); el plugin parchea el descargador de fragmentos de yt-dlp para
  quitar ese PNG (solo si el fragmento empieza por PNG y detrás hay MPEG-TS). Se carga
  vía `PYTHONPATH=/app/ytdlp-plugins`. Espejos nuevos: añadirlos a `_DOMAINS`.
- **Calidad elegida respetada** también en formatos que ya traen audio (HLS):
  `-f ID+bestaudio/ID/best` en vez de `ID+bestaudio/best`, que caía en "la mejor".
- **Errores en el log:** cada fallo queda en `docker logs` con la URL y la línea
  `ERROR:` de yt-dlp.
- Tests (`pytest`) y `ruff` en CI.

## Features

- Download videos from 1000+ supported sites (via [yt-dlp](https://github.com/yt-dlp/yt-dlp))
- MP4 video or MP3 audio extraction
- Quality/resolution picker
- Bulk downloads — paste multiple URLs at once
- Automatic URL deduplication
- Clean, responsive UI — no frameworks, no build step
- Single Python file backend (~150 lines)

## Quick Start

```bash
brew install yt-dlp ffmpeg    # or apt install ffmpeg && pip install yt-dlp
git clone https://github.com/averygan/reclip.git
cd reclip
./reclip.sh
```

Open **http://localhost:8899**.

Or with Docker:

```bash
docker build -t reclip . && docker run -p 8899:8899 reclip
```

## Usage

1. Paste one or more video URLs into the input box
2. Choose **MP4** (video) or **MP3** (audio)
3. Click **Fetch** to load video info and thumbnails
4. Select quality/resolution if available
5. Click **Download** on individual videos, or **Download All**

## Supported Sites

Anything [yt-dlp supports](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md), including:

YouTube, TikTok, Instagram, Twitter/X, Reddit, Facebook, Vimeo, Twitch, Dailymotion, SoundCloud, Loom, Streamable, Pinterest, Tumblr, Threads, LinkedIn, and many more.

## Stack

- **Backend:** Python + Flask (~150 lines)
- **Frontend:** Vanilla HTML/CSS/JS (single file, no build step)
- **Download engine:** [yt-dlp](https://github.com/yt-dlp/yt-dlp) + [ffmpeg](https://ffmpeg.org/)
- **Dependencies:** 2 (Flask, yt-dlp)

## Disclaimer

This tool is intended for personal use only. Please respect copyright laws and the terms of service of the platforms you download from. The developers are not responsible for any misuse of this tool.

## License

[MIT](LICENSE)
