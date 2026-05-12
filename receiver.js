/* ETB Shaka Cast Receiver v6
 * Minimal TV UI, no fullscreen overlay, deterministic remote navigation.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const video = $('video');
const titleEl = $('title');
const currentText = $('currentText');
const durationText = $('durationText');
const scrubber = $('scrubber');
const bufferBar = $('bufferBar');
const progressBar = $('progressBar');
const thumb = $('thumb');
const debugEl = $('debug');

const buttons = [
  $('restartBtn'), $('rewBtn'), $('playBtn'), $('fwdBtn'), $('audioBtn'), $('subsBtn'), $('qualityBtn')
];
const [restartBtn, rewBtn, playBtn, fwdBtn, audioBtn, subsBtn, qualityBtn] = buttons;
const menus = {
  audio: $('audioMenu'),
  subs: $('subsMenu'),
  quality: $('qualityMenu'),
};

const ICONS = {
  play: '<svg viewBox="0 0 56 56" aria-hidden="true"><path d="M18.4 43.8c-1.3.8-2.7.2-2.7-1.4V13.6c0-1.6 1.4-2.2 2.7-1.4L41.1 26c1.3.8 1.3 3.2 0 4z"/></svg>',
  pause: '<svg viewBox="0 0 56 56" aria-hidden="true"><path d="M16.8 47.1h5.3c2.1 0 3.2-1.1 3.2-3.1V12c0-2.1-1.1-3.1-3.2-3.1h-5.3c-2.1 0-3.1 1.1-3.1 3.1v31.9c0 2.1 1.1 3.2 3.1 3.2zm17 0h5.3c2.1 0 3.2-1.1 3.2-3.1V12c0-2.1-1.1-3.1-3.2-3.1h-5.3c-2.1 0-3.1 1.1-3.1 3.1v31.9c0 2.1 1.1 3.2 3.1 3.2z"/></svg>',
  restart: '<svg viewBox="0 0 56 56" aria-hidden="true"><path d="M28 52.5c13.2 0 24.2-11 24.2-24.2 0-8-4-15.1-10.2-19.6-1-.8-2.4-.5-3 .5-.6 1-.3 2.1.7 2.9 5.1 3.6 8.4 9.6 8.4 16.2 0 11.2-9 20.2-20.2 20.2S7.8 39.5 7.8 28.3c0-9.6 6.6-17.6 15.6-19.6v3.4c0 1.7 1.2 2.1 2.5 1.2l7.6-5.3c1.1-.7 1.1-1.9 0-2.7L26 0c-1.3-.9-2.5-.5-2.5 1.2v3.3C12.3 6.7 3.7 16.6 3.7 28.3c0 13.2 11 24.2 24.3 24.2z"/></svg>',
  back: '<svg viewBox="0 0 56 56" aria-hidden="true"><path d="M15.4 29.9c0 7 5.7 12.6 12.6 12.6s12.6-5.6 12.6-12.6S35 17.3 28 17.3c-2.5 0-4.8.7-6.8 2l2.8 2.8c1.2-.6 2.5-.9 4-.9 4.8 0 8.7 3.9 8.7 8.7s-3.9 8.7-8.7 8.7-8.7-3.9-8.7-8.7h4.2l-6.2-6.2-6.2 6.2z"/><text x="28" y="34" text-anchor="middle" font-size="13" font-weight="900" fill="currentColor">10</text></svg>',
  fwd: '<svg viewBox="0 0 56 56" aria-hidden="true"><path d="M40.6 29.9c0 7-5.7 12.6-12.6 12.6s-12.6-5.6-12.6-12.6S21 17.3 28 17.3c2.5 0 4.8.7 6.8 2L32 22.1c-1.2-.6-2.5-.9-4-.9-4.8 0-8.7 3.9-8.7 8.7s3.9 8.7 8.7 8.7 8.7-3.9 8.7-8.7h-4.2l6.2-6.2 6.2 6.2z"/><text x="28" y="34" text-anchor="middle" font-size="13" font-weight="900" fill="currentColor">10</text></svg>',
  audio: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h4l5-4v13l-5-4H4z"/><path d="M16 9a5 5 0 0 1 0 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M18.7 6.3a8.8 8.8 0 0 1 0 11.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  subs: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 11h5M7 15h3M13 15h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  quality: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.3a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4zm8.3 4.7.1-1-.1-1.1 2-1.5-2-3.5-2.5 1a8.3 8.3 0 0 0-1.8-1L15.6 3H8.4L8 5.6a8.3 8.3 0 0 0-1.8 1l-2.5-1-2 3.5 2 1.5-.1 1.1.1 1-2 1.5 2 3.5 2.5-1c.6.4 1.2.8 1.8 1l.4 2.6h7.2l.4-2.6c.6-.2 1.2-.6 1.8-1l2.5 1 2-3.5z"/></svg>',
};
restartBtn.innerHTML = ICONS.restart;
rewBtn.innerHTML = ICONS.back;
fwdBtn.innerHTML = ICONS.fwd;
audioBtn.innerHTML = ICONS.audio;
subsBtn.innerHTML = ICONS.subs;
qualityBtn.innerHTML = ICONS.quality;

let player = null;
let context = null;
let playerManager = null;
let currentMediaInfo = null;
let debugEnabled = new URLSearchParams(location.search).get('debug') === '1';
let debugOnError = new URLSearchParams(location.search).get('debugOnError') === '1';
let uiVisible = true;
let hideTimer = null;
let focusRow = 1; // 0 scrubber, 1 buttons, 2 menu
let focusIndex = 2; // play
let currentMenu = null;
let menuIndex = 0;
let menuItems = [];
let pendingSeekTime = null;
let castTrackMap = new Map();
let activeCastTrackIds = [];
let qualityAuto = true;

function log(...args) {
  console.log('[ETBReceiver]', ...args);
  if (!debugEnabled) return;
  const line = args.map(x => {
    try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); }
  }).join(' ');
  debugEl.textContent += line + '\n';
  debugEl.scrollTop = debugEl.scrollHeight;
}

function showDebug() {
  debugEnabled = true;
  document.body.classList.add('debug');
}

function setTitle(text) {
  titleEl.textContent = text || 'ETB';
}

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
}

function duration() {
  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function showUi(reason = '') {
  uiVisible = true;
  document.body.classList.add('ui-visible');
  resetAutohide(reason);
}

function hideUi() {
  if (video.paused || currentMenu) return;
  uiVisible = false;
  document.body.classList.remove('ui-visible');
}

function resetAutohide(reason = '') {
  clearTimeout(hideTimer);
  if (video.paused || currentMenu) return;
  hideTimer = setTimeout(hideUi, 4200);
}

function closeMenus() {
  currentMenu = null;
  menuItems = [];
  Object.values(menus).forEach(m => m.classList.remove('open'));
  document.body.classList.remove('menu-open');
  focusRow = 1;
  updateFocus();
  resetAutohide('close-menu');
}

function updateFocus() {
  scrubber.classList.toggle('focused', focusRow === 0);
  buttons.forEach((b, i) => b.classList.toggle('focused', focusRow === 1 && i === focusIndex));
  document.querySelectorAll('.menu-item').forEach((el, i) => el.classList.toggle('focused', focusRow === 2 && i === menuIndex));
  if (focusRow === 0) scrubber.focus({preventScroll:true});
  else if (focusRow === 1 && buttons[focusIndex]) buttons[focusIndex].focus({preventScroll:true});
  else if (focusRow === 2 && menuItems[menuIndex]) menuItems[menuIndex].focus({preventScroll:true});
}

function setFocus(row, index) {
  focusRow = row;
  if (row === 1) focusIndex = clamp(index, 0, buttons.length - 1);
  if (row === 2) menuIndex = clamp(index, 0, Math.max(0, menuItems.length - 1));
  updateFocus();
  showUi('focus');
}

function updatePlayIcon() {
  playBtn.innerHTML = video.paused ? ICONS.play : ICONS.pause;
  document.body.classList.toggle('paused', video.paused);
}

function updateTimeline() {
  const dur = duration();
  const cur = pendingSeekTime != null ? pendingSeekTime : (Number.isFinite(video.currentTime) ? video.currentTime : 0);
  const pct = dur ? clamp(cur / dur, 0, 1) * 100 : 0;
  progressBar.style.width = pct + '%';
  thumb.style.left = pct + '%';
  currentText.textContent = fmtTime(cur);
  durationText.textContent = fmtTime(dur);
  scrubber.setAttribute('aria-valuemax', String(Math.floor(dur)));
  scrubber.setAttribute('aria-valuenow', String(Math.floor(cur)));

  let bufEnd = 0;
  try {
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= cur + 1 && video.buffered.end(i) > bufEnd) bufEnd = video.buffered.end(i);
    }
    if (!bufEnd && video.buffered.length) bufEnd = video.buffered.end(video.buffered.length - 1);
  } catch {}
  const bufPct = dur ? clamp(bufEnd / dur, 0, 1) * 100 : 0;
  bufferBar.style.width = bufPct + '%';
}

function seekBy(delta) {
  const dur = duration();
  if (!dur) return;
  const base = pendingSeekTime != null ? pendingSeekTime : video.currentTime;
  pendingSeekTime = clamp(base + delta, 0, dur);
  updateTimeline();
  showUi('seekBy');
  clearTimeout(seekBy._timer);
  seekBy._timer = setTimeout(() => {
    video.currentTime = pendingSeekTime;
    pendingSeekTime = null;
  }, 160);
}

function seekTo(seconds) {
  const dur = duration();
  video.currentTime = dur ? clamp(seconds, 0, dur) : Math.max(0, seconds || 0);
  pendingSeekTime = null;
  updateTimeline();
  showUi('seekTo');
}

function togglePlay() {
  if (video.paused) video.play().catch(e => log('play failed', e && e.message || e));
  else video.pause();
  showUi('toggle-play');
}

function stopPlayback() {
  log('stop requested');
  try { video.pause(); } catch {}
  try { if (player) player.unload(); } catch {}
  try { if (context && context.stop) context.stop(); } catch (e) { log('context.stop failed', e && e.message || e); }
}

function performButton(i) {
  switch (i) {
    case 0: seekTo(0); break;
    case 1: seekBy(-10); break;
    case 2: togglePlay(); break;
    case 3: seekBy(10); break;
    case 4: openMenu('audio'); break;
    case 5: openMenu('subs'); break;
    case 6: openMenu('quality'); break;
  }
}

buttons.forEach((btn, i) => {
  btn.addEventListener('click', () => { setFocus(1, i); performButton(i); });
  btn.addEventListener('focus', () => { focusRow = 1; focusIndex = i; updateFocus(); });
});
scrubber.addEventListener('focus', () => { focusRow = 0; updateFocus(); });
scrubber.addEventListener('click', ev => {
  const rect = scrubber.getBoundingClientRect();
  const ratio = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
  seekTo(ratio * duration());
});

function requestHeadersFrom(customData = {}) {
  return customData.headers || (customData.drm && customData.drm.headers) || null;
}

function normalizeDrmType(type) { return String(type || 'none').toLowerCase(); }
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
  const isHls = String(contentType || '').toLowerCase().includes('mpegurl') || String(contentType || '').toLowerCase().includes('hls');
  const config = {...shakaConfig};

  // HLS clear from MediaFlow should not receive DRM configuration unless explicitly forced.
  if (!isHls && (type !== 'none' || drm.licenseUrl || drm.clearKeys)) {
    config.drm = {
      ...(shakaConfig.drm || {}),
      servers: {...((shakaConfig.drm && shakaConfig.drm.servers) || {})},
      advanced: {...((shakaConfig.drm && shakaConfig.drm.advanced) || {})},
    };
    if (type === 'clearkey') config.drm.clearKeys = drm.clearKeys || {};
    if (keySystem && drm.licenseUrl) config.drm.servers[keySystem] = drm.licenseUrl;
    if (type === 'fairplay' && drm.certificateUrl) {
      config.drm.advanced['com.apple.fps'] = {
        ...(config.drm.advanced['com.apple.fps'] || {}),
        serverCertificateUri: drm.certificateUrl,
      };
    }
  }
  return config;
}

async function initPlayer() {
  if (player) {
    try { await player.destroy(); } catch {}
  }
  player = new shaka.Player(video);
  player.addEventListener('error', ev => handleShakaError(ev.detail));
  return player;
}

function applyOptionalHeaders(shakaPlayer, headers) {
  if (!headers || !Object.keys(headers).length) return;
  const net = shakaPlayer.getNetworkingEngine();
  if (!net) return;
  net.registerRequestFilter((type, request) => {
    Object.entries(headers).forEach(([k, v]) => {
      if (v != null && String(v) !== '') request.headers[k] = String(v);
    });
  });
  log('custom headers enabled', Object.keys(headers));
}

function handleShakaError(error) {
  console.error('[Shaka error]', error);
  log('Shaka error', error);
  if (debugOnError) showDebug();
}

async function loadContent(mediaInfo) {
  currentMediaInfo = mediaInfo || {};
  const url = currentMediaInfo.contentUrl || currentMediaInfo.contentId;
  if (!url) throw new Error('Missing media URL');
  const contentType = currentMediaInfo.contentType || '';
  const customData = currentMediaInfo.customData || {};
  debugOnError = !!customData.debugOnError || debugOnError;
  if (customData.debug) showDebug();

  setTitle((currentMediaInfo.metadata && currentMediaInfo.metadata.title) || customData.title || 'ETB');
  document.body.classList.add('ui-visible');
  const shakaPlayer = await initPlayer();
  shakaPlayer.configure(buildShakaConfig(customData, contentType));
  applyOptionalHeaders(shakaPlayer, requestHeadersFrom(customData));

  log('load', url, contentType, customData);
  await shakaPlayer.load(url);
  qualityAuto = true;
  updateTrackState();
  updateTimeline();
  updatePlayIcon();
  setFocus(1, 2);
  showUi('loaded');
}

function getVariantTracks() {
  if (!player) return [];
  try { return player.getVariantTracks() || []; } catch { return []; }
}
function getTextTracks() {
  if (!player) return [];
  try { return player.getTextTracks() || []; } catch { return []; }
}
function labelAudioTrack(t, i) {
  return t.label || t.language || (t.roles && t.roles[0]) || `Audio ${i + 1}`;
}
function labelTextTrack(t, i) {
  return t.label || t.language || (t.roles && t.roles[0]) || `Subtítulos ${i + 1}`;
}
function labelQuality(t) {
  const h = t.height ? `${t.height}p` : 'Vídeo';
  const mbps = t.bandwidth ? ` · ${(t.bandwidth / 1000000).toFixed(1)} Mbps` : '';
  return h + mbps;
}
function uniqueAudioOptions() {
  const seen = new Set();
  const out = [];
  getVariantTracks().forEach((t, i) => {
    const key = `${t.language || ''}|${(t.roles || []).join(',')}|${t.label || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({track:t, index:i, label:labelAudioTrack(t, out.length)});
  });
  return out;
}
function uniqueQualityOptions() {
  const map = new Map();
  getVariantTracks().forEach(t => {
    if (!t.height && !t.bandwidth) return;
    const key = `${t.height || 0}|${t.bandwidth || 0}`;
    const cur = map.get(key);
    if (!cur || t.active) map.set(key, t);
  });
  return Array.from(map.values()).sort((a,b) => (b.height||0)-(a.height||0) || (b.bandwidth||0)-(a.bandwidth||0));
}

function buildMenu(kind) {
  const el = menus[kind];
  el.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'menu-title';
  title.textContent = kind === 'audio' ? 'Audio' : kind === 'subs' ? 'Subtítulos' : 'Calidad';
  el.appendChild(title);
  const items = [];
  function add(label, active, action) {
    const b = document.createElement('button');
    b.className = 'menu-item' + (active ? ' active' : '');
    b.tabIndex = -1;
    b.innerHTML = `<span>${escapeHtml(label)}</span><span class="check">✓</span>`;
    b.addEventListener('click', () => { action(); closeMenus(); });
    el.appendChild(b);
    items.push({el:b, action});
  }
  if (kind === 'audio') {
    const opts = uniqueAudioOptions();
    if (!opts.length) add('Audio único', true, () => {});
    opts.forEach((o) => add(o.label, !!o.track.active, () => {
      if (!player) return;
      try { player.selectAudioLanguage(o.track.language, o.track.roles && o.track.roles[0]); } catch {}
      const active = getVariantTracks().find(t => t.language === o.track.language && (!o.track.roles || !o.track.roles.length || (t.roles || []).includes(o.track.roles[0])));
      if (active) try { player.selectVariantTrack(active, true); } catch {}
      updateTrackState();
    }));
  } else if (kind === 'subs') {
    let visible = false;
    try { visible = player && player.isTextTrackVisible(); } catch {}
    add('Sin subtítulos', !visible, () => { if (player) player.setTextTrackVisibility(false); updateTrackState(); });
    getTextTracks().forEach((t, i) => add(labelTextTrack(t, i), visible && !!t.active, () => {
      if (!player) return;
      try { player.selectTextTrack(t); player.setTextTrackVisibility(true); } catch {}
      updateTrackState();
    }));
  } else if (kind === 'quality') {
    add('Auto', qualityAuto, () => { qualityAuto = true; if (player) player.configure({abr:{enabled:true}}); updateTrackState(); });
    uniqueQualityOptions().forEach((t) => add(labelQuality(t), !qualityAuto && !!t.active, () => {
      qualityAuto = false;
      if (!player) return;
      player.configure({abr:{enabled:false}});
      try { player.selectVariantTrack(t, true); } catch {}
      updateTrackState();
    }));
  }
  return items;
}

function openMenu(kind) {
  Object.entries(menus).forEach(([k, m]) => m.classList.toggle('open', k === kind));
  currentMenu = kind;
  document.body.classList.add('menu-open');
  menuItems = buildMenu(kind);
  menuIndex = Math.max(0, menuItems.findIndex(x => x.el.classList.contains('active')));
  if (menuIndex < 0) menuIndex = 0;
  focusRow = 2;
  updateFocus();
  showUi('open-menu');
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function updateTrackState() {
  // Buttons stay enabled but dim when there are no options.
  audioBtn.classList.toggle('disabled', uniqueAudioOptions().length <= 1);
  subsBtn.classList.toggle('disabled', getTextTracks().length === 0);
  qualityBtn.classList.toggle('disabled', uniqueQualityOptions().length <= 1);
  publishCastTracks();
}

function publishCastTracks() {
  castTrackMap = new Map();
  activeCastTrackIds = [];
  let id = 1;
  const tracks = [];
  uniqueAudioOptions().forEach((o, i) => {
    const t = new chrome.cast.media.Track(id, chrome.cast.media.TrackType.AUDIO);
    t.trackContentType = 'audio/mp4';
    t.name = o.label;
    t.language = o.track.language || 'und';
    t.subtype = null;
    tracks.push(t);
    castTrackMap.set(id, {kind:'audio', track:o.track});
    if (o.track.active) activeCastTrackIds.push(id);
    id++;
  });
  let textVisible = false;
  try { textVisible = player && player.isTextTrackVisible(); } catch {}
  getTextTracks().forEach((o, i) => {
    const t = new chrome.cast.media.Track(id, chrome.cast.media.TrackType.TEXT);
    t.trackContentType = 'text/vtt';
    t.name = labelTextTrack(o, i);
    t.language = o.language || 'und';
    t.subtype = chrome.cast.media.TextTrackType.SUBTITLES;
    tracks.push(t);
    castTrackMap.set(id, {kind:'text', track:o});
    if (textVisible && o.active) activeCastTrackIds.push(id);
    id++;
  });
  if (currentMediaInfo) {
    currentMediaInfo.tracks = tracks;
    currentMediaInfo.activeTrackIds = activeCastTrackIds;
  }
}

function applyCastTrackIds(ids = []) {
  const wanted = new Set(ids || []);
  let selectedText = null;
  let selectedAudio = null;
  for (const id of wanted) {
    const entry = castTrackMap.get(id);
    if (!entry) continue;
    if (entry.kind === 'audio') selectedAudio = entry.track;
    if (entry.kind === 'text') selectedText = entry.track;
  }
  if (selectedAudio && player) {
    try { player.selectAudioLanguage(selectedAudio.language, selectedAudio.roles && selectedAudio.roles[0]); } catch {}
  }
  if (player) {
    if (selectedText) { try { player.selectTextTrack(selectedText); player.setTextTrackVisibility(true); } catch {} }
    else { try { player.setTextTrackVisibility(false); } catch {} }
  }
  updateTrackState();
}

function handleKey(ev) {
  const key = ev.key || '';
  const code = ev.keyCode || ev.which || 0;
  log('key', key, code);

  if (debugEnabled && (key === 'd' || key === 'D')) return;

  const norm = key.toLowerCase();
  const isBack = key === 'Escape' || key === 'Backspace' || key === 'BrowserBack' || code === 461 || code === 27;
  const isEnter = key === 'Enter' || key === 'OK' || key === 'Select' || code === 13;
  const isStop = key === 'MediaStop' || key === 'Stop' || code === 413;
  const isPlayPause = key === 'MediaPlayPause' || key === 'PlayPause' || key === 'MediaPlay' || key === 'MediaPause' || code === 179 || code === 415 || code === 19;
  const isAudioKey = /audio|sound|language/i.test(key) || code === 751;
  const isSubsKey = /subtitle|subtitles|caption|closedcaption|cc/i.test(key) || code === 460;

  if (isStop) { ev.preventDefault(); stopPlayback(); return; }
  if (isPlayPause) { ev.preventDefault(); togglePlay(); return; }
  if (isAudioKey) { ev.preventDefault(); openMenu('audio'); return; }
  if (isSubsKey) { ev.preventDefault(); openMenu('subs'); return; }

  if (isBack) {
    ev.preventDefault();
    if (currentMenu) closeMenus(); else if (uiVisible) hideUi(); else showUi('back-show');
    return;
  }

  if (!uiVisible && !currentMenu) {
    showUi('key-show');
    if (key.startsWith('Arrow')) { ev.preventDefault(); return; }
  }

  if (focusRow === 2 && currentMenu) {
    if (key === 'ArrowDown') { ev.preventDefault(); menuIndex = clamp(menuIndex + 1, 0, menuItems.length - 1); updateFocus(); return; }
    if (key === 'ArrowUp') { ev.preventDefault(); menuIndex = clamp(menuIndex - 1, 0, menuItems.length - 1); updateFocus(); return; }
    if (key === 'ArrowLeft' || key === 'ArrowRight') { ev.preventDefault(); return; }
    if (isEnter) { ev.preventDefault(); if (menuItems[menuIndex]) menuItems[menuIndex].action(); closeMenus(); return; }
  }

  if (key === 'ArrowUp') { ev.preventDefault(); setFocus(0, 0); return; }
  if (key === 'ArrowDown') { ev.preventDefault(); setFocus(1, focusIndex); return; }
  if (key === 'ArrowLeft') {
    ev.preventDefault();
    if (focusRow === 0) seekBy(-10);
    else setFocus(1, focusIndex - 1);
    return;
  }
  if (key === 'ArrowRight') {
    ev.preventDefault();
    if (focusRow === 0) seekBy(10);
    else setFocus(1, focusIndex + 1);
    return;
  }
  if (isEnter) {
    ev.preventDefault();
    if (focusRow === 0) togglePlay();
    else performButton(focusIndex);
    return;
  }
}

document.addEventListener('keydown', handleKey, true);
document.addEventListener('mousemove', () => showUi('mouse'));
video.addEventListener('timeupdate', updateTimeline);
video.addEventListener('durationchange', updateTimeline);
video.addEventListener('progress', updateTimeline);
video.addEventListener('play', () => { updatePlayIcon(); showUi('play'); });
video.addEventListener('pause', () => { updatePlayIcon(); showUi('pause'); });
video.addEventListener('seeking', () => showUi('seeking'));
video.addEventListener('seeked', () => showUi('seeked'));

async function main() {
  shaka.polyfill.installAll();
  if (!shaka.Player.isBrowserSupported()) {
    showDebug();
    log('Shaka not supported');
    return;
  }
  context = cast.framework.CastReceiverContext.getInstance();
  playerManager = context.getPlayerManager();

  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, async (loadRequestData) => {
    try {
      await loadContent(loadRequestData.media || {});
      return loadRequestData;
    } catch (e) {
      console.error('[LOAD failed]', e);
      log('LOAD failed', e && (e.stack || e.message) || e);
      if (debugOnError) showDebug();
      const errorData = new cast.framework.messages.ErrorData(cast.framework.messages.ErrorType.LOAD_FAILED);
      errorData.reason = cast.framework.messages.ErrorReason.INVALID_REQUEST;
      errorData.customData = {message: e && e.message || String(e)};
      throw errorData;
    }
  });

  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.PLAY, (data) => { video.play().catch(()=>{}); return data; });
  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.PAUSE, (data) => { video.pause(); return data; });
  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.SEEK, (data) => { if (data.currentTime != null) seekTo(data.currentTime); return data; });
  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.STOP, (data) => { stopPlayback(); return data; });
  playerManager.setMessageInterceptor(cast.framework.messages.MessageType.EDIT_TRACKS_INFO, (data) => {
    applyCastTrackIds(data.activeTrackIds || []);
    return data;
  });

  context.start({disableIdleTimeout: true});
  setTitle('Ready');
  updatePlayIcon();
  setFocus(1, 2);
  showUi('boot');
}

main().catch(e => { console.error(e); showDebug(); log('fatal', e && (e.stack || e.message) || e); });
