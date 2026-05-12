const video = document.getElementById('video');
const statusEl = document.getElementById('status');
const debugEl = document.getElementById('debugOverlay');
const debugPrevBtn = document.getElementById('debugPrev');
const debugNextBtn = document.getElementById('debugNext');
const debugAutoBtn = document.getElementById('debugAuto');
const debugPageLabel = document.getElementById('debugPageLabel');
const debugQrBtn = document.getElementById('debugQr');
const qrPanel = document.getElementById('qrPanel');
const qrImage = document.getElementById('qrImage');
const qrText = document.getElementById('qrText');

let player = null;
let lastObjectUrl = null;
const queryParams = new URLSearchParams(location.search);
let debugEnabled = queryParams.get('debug') === '1';
let autoDebugOnError = queryParams.get('debugOnError') === '1';
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
let currentMediaInfoForStatus = null;
let currentActiveTrackIds = [];
let castTrackMap = new Map();
let playerManagerRef = null;


function base64UrlEncodeUtf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function makeDebugPayloadForExport() {
  const fullText = debugTextCache || buildDebugText();
  const payload = {
    type: 'generic-shaka-receiver-debug',
    version: 73,
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    location: location.href,
    status: statusEl ? statusEl.textContent : '',
    lastLoad,
    lastRequest,
    lastResponse,
    videoSnapshot: lastVideoSnapshot || videoSnapshot('qr-export'),
    tracks: lastTracks,
    manifestInfo: lastManifestInfo,
    recentLines,
    fullText,
  };
  return JSON.stringify(payload, null, 2);
}

// Minimal QR generator would be too heavy for all payload sizes.
// Use qrserver public image API for compact payloads; for large logs show a data URL text payload.
// Chromecast only needs to display it. No receiver data is sent to our app.
function renderQrImageUrl(url) {
  return new Promise((resolve, reject) => {
    if (!qrImage) return reject(new Error('qrImage element missing'));
    qrImage.onload = () => resolve();
    qrImage.onerror = () => reject(new Error('QR img load failed'));
    qrImage.src = url;
  });
}

async function showDebugQr() {
  if (!qrPanel || !qrImage || !qrText) return;

  const payload = makeDebugPayloadForExport();
  const encoded = base64UrlEncodeUtf8(payload);
  const dataUrl = `data:application/json;base64,${encoded}`;
  const compact = `DBG73:${encoded}`;

  qrPanel.classList.add('visible');

  // QR practical limit: keep it short. If too long, encode the tail plus an instruction.
  let qrData = compact;
  let label = `DBG73 base64url JSON chars=${encoded.length}`;

  if (compact.length > 1800) {
    const slimPayload = JSON.stringify({
      type: 'generic-shaka-receiver-debug-slim',
      version: 73,
      generatedAt: new Date().toISOString(),
      status: statusEl ? statusEl.textContent : '',
      errorHint: recentLines.slice(-20).join('\n'),
      lastRequest,
      lastResponse,
      videoSnapshot: lastVideoSnapshot || videoSnapshot('qr-export-slim'),
      manifestInfo: lastManifestInfo,
    }, null, 2);
    const slim = base64UrlEncodeUtf8(slimPayload);
    qrData = `DBG73:${slim}`;
    label = `DBG73 slim base64url JSON chars=${slim.length}; full=${encoded.length}`;
  }

  qrText.textContent = label + '\n' + qrData.slice(0, 240) + (qrData.length > 240 ? '…' : '');

  const api = 'https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=8&data=' + encodeURIComponent(qrData);
  try {
    await renderQrImageUrl(api);
    debugLine('QR DEBUG generated', label);
  } catch (e) {
    if (qrImage) qrImage.removeAttribute('src');
    qrText.textContent = 'QR image failed. Copy/photograph this payload:\n' + qrData;
    debugLine('QR DEBUG failed', String(e && e.message || e));
  }
}



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
  debugQrBtn && debugQrBtn.addEventListener('click', () => showDebugQr());
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
    if (key === 'q' || key === 'Q') { ev.preventDefault(); showDebugQr(); return; }
    if (key === 'Escape' && qrPanel && qrPanel.classList.contains('visible')) { ev.preventDefault(); qrPanel.classList.remove('visible'); return; }
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
    `debugAutoScroll: ${debugAutoScroll} · use arrows/PageUp/PageDown/Enter; Q = QR log`,
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
  if (debugEnabled || autoDebugOnError) enableDebug('error');
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


function headerObjectFromCustomData(customData = {}) {
  const drm = customData.drm || {};
  return {
    ...(customData.headers || {}),
    ...(drm.headers || {})
  };
}

function normalizeTrackLanguage(value) {
  const lang = String(value || '').trim();
  return lang || 'und';
}

function audioKeyFromVariant(track) {
  return [
    normalizeTrackLanguage(track.language || track.audioLanguage),
    track.audioId || '',
    Array.isArray(track.roles) ? track.roles.join(',') : '',
    track.label || ''
  ].join('|');
}

function textKeyFromTrack(track) {
  return [
    normalizeTrackLanguage(track.language),
    track.id || '',
    Array.isArray(track.roles) ? track.roles.join(',') : '',
    track.label || ''
  ].join('|');
}

function makeCastTrack(id, type, fields) {
  return {
    trackId: id,
    type,
    ...fields
  };
}

function collectCastTracksFromShaka(shakaPlayer) {
  const castTracks = [];
  const activeTrackIds = [];
  castTrackMap = new Map();

  let nextAudioId = 1;
  let nextTextId = 1001;

  const audioSeen = new Map();
  const variants = shakaPlayer.getVariantTracks ? shakaPlayer.getVariantTracks() : [];
  for (const variant of variants) {
    const key = audioKeyFromVariant(variant);
    if (audioSeen.has(key)) continue;
    const id = nextAudioId++;
    audioSeen.set(key, id);

    const language = normalizeTrackLanguage(variant.language || variant.audioLanguage);
    const name = variant.label || `Audio ${language}`;
    castTracks.push(makeCastTrack(id, 'AUDIO', {
      name,
      language,
      roles: variant.roles || [],
      customData: { shakaKind: 'audio', key, language, audioId: variant.audioId || null }
    }));
    castTrackMap.set(id, { kind: 'audio', key, language, variant });

    if (variant.active && !activeTrackIds.includes(id)) activeTrackIds.push(id);
  }

  const texts = shakaPlayer.getTextTracks ? shakaPlayer.getTextTracks() : [];
  for (const textTrack of texts) {
    const id = nextTextId++;
    const language = normalizeTrackLanguage(textTrack.language);
    const mime = textTrack.mimeType || 'text/vtt';
    const name = textTrack.label || `Subtitles ${language}`;
    castTracks.push(makeCastTrack(id, 'TEXT', {
      name,
      language,
      trackContentType: mime,
      subtype: 'SUBTITLES',
      roles: textTrack.roles || [],
      customData: { shakaKind: 'text', key: textKeyFromTrack(textTrack), language, shakaId: textTrack.id }
    }));
    castTrackMap.set(id, { kind: 'text', textTrack, language });
  }

  if (shakaPlayer.isTextTrackVisible && shakaPlayer.isTextTrackVisible()) {
    const activeText = texts.find(t => t.active) || texts[0];
    if (activeText) {
      for (const [id, info] of castTrackMap.entries()) {
        if (info.kind === 'text' && info.textTrack === activeText) activeTrackIds.push(id);
      }
    }
  }

  currentActiveTrackIds = activeTrackIds;
  lastTracks = {
    variantTracks: variants,
    textTracks: texts,
    castTracks,
    activeTrackIds
  };

  return { castTracks, activeTrackIds };
}

function updateCastMediaTracksOnStatus(mediaInfo, trackState) {
  if (!mediaInfo || !trackState) return;
  mediaInfo.tracks = trackState.castTracks;
  mediaInfo.activeTrackIds = trackState.activeTrackIds;
  currentMediaInfoForStatus = mediaInfo;
  currentActiveTrackIds = trackState.activeTrackIds;

  try {
    if (playerManagerRef && typeof playerManagerRef.setMediaInformation === 'function') {
      playerManagerRef.setMediaInformation(mediaInfo);
    }
    if (playerManagerRef && typeof playerManagerRef.broadcastStatus === 'function') {
      playerManagerRef.broadcastStatus(true);
    }
  } catch (e) {
    debugLine('CAF track status update failed', e);
  }
}

function selectAudioTrackByCastTrackId(trackId) {
  if (!player || !castTrackMap.has(trackId)) return false;
  const info = castTrackMap.get(trackId);
  if (!info || info.kind !== 'audio') return false;

  const variants = player.getVariantTracks ? player.getVariantTracks() : [];
  const current = variants.find(v => v.active) || null;
  const candidates = variants.filter(v => audioKeyFromVariant(v) === info.key);
  const target =
    (current && candidates.find(v => v.height === current.height && v.videoId === current.videoId)) ||
    (current && candidates.find(v => v.height === current.height)) ||
    candidates[0];

  if (!target) return false;
  player.selectVariantTrack(target, true);
  debugLine('Selected audio track', { trackId, target });
  return true;
}

function applyCastActiveTrackIds(activeTrackIds = []) {
  const ids = Array.isArray(activeTrackIds) ? activeTrackIds.map(Number) : [];
  const textIds = ids.filter(id => castTrackMap.get(id)?.kind === 'text');
  const audioIds = ids.filter(id => castTrackMap.get(id)?.kind === 'audio');

  if (audioIds.length) selectAudioTrackByCastTrackId(audioIds[0]);

  if (player) {
    if (textIds.length) {
      const info = castTrackMap.get(textIds[0]);
      if (info && info.textTrack) {
        player.selectTextTrack(info.textTrack);
        player.setTextTrackVisibility(true);
        debugLine('Selected text track', { trackId: textIds[0], textTrack: info.textTrack });
      }
    } else if (player.setTextTrackVisibility) {
      player.setTextTrackVisibility(false);
      debugLine('Text tracks disabled');
    }
  }

  currentActiveTrackIds = ids;
  if (currentMediaInfoForStatus) currentMediaInfoForStatus.activeTrackIds = ids;
  try {
    if (playerManagerRef && typeof playerManagerRef.broadcastStatus === 'function') {
      playerManagerRef.broadcastStatus(true);
    }
  } catch (e) {}
}

function interceptMessage(playerManager, messageTypeName, handler) {
  const messageType = cast?.framework?.messages?.MessageType?.[messageTypeName];
  if (!messageType) {
    debugLine('CAF message type unavailable', messageTypeName);
    return;
  }
  try {
    playerManager.setMessageInterceptor(messageType, handler);
  } catch (e) {
    debugLine('Failed to install interceptor', messageTypeName, e);
  }
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

  const combinedHeaders = headerObjectFromCustomData(customData);
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

  let trackState = null;
  try {
    trackState = collectCastTracksFromShaka(shakaPlayer);
    lastTracks = {
      ...(lastTracks || {}),
      stats: shakaPlayer.getStats ? shakaPlayer.getStats() : null
    };
  } catch(e) {
    debugLine('collectCastTracks failed', e);
  }
  videoSnapshot('after-load');
  setStatus('Playing');
  return trackState;
}

async function main() {
  setupDebugControls();
  window.addEventListener('error', e => showError('WINDOW ERROR', {message:e.message, filename:e.filename, lineno:e.lineno, colno:e.colno, error:e.error}));
  window.addEventListener('unhandledrejection', e => showError('UNHANDLED REJECTION', e.reason));
  shaka.polyfill.installAll();
  if (shaka.log && shaka.log.setLevel) { try { shaka.log.setLevel(debugEnabled ? shaka.log.Level.DEBUG : shaka.log.Level.WARNING); } catch(e) {} }

  if (!shaka.Player.isBrowserSupported()) {
    setStatus('Shaka not supported');
    return;
  }

  const context = cast.framework.CastReceiverContext.getInstance();
  const playerManager = context.getPlayerManager();
  playerManagerRef = playerManager;

  try {
    playerManager.setSupportedMediaCommands(
      cast.framework.messages.Command.ALL_BASIC_MEDIA |
      cast.framework.messages.Command.QUEUE_NEXT |
      cast.framework.messages.Command.QUEUE_PREV,
      true
    );
  } catch (e) {
    debugLine('setSupportedMediaCommands failed', e);
  }

  // v7.1 safe remote debug controls.
  // Do not capture TV remote keys globally; instead let the sender request QR/debug actions.
  try {
    context.addCustomMessageListener('urn:x-cast:debug', event => {
      try {
        let data = event && event.data ? event.data : {};
        if (typeof data === 'string') {
          try {
            data = JSON.parse(data);
          } catch (_) {
            data = { action: data };
          }
        }
        debugLine('DEBUG MESSAGE', data);
        if (data.action === 'enableDebug') enableDebug('remote message');
        if (data.action === 'showQr') {
          enableDebug('remote showQr');
          showDebugQr();
        }
        if (data.action === 'hideQr' && qrPanel) qrPanel.classList.remove('visible');
        if (data.action === 'nextPage') scrollDebugByPages(1);
        if (data.action === 'prevPage') scrollDebugByPages(-1);
        if (data.action === 'auto') {
          debugAutoScroll = !debugAutoScroll;
          updateDebugPageLabel();
        }
      } catch (e) {
        console.error('[GenericShakaReceiver] debug message failed', e);
      }
    });
  } catch (e) {
    console.warn('[GenericShakaReceiver] addCustomMessageListener failed', e);
  }


  playerManager.addEventListener(cast.framework.events.EventType.ERROR, event => {
    showError('CAF ERROR EVENT', event);
  });

  playerManager.addEventListener(cast.framework.events.EventType.PLAYER_LOAD_COMPLETE, event => {
    debugLine('CAF PLAYER_LOAD_COMPLETE', event);
  });


  interceptMessage(playerManager, 'PLAY', requestData => {
    debugLine('CAF PLAY', requestData);
    video.play && video.play().catch(e => debugLine('video.play failed', e));
    return requestData;
  });

  interceptMessage(playerManager, 'PAUSE', requestData => {
    debugLine('CAF PAUSE', requestData);
    video.pause && video.pause();
    return requestData;
  });

  interceptMessage(playerManager, 'SEEK', requestData => {
    debugLine('CAF SEEK', requestData);
    if (typeof requestData.currentTime === 'number' && Number.isFinite(requestData.currentTime)) {
      video.currentTime = requestData.currentTime;
    }
    return requestData;
  });

  interceptMessage(playerManager, 'STOP', requestData => {
    debugLine('CAF STOP', requestData);
    try { if (player) player.unload(); } catch(e) {}
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch(e) {}
    return requestData;
  });

  interceptMessage(playerManager, 'EDIT_TRACKS_INFO', requestData => {
    debugLine('CAF EDIT_TRACKS_INFO', requestData);
    const ids = requestData.activeTrackIds || [];
    applyCastActiveTrackIds(ids);
    return requestData;
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
        const trackState = await loadContent(mediaInfo);
        if (trackState) {
          updateCastMediaTracksOnStatus(mediaInfo, trackState);
          loadRequestData.activeTrackIds = trackState.activeTrackIds;
        }

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
