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
const controlsEl = document.getElementById('controls');
const titleEl = document.getElementById('title');
const playPauseBtn = document.getElementById('playPause');
const seekEl = document.getElementById('seek');
const timeEl = document.getElementById('time');
const audioButton = document.getElementById('audioButton');
const subsButton = document.getElementById('subsButton');
const audioMenu = document.getElementById('audioMenu');
const subsMenu = document.getElementById('subsMenu');
const skipBackBtn = document.getElementById('skipBack');

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
let controlsHideTimer = null;
let uiTrackOptions = { audio: [], text: [] };
let lastMediaTitle = '';
let isSeekingUi = false;
let openMenuEl = null;
let lastFocusedControl = null;


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
  if (statusEl) statusEl.textContent = text;
  debugLine('STATUS:', text);
  if (titleEl && !lastMediaTitle) titleEl.textContent = text;
}


function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  const mTotal = Math.floor(seconds / 60);
  const m = (mTotal % 60).toString().padStart(2, '0');
  const h = Math.floor(mTotal / 60);
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

function focusables() {
  return Array.from(document.querySelectorAll('#controls .focusable, .track-menu.open .track-menu-item'))
    .filter(el => el && el.offsetParent !== null && !el.disabled);
}

function focusControl(el) {
  if (!el || typeof el.focus !== 'function') return;
  try { el.focus(); lastFocusedControl = el; } catch (_) {}
}

function showControls(reason = 'activity', focusDefault = false) {
  if (!document.body) return;
  document.body.classList.add('controls-visible');
  clearTimeout(controlsHideTimer);
  if (focusDefault) {
    const target = lastFocusedControl && lastFocusedControl.offsetParent !== null ? lastFocusedControl : playPauseBtn;
    setTimeout(() => focusControl(target), 0);
  }
  controlsHideTimer = setTimeout(() => {
    if (video && !video.paused && !openMenuEl && !document.activeElement?.closest?.('#controls')) {
      document.body.classList.remove('controls-visible');
    }
  }, 5200);
}

function keepControlsVisible(reason = 'keep') {
  showControls(reason, false);
}

function hideControlsNow() {
  closeTrackMenus();
  if (video && !video.paused) document.body.classList.remove('controls-visible');
}

function updatePlaybackUi() {
  if (playPauseBtn) playPauseBtn.textContent = video && !video.paused ? '❚❚' : '▶';
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  if (seekEl && !isSeekingUi) {
    seekEl.max = duration || 0;
    seekEl.value = Math.min(current, duration || current) || 0;
  }
  if (timeEl) timeEl.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
}

function optionLabel(parts) {
  return parts.filter(Boolean).join(' · ');
}

function setButtonLabel(btn, prefix, label, fallback = '') {
  if (!btn) return;
  const clean = label || fallback || prefix;
  btn.textContent = `${prefix}: ${clean}`;
}

function closeTrackMenus() {
  if (audioMenu) audioMenu.classList.remove('open');
  if (subsMenu) subsMenu.classList.remove('open');
  openMenuEl = null;
  document.body.classList.remove('menu-open');
}

function openTrackMenu(menu, sourceButton) {
  if (!menu) return;
  const wasOpen = menu.classList.contains('open');
  closeTrackMenus();
  if (wasOpen) return;
  menu.classList.add('open');
  openMenuEl = menu;
  document.body.classList.add('menu-open');
  showControls('menu', false);
  const active = menu.querySelector('.track-menu-item.active') || menu.querySelector('.track-menu-item');
  setTimeout(() => focusControl(active || sourceButton), 0);
}

function makeMenuItem(label, active, onSelect) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'track-menu-item focusable' + (active ? ' active' : '');
  b.setAttribute('role', 'menuitemradio');
  b.setAttribute('aria-checked', active ? 'true' : 'false');
  b.innerHTML = `<span>${escapeHtml(String(label || 'Track'))}</span><span class="check">✓</span>`;
  b.addEventListener('click', () => {
    onSelect();
    closeTrackMenus();
    refreshControlsTracksFromShaka();
    showControls('menuSelect', true);
  });
  b.addEventListener('focus', () => { lastFocusedControl = b; showControls('menuFocus', false); });
  return b;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
}

function refreshControlsTracksFromShaka() {
  if (!player) return;
  const variants = player.getVariantTracks ? player.getVariantTracks() : [];
  const textTracks = player.getTextTracks ? player.getTextTracks() : [];
  const audioSeen = new Map();
  const audioOptions = [];
  for (const variant of variants) {
    const key = audioKeyFromVariant(variant);
    if (audioSeen.has(key)) continue;
    audioSeen.set(key, true);
    const language = normalizeTrackLanguage(variant.language || variant.audioLanguage);
    audioOptions.push({
      key,
      label: optionLabel([variant.label || 'Audio', language]),
      active: !!variant.active,
    });
  }
  const textVisible = !!(player.isTextTrackVisible && player.isTextTrackVisible());
  const textOptions = textTracks.map(t => ({
    key: textKeyFromTrack(t),
    label: optionLabel([t.label || 'Subtitles', normalizeTrackLanguage(t.language)]),
    active: textVisible && !!t.active,
    track: t,
  }));
  uiTrackOptions = { audio: audioOptions, text: textOptions };

  const activeAudio = audioOptions.find(o => o.active) || audioOptions[0] || null;
  setButtonLabel(audioButton, 'Audio', activeAudio && activeAudio.label, 'None');
  if (audioButton) audioButton.style.display = audioOptions.length > 1 ? '' : 'none';

  const activeText = textOptions.find(o => o.active) || null;
  setButtonLabel(subsButton, 'Subs', activeText ? activeText.label : 'Off', 'Off');
  if (subsButton) subsButton.style.display = textOptions.length ? '' : 'none';

  if (audioMenu) {
    audioMenu.innerHTML = '<div class="track-menu-title">Audio</div>';
    for (const opt of audioOptions) {
      audioMenu.appendChild(makeMenuItem(opt.label, opt.active, () => {
        const entry = [...castTrackMap.entries()].find(([, info]) => info.kind === 'audio' && info.key === opt.key);
        if (entry) selectAudioTrackByCastTrackId(entry[0]);
      }));
    }
  }

  if (subsMenu) {
    subsMenu.innerHTML = '<div class="track-menu-title">Subtitles</div>';
    subsMenu.appendChild(makeMenuItem('Off', !activeText, () => {
      if (player && player.setTextTrackVisibility) player.setTextTrackVisibility(false);
    }));
    for (const opt of textOptions) {
      subsMenu.appendChild(makeMenuItem(opt.label, opt.active, () => {
        if (opt.track && player) {
          player.selectTextTrack(opt.track);
          player.setTextTrackVisibility(true);
        }
      }));
    }
  }
}

function cycleAudioTrack(direction = 1) {
  refreshControlsTracksFromShaka();
  const opts = uiTrackOptions.audio || [];
  if (opts.length < 2) return;
  const idx = Math.max(0, opts.findIndex(o => o.active));
  const next = opts[(idx + direction + opts.length) % opts.length];
  const entry = [...castTrackMap.entries()].find(([, info]) => info.kind === 'audio' && info.key === next.key);
  if (entry) selectAudioTrackByCastTrackId(entry[0]);
  refreshControlsTracksFromShaka();
  showControls('cycleAudio', true);
}

function cycleSubtitleTrack(direction = 1) {
  refreshControlsTracksFromShaka();
  const opts = [{ key: 'off', label: 'Off', active: !(player && player.isTextTrackVisible && player.isTextTrackVisible()) }, ...(uiTrackOptions.text || [])];
  if (opts.length < 2) return;
  const idx = Math.max(0, opts.findIndex(o => o.active));
  const next = opts[(idx + direction + opts.length) % opts.length];
  if (next.key === 'off') {
    if (player && player.setTextTrackVisibility) player.setTextTrackVisibility(false);
  } else if (next.track && player) {
    player.selectTextTrack(next.track);
    player.setTextTrackVisibility(true);
  }
  refreshControlsTracksFromShaka();
  showControls('cycleSubs', true);
}

function seekBy(delta) {
  const duration = Number.isFinite(video.duration) ? video.duration : Infinity;
  const target = Math.max(0, Math.min(duration, (video.currentTime || 0) + delta));
  if (Number.isFinite(target)) video.currentTime = target;
  showControls('seekBy', true);
  updatePlaybackUi();
}

function moveFocus(delta) {
  const items = focusables();
  if (!items.length) return;
  const current = document.activeElement;
  let idx = items.indexOf(current);
  if (idx < 0) idx = delta > 0 ? -1 : 0;
  const next = items[(idx + delta + items.length) % items.length];
  focusControl(next);
  showControls('moveFocus', false);
}

function handleReceiverKey(ev) {
  const key = ev.key || '';
  const code = ev.code || '';
  const keyCode = ev.keyCode || ev.which || 0;
  const target = ev.target;
  const inMenu = !!target?.closest?.('.track-menu');
  const controlsVisible = document.body.classList.contains('controls-visible') || document.body.classList.contains('menu-open');

  const isAudioKey = /audio/i.test(key) || /audio/i.test(code) || keyCode === 460;
  const isSubtitleKey = /subtitle|caption|text/i.test(key) || /subtitle|caption|text/i.test(code) || keyCode === 461;
  if (isAudioKey) { ev.preventDefault(); cycleAudioTrack(1); return; }
  if (isSubtitleKey) { ev.preventDefault(); cycleSubtitleTrack(1); return; }

  if (key === 'MediaPlayPause' || keyCode === 179) {
    ev.preventDefault();
    if (video.paused) video.play().catch(e => debugLine('remote play failed', e)); else video.pause();
    showControls('mediaPlayPause', true);
    return;
  }
  if (key === 'MediaPlay' || keyCode === 415) { ev.preventDefault(); video.play().catch(e => debugLine('remote play failed', e)); showControls('play', true); return; }
  if (key === 'MediaPause' || keyCode === 19) { ev.preventDefault(); video.pause(); showControls('pause', true); return; }

  if (!controlsVisible && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Enter',' ','Spacebar'].includes(key)) {
    ev.preventDefault();
    showControls('remoteWake', true);
    return;
  }

  if (key === 'Escape' || key === 'Backspace' || key === 'BrowserBack') {
    ev.preventDefault();
    if (openMenuEl) closeTrackMenus(); else hideControlsNow();
    return;
  }

  if (key === 'ArrowLeft') {
    ev.preventDefault();
    if (inMenu) moveFocus(-1);
    else if (target === seekEl || !document.activeElement?.closest?.('#controls')) seekBy(-10);
    else moveFocus(-1);
    return;
  }
  if (key === 'ArrowRight') {
    ev.preventDefault();
    if (inMenu) moveFocus(1);
    else if (target === seekEl || !document.activeElement?.closest?.('#controls')) seekBy(30);
    else moveFocus(1);
    return;
  }
  if (key === 'ArrowUp') { ev.preventDefault(); moveFocus(-1); return; }
  if (key === 'ArrowDown') { ev.preventDefault(); moveFocus(1); return; }

  if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
    showControls('enter', false);
    return;
  }
}

function installControlUiHandlers() {
  if (controlsEl) {
    ['mousemove', 'pointermove', 'click', 'touchstart'].forEach(name => {
      document.addEventListener(name, () => showControls(name), { passive: true });
    });
    controlsEl.addEventListener('focusin', () => keepControlsVisible('focusin'));
    controlsEl.addEventListener('focusout', () => showControls('focusout'));
  }
  document.addEventListener('keydown', handleReceiverKey, true);

  if (playPauseBtn) {
    playPauseBtn.addEventListener('click', () => {
      if (video.paused) video.play().catch(e => debugLine('UI play failed', e));
      else video.pause();
      showControls('playPause', true);
    });
    playPauseBtn.addEventListener('focus', () => { lastFocusedControl = playPauseBtn; showControls('playFocus'); });
  }
  if (skipBackBtn) {
    skipBackBtn.addEventListener('click', () => seekBy(-10));
    skipBackBtn.addEventListener('focus', () => { lastFocusedControl = skipBackBtn; showControls('backFocus'); });
  }
  if (seekEl) {
    seekEl.addEventListener('input', () => { isSeekingUi = true; updatePlaybackUi(); showControls('seek', false); });
    seekEl.addEventListener('change', () => {
      const t = Number(seekEl.value);
      if (Number.isFinite(t)) video.currentTime = t;
      isSeekingUi = false;
      showControls('seekChange', true);
    });
    seekEl.addEventListener('focus', () => { lastFocusedControl = seekEl; showControls('seekFocus', false); });
  }
  if (audioButton) {
    audioButton.addEventListener('click', () => openTrackMenu(audioMenu, audioButton));
    audioButton.addEventListener('focus', () => { lastFocusedControl = audioButton; showControls('audioFocus'); });
  }
  if (subsButton) {
    subsButton.addEventListener('click', () => openTrackMenu(subsMenu, subsButton));
    subsButton.addEventListener('focus', () => { lastFocusedControl = subsButton; showControls('subsFocus'); });
  }
  ['timeupdate', 'durationchange', 'loadedmetadata'].forEach(name => {
    video.addEventListener(name, updatePlaybackUi);
  });
  ['play', 'pause', 'waiting', 'playing', 'seeking', 'seeked'].forEach(name => {
    video.addEventListener(name, () => { updatePlaybackUi(); showControls(name, name === 'pause' || name === 'seeking' || name === 'seeked'); });
  });
  setInterval(updatePlaybackUi, 500);
  showControls('startup', false);
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
    refreshControlsTracksFromShaka();
  });

  player.addEventListener('trackschanged', () => {
    try { lastTracks = {variantTracks: player.getVariantTracks(), textTracks: player.getTextTracks()}; }
    catch (e) { lastTracks = {error:e.message}; }
    debugLine('SHAKA EVENT trackschanged', lastTracks);
    refreshControlsTracksFromShaka();
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
    lastMediaTitle = (mediaInfo.metadata && mediaInfo.metadata.title) || mediaInfo.title || mediaInfo.contentId || 'Playing';
    if (titleEl) titleEl.textContent = lastMediaTitle;
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
  refreshControlsTracksFromShaka();
  updatePlaybackUi();
  showControls('loaded');
  videoSnapshot('after-load');
  setStatus('Playing');
  return trackState;
}

async function main() {
  setupDebugControls();
  installControlUiHandlers();
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
    showControls('castPlay', true);
    return requestData;
  });

  interceptMessage(playerManager, 'PAUSE', requestData => {
    debugLine('CAF PAUSE', requestData);
    video.pause && video.pause();
    showControls('castPause', true);
    return requestData;
  });

  interceptMessage(playerManager, 'SEEK', requestData => {
    debugLine('CAF SEEK', requestData);
    if (typeof requestData.currentTime === 'number' && Number.isFinite(requestData.currentTime)) {
      video.currentTime = requestData.currentTime;
      showControls('castSeek', true);
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
