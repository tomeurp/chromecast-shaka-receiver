const video = document.getElementById('video');
const statusEl = document.getElementById('status');
const debugEl = document.getElementById('debugOverlay');
const debugPrevBtn = document.getElementById('debugPrev');
const debugNextBtn = document.getElementById('debugNext');
const debugAutoBtn = document.getElementById('debugAuto');
const debugPageLabel = document.getElementById('debugPageLabel');

let player = null;
let lastObjectUrl = null;
let debugEnabled = new URLSearchParams(location.search).get('debug') === '1';
let lastLoad = null;
let lastRequest = null;
let lastResponse = null;
let recentLines = [];
let lastVideoSnapshot = null;
let lastTracks = null;
let lastManifestInfo = null;
let debugTextCache = '';
let debugPage = 0;
let debugAutoScroll = true;
let debugAutoTimer = null;


function updateDebugPageLabel() {
  if (!debugEl || !debugPageLabel) return;
  const totalPages = Math.max(1, Math.ceil(debugEl.scrollHeight / Math.max(1, debugEl.clientHeight)));
  const currentPage = Math.min(totalPages, Math.floor(debugEl.scrollTop / Math.max(1, debugEl.clientHeight)) + 1);
  debugPageLabel.textContent = `Page ${currentPage}/${totalPages} · top ${Math.round(debugEl.scrollTop)} / ${Math.max(0, debugEl.scrollHeight - debugEl.clientHeight)}`;
  if (debugAutoBtn) debugAutoBtn.textContent = debugAutoScroll ? 'Auto: ON' : 'Auto: OFF';
}

function scrollDebugToPage(page) {
  if (!debugEl) return;
  const pageHeight = Math.max(1, debugEl.clientHeight - 10);
  const totalPages = Math.max(1, Math.ceil(debugEl.scrollHeight / pageHeight));
  debugPage = Math.max(0, Math.min(totalPages - 1, page));
  debugEl.scrollTop = debugPage * pageHeight;
  updateDebugPageLabel();
}

function scrollDebugByPages(delta) {
  debugAutoScroll = false;
  scrollDebugToPage(debugPage + delta);
}

function refreshDebugOverlay(text, preservePage = false) {
  if (!debugEnabled || !debugEl) return;
  const oldTop = debugEl.scrollTop;
  debugTextCache = text;
  debugEl.textContent = text;
  if (debugAutoScroll) {
    // Jump to bottom so the newest error/recent events are visible on TV.
    debugEl.scrollTop = debugEl.scrollHeight;
    const pageHeight = Math.max(1, debugEl.clientHeight - 10);
    debugPage = Math.max(0, Math.floor(debugEl.scrollTop / pageHeight));
  } else if (preservePage) {
    debugEl.scrollTop = oldTop;
    const pageHeight = Math.max(1, debugEl.clientHeight - 10);
    debugPage = Math.max(0, Math.floor(debugEl.scrollTop / pageHeight));
  } else {
    scrollDebugToPage(debugPage);
  }
  updateDebugPageLabel();
}

function startDebugAutoPager() {
  if (debugAutoTimer) return;
  debugAutoTimer = setInterval(() => {
    if (!debugEnabled || !debugEl || !debugAutoScroll) return;
    // Keep the newest lines visible; useful when the TV cannot scroll.
    debugEl.scrollTop = debugEl.scrollHeight;
    const pageHeight = Math.max(1, debugEl.clientHeight - 10);
    debugPage = Math.max(0, Math.floor(debugEl.scrollTop / pageHeight));
    updateDebugPageLabel();
  }, 1200);
}

function setupDebugControls() {
  if (!debugEl) return;
  debugPrevBtn && debugPrevBtn.addEventListener('click', () => scrollDebugByPages(-1));
  debugNextBtn && debugNextBtn.addEventListener('click', () => scrollDebugByPages(1));
  debugAutoBtn && debugAutoBtn.addEventListener('click', () => {
    debugAutoScroll = !debugAutoScroll;
    if (debugAutoScroll) {
      debugEl.scrollTop = debugEl.scrollHeight;
      const pageHeight = Math.max(1, debugEl.clientHeight - 10);
      debugPage = Math.max(0, Math.floor(debugEl.scrollTop / pageHeight));
    }
    updateDebugPageLabel();
  });
  debugEl.addEventListener('scroll', () => {
    const pageHeight = Math.max(1, debugEl.clientHeight - 10);
    debugPage = Math.max(0, Math.floor(debugEl.scrollTop / pageHeight));
    updateDebugPageLabel();
  });
  window.addEventListener('keydown', ev => {
    if (!debugEnabled) return;
    const key = ev.key;
    if (key === 'ArrowDown' || key === 'PageDown' || key === 'MediaTrackNext') { ev.preventDefault(); scrollDebugByPages(1); }
    else if (key === 'ArrowUp' || key === 'PageUp' || key === 'MediaTrackPrevious') { ev.preventDefault(); scrollDebugByPages(-1); }
    else if (key === 'ArrowRight') { ev.preventDefault(); scrollDebugByPages(1); }
    else if (key === 'ArrowLeft') { ev.preventDefault(); scrollDebugByPages(-1); }
    else if (key === 'Enter' || key === ' ') {
      ev.preventDefault();
      debugAutoScroll = !debugAutoScroll;
      if (debugAutoScroll) debugEl.scrollTop = debugEl.scrollHeight;
      updateDebugPageLabel();
    }
    else if (key === 'Home') { ev.preventDefault(); debugAutoScroll = false; scrollDebugToPage(0); }
    else if (key === 'End') { ev.preventDefault(); debugAutoScroll = true; debugEl.scrollTop = debugEl.scrollHeight; updateDebugPageLabel(); }
  });
  startDebugAutoPager();
}

function enumName(obj, value) {
  if (!obj) return String(value);
  for (const k of Object.keys(obj)) {
    if (obj[k] === value) return k;
  }
  return String(value);
}

function mediaErrorDetails(err) {
  if (!err) return null;
  return {
    code: err.code,
    codeName: ({1:'MEDIA_ERR_ABORTED',2:'MEDIA_ERR_NETWORK',3:'MEDIA_ERR_DECODE',4:'MEDIA_ERR_SRC_NOT_SUPPORTED'})[err.code] || String(err.code),
    message: err.message || '',
    msExtendedCode: err.msExtendedCode || null
  };
}

function videoSnapshot(label = '') {
  if (!video) return null;
  const snap = {
    label,
    currentTime: video.currentTime,
    duration: video.duration,
    paused: video.paused,
    ended: video.ended,
    muted: video.muted,
    volume: video.volume,
    networkState: video.networkState,
    readyState: video.readyState,
    currentSrc: video.currentSrc,
    error: mediaErrorDetails(video.error),
    buffered: []
  };
  try {
    for (let i = 0; i < video.buffered.length; i++) {
      snap.buffered.push([video.buffered.start(i), video.buffered.end(i)]);
    }
  } catch (e) {}
  lastVideoSnapshot = snap;
  return snap;
}

function describeShakaError(error) {
  if (!error) return null;
  const E = window.shaka && shaka.util && shaka.util.Error;
  const out = {
    name: error.name || null,
    message: error.message || String(error),
    severity: error.severity,
    severityName: E ? enumName(E.Severity, error.severity) : null,
    category: error.category,
    categoryName: E ? enumName(E.Category, error.category) : null,
    code: error.code,
    codeName: E ? enumName(E.Code, error.code) : null,
    handled: error.handled,
    stack: error.stack || null,
    data: []
  };
  const data = Array.isArray(error.data) ? error.data : [];
  out.data = data.map((d, i) => describeErrorDatum(d, i));
  return out;
}

function describeErrorDatum(d, i) {
  if (d instanceof Error) {
    return {index:i, type:'Error', name:d.name, message:d.message, stack:d.stack, code:d.code};
  }
  if (typeof MediaError !== 'undefined' && d instanceof MediaError) {
    return {index:i, type:'MediaError', ...mediaErrorDetails(d)};
  }
  if (d && typeof d === 'object') {
    const copy = {index:i, type:d.constructor && d.constructor.name || 'Object'};
    for (const k of Object.keys(d)) {
      const v = d[k];
      if (v instanceof Error) copy[k] = {name:v.name, message:v.message, stack:v.stack, code:v.code};
      else if (typeof MediaError !== 'undefined' && v instanceof MediaError) copy[k] = mediaErrorDetails(v);
      else copy[k] = v;
    }
    if (Object.keys(copy).length <= 2) copy.string = String(d);
    return copy;
  }
  return {index:i, type:typeof d, value:d};
}

function parseManifestInfo(xml) {
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const codecs = [...doc.querySelectorAll('Representation[codecs], AdaptationSet[codecs]')]
      .map(el => el.getAttribute('codecs')).filter(Boolean);
    const mimeTypes = [...doc.querySelectorAll('Representation[mimeType], AdaptationSet[mimeType]')]
      .map(el => el.getAttribute('mimeType')).filter(Boolean);
    const kids = [...xml.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}/gi)]
      .map(m => m[0]).slice(0, 30);
    const tests = [];
    const uniqueCodecs = [...new Set(codecs)];
    const uniqueMimes = [...new Set(mimeTypes)];
    for (const mt of uniqueMimes.length ? uniqueMimes : ['video/mp4','audio/mp4']) {
      for (const c of uniqueCodecs.length ? uniqueCodecs : ['']) {
        const type = c ? `${mt}; codecs=\"${c}\"` : mt;
        tests.push({type, canPlayType: video && video.canPlayType ? video.canPlayType(type) : null});
      }
    }
    return {
      mpdType: doc.querySelector('MPD')?.getAttribute('type') || null,
      profiles: doc.querySelector('MPD')?.getAttribute('profiles') || null,
      baseUrls: [...doc.querySelectorAll('BaseURL')].map(e => (e.textContent || '').trim()).slice(0, 20),
      codecs: uniqueCodecs.slice(0, 30),
      mimeTypes: uniqueMimes.slice(0, 20),
      kids,
      canPlayType: tests.slice(0, 50),
      segmentTemplates: [...doc.querySelectorAll('SegmentTemplate')].map(e => ({
        initialization:e.getAttribute('initialization'),
        media:e.getAttribute('media'),
        timescale:e.getAttribute('timescale'),
        duration:e.getAttribute('duration'),
        startNumber:e.getAttribute('startNumber')
      })).slice(0, 15),
      segmentUrls: [...doc.querySelectorAll('SegmentURL')].map(e => ({media:e.getAttribute('media'), index:e.getAttribute('index')})).slice(0, 15)
    };
  } catch (e) {
    return {parseError: e.message};
  }
}


function safeJson(value, max = 7000) {
  try {
    const seen = new WeakSet();
    const text = JSON.stringify(value, (key, val) => {
      if (typeof val === 'function') return '[Function]';
      if (typeof MediaError !== 'undefined' && val instanceof MediaError) return mediaErrorDetails(val);
      if (val && val.code && val.category && val.severity && Array.isArray(val.data)) return describeShakaError(val);
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
    refreshDebugOverlay(buildDebugText(), true);
  }
  console.log('[GenericShakaReceiver]', ...args);
}

function buildDebugText(extra = '') {
  return [
    'Generic Shaka Cast Receiver DEBUG',
    '=================================',
    `time: ${new Date().toISOString()}`,
    `status: ${statusEl ? statusEl.textContent : ''}`,
    `debugAutoScroll: ${debugAutoScroll} · use arrows/PageUp/PageDown/Enter if available`,
    '',
    'LAST LOAD:',
    safeJson(lastLoad, 2500),
    '',
    'LAST REQUEST:',
    safeJson(lastRequest, 2500),
    '',
    'LAST RESPONSE:',
    safeJson(lastResponse, 2500),
    '',
    'VIDEO SNAPSHOT:',
    safeJson(lastVideoSnapshot || videoSnapshot('debug'), 2500),
    '',
    'TRACKS:',
    safeJson(lastTracks, 2500),
    '',
    'MANIFEST INFO:',
    safeJson(lastManifestInfo, 3500),
    extra ? '\nEXTRA:\n' + extra : '',
    '',
    'RECENT:',
    recentLines.slice(-35).join('\n')
  ].join('\n');
}

function showError(title, error) {
  enableDebug('error');
  const rawDetail = error && error.detail ? error.detail : error;
  const detail = rawDetail && rawDetail.code && rawDetail.category && rawDetail.severity ? describeShakaError(rawDetail) : rawDetail;
  videoSnapshot(title);
  const text = [
    title,
    '-----',
    safeJson(detail, 9000)
  ].join('\n');
  if (debugEl) refreshDebugOverlay(buildDebugText(text), false);
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
  lastManifestInfo = parseManifestInfo(xml);

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
    setStatus(`Shaka error: ${err && err.code} ${describeShakaError(err)?.codeName || ''}`);
    showError('SHAKA PLAYER ERROR', err);
  });

  player.addEventListener('adaptation', () => {
    try { lastTracks = {variantTracks: player.getVariantTracks(), textTracks: player.getTextTracks()}; }
    catch (e) { lastTracks = {error:e.message}; }
    debugLine('SHAKA EVENT adaptation', lastTracks);
  });

  player.addEventListener('trackschanged', () => {
    try { lastTracks = {variantTracks: player.getVariantTracks(), textTracks: player.getTextTracks()}; }
    catch (e) { lastTracks = {error:e.message}; }
    debugLine('SHAKA EVENT trackschanged', lastTracks);
  });

  player.addEventListener('drmsessionupdate', event => debugLine('SHAKA EVENT drmsessionupdate', event));
  player.addEventListener('expirationupdated', event => debugLine('SHAKA EVENT expirationupdated', event));

  video.addEventListener('error', () => {
    showError('VIDEO ELEMENT ERROR', {
      code: video.error && video.error.code,
      message: video.error && video.error.message,
      networkState: video.networkState,
      readyState: video.readyState,
      currentSrc: video.currentSrc
    });
  });

  ['loadstart','loadedmetadata','loadeddata','canplay','canplaythrough','playing','pause','waiting','stalled','suspend','emptied','abort','ended','encrypted'].forEach(name => {
    video.addEventListener(name, ev => debugLine('VIDEO EVENT ' + name, videoSnapshot(name)));
  });

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

  config.streaming = {
    ...(config.streaming || {}),
    failureCallback: error => {
      debugLine('STREAMING failureCallback', describeShakaError(error));
      showError('STREAMING FAILURE CALLBACK', error);
    }
  };
  config.manifest = {
    ...(config.manifest || {}),
    dash: {
      ...((config.manifest && config.manifest.dash) || {}),
      ignoreMinBufferTime: true
    }
  };

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
    const described = describeShakaError(e);
    setStatus(`LOAD failed: Shaka Error ${e && e.code ? e.code : e.message} ${described?.codeName || ''}`);
    showError('SHAKA LOAD THROW', e);
    throw e;
  }

  try { lastTracks = {variantTracks: shakaPlayer.getVariantTracks(), textTracks: shakaPlayer.getTextTracks(), stats: shakaPlayer.getStats()}; } catch(e) {}
  videoSnapshot('after-load');
  setStatus('Playing');
}

async function main() {
  setupDebugControls();
  window.addEventListener('error', e => showError('WINDOW ERROR', {message:e.message, filename:e.filename, lineno:e.lineno, colno:e.colno, error:e.error}));
  window.addEventListener('unhandledrejection', e => showError('UNHANDLED REJECTION', e.reason));
  shaka.polyfill.installAll();
  if (shaka.log && shaka.log.setLevel) { try { shaka.log.setLevel(shaka.log.Level.DEBUG); } catch(e) {} }

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
