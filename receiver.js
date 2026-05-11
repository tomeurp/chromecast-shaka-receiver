const video = document.getElementById('video');
const statusEl = document.getElementById('status');

let player = null;
let lastObjectUrl = null;

function log(...args) {
  console.log('[GenericShakaReceiver]', ...args);
}

function setStatus(text) {
  statusEl.textContent = text;
  log(text);
}

function normalizeDrmType(type) {
  return String(type || 'none').toLowerCase();
}

function keySystemFor(type) {
  switch (normalizeDrmType(type)) {
    case 'widevine':
      return 'com.widevine.alpha';
    case 'playready':
    case 'microsoft':
      return 'com.microsoft.playready';
    case 'fairplay':
      return 'com.apple.fps';
    case 'clearkey':
      return 'org.w3.clearkey';
    default:
      return null;
  }
}

function buildShakaConfig(customData = {}) {
  const drm = customData.drm || {};
  const shakaConfig = customData.shakaConfig || {};
  const type = normalizeDrmType(drm.type);
  const keySystem = keySystemFor(type);

  const config = {
    ...shakaConfig,
    drm: {
      ...(shakaConfig.drm || {}),
      servers: {
        ...((shakaConfig.drm && shakaConfig.drm.servers) || {})
      },
      advanced: {
        ...((shakaConfig.drm && shakaConfig.drm.advanced) || {})
      }
    }
  };

  if (type === 'clearkey') {
    config.drm.clearKeys = drm.clearKeys || {};
  }

  if (keySystem && drm.licenseUrl) {
    config.drm.servers[keySystem] = drm.licenseUrl;
  }

  if (type === 'fairplay' && drm.certificateUrl) {
    config.drm.advanced['com.apple.fps'] = {
      ...(config.drm.advanced['com.apple.fps'] || {}),
      serverCertificateUri: drm.certificateUrl
    };
  }

  return config;
}

function applyRequestHeaders(shakaPlayer, headers = {}) {
  const networking = shakaPlayer.getNetworkingEngine();

  if (!networking) {
    return;
  }

  networking.registerRequestFilter((requestType, request) => {
    Object.entries(headers).forEach(([name, value]) => {
      request.headers[name] = String(value);
    });
  });
}

function decodeBase64Utf8(base64) {
  const binary = atob(String(base64).trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function dirnameUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    u.pathname = u.pathname.replace(/[^/]*$/, '');
    return u.toString();
  } catch (e) {
    return null;
  }
}

function hasMpdBaseUrl(xml) {
  return /<BaseURL[\s>]/i.test(xml);
}

function injectBaseUrl(xml, baseUrl) {
  if (!baseUrl || hasMpdBaseUrl(xml)) {
    return xml;
  }

  // Insert a document-level BaseURL immediately after the opening MPD tag.
  // This lets Blob-loaded MPDs keep resolving relative segment URLs against
  // the original manifest location.
  return xml.replace(/(<MPD\b[^>]*>)/i, `$1\n  <BaseURL>${baseUrl}</BaseURL>`);
}

function createManifestObjectUrl(mediaInfo, customData) {
  const manifestText = customData.manifestText || customData.mpdText || null;
  const manifestBase64 = customData.manifestBase64 || customData.mpdBase64 || null;

  if (!manifestText && !manifestBase64) {
    return null;
  }

  if (lastObjectUrl) {
    URL.revokeObjectURL(lastObjectUrl);
    lastObjectUrl = null;
  }

  let xml = manifestText || decodeBase64Utf8(manifestBase64);

  const originalUrl =
    customData.manifestUrl ||
    customData.originalUrl ||
    mediaInfo.contentUrl ||
    mediaInfo.contentId ||
    '';

  const baseUrl = customData.manifestBaseUrl || dirnameUrl(originalUrl);
  xml = injectBaseUrl(xml, baseUrl);

  const blob = new Blob([xml], { type: 'application/dash+xml' });
  lastObjectUrl = URL.createObjectURL(blob);

  log('Using embedded MPD', {
    originalUrl,
    baseUrl,
    bytes: xml.length,
    objectUrl: lastObjectUrl
  });

  return lastObjectUrl;
}

async function initPlayer() {
  if (player) {
    await player.destroy();
  }

  player = new shaka.Player(video);

  player.addEventListener('error', event => {
    console.error('[Shaka error]', event.detail);
    setStatus(`Shaka error: ${event.detail && event.detail.code}`);
  });

  return player;
}

async function loadContent(mediaInfo) {
  const customData = mediaInfo.customData || {};
  const drm = customData.drm || {};

  let contentUrl = createManifestObjectUrl(mediaInfo, customData);
  if (!contentUrl) {
    contentUrl = mediaInfo.contentUrl || mediaInfo.contentId;
  }

  const contentType = mediaInfo.contentType || '';

  if (!contentUrl) {
    throw new Error('Missing media URL or embedded manifest');
  }

  setStatus('Loading');

  const shakaPlayer = await initPlayer();
  const config = buildShakaConfig(customData);

  shakaPlayer.configure(config);

  if (drm.headers) {
    applyRequestHeaders(shakaPlayer, drm.headers);
  }

  if (customData.headers) {
    applyRequestHeaders(shakaPlayer, customData.headers);
  }

  log('contentUrl', contentUrl);
  log('contentType', contentType);
  log('customData', customData);
  log('shakaConfig', config);

  await shakaPlayer.load(contentUrl);

  setStatus('Playing');
}

async function main() {
  shaka.polyfill.installAll();

  if (!shaka.Player.isBrowserSupported()) {
    setStatus('Shaka not supported');
    return;
  }

  const context = cast.framework.CastReceiverContext.getInstance();
  const playerManager = context.getPlayerManager();

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    async loadRequestData => {
      try {
        log('LOAD request', loadRequestData);

        const mediaInfo = loadRequestData.media || {};
        await loadContent(mediaInfo);

        return loadRequestData;
      } catch (error) {
        console.error('[LOAD failed]', error);
        setStatus(`LOAD failed: ${error.message}`);

        const errorData = new cast.framework.messages.ErrorData(
          cast.framework.messages.ErrorType.LOAD_FAILED
        );

        errorData.reason = cast.framework.messages.ErrorReason.INVALID_REQUEST;
        errorData.customData = {
          message: error.message,
          stack: error.stack || null
        };

        throw errorData;
      }
    }
  );

  context.start({
    disableIdleTimeout: true
  });

  setStatus('Receiver started');
}

main().catch(error => {
  console.error('[Receiver fatal]', error);
  setStatus(`Fatal error: ${error.message}`);
});
