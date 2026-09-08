# Broadcaster in Docker

Broadcaster turns local videos into continuously scheduled TV channels with a CRT-style web player. The image is `tedcharles/broadcaster:latest`; the web port is **12121**.

## Run

Create a writable data directory and put your channel definitions in `data/channels.json`:

```json
[
  {
    "name": "MTV",
    "slug": "mtv",
    "type": "shuffle",
    "paths": ["/media/Music Videos", "/media/TV/Beavis and Butt-Head (1993) {tvdb-75863}"]
  }
]
```

Mount persistent data at `/data` and your media read-only at `/media`. Paths in the channel file refer to paths **inside the container**. The container runs as UID 99 / GID 100; grant that user access to the data directory.

```sh
docker run -d --name broadcaster --restart unless-stopped \
  --gpus all \
  -e NVIDIA_VISIBLE_DEVICES=all \
  -e NVIDIA_DRIVER_CAPABILITIES=compute,video,utility \
  -e TZ=America/New_York \
  -p 12121:12121 \
  -v /your/broadcaster-data:/data \
  -v /your/media:/media:ro \
  tedcharles/broadcaster:latest
```

Without NVIDIA hardware, omit the GPU options and set `-e VIDEO_CODEC=libx264 -e VIDEO_PRESET=veryfast`. The app also falls back to software encoding if GPU detection or a GPU encode fails. Unraid installations can use the NVIDIA runtime and the existing Broadcaster template.

The supplied Compose file uses `./data:/data` and `${MEDIA_PATH:-./media}:/media:ro`:

```sh
docker compose pull
docker compose up -d
docker compose logs -f broadcaster
```

## Configuration

Environment variables override the image's `config.txt` defaults. An optional read-only mount at `/app/config.txt` can replace that file. Channel definitions live at `/data/channels.json` by default.

| Variable | Default in the image | Purpose |
| --- | --- | --- |
| `CACHE_DIR` | `/data` | Database, guides and cached streams |
| `CHANNEL_LIST` | `/data/channels.json` | Channel configuration |
| `WEB_UI_PORT` | `12121` | HTTP port |
| `VIDEO_CODEC` | `h264_nvenc` | NVIDIA encoding; `libx264` for CPU |
| `VIDEO_PRESET` | `p4` | NVIDIA preset; use `veryfast` for CPU |
| `VIDEO_CRF` | `35` | Encoder quality value |
| `VIDEO_FILTER` | `yadif` | Deinterlacing; CUDA used where compatible |
| `DIMENSIONS` | `640x480` | Output width; source aspect ratio is preserved |
| `AUDIO_BITRATE` | `192k` | AAC stereo at 48 kHz |
| `HLS_SEGMENT_LENGTH_SECONDS` | `1` | Forced keyframe/IDR interval |
| `GENERATION_WORKERS` | `2` for NVIDIA, `1` for CPU | Background encoders, limited to 1–4 |
| `TZ` | container timezone | Local 3 a.m. guide boundary |

Channel types are `shuffle` and `alphabetical`. Slugs must contain letters, digits, underscores or hyphens and must be unique. Restart after editing channel definitions.

## Cache upgrade and rebuild

Version 0.1.0 automatically queues legacy HLS for regeneration into `channels/<slug>/videos/<hash>/v2/`. It fixes the old mismatch between the one-second setting and the actual 8–10 second segments. The new cache uses [HLS byte ranges](https://ffmpeg.org/ffmpeg-formats.html#hls-2): one media file per video, avoiding millions of tiny files while retaining one-second independent chunks. The previous cache remains available while replacements are encoded and checked. On-air schedules retain their selected cache version; newly generated daily schedules use completed replacements. Programs crossing 3 a.m. finish normally.

Do **not** delete the old cache to start the upgrade. Progress survives container restarts. The first rebuild needs space for both versions and may take days for a large library. Encoding stops if free space falls below 5 GiB; free space and restart to resume. Unreadable files are reported separately and retried after their size or modification time changes. Older cache files are retained for rollback and existing schedules.

The guide displays short music and Beavis clips in roughly half-hour blocks, without changing their actual playout order or timing. Titles stay visible while scrolling through long programs. The player refreshes channel availability and guide data automatically.

## Monitoring

- `/healthz`: startup state and deployed Git commit.
- `/manifest.json`: playable channels.
- `/api/db-stats`: per-channel cache counts and background generation progress, including failures/skips.
- `/api/guide?display=1`: compact grouped guide.
- `/<slug>/schedule`: exact per-video schedule.
- `/<slug>/debug`: current playback timing without host filesystem paths.

Live playlists are sent with `Cache-Control: no-store`; media segments have a bounded cache lifetime. Reverse proxies should preserve these headers and avoid caching `*.m3u8` or API responses.

## Updates and verification

Pushes to `master` run unit tests, build the frontend, audit dependencies, and test real HLS playback in Chromium before publishing `latest`, `master`, and an immutable `sha-<commit>` tag. Pushes to `devel` publish `dev` after the same checks. Workflows also support manual dispatch.

In Unraid, update **Broadcaster** from the Docker tab. This pulls the published image and recreates the container from its saved template, retaining mounts, GPU settings and configuration.

For development:

```sh
npm ci
npm ci --prefix Webapp
npm test
npm run build:frontend
npx playwright install --with-deps chromium
npm run test:playback
```

The playback check generates real clips (including a silent source), verifies continuous playback across transitions, channel surfing, network recovery, mobile guide layout and power-off cleanup. `scripts/verify-encode.cjs` can check specific media in a scratch cache, including segment duration, keyframe starts and decoding. It must not be run against the production cache.
