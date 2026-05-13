# ETB CAF Receiver

This build intentionally uses the native Chromecast CAF player UI only:

- `<cast-media-player>` for TV controls and DPAD navigation.
- CAF/Shaka internal playback for HLS/DASH.
- No custom playback overlay.
- No custom focus manager.
- No Shaka UI library.

Custom behavior retained:

- Optional `media.customData.headers` / `requestHeaders` for Cloudflare Access or other proxy headers.
- Optional `media.customData.drm.headers` for license requests.
- Optional ClearKey config via either:

```js
mediaInfo.customData = {
  clearKeys: { '<kid>': '<key>' }
};
```

or:

```js
mediaInfo.customData = {
  drm: {
    clearKeys: { '<kid>': '<key>' }
  }
};
```

- Optional debug overlay:

```js
mediaInfo.customData = { debug: true };
// or
mediaInfo.customData = { debugOnError: true };
```

Typical MediaFlow HLS load:

```js
const mediaInfo = new chrome.cast.media.MediaInfo(URL, 'application/x-mpegURL');
mediaInfo.customData = {
  headers: {
    'CF-Access-Client-Id': '...',
    'CF-Access-Client-Secret': '...'
  }
};
```


## v1-native-caf-hls-native patch

This build keeps the original native CAF receiver base, but changes HLS handling:

- HLS content type is normalized to `application/x-mpegURL`.
- DASH/ClearKey still uses Shaka.
- HLS is not forced through Shaka (`useShakaForHls = false`) because ETB catch-up HLS can fail/idle on some Chromecast firmware when Shaka is forced.

