const context = cast.framework.CastReceiverContext.getInstance();
const playerManager = context.getPlayerManager();

// --- 1. FILTRO DE RED (Tokens y Evasión de Bloqueos) ---
playerManager.getNetworkingEngine().registerRequestFilter((type, request) => {
    // Inyectamos el token en todas las peticiones (manifiesto y segmentos)
    const token = "include_tudum=true";
    const separator = request.uris[0].includes('?') ? '&' : '?';
    request.uris[0] += separator + token;
    
    // Forzamos el Origin para que el CDN de Makusi no nos rechace
    request.headers['Origin'] = 'https://makusi.eus';
});

// --- 2. MANEJO DE CLEARKEY (Simulación de Licencia Local) ---
playerManager.setMediaPlaybackInfoHandler((loadRequestData, playbackConfig) => {
    const customData = loadRequestData.media.customData || {};
    
    if (customData.drm && customData.drm.clearKeys) {
        // Indicamos que use el sistema de protección ClearKey
        playbackConfig.protectionSystem = cast.framework.ContentProtection.CLEARKEY;
        
        // Esta función responde a la petición de llave sin salir a internet
        playbackConfig.licenseRequestHandler = (requestInfo) => {
            const keys = customData.drm.clearKeys;
            const kid = Object.keys(keys)[0];
            const key = keys[kid];

            // Formato JWK (JSON Web Key) que el reproductor entiende
            const jwk = {
                keys: [{
                    kty: 'oct',
                    kid: hexToBase64Url(kid),
                    k: hexToBase64Url(key)
                }]
            };
            
            // Inyectamos la llave directamente en la respuesta
            requestInfo.content = new TextEncoder().encode(JSON.stringify(jwk));
        };
    }
    return playbackConfig;
});

// Utilidad para convertir Hexadecimal a Base64URL (estándar EME)
function hexToBase64Url(hex) {
    const cleanHex = hex.replace(/-/g, '');
    const binary = hex.match(/\w{2}/g).map(a => String.fromCharCode(parseInt(a, 16))).join("");
    return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
}

// Iniciar el receptor
context.start();