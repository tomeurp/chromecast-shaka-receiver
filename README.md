# Chromecast Shaka Receiver - v2 base + native Shaka UI

This version intentionally uses the previously working v2 receiver as the base.

Changes:
- Keeps the v2 Cast/CAF load path, Cloudflare header injection, DRM/ClearKey support and debug-on-error plumbing.
- Removes custom playback overlays and focus engines.
- Loads Shaka UI (`shaka-player.ui.js` + `controls.css`) and creates `shaka.ui.Overlay(player, container, video)`.
- Status overlay is hidden by default so it cannot cover the video.
- Debug overlay is still opt-in only via `customData.debug` or `?debug=1`.
- Cloudflare headers are injected only when `customData.headers` or `customData.drm.headers` are present.

Recommended Cast media type for MediaFlow HLS:
`application/x-mpegURL`
