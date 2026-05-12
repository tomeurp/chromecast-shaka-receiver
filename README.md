# Chromecast Shaka Receiver v4

Changes:
- Debug overlay remains off by default and only opens with `customData.debug` or `customData.debugOnError`.
- Cloudflare Access headers are injected only when `media.customData.headers` is provided.
- Removes the visible status overlay such as "Playing".
- Adds Apple/ETB-inspired glass controls with scrubber, time, play/pause, skip-back, audio and subtitles.
- Controls show on pause, seek, waiting/playing, pointer activity, and remote navigation.
- TV remote navigation support: arrows, OK/Enter, Back/Escape, media play/pause keys.
- Dedicated audio/subtitle remote keys are handled when the device exposes `Audio`, `Subtitle`, `Caption`, or equivalent key codes.
- Cast `EDIT_TRACKS_INFO` still maps to Shaka audio/text selection.

Deploy by replacing the receiver files in your custom Cast receiver hosting and reloading the app ID in the Cast console/device.
