/*
 * ETB / Primeran CAF Receiver - clean native CAF build
 *
 * Base: chromecast-caf-receiver-v1-native-caf
 *
 * Goals:
 * - Use Chromecast CAF native player/UI only (<cast-media-player>).
 * - No custom playback overlays, no DPAD/focus engine, no Shaka UI.
 * - Configure ClearKey BEFORE CAF starts loading the media.
 * - Apply Cloudflare Access headers only to the same origin as the manifest URL.
 *   Never leak CF-Access-* headers to CDN origins.
 */

const context = cast.framework.CastReceiverContext.getInstance();
const playerManager = context.getPlayerManager();
const debugOverlay = document.getElementById('debugOverlay');

let currentCustomData = {};
let currentManifestOrigin = '';
let debugEnabled = new URLSearchParams(location.search).get('debug') === '1';
let debugOnError = new URLSearchParams(location.search).get('debugOnError') === '1';
let recent = [];

function safeJson(value, max = 9000) {
  try {
    const seen = new WeakSet();
    const text = JSON.stringify(value, (key, val) => {
      if (typeof val === 'function') return '[Function]';
      if (val instanceof Error) {
        return { name: val.name, message: val.message, stack: val.stack, code: val.code };
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

function log(...args) {
  const line = `${new Date().toISOString().slice(11, 19)} ${args.map(a => typeof a === 'string' ? a : safeJson(a, 1600)).join(' ')}`;
  recent.push(line);
  if (recent.length > 120) recent = recent.slice(-120);
  console.log('[ETB CAF Receiver]', ...args);
  if (debugEnabled) renderDebug();
}

function renderDebug(extra = '') {
  if (!debugOverlay) return;
  document.body.classList.add('debug');
  debugOverlay.textContent = [
    'ETB CAF Receiver DEBUG',
    '======================',
    `time: ${new Date().toISOString()}`,
    `userAgent: ${navigator.userAgent}`,
    `url: ${location.href}`,
    `manifestOrigin: ${currentManifestOrigin}`,
    '',
    'currentCustomData:',
    safeJson(redactCustomData(currentCustomData), 4000),
    '',
    extra,
    '',
    'recent:',
    recent.slice(-60).join('\n')
  ].join('\n');
}

function redactCustomData(data) {
  if (!data || typeof data !== 'object') return data;
  const copy = JSON.parse(JSON.stringify(data));
  const redactObj = obj => {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      if (/secret|token|password|cf-access-client-secret/i.test(k)) obj[k] = '[REDACTED]';
      else if (typeof obj[k] === 'object') redactObj(obj[k]);
    }
  };
  redactObj(copy);
  return copy;
}

function maybeEnableDebug(reason, extra) {
  if (debugEnabled || debugOnError || currentCustomData.debug || currentCustomData.debugOnError) {
    debugEnabled = true;
    log(`debug enabled: ${reason}`);
    renderDebug(extra || '');
  }
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!k || v === undefined || v === null || v === '') continue;
    out[String(k)] = String(v);
  }
  return out;
}

function accessHeaders() {
  const cd = currentCustomData || {};
  return {
    ...normalizeHeaders(cd.headers),
    ...normalizeHeaders(cd.requestHeaders)
  };
}

function requestUrlFromInfo(requestInfo) {
  if (!requestInfo) return '';
  if (requestInfo.url) return String(requestInfo.url);
  if (Array.isArray(requestInfo.urls) && requestInfo.urls.length) return String(requestInfo.urls[0]);
  return '';
}

function requestOrigin(url) {
  try {
    return new URL(url, location.href).origin;
  } catch (_) {
    return '';
  }
}

function shouldApplyAccessHeaders(url) {
  const headers = accessHeaders();
  if (!Object.keys(headers).length) return false;
  if (!currentManifestOrigin) return false;
  return requestOrigin(url) === currentManifestOrigin;
}

function applyAccessHeadersScoped(requestInfo) {
  const url = requestUrlFromInfo(requestInfo);
  if (!shouldApplyAccessHeaders(url)) return;
  const headers = accessHeaders();
  requestInfo.headers = requestInfo.headers || {};
  for (const [name, value] of Object.entries(headers)) {
    requestInfo.headers[name] = value;
  }
  log('applied scoped access headers', { origin: requestOrigin(url), names: Object.keys(headers) });
}

function applyAccessHeadersToShakaRequestScoped(request) {
  const url = request && Array.isArray(request.uris) && request.uris.length ? request.uris[0] : '';
  if (!shouldApplyAccessHeaders(url)) return;
  const headers = accessHeaders();
  request.headers = request.headers || {};
  for (const [name, value] of Object.entries(headers)) {
    request.headers[name] = value;
  }
}

function isHlsLike(media) {
  const type = String(media && media.contentType || '').toLowerCase();
  const url = String(media && (media.contentUrl || media.contentId) || '').toLowerCase();
  return type.includes('mpegurl') || type.includes('m3u8') || url.includes('.m3u8');
}

function isDashLike(media) {
  const type = String(media && media.contentType || '').toLowerCase();
  const url = String(media && (media.contentUrl || media.contentId) || '').toLowerCase();
  return type.includes('dash') || type.includes('mpd') || url.includes('.mpd');
}

function getMediaUrl(media) {
  return String(media && (media.contentUrl || media.contentId) || '');
}

function extractCustomData(loadRequestData) {
  const media = loadRequestData && loadRequestData.media;
  return {
    ...(loadRequestData && loadRequestData.customData || {}),
    ...(media && media.customData || {})
  };
}

function normalizeLoadRequest(loadRequestData) {
  const media = loadRequestData && loadRequestData.media;
  if (!media) return loadRequestData;

  currentCustomData = extractCustomData(loadRequestData);
  debugOnError = !!(debugOnError || currentCustomData.debugOnError);
  debugEnabled = !!(debugEnabled || currentCustomData.debug);

  // CAF expects contentUrl for playback. Many sender snippets only set contentId.
  if (!media.contentUrl && media.contentId) {
    media.contentUrl = media.contentId;
  }

  if (!media.contentType) {
    if (isHlsLike(media)) media.contentType = 'application/x-mpegURL';
    else if (isDashLike(media)) media.contentType = 'application/dash+xml';
  }

  currentManifestOrigin = requestOrigin(getMediaUrl(media));

  if (!media.metadata) {
    media.metadata = new cast.framework.messages.GenericMediaMetadata();
    media.metadata.title = currentCustomData.title || 'ETB';
  }

  // Do not force textTrackStyle here. The sender controls subtitles style
  // via GCKRemoteMediaClient.setTextTrackStyle(), including background/window.

  log('LOAD', {
    contentId: media.contentId,
    contentUrl: media.contentUrl,
    contentType: media.contentType,
    manifestOrigin: currentManifestOrigin,
    customDataKeys: Object.keys(currentCustomData || {})
  });

  return loadRequestData;
}

function getClearKeys(cd) {
  const drm = cd && cd.drm || {};
  return drm.clearKeys || cd.clearKeys || null;
}

function applyClearKeysToPlaybackConfig(config, cd) {
  const clearKeys = getClearKeys(cd);
  if (!clearKeys || typeof clearKeys !== 'object') return;

  // This is the important bit: set Shaka DRM config before CAF starts playback.
  config.shakaConfig = config.shakaConfig || {};
  config.shakaConfig.drm = config.shakaConfig.drm || {};
  config.shakaConfig.drm.clearKeys = clearKeys;

  // Some CAF versions also honor protectionSystem for encrypted DASH.
  try {
    config.protectionSystem = cast.framework.ContentProtection.WIDEVINE;
  } catch (_) {}

  log('configured ClearKey before load', { kids: Object.keys(clearKeys) });
}

function buildPlaybackConfig(loadRequestData, playbackConfig) {
  normalizeLoadRequest(loadRequestData);

  const config = playbackConfig || new cast.framework.PlaybackConfig();
  const cd = extractCustomData(loadRequestData);

  applyClearKeysToPlaybackConfig(config, cd);

  const oldManifestHandler = config.manifestRequestHandler;
  const oldSegmentHandler = config.segmentRequestHandler;
  const oldLicenseHandler = config.licenseRequestHandler;

  config.manifestRequestHandler = requestInfo => {
    applyAccessHeadersScoped(requestInfo);
    if (oldManifestHandler) oldManifestHandler(requestInfo);
  };

  config.segmentRequestHandler = requestInfo => {
    applyAccessHeadersScoped(requestInfo);
    if (oldSegmentHandler) oldSegmentHandler(requestInfo);
  };

  config.licenseRequestHandler = requestInfo => {
    // Access headers are scoped to the manifest origin; DRM headers are only for license endpoints.
    applyAccessHeadersScoped(requestInfo);

    const drmHeaders = normalizeHeaders(cd.drm && cd.drm.headers);
    if (Object.keys(drmHeaders).length) {
      requestInfo.headers = requestInfo.headers || {};
      Object.assign(requestInfo.headers, drmHeaders);
    }

    if (oldLicenseHandler) oldLicenseHandler(requestInfo);
  };

  if (cd.drm && cd.drm.licenseUrl) {
    config.licenseUrl = cd.drm.licenseUrl;
  }

  return config;
}

function getShakaPlayerFromEvent(event) {
  try {
    if (event && event.player && event.player.getShakaPlayer) return event.player.getShakaPlayer();
  } catch (_) {}
  try {
    if (playerManager.getShakaPlayer) return playerManager.getShakaPlayer();
  } catch (_) {}
  try {
    if (playerManager.getPlayer && playerManager.getPlayer().getShakaPlayer) return playerManager.getPlayer().getShakaPlayer();
  } catch (_) {}
  return null;
}

function installBestEffortShakaRequestFilter(event) {
  const cd = currentCustomData || {};
  const shakaPlayer = getShakaPlayerFromEvent(event);
  if (!shakaPlayer) return;

  try {
    // Keep this as a fallback. The primary ClearKey config happens before load.
    const extraShakaConfig = cd.shakaConfig || {};
    if (Object.keys(extraShakaConfig).length) {
      shakaPlayer.configure(extraShakaConfig);
      log('configured extra Shaka config', extraShakaConfig);
    }

    const net = shakaPlayer.getNetworkingEngine && shakaPlayer.getNetworkingEngine();
    if (net && !net.__etbScopedHeadersInstalled) {
      net.__etbScopedHeadersInstalled = true;
      net.registerRequestFilter((type, request) => {
        applyAccessHeadersToShakaRequestScoped(request);
        const drmHeaders = normalizeHeaders(cd.drm && cd.drm.headers);
        if (Object.keys(drmHeaders).length) {
          request.headers = request.headers || {};
          Object.assign(request.headers, drmHeaders);
        }
      });
      log('installed scoped Shaka request filter');
    }
  } catch (e) {
    maybeEnableDebug('shaka-config-error', safeJson(e, 6000));
  }
}



// -----------------------------------------------------------------------------
// ETB Custom Control Channel (isolated, best-effort)
// -----------------------------------------------------------------------------
// This module is deliberately isolated from LOAD / ClearKey / playbackConfig.
// It only reads Shaka state after playback has started and applies user-initiated
// text-track / quality selections. If Shaka is not available, it reports empty
// capabilities instead of touching the playback pipeline.
const ETB_CUSTOM_NAMESPACE = 'urn:x-cast:etb.custom';
let lastEtbSenderId = null;

function getCustomChannelShakaPlayer() {
  try {
    if (playerManager.getShakaPlayer) {
      const p = playerManager.getShakaPlayer();
      if (p) return p;
    }
  } catch (_) {}
  try {
    if (playerManager.getPlayer && playerManager.getPlayer().getShakaPlayer) {
      const p = playerManager.getPlayer().getShakaPlayer();
      if (p) return p;
    }
  } catch (_) {}
  return null;
}

function safeTrackLabel(track, fallback) {
  return track && (track.label || track.language || track.originalLanguage || track.kind || fallback) || fallback;
}

function normalizeTextTrack(track) {
  return {
    id: track.id,
    language: track.language || track.originalLanguage || '',
    label: safeTrackLabel(track, 'Subtitles'),
    kind: track.kind || 'subtitle',
    active: !!track.active,
    roles: Array.isArray(track.roles) ? track.roles : [],
    forced: !!track.forced
  };
}

function normalizeVariantTrack(track) {
  const height = track.height || 0;
  const width = track.width || 0;
  const bandwidth = track.bandwidth || 0;
  const mbps = bandwidth ? Math.round((bandwidth / 1000000) * 10) / 10 : 0;
  return {
    id: track.id,
    language: track.language || '',
    label: track.label || (height ? `${height}p` : (mbps ? `${mbps} Mbps` : `Variant ${track.id}`)),
    width,
    height,
    bandwidth,
    codecs: track.codecs || '',
    audioCodec: track.audioCodec || '',
    videoCodec: track.videoCodec || '',
    active: !!track.active
  };
}

function getAbrEnabled(shakaPlayer) {
  try {
    const config = shakaPlayer.getConfiguration && shakaPlayer.getConfiguration();
    return !!(config && config.abr && config.abr.enabled);
  } catch (_) {
    return true;
  }
}

function collectCustomChannelState() {
  const shakaPlayer = getCustomChannelShakaPlayer();
  if (!shakaPlayer) {
    return {
      ok: true,
      shakaAvailable: false,
      textTracks: [],
      variantTracks: [],
      textVisible: false,
      abrEnabled: true,
      note: 'Shaka player not available for current media.'
    };
  }

  let textTracks = [];
  let variantTracks = [];
  let textVisible = false;
  let abrEnabled = true;

  try { textTracks = (shakaPlayer.getTextTracks() || []).map(normalizeTextTrack); } catch (e) { log('custom getTextTracks failed', e); }
  try { variantTracks = (shakaPlayer.getVariantTracks() || []).map(normalizeVariantTrack); } catch (e) { log('custom getVariantTracks failed', e); }
  try { textVisible = !!shakaPlayer.isTextTrackVisible(); } catch (_) {}
  abrEnabled = getAbrEnabled(shakaPlayer);

  return {
    ok: true,
    shakaAvailable: true,
    textTracks,
    variantTracks,
    textVisible,
    abrEnabled,
    activeTextTrackId: (textTracks.find(t => t.active) || {}).id ?? null,
    activeVariantTrackId: (variantTracks.find(t => t.active) || {}).id ?? null
  };
}

function sendCustomChannelMessage(senderId, payload) {
  try {
    context.sendCustomMessage(ETB_CUSTOM_NAMESPACE, senderId, payload);
  } catch (e) {
    log('custom send failed', e, payload);
  }
}

function replyCustom(event, payload) {
  const data = event && event.data || {};
  const senderId = event && event.senderId || lastEtbSenderId;
  if (!senderId) return;
  sendCustomChannelMessage(senderId, {
    requestId: data.requestId || null,
    ...payload
  });
}

function selectCustomTextTrack(id) {
  const shakaPlayer = getCustomChannelShakaPlayer();
  if (!shakaPlayer) throw new Error('Shaka player not available');

  if (id === null || id === undefined || id === 'off') {
    shakaPlayer.setTextTrackVisibility(false);
    return collectCustomChannelState();
  }

  const numericId = Number(id);
  const track = (shakaPlayer.getTextTracks() || []).find(t => Number(t.id) === numericId);
  if (!track) throw new Error(`Text track not found: ${id}`);

  shakaPlayer.selectTextTrack(track);
  shakaPlayer.setTextTrackVisibility(true);
  return collectCustomChannelState();
}

function selectCustomVariant(id) {
  const shakaPlayer = getCustomChannelShakaPlayer();
  if (!shakaPlayer) throw new Error('Shaka player not available');

  if (id === null || id === undefined || id === 'auto') {
    shakaPlayer.configure({ abr: { enabled: true } });
    return collectCustomChannelState();
  }

  const numericId = Number(id);
  const track = (shakaPlayer.getVariantTracks() || []).find(t => Number(t.id) === numericId);
  if (!track) throw new Error(`Variant track not found: ${id}`);

  shakaPlayer.configure({ abr: { enabled: false } });
  // clearBuffer=true helps the selected quality take effect quickly. If unsupported
  // by the platform/Shaka version, fall back to the non-clearing form.
  try { shakaPlayer.selectVariantTrack(track, true); }
  catch (_) { shakaPlayer.selectVariantTrack(track); }
  return collectCustomChannelState();
}

function installCustomControlChannel() {
  try {
    context.addCustomMessageListener(ETB_CUSTOM_NAMESPACE, event => {
      lastEtbSenderId = event && event.senderId || lastEtbSenderId;
      const data = event && event.data || {};
      const type = data.type;
      log('custom channel message', { type, requestId: data.requestId });

      try {
        if (type === 'ping') {
          replyCustom(event, { type: 'pong', ok: true });
          return;
        }
        if (type === 'getTracks' || type === 'getState') {
          replyCustom(event, { type: 'tracks', ...collectCustomChannelState() });
          return;
        }
        if (type === 'setTextTrack') {
          replyCustom(event, { type: 'tracks', ...selectCustomTextTrack(data.id) });
          return;
        }
        if (type === 'setVariant' || type === 'setQuality') {
          replyCustom(event, { type: 'tracks', ...selectCustomVariant(data.id) });
          return;
        }
        if (type === 'setAutoQuality') {
          replyCustom(event, { type: 'tracks', ...selectCustomVariant('auto') });
          return;
        }
        replyCustom(event, { type: 'error', ok: false, error: `Unknown custom message type: ${type}` });
      } catch (e) {
        log('custom channel command failed', e);
        replyCustom(event, { type: 'error', ok: false, error: e && e.message ? e.message : String(e) });
      }
    });
    log('custom control channel installed', ETB_CUSTOM_NAMESPACE);
  } catch (e) {
    log('custom control channel install failed', e);
  }
}

function broadcastCustomChannelStateSoon(reason) {
  const senderId = lastEtbSenderId;
  if (!senderId) return;
  setTimeout(() => {
    sendCustomChannelMessage(senderId, { type: 'tracks', reason, ...collectCustomChannelState() });
  }, 250);
}

playerManager.setMessageInterceptor(
  cast.framework.messages.MessageType.LOAD,
  loadRequestData => normalizeLoadRequest(loadRequestData)
);

playerManager.setMediaPlaybackInfoHandler((loadRequestData, playbackConfig) => {
  return buildPlaybackConfig(loadRequestData, playbackConfig);
});

playerManager.setMessageInterceptor(
  cast.framework.messages.MessageType.EDIT_TRACKS_INFO,
  request => {
    // Preserve sender-provided textTrackStyle. Older receiver versions forced
    // transparent backgrounds here, which overrode the iOS subtitle style UI.
    return request;
  }
);

playerManager.addEventListener(cast.framework.events.EventType.PLAYER_LOAD_COMPLETE, event => {
  log('PLAYER_LOAD_COMPLETE');
  installBestEffortShakaRequestFilter(event);
  broadcastCustomChannelStateSoon('loadComplete');
});

playerManager.addEventListener(cast.framework.events.EventType.ERROR, event => {
  maybeEnableDebug('caf-error', safeJson(event, 8000));
});

playerManager.addEventListener(cast.framework.events.EventType.MEDIA_STATUS, event => {
  if (debugEnabled) log('MEDIA_STATUS', event && event.mediaStatus ? {
    playerState: event.mediaStatus.playerState,
    currentTime: event.mediaStatus.currentTime,
    activeTrackIds: event.mediaStatus.activeTrackIds
  } : event);
});

try {
  const Command = cast.framework.messages.Command;
  playerManager.setSupportedMediaCommands(
    Command.PAUSE |
    Command.SEEK |
    Command.STREAM_VOLUME |
    Command.STREAM_MUTE |
    Command.EDIT_TRACKS |
    Command.PLAYBACK_RATE
  );
} catch (e) {
  log('setSupportedMediaCommands skipped', e);
}

const options = new cast.framework.CastReceiverOptions();
options.disableIdleTimeout = true;
options.useShakaForHls = true;
options.useShakaForDash = true;
options.useShaka = true;

installCustomControlChannel();

log('starting CAF receiver');
context.start(options);
