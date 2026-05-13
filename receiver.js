/*
 * ETB / MediaFlow CAF Receiver
 *
 * Design goal:
 * - Use Chromecast CAF native player and UI only (<cast-media-player>).
 * - Do not create custom playback overlays, controls, focus engines, or Shaka UI controls.
 * - Use CAF/Shaka internals for HLS/DASH playback, scrubber, captions, audio tracks and remote control.
 * - Keep only the required custom behavior: optional Cloudflare headers, optional DRM/ClearKey config,
 *   debug-on-error, and safe LOAD normalization.
 */

const context = cast.framework.CastReceiverContext.getInstance();
const playerManager = context.getPlayerManager();
const debugOverlay = document.getElementById('debugOverlay');

let currentCustomData = {};
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
  const line = `${new Date().toISOString().slice(11,19)} ${args.map(a => typeof a === 'string' ? a : safeJson(a, 1600)).join(' ')}`;
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
    '',
    'currentCustomData:',
    safeJson(currentCustomData, 4000),
    '',
    extra,
    '',
    'recent:',
    recent.slice(-60).join('\n')
  ].join('\n');
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

function combinedHeaders() {
  const cd = currentCustomData || {};
  return {
    ...normalizeHeaders(cd.headers),
    ...normalizeHeaders(cd.requestHeaders)
  };
}

function applyHeadersToRequestInfo(requestInfo) {
  const headers = combinedHeaders();
  if (!Object.keys(headers).length || !requestInfo) return;
  requestInfo.headers = requestInfo.headers || {};
  for (const [name, value] of Object.entries(headers)) {
    requestInfo.headers[name] = value;
  }
  log('applied custom headers', Object.keys(headers));
}

function applyHeadersToShakaRequest(request) {
  const headers = combinedHeaders();
  if (!Object.keys(headers).length || !request) return;
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

function normalizeLoadRequest(loadRequestData) {
  const media = loadRequestData && loadRequestData.media;
  if (!media) return loadRequestData;

  currentCustomData = {
    ...(loadRequestData.customData || {}),
    ...(media.customData || {})
  };
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

  // Chromecast CAF is picky about HLS MIME types on some firmware.
  // Normalize both sender variants to the CAF-native MIME used by Google examples.
  if (isHlsLike(media)) {
    media.contentType = 'application/x-mpegURL';
  }

  // Keep metadata visible in CAF UI if sender omitted it.
  if (!media.metadata) {
    media.metadata = new cast.framework.messages.GenericMediaMetadata();
    media.metadata.title = currentCustomData.title || 'ETB';
  }

  log('LOAD', {
    contentId: media.contentId,
    contentUrl: media.contentUrl,
    contentType: media.contentType,
    customDataKeys: Object.keys(currentCustomData || {})
  });

  return loadRequestData;
}

function buildPlaybackConfig(loadRequestData, playbackConfig) {
  const config = playbackConfig || new cast.framework.PlaybackConfig();
  const cd = currentCustomData || {};

  const oldManifestHandler = config.manifestRequestHandler;
  const oldSegmentHandler = config.segmentRequestHandler;
  const oldLicenseHandler = config.licenseRequestHandler;

  config.manifestRequestHandler = requestInfo => {
    applyHeadersToRequestInfo(requestInfo);
    if (oldManifestHandler) oldManifestHandler(requestInfo);
  };

  config.segmentRequestHandler = requestInfo => {
    applyHeadersToRequestInfo(requestInfo);
    if (oldSegmentHandler) oldSegmentHandler(requestInfo);
  };

  config.licenseRequestHandler = requestInfo => {
    // General headers are useful for Cloudflare Access in front of license endpoints too.
    applyHeadersToRequestInfo(requestInfo);

    const drmHeaders = normalizeHeaders(cd.drm && cd.drm.headers);
    if (Object.keys(drmHeaders).length) {
      requestInfo.headers = requestInfo.headers || {};
      Object.assign(requestInfo.headers, drmHeaders);
    }

    if (oldLicenseHandler) oldLicenseHandler(requestInfo);
  };

  // Optional CAF-level license config for non-ClearKey DRM.
  if (cd.drm && cd.drm.licenseUrl) {
    config.licenseUrl = cd.drm.licenseUrl;
  }

  return config;
}

function getShakaPlayerFromEvent(event) {
  // CAF internals differ by firmware. This is best-effort only.
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

function configureShakaIfAvailable(event) {
  const cd = currentCustomData || {};
  const shakaPlayer = getShakaPlayerFromEvent(event);
  if (!shakaPlayer) return;

  try {
    const shakaConfig = cd.shakaConfig || {};
    const drm = cd.drm || {};
    const config = { ...shakaConfig };

    // Common sender shapes supported:
    // customData.drm.clearKeys = { kid: key }
    // customData.clearKeys = { kid: key }
    const clearKeys = drm.clearKeys || cd.clearKeys;
    if (clearKeys && typeof clearKeys === 'object') {
      config.drm = {
        ...(config.drm || {}),
        clearKeys
      };
    }

    if (Object.keys(config).length) {
      shakaPlayer.configure(config);
      log('configured Shaka', config);
    }

    // Optional fallback network filter in addition to CAF request handlers.
    const net = shakaPlayer.getNetworkingEngine && shakaPlayer.getNetworkingEngine();
    if (net && !net.__etbHeadersInstalled) {
      net.__etbHeadersInstalled = true;
      net.registerRequestFilter((type, request) => {
        applyHeadersToShakaRequest(request);
        const drmHeaders = normalizeHeaders(cd.drm && cd.drm.headers);
        if (Object.keys(drmHeaders).length) {
          request.headers = request.headers || {};
          Object.assign(request.headers, drmHeaders);
        }
      });
      log('installed Shaka request filter');
    }
  } catch (e) {
    maybeEnableDebug('shaka-config-error', safeJson(e, 6000));
  }
}

playerManager.setMessageInterceptor(
  cast.framework.messages.MessageType.LOAD,
  loadRequestData => normalizeLoadRequest(loadRequestData)
);

playerManager.setMediaPlaybackInfoHandler((loadRequestData, playbackConfig) => {
  normalizeLoadRequest(loadRequestData);
  return buildPlaybackConfig(loadRequestData, playbackConfig);
});

playerManager.addEventListener(cast.framework.events.EventType.PLAYER_LOAD_COMPLETE, event => {
  log('PLAYER_LOAD_COMPLETE');
  configureShakaIfAvailable(event);
});

playerManager.addEventListener(cast.framework.events.EventType.PLAYER_PRELOADING, event => {
  log('PLAYER_PRELOADING', event);
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

// Remote command support. CAF handles these natively, but this declares capabilities clearly to senders.
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

// DASH/ClearKey needs Shaka. HLS is more reliable through CAF/native HLS on Chromecast.
// Do NOT force Shaka for HLS: ETB catch-up HLS can fail/idle on some Chromecast firmware when routed through Shaka.
options.useShakaForDash = true;
options.useShaka = true;
options.useShakaForHls = false;

log('starting CAF receiver');
context.start(options);
