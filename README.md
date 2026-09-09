# Broadcaster
Generate and host HTTP Live Streams from local video content using FFMpeg. Broadcaster will create playlists of your video files and live stream the playlist. It will orchestrate time keeping to make sure anyone watching your stream is in the same position. If no one is watching, the timeline keeps going, just like old school TV stations.

## How It Works

Broadcaster pre-generates HLS segments for all your videos on first startup. This transcoding process runs in the background and can take a while depending on your library size and hardware. Once transcoded, videos are cached and don't need to be re-encoded on subsequent startups.

The web UI is available immediately at startup, but channels won't appear until at least one video has been transcoded. You can monitor transcoding progress in the Docker logs or console output.

## Prerequisites
* Broadcaster uses FFMpeg to encode your videos to h264 for HTTP Live Streaming.
* If you have an Nvidia GPU, it is highly recommended you have `ffmpeg` compiled with Nvidia's non-free `h264_nvenc` codec.
* If you have an Intel CPU with Intel QuickSync, you can try the `h264_qsv` codec.
* Without either of these, you'll have to use a software codec like `libx264` which will be slower. You can set the codec in the config.txt.

## Getting Started

Clone the repository:
```
git clone https://github.com/theodorecharles/Broadcaster.git
```

Change into the Broadcaster directory and run `npm install`:
```
cd ./Broadcaster
npm install
```

Define your channels in a `channels.json` file:
```json
[{
  "type": "shuffle",
  "name": "My Channel",
  "slug": "mychannel",
  "paths": [
    "/path/to/videos"
  ]
}]
```

The `type` specifies the playlist type:
* `shuffle`: will shuffle the files and play them in a random order.
* `alphabetical`: will play the files back in alphabetical order.

The `name` is a human readable name for the channel and the `slug` specifies the directory name the channel will use.

Start your server:
```
npm start
```

## Monitoring Progress

On first run, Broadcaster will transcode all videos in your library. Monitor progress with:

```bash
# Docker
docker logs -f broadcaster

# Or if running directly
npm start
```

You'll see output like:
```
[PreGenerator] Transcoding: My Video.mkv (1/50)
[PreGenerator] Transcoding complete: My Video.mkv
```

Channels will appear in the web UI as their videos finish transcoding.

## Playback and guide improvements

The player preloads adjacent channels for fast switching, recovers interrupted streams, and renders procedural static with optional square-cornered CRT scanlines, phosphor texture and glass shading. Automatic framing removes baked-in 4:3 side bars while preserving widescreen letterboxing. The CC button enables classic TV captions from external or embedded text subtitles, including Plex downloads. The guide groups short music/Beavis clips into readable blocks and renders only the visible part of the schedule.

Release 0.1.0 automatically rebuilds old HLS into a separate cache with forced one-second keyframes. Channels keep playing during the rebuild; existing schedules retain their cache version and new daily schedules adopt completed replacements. See [DOCKER.md](DOCKER.md) for configuration, progress monitoring and deployment details.
