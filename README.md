# ETB CAF Receiver - clean scoped headers build

Base: `chromecast-caf-receiver-v1-native-caf.zip`.

This build keeps the native Chromecast CAF player only:

- `<cast-media-player>` for playback UI and remote controls.
- No custom overlays.
- No custom DPAD/focus engine.
- No Shaka UI library.

Fixes included:

1. ClearKey is applied before CAF/Shaka starts playback, inside `setMediaPlaybackInfoHandler`:

```js
playbackConfig.shakaConfig.drm.clearKeys = customData.clearKeys
```

This avoids the race where the first load sometimes enters `PLAYING` and then drops to `IDLE`.

2. Cloudflare Access headers are scoped to the manifest origin only.

If the manifest URL is:

```text
https://mfp.tomeurp.com/proxy/mpd/dash.mpd?...
```

then `CF-Access-*` headers are only added to requests whose URL origin is:

```text
https://mfp.tomeurp.com
```

They are never sent to CDN origins such as:

```text
https://cdn.primeran.eus
https://cdn.makusi.eus
https://cdnstorage.primeran.eus
```

3. CAF text track style is set to transparent background + outline.

## Direct CDN DASH sender example

```js
const url = 'https://cdn.primeran.eus/media/c6c2a61feeaad0ff83e53e303b8a0592/cenc/manifest.mpd';
const session = cast.framework.CastContext.getInstance().getCurrentSession()
  || await cast.framework.CastContext.getInstance().requestSession();

const mediaInfo = new chrome.cast.media.MediaInfo(url, 'application/dash+xml');
mediaInfo.metadata = new chrome.cast.media.GenericMediaMetadata();
mediaInfo.metadata.title = 'Primeran Direct CDN DASH';
mediaInfo.customData = {
  clearKeys: {
    '662f4a9a18714d378d0cd58adcc62b16': '3adcf39a811a5ab45f901e5b835b688c'
  }
};

await session.loadMedia(new chrome.cast.media.LoadRequest(mediaInfo));
```

## CF Tunnel sender example

```js
const url = 'https://mfp.tomeurp.com/proxy/mpd/dash.mpd?d=https%3A%2F%2Fprimeran.eus%2Fmanifests%2FSLUG%2Feu%2Fwidevine%2Fdash.mpd&api_password=...';

mediaInfo.customData = {
  headers: {
    'CF-Access-Client-Id': '...',
    'CF-Access-Client-Secret': '...'
  },
  clearKeys: {
    '<kid>': '<key>'
  }
};
```

The receiver will only send the CF headers to `https://mfp.tomeurp.com`, not to CDN URLs.
