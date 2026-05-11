const video = document.getElementById('video');
const player = new shaka.Player(video);

async function initReceiver() {
    // Escuchar mensajes del Sender para recibir la URL y las llaves
    const castContext = cast.framework.CastReceiverContext.getInstance();
    const playerManager = castContext.getPlayerManager();

    player.getNetworkingEngine().registerRequestFilter((type, request) => {
        // Inyectar Token include_tudum
        const sep = request.uris[0].includes('?') ? '&' : '?';
        request.uris[0] += sep + 'include_tudum=true';
        request.headers['Origin'] = 'https://makusi.eus';
    });

    player.getNetworkingEngine().registerResponseFilter((type, response) => {
        if (type === shaka.net.NetworkingEngine.RequestType.MANIFEST) {
            let xml = new TextDecoder().decode(response.data);
            // Limpiar Widevine para forzar ClearKey
            xml = xml.replace(/<ContentProtection [^>]*schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"[^>]*>[\s\S]*?<\/ContentProtection>/gi, '');
            response.data = new TextEncoder().encode(xml);
        }
    });

    // Escuchamos el evento de carga del móvil/PC
    playerManager.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, loadRequestData => {
        const drm = loadRequestData.media.customData.drm;
        
        player.configure({
            drm: { clearKeys: drm.clearKeys }
        });

        player.load(loadRequestData.media.contentId);
        return null; // Anulamos la carga por defecto de CAF para que Shaka tome el control
    });

    castContext.start();
}

// Cargar la librería de Cast y arrancar
if (window.cast) {
    initReceiver();
}