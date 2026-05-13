# ETB CAF Receiver v2 - Native CAF + DPAD subtitle menu

This build keeps native Chromecast CAF playback controls through `<cast-media-player>`.
It adds only a tiny DPAD-accessible subtitle menu because CAF does not reliably expose a TV subtitle selector for HLS sidecar WebVTT tracks on all firmwares.

## What it does

- Uses native CAF player and UI for play/pause/seek/stop/buffer.
- Forces Shaka for HLS/DASH where the firmware supports it.
- Discovers `#EXT-X-MEDIA:TYPE=SUBTITLES` entries from the HLS master URL itself.
- Unwraps subtitle HLS playlists to direct `.vtt` URLs when possible.
- Injects those WebVTT tracks into the CAF `media.tracks` before playback starts.
- Adds a small subtitle menu:
  - `ArrowUp` / `Menu` opens it.
  - Subtitle/CC remote key toggles subtitles if exposed by the TV.
  - Left/right changes option.
  - OK/Enter activates.
  - Back/Escape hides.
  - Autohides after 7 seconds.
- Keeps Cloudflare Access headers optional via `customData.headers`.
- Keeps optional ClearKey support via `customData.clearKeys` or `customData.drm.clearKeys`.

## Sender payload

The sender can pass only the HLS URL. It does not need to know subtitle VTT URLs.

```js
mediaInfo.customData = {
  headers: {
    'CF-Access-Client-Id': '...',
    'CF-Access-Client-Secret': '...'
  }
};
```

Local/LAN playback can omit `customData.headers`.
