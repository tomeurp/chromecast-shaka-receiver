const video = document.getElementById('video');
const player = new shaka.Player(video);

// Configuración de red para Makusi
player.getNetworkingEngine().registerRequestFilter((type, request) => {
    const sep = request.uris[0].includes('?') ? '&' : '?';
    request.uris[0] += sep + 'include_tudum=true';
    request.headers['Origin'] = 'https://makusi.eus';
});

player.getNetworkingEngine().registerResponseFilter((type, response) => {
    if (type === shaka.net.NetworkingEngine.RequestType.MANIFEST) {
        let xml = new TextDecoder().decode(response.data);
        xml = xml.replace(/<ContentProtection [^>]*schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"[^>]*>[\s\S]*?<\/ContentProtection>/gi, '');
        response.data = new TextEncoder().encode(xml);
    }
});

// --- INICIALIZAR BUS DE DATOS DEL CHROMECAST ---
const windowCast = window.cast || {};
if (windowCast.receiver) {
    const manager = windowCast.receiver.CastReceiverManager.getInstance();
    const messageBus = manager.getCastMessageBus('urn:x-cast:com.google.cast.media');

    manager.onReady = () => console.log("📺 Receptor listo y esperando...");

    messageBus.onMessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'LOAD') {
            const drm = message.media.customData.drm;
            const url = message.media.contentId;

            player.configure({
                drm: { clearKeys: drm.clearKeys }
            });

            player.load(url).then(() => {
                console.log("🎬 Reproduciendo One Piece");
            }).catch(e => console.error("❌ Error carga:", e));
        }
    };

    manager.start();
}