const context = cast.framework.CastReceiverContext.getInstance();
const videoElement = document.getElementById('shaka-video');
const player = new shaka.Player(videoElement);

// 1. Configuración de Red (Token y Origin)
player.getNetworkingEngine().registerRequestFilter((type, request) => {
    const sep = request.uris[0].includes('?') ? '&' : '?';
    request.uris[0] += sep + 'include_tudum=true';
    request.headers['Origin'] = 'https://makusi.eus';
});

// 2. Limpieza de DRM en el Manifiesto
player.getNetworkingEngine().registerResponseFilter((type, response) => {
    if (type === shaka.net.NetworkingEngine.RequestType.MANIFEST) {
        let xml = new TextDecoder().decode(response.data);
        xml = xml.replace(/<ContentProtection [^>]*schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"[^>]*>[\s\S]*?<\/ContentProtection>/gi, '');
        response.data = new TextEncoder().encode(xml);
    }
});

// 3. Interceptar el comando de carga del móvil/PC
const playerManager = context.getPlayerManager();
playerManager.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, loadRequestData => {
    const drm = loadRequestData.media.customData.drm;
    const url = loadRequestData.media.contentId;

    player.configure({
        drm: { clearKeys: drm.clearKeys }
    });

    player.load(url).then(() => {
        console.log("✅ One Piece cargado con Shaka");
    }).catch(e => console.error("❌ Error Shaka:", e));

    // Retornamos null para que el reproductor por defecto de Google no intente cargar nada
    return null; 
});

context.start();