/* ETB Shaka Cast Receiver v5 - step build */
const video = document.getElementById('video');
const statusEl = document.getElementById('status');
const debugEl = document.getElementById('debugOverlay');
const controlsEl = document.getElementById('controls');
const titleEl = document.getElementById('title');
const playPauseBtn = document.getElementById('playPause');
const playIcon = document.getElementById('playIcon');
const skipBackBtn = document.getElementById('skipBack');
const scrubber = document.getElementById('scrubber');
const playedBar = document.getElementById('playedBar');
const bufferBar = document.getElementById('bufferBar');
const timeEl = document.getElementById('time');
const audioButton = document.getElementById('audioButton');
const subsButton = document.getElementById('subsButton');
const qualityButton = document.getElementById('qualityButton');
const audioMenu = document.getElementById('audioMenu');
const subsMenu = document.getElementById('subsMenu');
const qualityMenu = document.getElementById('qualityMenu');

let player = null;
let context = null;
let playerManager = null;
let currentMediaInfo = null;
let hideTimer = null;
let menuOpen = null;
let uiSeeking = false;
let debugEnabled = new URLSearchParams(location.search).get('debug') === '1';
let debugOnError = new URLSearchParams(location.search).get('debugOnError') === '1';
let recent = [];
let preferredQuality = 'auto';
let lastFocused = playPauseBtn;

const FOCUS_SELECTOR = '.tv-focus, .track-menu.open .track-menu-item';
const SVG_PLAY = '<path d="M8 5v14l11-7z" fill="currentColor"/>';
const SVG_PAUSE = '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/>';

function log(...args) {
  console.log('[ETBReceiver]', ...args);
  recent.push(args.map(String).join(' '));
  if (recent.length > 160) recent.shift();
  refreshDebug();
}

function setStatus(text, isError = false) {
  if (statusEl) statusEl.textContent = text || '';
  document.body.classList.toggle('error', !!isError);
  log(text || '');
}

function refreshDebug() {
  if (!debugEnabled || !debugEl) return;
  debugEl.textContent = recent.slice(-100).join('\n');
}

function setDebug(enabled) {
  debugEnabled = !!enabled;
  document.body.classList.toggle('debug', debugEnabled);
  refreshDebug();
}

function normalizeDrmType(type) {
  return String(type || 'none').toLowerCase();
}

function keySystemFor(type) {
  switch (normalizeDrmType(type)) {
    case 'widevine': return 'com.widevine.alpha';
    case 'playready':
    case 'microsoft': return 'com.microsoft.playready';
    case 'fairplay': return 'com.apple.fps';
    case 'clearkey': return 'org.w3.clearkey';
    default: return null;
  }
}

function buildShakaConfig(customData = {}, contentType = '') {
  const drm = customData.drm || {};
  const shakaConfig = customData.shakaConfig || {};
  const type = normalizeDrmType(drm.type);
  const keySystem = keySystemFor(type);
  const isHls = /mpegurl|m3u8|hls/i.test(contentType || '');

  const config = {
    ...shakaConfig,
    streaming: {
      bufferingGoal: 120,
      rebufferingGoal: 4,
      bufferBehind: 60,
      ...(shakaConfig.streaming || {})
    },
    abr: {
      enabled: true,
      ...(shakaConfig.abr || {})
    }
  };

  // HLS clear from MediaFlow must not inherit stale DRM settings unless explicitly requested.
  if (!isHls && (type !== 'none' || drm.clearKeys || drm.licenseUrl)) {
    config.drm = {
      ...(shakaConfig.drm || {}),
      servers: { ...((shakaConfig.drm && shakaConfig.drm.servers) || {}) },
      advanced: { ...((shakaConfig.drm && shakaConfig.drm.advanced) || {}) }
    };
    if (type === 'clearkey') config.drm.clearKeys = drm.clearKeys || {};
    if (keySystem && drm.licenseUrl) config.drm.servers[keySystem] = drm.licenseUrl;
    if (type === 'fairplay' && drm.certificateUrl) {
      config.drm.advanced['com.apple.fps'] = {
        ...(config.drm.advanced['com.apple.fps'] || {}),
        serverCertificateUri: drm.certificateUrl
      };
    }
  }
  return config;
}

function applyOptionalHeaders(shakaPlayer, headers) {
  if (!headers || typeof headers !== 'object' || !Object.keys(headers).length) return;
  const networking = shakaPlayer.getNetworkingEngine && shakaPlayer.getNetworkingEngine();
  if (!networking) return;
  networking.registerRequestFilter((requestType, request) => {
    Object.entries(headers).forEach(([name, value]) => {
      if (value != null && String(value) !== '') request.headers[name] = String(value);
    });
  });
  log('Custom request headers enabled:', Object.keys(headers).join(', '));
}

function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
}

function duration() {
  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
}

function bufferedEnd() {
  try {
    if (!video.buffered || !video.buffered.length) return 0;
    let end = 0;
    for (let i = 0; i < video.buffered.length; i++) end = Math.max(end, video.buffered.end(i));
    return end;
  } catch (_) { return 0; }
}

function updateTransport() {
  const d = duration();
  const t = video.currentTime || 0;
  const pct = d ? Math.max(0, Math.min(100, (t / d) * 100)) : 0;
  const bpct = d ? Math.max(0, Math.min(100, (bufferedEnd() / d) * 100)) : 0;

  if (!uiSeeking && scrubber) scrubber.value = String(Math.round(pct * 10));
  if (playedBar) playedBar.style.width = `${pct}%`;
  if (bufferBar) bufferBar.style.width = `${bpct}%`;
  if (timeEl) timeEl.textContent = `${fmt(t)} / ${fmt(d)}`;
  if (playIcon) playIcon.innerHTML = video.paused ? SVG_PLAY : SVG_PAUSE;
}

function clearHideTimer() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
}

function showControls({focus = false, keep = false} = {}) {
  document.body.classList.add('controls-visible');
  clearHideTimer();
  if (focus && lastFocused && document.body.contains(lastFocused)) {
    try { lastFocused.focus(); } catch (_) {}
  }
  if (!keep && !video.paused && !menuOpen && !debugEnabled) {
    hideTimer = setTimeout(() => hideControls(), 5200);
  }
}

function hideControls() {
  if (video.paused || menuOpen || debugEnabled) return;
  document.body.classList.remove('controls-visible');
  closeMenus();
}

function closeMenus() {
  [audioMenu, subsMenu, qualityMenu].forEach(m => m && m.classList.remove('open'));
  menuOpen = null;
  document.body.classList.remove('menu-open');
}

function toggleMenu(menu, builder) {
  showControls({keep: true});
  if (menuOpen === menu) {
    closeMenus();
    showControls();
    return;
  }
  closeMenus();
  if (builder) builder();
  menu.classList.add('open');
  menuOpen = menu;
  document.body.classList.add('menu-open');
  const first = menu.querySelector('.track-menu-item');
  if (first) first.focus();
}

function menuButton(label, active, action) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'track-menu-item tv-focus' + (active ? ' active' : '');
  b.tabIndex = 0;
  b.innerHTML = `<span>${escapeHtml(label)}</span><span class="check">✓</span>`;
  b.addEventListener('click', () => {
    action();
    closeMenus();
    showControls();
  });
  return b;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

function renderMenu(menu, title, rows) {
  menu.innerHTML = '';
  const h = document.createElement('div');
  h.className = 'track-menu-title';
  h.textContent = title;
  menu.appendChild(h);
  if (!rows.length) rows = [{label: 'No disponible', active: true, action: () => {}}];
  rows.forEach(r => menu.appendChild(menuButton(r.label, r.active, r.action)));
}

function variantTracks() {
  if (!player || !player.getVariantTracks) return [];
  return player.getVariantTracks() || [];
}

function textTracks() {
  if (!player || !player.getTextTracks) return [];
  return player.getTextTracks() || [];
}

function audioRows() {
  const vars = variantTracks();
  const active = vars.find(v => v.active) || null;
  const seen = new Map();
  vars.forEach(v => {
    const key = `${v.language || ''}|${v.audioId || v.id || ''}|${v.label || ''}`;
    if (!seen.has(key)) seen.set(key, v);
  });
  return Array.from(seen.values()).map(v => ({
    label: v.label || v.language || `Audio ${v.audioId || v.id}`,
    active: !!active && ((v.audioId && v.audioId === active.audioId) || v.language === active.language),
    action: () => selectAudio(v)
  }));
}

function selectAudio(track) {
  const active = variantTracks().find(v => v.active) || {};
  const candidates = variantTracks().filter(v => {
    const sameAudio = (track.audioId && v.audioId === track.audioId) || (!track.audioId && v.language === track.language);
    const sameQuality = active.height ? v.height === active.height : true;
    return sameAudio && sameQuality;
  });
  const chosen = candidates[0] || track;
  try { player.selectVariantTrack(chosen, true); } catch (e) { log('selectAudio failed', e.message || e); }
}

function subsRows() {
  const activeVisible = player && player.isTextTrackVisible && player.isTextTrackVisible();
  const tracks = textTracks();
  const rows = [{
    label: 'Sin subtítulos',
    active: !activeVisible,
    action: () => { try { player.setTextTrackVisibility(false); } catch (_) {} }
  }];
  tracks.forEach((t, i) => rows.push({
    label: t.label || t.language || `Subtítulos ${i + 1}`,
    active: activeVisible && t.active,
    action: () => { try { player.selectTextTrack(t); player.setTextTrackVisibility(true); } catch (e) { log('selectText failed', e.message || e); } }
  }));
  return rows;
}

function qualityRows() {
  const vars = variantTracks().filter(v => v.height || v.bandwidth);
  const active = vars.find(v => v.active) || null;
  const grouped = new Map();
  vars.forEach(v => {
    const key = v.height ? `${v.height}` : `${Math.round((v.bandwidth || 0) / 1000)}k`;
    const old = grouped.get(key);
    if (!old || (v.bandwidth || 0) > (old.bandwidth || 0)) grouped.set(key, v);
  });
  const rows = [{
    label: 'Auto',
    active: preferredQuality === 'auto' && player && player.getConfiguration && player.getConfiguration().abr.enabled,
    action: () => { preferredQuality = 'auto'; player.configure({abr: {enabled: true}}); }
  }];
  Array.from(grouped.values()).sort((a,b) => (b.height || b.bandwidth || 0) - (a.height || a.bandwidth || 0)).forEach(v => {
    const label = v.height ? `${v.height}p` : `${Math.round((v.bandwidth || 0) / 1000)} kbps`;
    rows.push({
      label,
      active: preferredQuality === label || (!!active && active.height === v.height && preferredQuality !== 'auto'),
      action: () => {
        preferredQuality = label;
        player.configure({abr: {enabled: false}});
        const current = variantTracks().find(t => t.active) || {};
        const candidates = variantTracks().filter(t => {
          const sameQuality = v.height ? t.height === v.height : t.id === v.id;
          const sameAudio = current.audioId ? t.audioId === current.audioId : true;
          return sameQuality && sameAudio;
        });
        try { player.selectVariantTrack(candidates[0] || v, true); } catch (e) { log('selectQuality failed', e.message || e); }
      }
    });
  });
  return rows;
}

function rebuildMenus() {
  renderMenu(audioMenu, 'Audio', audioRows());
  renderMenu(subsMenu, 'Subtítulos', subsRows());
  renderMenu(qualityMenu, 'Calidad', qualityRows());
}

function initControls() {
  playPauseBtn.addEventListener('click', togglePlay);
  skipBackBtn.addEventListener('click', () => seekRelative(-10));
  audioButton.addEventListener('click', () => toggleMenu(audioMenu, () => renderMenu(audioMenu, 'Audio', audioRows())));
  subsButton.addEventListener('click', () => toggleMenu(subsMenu, () => renderMenu(subsMenu, 'Subtítulos', subsRows())));
  qualityButton.addEventListener('click', () => toggleMenu(qualityMenu, () => renderMenu(qualityMenu, 'Calidad', qualityRows())));

  scrubber.addEventListener('input', () => {
    uiSeeking = true;
    const d = duration();
    const pct = Number(scrubber.value || 0) / 1000;
    if (playedBar) playedBar.style.width = `${pct * 100}%`;
    if (timeEl) timeEl.textContent = `${fmt(d * pct)} / ${fmt(d)}`;
    showControls({keep: true});
  });
  scrubber.addEventListener('change', () => {
    const d = duration();
    if (d) video.currentTime = d * (Number(scrubber.value || 0) / 1000);
    uiSeeking = false;
    showControls();
  });
  scrubber.addEventListener('blur', () => { uiSeeking = false; });

  ['mousemove','pointermove','click'].forEach(name => document.addEventListener(name, () => showControls(), {passive: true}));
  ['play','pause','seeking','seeked','waiting','canplay','timeupdate','durationchange','progress','loadedmetadata','ratechange'].forEach(name => {
    video.addEventListener(name, () => {
      updateTransport();
      if (name === 'pause' || name === 'seeking' || name === 'waiting') showControls({keep: true});
      else if (name === 'play' || name === 'seeked' || name === 'canplay') showControls();
    });
  });

  document.addEventListener('focusin', ev => {
    if (ev.target && ev.target.matches && ev.target.matches(FOCUS_SELECTOR)) {
      lastFocused = ev.target;
      showControls({keep: true});
    }
  });
  document.addEventListener('keydown', handleKey, true);
  setInterval(updateTransport, 500);
}

function togglePlay() {
  if (video.paused) video.play().catch(e => log('play failed', e.message || e));
  else video.pause();
  showControls({keep: true});
}

function seekRelative(delta) {
  const d = duration();
  video.currentTime = Math.max(0, Math.min(d || Infinity, (video.currentTime || 0) + delta));
  showControls({keep: true});
}

function focusables() {
  return Array.from(document.querySelectorAll(FOCUS_SELECTOR)).filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  });
}

function focusElement(el) {
  if (!el) return;
  try { el.focus(); lastFocused = el; } catch (_) {}
}

function moveFocus(dx, dy) {
  const current = document.activeElement && document.activeElement.matches(FOCUS_SELECTOR) ? document.activeElement : lastFocused;
  const items = focusables();
  if (!items.length) return;
  if (!current || !items.includes(current)) return focusElement(items[0]);

  const cr = current.getBoundingClientRect();
  const cx = cr.left + cr.width / 2;
  const cy = cr.top + cr.height / 2;
  let best = null;
  let bestScore = Infinity;
  items.forEach(el => {
    if (el === current) return;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const vx = x - cx;
    const vy = y - cy;
    if (dx && Math.sign(vx) !== Math.sign(dx)) return;
    if (dy && Math.sign(vy) !== Math.sign(dy)) return;
    const primary = dx ? Math.abs(vx) : Math.abs(vy);
    const secondary = dx ? Math.abs(vy) : Math.abs(vx);
    const score = primary * 10 + secondary;
    if (score < bestScore) { bestScore = score; best = el; }
  });
  focusElement(best || current);
}

function handleKey(ev) {
  const key = ev.key || ev.code || '';
  const target = ev.target;
  const inMenu = !!(target && target.closest && target.closest('.track-menu.open'));
  const onScrubber = target === scrubber;

  const audioKeys = ['Audio', 'MediaAudioTrack', 'Lang', 'Language', 'KeyA'];
  const subKeys = ['Subtitle', 'Subtitles', 'ClosedCaptionToggle', 'Caption', 'KeyS', 'KeyC'];

  if (audioKeys.includes(key)) { ev.preventDefault(); showControls({keep:true}); toggleMenu(audioMenu, () => renderMenu(audioMenu, 'Audio', audioRows())); return; }
  if (subKeys.includes(key)) { ev.preventDefault(); showControls({keep:true}); toggleMenu(subsMenu, () => renderMenu(subsMenu, 'Subtítulos', subsRows())); return; }

  switch (key) {
    case 'MediaPlayPause':
    case ' ':
    case 'Enter':
      if (target && target.matches && target.matches('button, .track-menu-item')) return;
      ev.preventDefault(); togglePlay(); return;
    case 'MediaPlay': ev.preventDefault(); video.play().catch(() => {}); showControls(); return;
    case 'MediaPause': ev.preventDefault(); video.pause(); showControls({keep:true}); return;
    case 'MediaRewind': ev.preventDefault(); seekRelative(-10); return;
    case 'MediaFastForward': ev.preventDefault(); seekRelative(10); return;
    case 'Escape':
    case 'Backspace':
    case 'BrowserBack':
      ev.preventDefault(); if (menuOpen) closeMenus(); else hideControls(); return;
    case 'ArrowLeft':
      ev.preventDefault();
      showControls({keep:true});
      if (onScrubber) seekRelative(-10); else moveFocus(-1, 0);
      return;
    case 'ArrowRight':
      ev.preventDefault();
      showControls({keep:true});
      if (onScrubber) seekRelative(10); else moveFocus(1, 0);
      return;
    case 'ArrowUp': ev.preventDefault(); showControls({keep:true}); moveFocus(0, -1); return;
    case 'ArrowDown': ev.preventDefault(); showControls({keep:true}); moveFocus(0, 1); return;
    default:
      showControls();
      if (inMenu) return;
  }
}

async function initShaka() {
  if (player) {
    try { await player.destroy(); } catch (_) {}
  }
  player = new shaka.Player(video);
  player.addEventListener('error', event => onShakaError(event.detail));
  player.addEventListener('variantchanged', () => { rebuildMenus(); updateCastTracks(); });
  player.addEventListener('textchanged', () => { rebuildMenus(); updateCastTracks(); });
  player.addEventListener('trackschanged', () => { rebuildMenus(); updateCastTracks(); });
  return player;
}

function onShakaError(error) {
  console.error('[Shaka error]', error);
  setStatus(`Shaka error ${error && error.code}`, true);
  if (debugOnError) setDebug(true);
}

async function loadContent(mediaInfo) {
  currentMediaInfo = mediaInfo || {};
  const url = currentMediaInfo.contentUrl || currentMediaInfo.contentId;
  const contentType = currentMediaInfo.contentType || '';
  const customData = currentMediaInfo.customData || {};
  if (!url) throw new Error('Missing media URL');

  setDebug(!!customData.debug || debugEnabled);
  debugOnError = !!customData.debugOnError || debugOnError;
  preferredQuality = 'auto';
  closeMenus();
  setStatus('Loading');
  showControls({keep: true});
  titleEl.textContent = (currentMediaInfo.metadata && currentMediaInfo.metadata.title) || customData.title || 'ETB';

  const p = await initShaka();
  const config = buildShakaConfig(customData, contentType);
  p.configure(config);
  applyOptionalHeaders(p, customData.headers);
  log('Loading URL', url);
  log('contentType', contentType);
  await p.load(url);
  rebuildMenus();
  updateCastTracks();
  setStatus('Playing');
  showControls();
}

function makeCastTrack(id, type, name, language) {
  const t = new chrome.cast.media.Track(id, type);
  t.name = name || `${type} ${id}`;
  t.language = language || 'und';
  t.trackContentType = type === chrome.cast.media.TrackType.TEXT ? 'text/vtt' : undefined;
  t.subtype = type === chrome.cast.media.TrackType.TEXT ? chrome.cast.media.TextTrackType.SUBTITLES : undefined;
  return t;
}

function updateCastTracks() {
  if (!playerManager || !currentMediaInfo) return;
  try {
    const tracks = [];
    const activeIds = [];
    let id = 1;
    const activeVariant = variantTracks().find(v => v.active) || {};
    const audioSeen = new Set();
    variantTracks().forEach(v => {
      const key = `${v.language || ''}|${v.audioId || ''}|${v.label || ''}`;
      if (audioSeen.has(key)) return;
      audioSeen.add(key);
      const track = makeCastTrack(id++, chrome.cast.media.TrackType.AUDIO, v.label || v.language || 'Audio', v.language || 'und');
      track.customData = { kind: 'audio', audioId: v.audioId || null, language: v.language || null };
      tracks.push(track);
      if ((v.audioId && v.audioId === activeVariant.audioId) || (!v.audioId && v.language === activeVariant.language)) activeIds.push(track.trackId);
    });
    const textVisible = player.isTextTrackVisible && player.isTextTrackVisible();
    textTracks().forEach(t => {
      const track = makeCastTrack(id++, chrome.cast.media.TrackType.TEXT, t.label || t.language || 'Subtítulos', t.language || 'und');
      track.customData = { kind: 'text', shakaId: t.id || null, language: t.language || null, label: t.label || null };
      tracks.push(track);
      if (textVisible && t.active) activeIds.push(track.trackId);
    });
    currentMediaInfo.tracks = tracks;
    const mediaStatus = new cast.framework.messages.MediaStatus();
    mediaStatus.media = currentMediaInfo;
    mediaStatus.activeTrackIds = activeIds;
  } catch (e) {
    log('updateCastTracks failed', e.message || e);
  }
}

function applyCastActiveTracks(activeTrackIds) {
  if (!Array.isArray(activeTrackIds)) activeTrackIds = [];
  const media = currentMediaInfo || {};
  const tracks = media.tracks || [];
  const selected = tracks.filter(t => activeTrackIds.includes(t.trackId));
  const audio = selected.find(t => t.type === chrome.cast.media.TrackType.AUDIO);
  const text = selected.find(t => t.type === chrome.cast.media.TrackType.TEXT);
  if (audio && audio.customData) {
    const row = variantTracks().find(v => (audio.customData.audioId && v.audioId === audio.customData.audioId) || v.language === audio.customData.language);
    if (row) selectAudio(row);
  }
  if (text && text.customData) {
    const tt = textTracks().find(t => (text.customData.shakaId && t.id === text.customData.shakaId) || (t.language === text.customData.language && t.label === text.customData.label));
    if (tt) { player.selectTextTrack(tt); player.setTextTrackVisibility(true); }
  } else if (player) {
    player.setTextTrackVisibility(false);
  }
  rebuildMenus();
}

async function main() {
  shaka.polyfill.installAll();
  if (!shaka.Player.isBrowserSupported()) {
    setStatus('Shaka not supported', true);
    return;
  }
  initControls();
  context = cast.framework.CastReceiverContext.getInstance();
  playerManager = context.getPlayerManager();

  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, async loadRequestData => {
    try {
      await loadContent(loadRequestData.media || {});
      return loadRequestData;
    } catch (error) {
      console.error('[LOAD failed]', error);
      setStatus(`LOAD failed: ${error.message || error}`, true);
      if (debugOnError) setDebug(true);
      const errorData = new cast.framework.messages.ErrorData(cast.framework.messages.ErrorType.LOAD_FAILED);
      errorData.reason = cast.framework.messages.ErrorReason.INVALID_REQUEST;
      errorData.customData = { message: error.message || String(error) };
      throw errorData;
    }
  });

  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.EDIT_TRACKS_INFO, requestData => {
    try { applyCastActiveTracks(requestData.activeTrackIds || []); } catch (e) { log('EDIT_TRACKS failed', e.message || e); }
    return requestData;
  });

  context.start({ disableIdleTimeout: true });
  setStatus('Receiver ready');
  showControls({keep: true, focus: true});
}

main().catch(error => {
  console.error('[Receiver fatal]', error);
  setStatus(`Fatal: ${error.message || error}`, true);
  setDebug(true);
});
