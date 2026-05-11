# Generic Shaka Chromecast Receiver - Debug build

Adds an on-TV debug overlay when `customData.debug === true` or `?debug=1` is present in the receiver URL.

The overlay shows:
- last LOAD payload
- final content URL / Blob URL
- last Shaka request
- last Shaka response
- full Shaka error data, including `code`, `category`, `severity`, and `data[]`
- video element errors/events

## Embedded MPD payload

```js
mediaInfo.customData = {
  playback: 'shaka',
  manifestBase64: '<base64 utf8 mpd>',
  originalManifestUrl: 'https://example.com/path/manifest.mpd',
  drm: {
    type: 'clearkey',
    clearKeys: {
      kidhex: 'keyhex'
    }
  },
  debug: true
};
```

Upload all files to GitHub Pages replacing the previous receiver files.


## Debug QR export

This build adds an on-screen **QR Log** button in debug mode.

Enable it by sending `customData.debug = true`.

The receiver shows:
- Prev / Next / Auto / QR Log
- press `Q` if keyboard/remote events are available
- press `Esc` to hide the QR panel

The QR encodes a compact base64url JSON payload prefixed with `DBG6:`. If the full log is too long for a practical QR, the receiver automatically emits a slim debug payload with the latest error, request/response, video snapshot and manifest info.


## v7.1 safe debug remote control

This build reverts the remote key capture from v7. It should not enable debug before content is loaded unless `?debug=1` is used or the sender sends `customData.debug = true`.

Use sender-side custom messages instead:

```js
const session = cast.framework.CastContext.getInstance().getCurrentSession();
session.sendMessage('urn:x-cast:debug', { action: 'enableDebug' });
session.sendMessage('urn:x-cast:debug', { action: 'showQr' });
session.sendMessage('urn:x-cast:debug', { action: 'nextPage' });
session.sendMessage('urn:x-cast:debug', { action: 'prevPage' });
```


## v7.2 sender message format

`CastSession.sendMessage()` must send a string, not a raw object:

```js
session.sendMessage('urn:x-cast:debug', JSON.stringify({ action: 'showQr' }));
```

The receiver now accepts both JSON strings and plain action strings.
