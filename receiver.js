/*
 * Minimal native Shaka UI Chromecast receiver.
 * No custom playback overlay, no custom focus engine, no custom theming.
 * Custom code is limited to:
 *   - Cast LOAD handling
 *   - optional request headers, e.g. Cloudflare Access
 *   - optional DRM/ClearKey config
 *   - media command glue for CAF
 */

const video = document.getElementById('video');
const container = document.querySelector('[data-shaka-player-container]');
const debugEl = document.getElementById('debug');

let player = null;
let ui = null;
let controls = null;
let currentMediaInfo = null;
let debugEnabled = false;
let debugOnError = false;
let castContext = null;
let playerManager = null;
let statusTimer = null;

function log(...args) {
  console.log('[ETBShakaReceiver]', ...args);
}

function showDebug(text, force = false) {
  if (!debugEnabled && !(force && debugOnError)) return;
  document.body.classList.add('debug-visible');
  debugEl.textContent = String(text || '');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    if (!debugEnabled) document.body.classList.remove('debug-visible');
  }, 12000);
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

function readOptionalHeaders(customData = {}) {
  // Keep this deliberately optional. Local playback must not be affected.
  return customData.headers || customData.requestHeaders || customData.drm?.headers || null;
}

function buildShakaConfig(customData = {}, contentType = '') {
  const drm = customData.drm || {};
  const shakaConfig = customData.shakaConfig || {};
  const type = normalizeDrmType(drm.type);
  const keySystem = keySystemFor(type);

  const isHls = /mpegurl|x-mpegurl|vnd\.apple\.mpegurl/i.test(contentType);

  const config = {
    ...shakaConfig,
    streaming: {
      lowLatencyMode: false,
      rebufferingGoal: 2,
      bufferingGoal: 60,
      bufferBehind: 30,
      retryParameters: {
        maxAttempts: 3,
        baseDelay: 500,
        backoffFactor: 2,
        fuzzFactor: 0.5,
        timeout: 30000,
        ...(shakaConfig.streaming?.retryParameters || {})
      },
      ...(shakaConfig.streaming || {})
    },
    manifest: {
      retryParameters: {
        maxAttempts: 3,
        baseDelay: 500,
        backoffFactor: 2,
        fuzzFactor: 0.5,
        timeout: 30000,
        ...(shakaConfig.manifest?.retryParameters || {})
      },
      ...(shakaConfig.manifest || {})
    },
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

  // HLS coming from MediaFlow is clear. Do not accidentally configure DRM for it
  // unless explicit drm config is supplied.
  if (type === 'clearkey') {
    config.drm.clearKeys = drm.clearKeys || customData.clearKeys || {};
  }

  if (!isHls && customData.clearKeys && !config.drm.clearKeys) {
    config.drm.clearKeys = customData.clearKeys;
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

function applyOptionalRequestHeaders(shakaPlayer, customData = {}) {
  const headers = readOptionalHeaders(customData);
  if (!headers || typeof headers !== 'object' || !Object.keys(headers).length) return;

  const networking = shakaPlayer.getNetworkingEngine();
  if (!networking) return;

  networking.registerRequestFilter((_type, request) => {
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined && value !== null && String(value) !== '') {
        request.headers[name] = String(value);
      }
    }
  });

  log('Custom request headers enabled:', Object.keys(headers));
}

function configureNativeShakaUi(shakaUi) {
  // Native Shaka UI only. This gives us its own autohide, controls, overflow menus,
  // audio/subtitle/language selection, quality selection, keyboard handling, etc.
  shakaUi.configure({
    addSeekBar: true,
    addBigPlayButton: false,
    enableKeyboardPlaybackControls: true,
    controlPanelElements: [
      'play_pause',
      'time_and_duration',
      'spacer',
      'mute',
      'volume',
      'captions',
      'overflow_menu',
      'fullscreen'
    ],
    overflowMenuButtons: [
      'quality',
      'language',
      'captions',
      'playback_rate',
      'picture_in_picture'
    ],
    seekBarColors: {
      base: 'rgba(255, 255, 255, 0.28)',
      buffered: 'rgba(255, 255, 255, 0.56)',
      played: 'rgb(255, 255, 255)'
    }
  });
}

async function destroyPlayer() {
  if (ui) {
    try { ui.destroy(); } catch (e) { log('UI destroy ignored', e); }
    ui = null;
    controls = null;
  }

  if (player) {
    try { await player.destroy(); } catch (e) { log('Player destroy ignored', e); }
    player = null;
  }
}

async function initPlayer(customData = {}) {
  await destroyPlayer();

  player = new shaka.Player(video);

  ui = new shaka.ui.Overlay(player, container, video);
  controls = ui.getControls();
  configureNativeShakaUi(ui);

  player.addEventListener('error', event => {
    const detail = event.detail || {};
    console.error('[Shaka error]', detail);
    showDebug(`Shaka error ${detail.code || ''}\n${JSON.stringify(detail, null, 2)}`, true);
    sendCastErrorStatus(detail);
  });

  video.addEventListener('play', sendCastStatusThrottled);
  video.addEventListener('pause', sendCastStatusThrottled);
  video.addEventListener('seeking', sendCastStatusThrottled);
  video.addEventListener('seeked', sendCastStatusThrottled);
  video.addEventListener('timeupdate', sendCastStatusThrottled);
  video.addEventListener('ended', sendCastStatusThrottled);
  video.addEventListener('durationchange', sendCastStatusThrottled);

  return player;
}

function getMediaUrl(mediaInfo = {}) {
  return mediaInfo.contentUrl || mediaInfo.contentId || mediaInfo.entity || '';
}

async function loadContent(mediaInfo) {
  currentMediaInfo = mediaInfo || {};
  const contentUrl = getMediaUrl(currentMediaInfo);
  const contentType = currentMediaInfo.contentType || '';
  const customData = currentMediaInfo.customData || {};

  debugEnabled = !!customData.debug;
  debugOnError = !!customData.debugOnError;
  if (!debugEnabled) document.body.classList.remove('debug-visible');

  if (!contentUrl) throw new Error('Missing media URL/contentId');

  const shakaPlayer = await initPlayer(customData);
  const config = buildShakaConfig(customData, contentType);
  shakaPlayer.configure(config);
  applyOptionalRequestHeaders(shakaPlayer, customData);

  log('Loading', { contentUrl, contentType, customData, config });
  showDebug(`Loading\n${contentUrl}`);

  await shakaPlayer.load(contentUrl);

  // Keep native controls available immediately after load, then Shaka UI will manage autohide.
  try {
    controls?.setEnabledShakaControls(true);
  } catch (_) {}

  sendCastStatus(true);
  log('Loaded');
}

function mediaPlayerState() {
  if (!video || video.readyState === 0) return 'IDLE';
  if (video.ended) return 'IDLE';
  return video.paused ? 'PAUSED' : 'PLAYING';
}

function idleReason() {
  return video && video.ended ? 'FINISHED' : undefined;
}

function buildCastTracks() {
  if (!player) return [];
  const tracks = [];
  let id = 1;

  for (const variant of player.getVariantTracks()) {
    if (variant.audioId || variant.language) {
      tracks.push({
        trackId: id++,
        type: cast.framework.messages.TrackType.AUDIO,
        name: variant.label || variant.language || `Audio ${id - 1}`,
        language: variant.language || 'und',
        subtype: undefined,
        customData: { shakaTrackId: variant.id, kind: 'variant' }
      });
    }
  }

  for (const text of player.getTextTracks()) {
    tracks.push({
      trackId: id++,
      type: cast.framework.messages.TrackType.TEXT,
      name: text.label || text.language || `Subtitles ${id - 1}`,
      language: text.language || 'und',
      subtype: cast.framework.messages.TextTrackType.SUBTITLES,
      customData: { shakaTrackId: text.id, kind: 'text' }
    });
  }

  return tracks;
}

function currentActiveTrackIds(castTracks) {
  if (!player || !castTracks.length) return [];
  const active = [];
  const currentVariant = player.getVariantTracks().find(t => t.active);
  const activeText = player.getTextTracks().find(t => t.active);

  for (const t of castTracks) {
    if (t.customData?.kind === 'variant' && currentVariant && t.customData.shakaTrackId === currentVariant.id) {
      active.push(t.trackId);
    }
    if (t.customData?.kind === 'text' && activeText && t.customData.shakaTrackId === activeText.id && player.isTextTrackVisible()) {
      active.push(t.trackId);
    }
  }
  return active;
}

function sendCastStatus(force = false) {
  if (!playerManager || !currentMediaInfo) return;

  const mediaStatus = new cast.framework.messages.MediaStatus();
  mediaStatus.playerState = mediaPlayerState();
  mediaStatus.currentTime = video.currentTime || 0;
  mediaStatus.playbackRate = video.playbackRate || 1;
  mediaStatus.supportedMediaCommands = supportedCommands();
  if (idleReason()) mediaStatus.idleReason = idleReason();

  const tracks = buildCastTracks();
  mediaStatus.media = currentMediaInfo;
  mediaStatus.media.duration = Number.isFinite(video.duration) ? video.duration : undefined;
  mediaStatus.media.tracks = tracks;
  mediaStatus.activeTrackIds = currentActiveTrackIds(tracks);

  try {
    playerManager.broadcastStatus(force, mediaStatus);
  } catch (e) {
    // Some CAF versions ignore custom MediaStatus objects here. Playback still works.
    log('broadcastStatus ignored', e);
  }
}

let statusPending = false;
function sendCastStatusThrottled() {
  if (statusPending) return;
  statusPending = true;
  setTimeout(() => {
    statusPending = false;
    sendCastStatus(false);
  }, 500);
}

function sendCastErrorStatus(detail) {
  log('sendCastErrorStatus', detail);
}

function supportedCommands() {
  const C = cast.framework.messages.Command;
  return C.PAUSE | C.SEEK | C.STREAM_VOLUME | C.STREAM_MUTE | C.EDIT_TRACKS | C.STOP;
}

function installCastInterceptors() {
  playerManager.setSupportedMediaCommands(supportedCommands(), true);

  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, async loadRequestData => {
    try {
      log('LOAD request', loadRequestData);
      const mediaInfo = loadRequestData.media || {};
      await loadContent(mediaInfo);
      return loadRequestData;
    } catch (error) {
      console.error('[LOAD failed]', error);
      showDebug(`LOAD failed\n${error.message || error}`, true);
      const errorData = new cast.framework.messages.ErrorData(cast.framework.messages.ErrorType.LOAD_FAILED);
      errorData.reason = cast.framework.messages.ErrorReason.INVALID_REQUEST;
      errorData.customData = { message: error.message || String(error) };
      throw errorData;
    }
  });

  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.PLAY, data => {
    video.play();
    sendCastStatus(true);
    return data;
  });

  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.PAUSE, data => {
    video.pause();
    sendCastStatus(true);
    return data;
  });

  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.STOP, async data => {
    await destroyPlayer();
    currentMediaInfo = null;
    return data;
  });

  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.SEEK, data => {
    const time = data.currentTime ?? data.mediaSessionId?.currentTime;
    if (typeof time === 'number' && Number.isFinite(time)) {
      video.currentTime = Math.max(0, Math.min(time, video.duration || time));
    }
    sendCastStatus(true);
    return data;
  });

  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.EDIT_TRACKS_INFO, data => {
    try {
      applyCastTrackSelection(data.activeTrackIds || []);
      sendCastStatus(true);
    } catch (e) {
      console.error('[EDIT_TRACKS_INFO failed]', e);
      showDebug(`Track change failed\n${e.message || e}`, true);
    }
    return data;
  });
}

function applyCastTrackSelection(activeTrackIds) {
  if (!player) return;
  const tracks = buildCastTracks();
  const selected = tracks.filter(t => activeTrackIds.includes(t.trackId));

  const selectedVariant = selected.find(t => t.customData?.kind === 'variant');
  if (selectedVariant) {
    const variant = player.getVariantTracks().find(v => v.id === selectedVariant.customData.shakaTrackId);
    if (variant) player.selectVariantTrack(variant, true);
  }

  const selectedText = selected.find(t => t.customData?.kind === 'text');
  if (selectedText) {
    const text = player.getTextTracks().find(tt => tt.id === selectedText.customData.shakaTrackId);
    if (text) {
      player.selectTextTrack(text);
      player.setTextTrackVisibility(true);
    }
  } else {
    player.setTextTrackVisibility(false);
  }
}

function installRemoteKeyFallbacks() {
  // Let Shaka UI handle normal arrows/enter. Only catch media keys and keys that
  // Chromecast remotes sometimes expose outside Shaka UI.
  window.addEventListener('keydown', event => {
    const key = event.key || event.code || '';
    log('key', key, event.keyCode);

    switch (key) {
      case 'MediaPlayPause':
      case 'PlayPause':
        event.preventDefault();
        video.paused ? video.play() : video.pause();
        sendCastStatus(true);
        break;
      case 'MediaPlay':
      case 'Play':
        event.preventDefault();
        video.play();
        sendCastStatus(true);
        break;
      case 'MediaPause':
      case 'Pause':
        event.preventDefault();
        video.pause();
        sendCastStatus(true);
        break;
      case 'MediaStop':
      case 'Stop':
        event.preventDefault();
        destroyPlayer();
        currentMediaInfo = null;
        break;
      case 'MediaTrackNext':
      case 'Subtitle':
      case 'Subtitles':
      case 'ClosedCaption':
      case 'Caption':
        event.preventDefault();
        cycleTextTrack();
        break;
      case 'Audio':
      case 'AudioTrack':
      case 'Language':
        event.preventDefault();
        cycleAudioTrack();
        break;
      default:
        break;
    }
  });
}

function cycleTextTrack() {
  if (!player) return;
  const tracks = player.getTextTracks();
  if (!tracks.length) return;
  const current = tracks.findIndex(t => t.active && player.isTextTrackVisible());
  if (current < 0) {
    player.selectTextTrack(tracks[0]);
    player.setTextTrackVisibility(true);
  } else if (current >= tracks.length - 1) {
    player.setTextTrackVisibility(false);
  } else {
    player.selectTextTrack(tracks[current + 1]);
    player.setTextTrackVisibility(true);
  }
  sendCastStatus(true);
}

function cycleAudioTrack() {
  if (!player) return;
  const variants = player.getVariantTracks();
  const audioVariants = variants.filter(v => v.audioId || v.language);
  if (!audioVariants.length) return;
  const current = audioVariants.findIndex(v => v.active);
  const next = audioVariants[(current + 1) % audioVariants.length];
  player.selectVariantTrack(next, true);
  sendCastStatus(true);
}

async function main() {
  shaka.polyfill.installAll();

  if (!shaka.Player.isBrowserSupported()) {
    showDebug('Shaka Player is not supported on this device.', true);
    return;
  }

  castContext = cast.framework.CastReceiverContext.getInstance();
  playerManager = castContext.getPlayerManager();

  installCastInterceptors();
  installRemoteKeyFallbacks();

  castContext.start({
    disableIdleTimeout: true
  });

  log('Receiver started');
}

main().catch(error => {
  console.error('[Receiver fatal]', error);
  showDebug(`Fatal\n${error.message || error}`, true);
});
