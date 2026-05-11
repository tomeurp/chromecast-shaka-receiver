const video = document.getElementById('video');
const statusEl = document.getElementById('status');

let player = null;

function log(...args) {
  console.log('[GenericShakaReceiver]', ...args);
}

function setStatus(text) {
  statusEl.textContent = text;
  log(text);
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

function applyRequestHeaders(shakaPlayer, headers = {}) {
  const networking = shakaPlayer.getNetworkingEngine();

  if (!networking) {
    return;
  }

  networking.registerRequestFilter((requestType, request) => {
    Object.entries(headers).forEach(([name, value]) => {
      request.headers[name] = String(value);
    });
  });
}

async function initPlayer() {
  if (player) {
    await player.destroy();
  }

  player = new shaka.Player(video);

  player.addEventListener('error', event => {
    console.error('[Shaka error]', event.detail);
    setStatus(`Shaka error: ${event.detail && event.detail.code}`);
  });

  return player;
}

async function loadContent(mediaInfo) {
  const contentUrl = mediaInfo.contentUrl || mediaInfo.contentId;
  const contentType = mediaInfo.contentType || '';
  const customData = mediaInfo.customData || {};
  const drm = customData.drm || {};

  if (!contentUrl) {
    throw new Error('Missing media URL');
  }

  setStatus('Loading');

  const shakaPlayer = await initPlayer();
  const config = buildShakaConfig(customData);

  shakaPlayer.configure(config);

  if (drm.headers) {
    applyRequestHeaders(shakaPlayer, drm.headers);
  }

  log('contentUrl', contentUrl);
  log('contentType', contentType);
  log('customData', customData);
  log('shakaConfig', config);

  await shakaPlayer.load(contentUrl);

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

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    async loadRequestData => {
      try {
        log('LOAD request', loadRequestData);

        const mediaInfo = loadRequestData.media || {};
        await loadContent(mediaInfo);

        return loadRequestData;
      } catch (error) {
        console.error('[LOAD failed]', error);
        setStatus(`LOAD failed: ${error.message}`);

        const errorData = new cast.framework.messages.ErrorData(
          cast.framework.messages.ErrorType.LOAD_FAILED
        );

        errorData.reason = cast.framework.messages.ErrorReason.INVALID_REQUEST;
        errorData.customData = {
          message: error.message
        };

        throw errorData;
      }
    }
  );

  context.start({
    disableIdleTimeout: true
  });

  setStatus('Receiver started');
}

main().catch(error => {
  console.error('[Receiver fatal]', error);
  setStatus(`Fatal error: ${error.message}`);
});
