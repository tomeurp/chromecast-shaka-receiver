# CAF receiver fix: scoped Cloudflare Access headers

This build keeps native CAF playback/UI and applies optional `customData.headers` only to requests whose URL has the same origin as the loaded manifest.

For example, if the manifest is loaded from `https://mfp.tomeurp.com/...`, the `CF-Access-*` headers are sent only to `https://mfp.tomeurp.com/...`. They are **not** sent to direct CDN URLs such as `cdn.makusi.eus` or `cdnstorage.primeran.eus`.

Use:

```js
mediaInfo.customData = {
  headers: {
    'CF-Access-Client-Id': '...',
    'CF-Access-Client-Secret': '...'
  },
  clearKeys: { '<kid>': '<key>' }
};
```

Local/LAN playback without headers is unchanged.
