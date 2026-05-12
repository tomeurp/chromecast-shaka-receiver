# ETB Shaka Cast Receiver v6

Stable TV UI rebuild:
- no fullscreen black overlay; only a bottom gradient when controls are visible
- top row: scrubber with buffer health + time
- bottom row: icon-only controls
- deterministic remote focus; does not rely on native browser focus only
- autohide timer
- STOP/PLAY/PAUSE/seek handling
- audio/subtitle/quality menus
- optional Cloudflare Access headers from `media.customData.headers`
- debug only with `customData.debug` or `customData.debugOnError`
