/*
 * ETB CAF Receiver - hybrid tracks build
 *
 * Playback/UI remains native CAF (<cast-media-player>).  The only custom UI is a
 * small DPAD-friendly subtitle menu, because CAF does not reliably expose a TV
 * subtitle selector for HLS sidecar WebVTT tracks on all Chromecast firmwares.
 */

const context = cast.framework.CastReceiverContext.getInstance();
const playerManager = context.getPlayerManager();
const debugOverlay = document.getElementById('debugOverlay');
const trackMenu = document.getElementById('trackMenu');
const trackMenuRow = document.getElementById('trackMenuRow');
const trackMenuTitle = document.getElementById('trackMenuTitle');

let currentCustomData = {};
let debugEnabled = new URLSearchParams(location.search).get('debug') === '1';
let debugOnError = new URLSearchParams(location.search).get('debugOnError') === '1';
let recent = [];
let discoveredTextTracks = [];
let discoveredAudioTracks = [];
let trackMenuMode = 'text';
let trackMenuVisible = false;
let trackMenuFocus = 0;
let trackMenuTimer = null;
let activeTextTrackId = null;
let activeAudioTrackId = null;

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
  if (recent.length > 160) recent = recent.slice(-160);
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
    'discoveredTextTracks:',
    safeJson(discoveredTextTracks, 4000),
    '',
    'discoveredAudioTracks:',
    safeJson(discoveredAudioTracks, 4000),
    '',
    extra,
    '',
    'recent:',
    recent.slice(-80).join('\n')
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
  for (const [name, value] of Object.entries(headers)) requestInfo.headers[name] = value;
}

function applyHeadersToShakaRequest(request) {
  const headers = combinedHeaders();
  if (!Object.keys(headers).length || !request) return;
  request.headers = request.headers || {};
  for (const [name, value] of Object.entries(headers)) request.headers[name] = value;
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
  return media && (media.contentUrl || media.contentId) || '';
}

function splitM3u8Attributes(text) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi;
  let match;
  while ((match = re.exec(text))) {
    let value = match[2] || '';
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    attrs[match[1].toUpperCase()] = value;
  }
  return attrs;
}

function absoluteUrl(base, maybeRelative) {
  try { return new URL(maybeRelative, base).toString(); }
  catch (_) { return maybeRelative; }
}

async function fetchText(url) {
  const headers = combinedHeaders();
  const response = await fetch(url, {
    mode: 'cors',
    credentials: 'omit',
    headers
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return await response.text();
}

function looksLikeVttUrl(url) {
  return /\.vtt(?:$|[?#])/i.test(url) || /webvtt/i.test(url);
}

async function resolveSubtitleContentUrl(masterUrl, subtitleUri) {
  const uri = absoluteUrl(masterUrl, subtitleUri);
  if (looksLikeVttUrl(uri)) return { url: uri, contentType: 'text/vtt' };

  // MediaFlow exposes subtitle renditions as a tiny HLS playlist in some builds.
  // CAF text sidecar tracks are much happier with a direct WebVTT URL, so unwrap it.
  try {
    const body = await fetchText(uri);
    if (/WEBVTT/i.test(body.slice(0, 80))) {
      return { url: uri, contentType: 'text/vtt' };
    }
    const lines = body.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith('#')) continue;
      const child = absoluteUrl(uri, line);
      if (looksLikeVttUrl(child)) return { url: child, contentType: 'text/vtt' };
    }
  } catch (e) {
    log('subtitle playlist unwrap failed', String(e && e.message || e));
  }

  return { url: uri, contentType: 'text/vtt' };
}

function makeTextTrack(id, name, language, url, contentType) {
  const track = new cast.framework.messages.Track(id, cast.framework.messages.TrackType.TEXT);
  track.trackContentId = url;
  track.trackContentType = contentType || 'text/vtt';
  track.name = name || language || `Subtitles ${id}`;
  track.language = language || 'und';
  track.subtype = cast.framework.messages.TextTrackType.SUBTITLES;
  return track;
}

function makeAudioTrack(id, name, language) {
  const track = new cast.framework.messages.Track(id, cast.framework.messages.TrackType.AUDIO);
  track.name = name || language || `Audio ${id}`;
  track.language = language || 'und';
  return track;
}

async function discoverTracksFromHls(media) {
  discoveredTextTracks = [];
  discoveredAudioTracks = [];

  const mediaUrl = getMediaUrl(media);
  if (!mediaUrl || !isHlsLike(media)) return;

  try {
    const master = await fetchText(mediaUrl);
    let nextTrackId = 9000;

    for (const rawLine of master.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.toUpperCase().startsWith('#EXT-X-MEDIA:')) continue;
      const attrs = splitM3u8Attributes(line.slice(line.indexOf(':') + 1));
      const type = String(attrs.TYPE || '').toUpperCase();
      const name = attrs.NAME || attrs.LANGUAGE || type;
      const language = attrs.LANGUAGE || attrs.LANG || 'und';

      if (type === 'SUBTITLES' || type === 'CLOSED-CAPTIONS') {
        if (!attrs.URI) continue;
        const resolved = await resolveSubtitleContentUrl(mediaUrl, attrs.URI);
        discoveredTextTracks.push({
          id: nextTrackId++,
          name,
          language,
          url: resolved.url,
          contentType: resolved.contentType
        });
      } else if (type === 'AUDIO') {
        // HLS alternate audio is normally already handled by CAF/Shaka from the manifest.
        // Keep lightweight metadata for our menu if we need it later.
        discoveredAudioTracks.push({
          id: nextTrackId++,
          name,
          language,
          uri: attrs.URI ? absoluteUrl(mediaUrl, attrs.URI) : ''
        });
      }
    }

    log('discovered tracks', { text: discoveredTextTracks, audio: discoveredAudioTracks });
  } catch (e) {
    log('track discovery failed', String(e && e.message || e));
  }
}

function mergeDiscoveredTracksIntoMedia(media) {
  media.tracks = Array.isArray(media.tracks) ? media.tracks : [];
  const existingIds = new Set(media.tracks.map(t => Number(t.trackId)));

  for (const t of discoveredTextTracks) {
    if (existingIds.has(t.id)) continue;
    media.tracks.push(makeTextTrack(t.id, t.name, t.language === 'eu' ? 'eu-ES' : t.language, t.url, t.contentType));
  }

  if (!media.textTrackStyle) {
    const style = new cast.framework.messages.TextTrackStyle();
    style.backgroundColor = '#00000000';
    style.foregroundColor = '#FFFFFFFF';
    style.edgeType = cast.framework.messages.TextTrackEdgeType.OUTLINE;
    style.edgeColor = '#000000FF';
    style.fontScale = 1.0;
    media.textTrackStyle = style;
  }
}

async function normalizeLoadRequest(loadRequestData) {
  const media = loadRequestData && loadRequestData.media;
  if (!media) return loadRequestData;

  currentCustomData = {
    ...(loadRequestData.customData || {}),
    ...(media.customData || {})
  };
  debugOnError = !!(debugOnError || currentCustomData.debugOnError);
  debugEnabled = !!(debugEnabled || currentCustomData.debug);

  if (!media.contentUrl && media.contentId) media.contentUrl = media.contentId;

  if (!media.contentType) {
    if (isHlsLike(media)) media.contentType = 'application/x-mpegURL';
    else if (isDashLike(media)) media.contentType = 'application/dash+xml';
  }

  if (!media.metadata) {
    media.metadata = new cast.framework.messages.GenericMediaMetadata();
    media.metadata.title = currentCustomData.title || 'ETB';
  }

  // Discover and inject external WebVTT tracks before CAF starts playback.
  await discoverTracksFromHls(media);
  mergeDiscoveredTracksIntoMedia(media);

  activeTextTrackId = Array.isArray(loadRequestData.activeTrackIds) && loadRequestData.activeTrackIds.length
    ? loadRequestData.activeTrackIds[0]
    : null;

  log('LOAD', {
    contentId: media.contentId,
    contentUrl: media.contentUrl,
    contentType: media.contentType,
    customDataKeys: Object.keys(currentCustomData || {}),
    tracks: media.tracks
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
    applyHeadersToRequestInfo(requestInfo);
    const drmHeaders = normalizeHeaders(cd.drm && cd.drm.headers);
    if (Object.keys(drmHeaders).length) {
      requestInfo.headers = requestInfo.headers || {};
      Object.assign(requestInfo.headers, drmHeaders);
    }
    if (oldLicenseHandler) oldLicenseHandler(requestInfo);
  };

  if (cd.drm && cd.drm.licenseUrl) config.licenseUrl = cd.drm.licenseUrl;
  return config;
}

function getShakaPlayerFromEvent(event) {
  try { if (event && event.player && event.player.getShakaPlayer) return event.player.getShakaPlayer(); } catch (_) {}
  try { if (playerManager.getShakaPlayer) return playerManager.getShakaPlayer(); } catch (_) {}
  try { if (playerManager.getPlayer && playerManager.getPlayer().getShakaPlayer) return playerManager.getPlayer().getShakaPlayer(); } catch (_) {}
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
    const clearKeys = drm.clearKeys || cd.clearKeys;
    if (clearKeys && typeof clearKeys === 'object') {
      config.drm = { ...(config.drm || {}), clearKeys };
    }
    if (Object.keys(config).length) shakaPlayer.configure(config);

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

function allTextOptions() {
  const opts = [{ id: null, name: 'Off', language: '' }];
  for (const t of discoveredTextTracks) opts.push(t);
  return opts;
}

function setTextTrack(trackId) {
  activeTextTrackId = trackId == null ? null : Number(trackId);
  const ids = activeTextTrackId == null ? [] : [activeTextTrackId];
  try {
    if (typeof playerManager.setActiveTrackIds === 'function') {
      playerManager.setActiveTrackIds(ids);
      log('setActiveTrackIds', ids);
      return;
    }
  } catch (e) {
    log('setActiveTrackIds failed', String(e && e.message || e));
  }

  // Fallback for firmware where CAF does not expose setActiveTrackIds.
  try {
    const shakaPlayer = getShakaPlayerFromEvent(null);
    if (shakaPlayer) {
      if (activeTextTrackId == null) {
        shakaPlayer.setTextTrackVisibility(false);
      } else {
        const target = shakaPlayer.getTextTracks().find(t => Number(t.id) === activeTextTrackId || t.language === 'eu' || t.language === 'eu-ES');
        if (target) shakaPlayer.selectTextTrack(target);
        shakaPlayer.setTextTrackVisibility(true);
      }
    }
  } catch (e) {
    log('Shaka text fallback failed', String(e && e.message || e));
  }
}

function renderTrackMenu() {
  if (!trackMenu || !trackMenuRow || !trackMenuTitle) return;
  const options = allTextOptions();
  trackMenuTitle.textContent = 'Subtitles';
  trackMenuRow.textContent = '';

  if (!options.length || options.length === 1) {
    const empty = document.createElement('div');
    empty.className = 'track-chip focused';
    empty.textContent = 'No subtitles';
    trackMenuRow.appendChild(empty);
    return;
  }

  trackMenuFocus = Math.max(0, Math.min(trackMenuFocus, options.length - 1));
  options.forEach((option, index) => {
    const chip = document.createElement('div');
    chip.className = 'track-chip';
    if ((option.id == null && activeTextTrackId == null) || Number(option.id) === Number(activeTextTrackId)) chip.classList.add('active');
    if (index === trackMenuFocus) chip.classList.add('focused');
    chip.textContent = option.name || option.language || 'Sub';
    trackMenuRow.appendChild(chip);
  });
}

function showTrackMenu() {
  if (!trackMenu) return;
  trackMenuVisible = true;
  trackMenu.setAttribute('aria-hidden', 'false');
  trackMenu.classList.add('visible');
  const options = allTextOptions();
  const activeIndex = options.findIndex(o => (o.id == null && activeTextTrackId == null) || Number(o.id) === Number(activeTextTrackId));
  trackMenuFocus = activeIndex >= 0 ? activeIndex : 0;
  renderTrackMenu();
  resetTrackMenuTimer();
}

function hideTrackMenu() {
  if (!trackMenu) return;
  trackMenuVisible = false;
  trackMenu.setAttribute('aria-hidden', 'true');
  trackMenu.classList.remove('visible');
  if (trackMenuTimer) clearTimeout(trackMenuTimer);
  trackMenuTimer = null;
}

function resetTrackMenuTimer() {
  if (trackMenuTimer) clearTimeout(trackMenuTimer);
  trackMenuTimer = setTimeout(() => hideTrackMenu(), 7000);
}

function moveTrackMenu(delta) {
  const options = allTextOptions();
  if (!options.length) return;
  trackMenuFocus = (trackMenuFocus + delta + options.length) % options.length;
  renderTrackMenu();
  resetTrackMenuTimer();
}

function activateTrackMenuSelection() {
  const options = allTextOptions();
  const selected = options[trackMenuFocus];
  if (!selected) return;
  setTextTrack(selected.id);
  renderTrackMenu();
  resetTrackMenuTimer();
}

function toggleSubtitles() {
  const options = allTextOptions();
  if (options.length <= 1) return;
  if (activeTextTrackId == null) {
    setTextTrack(options[1].id);
  } else {
    setTextTrack(null);
  }
  showTrackMenu();
}

function isSubtitleKey(key, code) {
  const s = `${key || ''} ${code || ''}`.toLowerCase();
  return s.includes('subtitle') || s.includes('caption') || s.includes('cc') || s.includes('teletext');
}

function isAudioKey(key, code) {
  const s = `${key || ''} ${code || ''}`.toLowerCase();
  return s.includes('audio') || s.includes('language');
}

window.addEventListener('keydown', event => {
  const key = event.key || '';
  const code = event.code || '';
  log('key', { key, code, keyCode: event.keyCode });

  if (debugEnabled && (key === 'd' || key === 'D')) {
    document.body.classList.toggle('debug');
    return;
  }

  if (isSubtitleKey(key, code)) {
    event.preventDefault();
    toggleSubtitles();
    return;
  }

  if (isAudioKey(key, code)) {
    event.preventDefault();
    // Placeholder: CAF/Shaka usually handles HLS audio internally. Show the same menu so the key is visible.
    showTrackMenu();
    return;
  }

  if (trackMenuVisible) {
    if (key === 'ArrowLeft' || key === 'Left') { event.preventDefault(); moveTrackMenu(-1); return; }
    if (key === 'ArrowRight' || key === 'Right') { event.preventDefault(); moveTrackMenu(1); return; }
    if (key === 'Enter' || key === 'OK' || key === ' ') { event.preventDefault(); activateTrackMenuSelection(); return; }
    if (key === 'Backspace' || key === 'Escape' || key === 'BrowserBack') { event.preventDefault(); hideTrackMenu(); return; }
  }

  // Long-press/menu/up can reveal subtitle selector without disturbing CAF playback controls.
  if (key === 'ArrowUp' || key === 'Up' || key === 'ContextMenu' || key === 'Menu') {
    if (discoveredTextTracks.length) {
      event.preventDefault();
      showTrackMenu();
    }
  }
});

playerManager.setMessageInterceptor(
  cast.framework.messages.MessageType.LOAD,
  loadRequestData => normalizeLoadRequest(loadRequestData)
);

playerManager.setMediaPlaybackInfoHandler((loadRequestData, playbackConfig) => {
  // MediaPlaybackInfoHandler cannot reliably be async on all CAF versions. It only applies headers/config.
  return buildPlaybackConfig(loadRequestData, playbackConfig);
});

playerManager.addEventListener(cast.framework.events.EventType.PLAYER_LOAD_COMPLETE, event => {
  log('PLAYER_LOAD_COMPLETE');
  configureShakaIfAvailable(event);
});

playerManager.addEventListener(cast.framework.events.EventType.ERROR, event => {
  maybeEnableDebug('caf-error', safeJson(event, 8000));
});

playerManager.addEventListener(cast.framework.events.EventType.MEDIA_STATUS, event => {
  if (event && event.mediaStatus && Array.isArray(event.mediaStatus.activeTrackIds)) {
    const active = event.mediaStatus.activeTrackIds.find(id => discoveredTextTracks.some(t => Number(t.id) === Number(id)));
    activeTextTrackId = active == null ? null : Number(active);
  }
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

log('starting CAF receiver hybrid tracks');
context.start(options);
