# Generic Shaka Chromecast Receiver

Generic CAF + Shaka receiver.

Supports normal URL loading and embedded DASH manifests via `customData.mpdBase64`, `customData.manifestBase64`, `customData.mpdText`, or `customData.manifestText`.

## Embedded MPD payload example

```js
mediaInfo.customData = {
  playback: 'shaka',
  manifestUrl: 'https://example.com/path/manifest.mpd',
  mpdBase64: '<base64 utf8 mpd>',
  drm: {
    type: 'clearkey',
    clearKeys: {
      kidhex: 'keyhex'
    }
  }
};
```

When loading an embedded MPD, the receiver injects a document-level `<BaseURL>` derived from `manifestUrl` or `contentUrl` if the MPD has no `BaseURL`, so relative segment URLs can keep resolving against the original manifest directory.

