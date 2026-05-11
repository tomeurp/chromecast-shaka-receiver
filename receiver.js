const video = document.getElementById('video');
const statusEl = document.getElementById('status');
const debugEl = document.getElementById('debugOverlay');

let player = null;
let lastObjectUrl = null;
let debugEnabled = new URLSearchParams(location.search).get('debug') === '1';
let lastLoad = null;
let lastRequest = null;
let lastResponse = null;
let recentLines = [];

function safeJson(value, max = 7000) {
  try {
    const seen = new WeakSet();
    const text = JSON.stringify(value, (key, val) => {
      if (typeof val === 'function') return '[Function]';
      if (val instanceof Error) {
        return {
          name: val.name,
          message: val.message,
          stack: val.stack,
          code: val.code,
          category: val.category,
          severity: val.severity,
          data: val.data
        };
      }
      if (val && typeof val === 'object') {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    }, 2);
    return text.length > max ? text.slice(0, max) + '\n... [truncated]' : text;
  } catch (e) {
    return String(value);
  }
}

function enableDebug(reason = '') {
  debugEnabled = true;
  document.body.classList.add('debug');
  debugLine('DEBUG ENABLED ' + reason);
}

function debugLine(...args) {
  const msg = args.map(a => typeof a === 'string' ? a : safeJson(a, 2000)).join(' ');
  const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
  recentLines.push(line);
  if (recentLines.length > 80) recentLines = recentLines.slice(-80);
  if (debugEnabled && debugEl) {
    debugEl.textContent = buildDebugText();
  }
  console.log('[GenericShakaReceiver]', ...args);
}

function buildDebugText(extra = '') {
  return [
    'Generic Shaka Cast Receiver DEBUG',
    '=================================',
    `time: ${new Date().toISOString()}`,
    `status: ${statusEl ? statusEl.textContent : ''}`,
    '',
    'LAST LOAD:',
    safeJson(lastLoad, 2500),
    '',
    'LAST REQUEST:',
    safeJson(lastRequest, 2500),
    '',
    'LAST RESPONSE:',
    safeJson(lastResponse, 2500),
    extra ? '\nEXTRA:\n' + extra : '',
    '',
    'RECENT:',
    recentLines.slice(-35).join('\n')
  ].join('\n');
}

function showError(title, error) {
  enableDebug('error');
  const detail = error && error.detail ? error.detail : error;
  const text = [
    title,
    '-----',
    safeJson(detail, 9000)
  ].join('\n');
  if (debugEl) debugEl.textContent = buildDebugText(text);
  console.error('[GenericShakaReceiver]', title, detail);
}

function log(...args) {
  debugLine(...args);
}

function setStatus(text) {
  statusEl.textContent = text;
  debugLine('STATUS:', text);
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

function installNetworkingDebug(shakaPlayer, headers = {}) {
  const networking = shakaPlayer.getNetworkingEngine();
  if (!networking) return;

  networking.registerRequestFilter((requestType, request) => {
    Object.entries(headers || {}).forEach(([name, value]) => {
      request.headers[name] = String(value);
    });

    lastRequest = {
      requestType,
      uris: request.uris,
      method: request.method,
      headers: request.headers,
      allowCrossSiteCredentials: request.allowCrossSiteCredentials,
      retryParameters: request.retryParameters
    };
    debugLine('REQ', lastRequest);
  });

  networking.registerResponseFilter((responseType, response) => {
    lastResponse = {
      responseType,
      uri: response.uri,
      originalUri: response.originalUri,
      fromCache: response.fromCache,
      headers: response.headers,
      dataBytes: response.data ? response.data.byteLength : null
    };
    debugLine('RES', lastResponse);
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
    customData.originalManifestUrl ||
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
    objectUrl: lastObjectUrl,
    first300: xml.slice(0, 300)
  });

  return lastObjectUrl;
}

async function initPlayer() {
  if (player) {
    await player.destroy();
  }

  player = new shaka.Player(video);

  player.addEventListener('error', event => {
    const err = event.detail;
    setStatus(`Shaka error: ${err && err.code}`);
    showError('SHAKA PLAYER ERROR', err);
  });

  video.addEventListener('error', () => {
    showError('VIDEO ELEMENT ERROR', {
      code: video.error && video.error.code,
      message: video.error && video.error.message,
      networkState: video.networkState,
      readyState: video.readyState,
      currentSrc: video.currentSrc
    });
  });

  video.addEventListener('playing', () => debugLine('VIDEO EVENT playing'));
  video.addEventListener('waiting', () => debugLine('VIDEO EVENT waiting'));
  video.addEventListener('stalled', () => debugLine('VIDEO EVENT stalled'));
  video.addEventListener('canplay', () => debugLine('VIDEO EVENT canplay'));

  return player;
}

async function loadContent(mediaInfo) {
  const customData = mediaInfo.customData || {};
  const drm = customData.drm || {};

  if (customData.debug) enableDebug('customData.debug');

  let contentUrl = createManifestObjectUrl(mediaInfo, customData);
  if (!contentUrl) {
    contentUrl = mediaInfo.contentUrl || mediaInfo.contentId;
  }

  const contentType = mediaInfo.contentType || '';

  if (!contentUrl) {
    throw new Error('Missing media URL or embedded manifest');
  }

  lastLoad = {
    contentUrl,
    contentType,
    mediaContentUrl: mediaInfo.contentUrl,
    mediaContentId: mediaInfo.contentId,
    customData
  };

  setStatus('Loading');

  const shakaPlayer = await initPlayer();
  const config = buildShakaConfig(customData);

  shakaPlayer.configure(config);

  const combinedHeaders = {
    ...(customData.headers || {}),
    ...(drm.headers || {})
  };
  installNetworkingDebug(shakaPlayer, combinedHeaders);

  log('contentUrl', contentUrl);
  log('contentType', contentType);
  log('customData', customData);
  log('shakaConfig', config);

  try {
    await shakaPlayer.load(contentUrl);
  } catch (e) {
    setStatus(`LOAD failed: Shaka Error ${e && e.code ? e.code : e.message}`);
    showError('SHAKA LOAD THROW', e);
    throw e;
  }

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

  playerManager.addEventListener(cast.framework.events.EventType.ERROR, event => {
    showError('CAF ERROR EVENT', event);
  });

  playerManager.addEventListener(cast.framework.events.EventType.PLAYER_LOAD_COMPLETE, event => {
    debugLine('CAF PLAYER_LOAD_COMPLETE', event);
  });

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    async loadRequestData => {
      try {
        lastLoad = loadRequestData;
        const mediaInfo = loadRequestData.media || {};
        const customData = mediaInfo.customData || {};
        if (customData.debug) enableDebug('LOAD debug');

        log('LOAD request', loadRequestData);
        await loadContent(mediaInfo);

        return loadRequestData;
      } catch (error) {
        console.error('[LOAD failed]', error);
        setStatus(`LOAD failed: ${error.code ? 'Shaka Error ' + error.code : error.message}`);
        showError('LOAD FAILED', error);

        const errorData = new cast.framework.messages.ErrorData(
          cast.framework.messages.ErrorType.LOAD_FAILED
        );

        errorData.reason = cast.framework.messages.ErrorReason.INVALID_REQUEST;
        errorData.customData = {
          message: error.message || String(error),
          code: error.code || null,
          category: error.category || null,
          severity: error.severity || null,
          data: error.data || null,
          stack: error.stack || null,
          lastRequest,
          lastResponse
        };

        throw errorData;
      }
    }
  );

  context.start({
    disableIdleTimeout: true
  });

  setStatus('Receiver started');
  if (debugEnabled) enableDebug('query debug');
}

main().catch(error => {
  console.error('[Receiver fatal]', error);
  setStatus(`Fatal error: ${error.message}`);
  showError('RECEIVER FATAL', error);
});
