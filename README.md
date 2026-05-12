# Generic Shaka Cast Receiver - ETB/MediaFlow build

Changes in this build:

- Debug overlay is closed by default.
  - Enable with receiver URL `?debug=1`, or with `media.customData.debug = true`.
  - Auto-open-on-error only with receiver URL `?debugOnError=1`.
- Cloudflare Access headers are optional.
  - If `media.customData.headers` is present, headers are injected into every Shaka networking request.
  - If no headers are passed, no headers are added.
- Keeps support for `customData.drm.headers` for DRM/license requests.
- Adds CAF interceptors for playback commands: play, pause, seek, stop.
- Exposes Shaka audio/text tracks back to CAF media status.
- Handles `EDIT_TRACKS_INFO` to switch audio tracks and toggle/select subtitles via Shaka.

Typical HLS load customData for Cloudflare Access:

```js
mediaInfo.customData = {
  headers: {
    'CF-Access-Client-Id': '...',
    'CF-Access-Client-Secret': '...'
  }
};
```

Local/LAN playback can omit `customData.headers` entirely.

## v3 controls build

- Removes the always-visible bottom-left status text, including the "Playing" overlay.
- Adds a minimal on-screen control bar with title, play/pause, scrubber, time, audio selector and subtitle selector.
- Controls auto-hide during playback and reappear on pointer/remote interaction.
- Keeps Cloudflare Access header injection optional: headers are only applied when `media.customData.headers` is present.
- Keeps CAF playback/seek/track interceptors so sender controls still work.
