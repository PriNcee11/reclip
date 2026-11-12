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
  reproductores tipo VidHide (`playrecord.biz`, `recordplay.biz`, dominios `vidhide*`/`filelions*` y StreamWish: cualquiera con "wish", p. ej. `sfastwish.com`; siguen las redirecciones entre espejos): páginas que
  los incrustan en un `<iframe>` pasan de "Unsupported URL" a descargarse con su
  selector de calidad. Esos hosts disfrazan los trozos HLS de imagen (un PNG pegado
  delante del MPEG-TS); el plugin parchea el descargador de fragmentos de yt-dlp para
  quitar ese PNG (solo si el fragmento empieza por PNG y detrás hay MPEG-TS). Se carga
  vía `PYTHONPATH=/app/ytdlp-plugins`. Espejos nuevos: añadirlos a `_DOMAINS`.
- **Embeds Stream Origin (plugin de yt-dlp, desde 2026-11-12).** Reproductor
  `video.playerrecord.cfd/e/<id>` (también `streamorigin`/`embedorigin`): el plugin
  `embedorigin.py` pide a su API pública (`embedorigin.cc/app/v1/play/<id>`) el HLS
  firmado, que caduca en unas horas, y marca el vídeo como «solo vídeo» para que se
  junte con su pista de audio aparte. La API no está tras Cloudflare aunque la
  página que incrusta el reproductor sí lo esté.
- **Marcador «Send to ReClip».** En la página de ReClip hay un enlace para
  arrastrar a la barra de marcadores. En cualquier web recoge los reproductores
  incrustados (iframes de al menos 200×150, ignora banners y los `javascript:`) y
  los `<video>`; si no hay ninguno, la propia página. Abre ReClip con
  `/?dl=1&url=…`: la página los busca y descarga los que no estaban ya en el
  historial, y el navegador guarda el fichero al terminar. Sirve para webs con
  verificación anti-bots, que pasa el navegador al abrirlas, no ReClip. Sin `dl=1`
  solo crea las tarjetas.
- **Extensión de Chrome** (`extension/`, desde 2026-11-12). Sustituye al marcador:
  - El icono cuenta los vídeos de la pestaña: reproductores incrustados, `<video>`,
    `og:video` y los streams que carga la página (`.m3u8`, `.mpd`, `.mp4`, con su
    `Referer`/`Origin`/`User-Agent`, nunca cookies).
    En **verde** si hay algo por bajar; en **naranja** si esa página o su vídeo ya
    se descargó o se está descargando (lo consulta a ReClip al abrir la página,
    sin yt-dlp, con `POST /api/lookup`). Sin vídeos contados pero ya bajada: ✓.
  - Al pulsarlo: «Descargar» prueba en orden reproductores, vídeos, la propia página
    y por último los streams capturados; baja el primero que ReClip sepa leer y el
    navegador guarda el fichero al terminar. Cada candidato tiene además su botón.
    Si la página o el vídeo ya están en el historial (o bajándose), el aviso sale
    nada más abrirlo y el botón pasa a «Descargar otra vez».
  - Debajo, la misma lista de descargas que la web (`GET /api/jobs`), con barra y
    «45% · 3.2 MB/s · 2:10» mientras baja y «Guardar» al terminar
    y un enlace a ReClip para el historial completo.
  - «Enviar a ReClip» en el menú del botón derecho (enlaces, vídeos, marcos, página).
  - Ajustes: servidor (por defecto `http://192.168.1.21:5018`) y alternativo, que se
    usa si el principal no responde (por defecto el i7 por Tailscale).
  - Permisos: acceso a todos los sitios (para ver las peticiones de vídeo),
    `webRequest`, `downloads`, `notifications`, `contextMenus`, `scripting`,
    `storage`, `alarms` y `tabs`. Solo habla con el servidor de ReClip configurado.
  - Instalar: `chrome://extensions` → «Modo de desarrollador» → «Cargar
    descomprimida» → la carpeta `extension/` de este repo. Actualizar: `git pull`
    y el botón de recargar de la extensión.
  - Tests: `node --test extension/tests/*.test.mjs` (también en CI).
- **Servidor para la extensión:** `GET /api/jobs` (descargas en memoria, las 200
  últimas, más recientes primero); `POST /api/lookup {"urls": [...]}` (hasta 50:
  devuelve la descarga en curso o la entrada del historial que coincida, por URL
  del vídeo o por la página desde la que se lanzó, que `/api/download` guarda en
  `page`); y campo `headers` en `/api/info` y
  `/api/download` (solo `Referer`, `Origin`, `User-Agent`; se pasan a yt-dlp con
  `--add-header`). La web lee también `/api/jobs`: las descargas lanzadas desde la
  extensión u otra pestaña salen con «Save» (las terminadas, solo 6 h).
- **Progreso real** (desde 2026-11-12): yt-dlp escribe una línea por actualización
  (`--progress-template`) en un fichero temporal; un hilo lee la última cada
  segundo y la deja en `progress` (`percent`, `speed`, `eta`, `bytes`, `part`) de
  `/api/jobs` y `/api/status`. Vídeo y audio se bajan uno tras otro: `part` pasa a
  2 cuando el porcentaje vuelve a empezar. La web y el popup lo pintan.
- **Límite de descarga de 60 min** (antes 5), ajustable con
  `RECLIP_DOWNLOAD_TIMEOUT` en segundos: los HLS largos pesan 1-2 GiB.
- **Calidad elegida respetada** también en formatos que ya traen audio (HLS):
  `-f ID+bestaudio/ID/best` en vez de `ID+bestaudio/best`, que caía en "la mejor".
- **Aviso de enlace ya descargado.** Cada descarga terminada se apunta en
  `data/history.json` (URL, título, formato, fecha; máx. 5000, las más viejas
  salen primero). Al pegar un enlace que ya se bajó, su tarjeta lo dice
  ("Already downloaded on 12 Oct as MP4"), el botón pasa a **Download again** y
  **Download all** se lo salta: hay que confirmarlo a mano. Reconoce el mismo vídeo
  aunque cambie la forma del enlace (`youtu.be`/`watch?v=`/`shorts`, `twitter.com`/
  `x.com`, `www.`, barra final, `utm_*`, `si`, `igsh`…). Ruta con
  `RECLIP_DATA_DIR` (por defecto `/app/data`); va aparte de `downloads/` porque esa
  se poda por antigüedad. Si no se puede escribir, se avisa en el log y la descarga
  sigue.
- **Historial en la página.** Al abrirla se pintan las últimas descargas (50, y
  «Show older» para más; `GET /api/history?limit=&offset=`), más recientes
  primero, como tarjetas compactas con **Download again**. Los enlaces nuevos
  entran arriba, en el orden en que se pegaron. Desde 2026-10-16 el historial
  guarda también miniatura, autor y duración; las entradas anteriores salen sin
  miniatura. Ojo: como la app no tiene login, quien llegue al puerto ve el historial.
- **Barra fija abajo** con el recuento (por descargar, ya descargados, en curso,
  fallidos, hechos), cada número salta a su primera tarjeta, **Download all** y
  **Clear finished** para quitar de la lista las terminadas. Las hechas se atenúan;
  pegar un enlace que ya está en la lista hace parpadear su tarjeta.
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
