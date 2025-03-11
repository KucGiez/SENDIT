/**
 * SendItClient - Klasa implementująca funkcjonalność klienta WebRTC dla aplikacji SendIt
 * Odpowiada za wykrywanie urządzeń, nawiązywanie połączeń i przesyłanie plików
 */
class SendItClient {
    constructor() {
        // Właściwości związane z połączeniem Socket.IO
        this.socket = null;
        this.peerId = null;
        this.deviceName = null;
        this.networkId = null;
        
        // Listy i kolekcje urządzeń i połączeń
        this.peers = {};  // Lista wykrytych urządzeń
        this.activeConnections = {};  // Aktywne połączenia WebRTC
        
        // Callbacki do interfejsu użytkownika
        this.onPeerConnected = null;
        this.onPeerDisconnected = null;
        this.onPeersUpdated = null;
        this.onConnectionStateChange = null;
        this.onTransferProgress = null;
        this.onTransferComplete = null;
        this.onTransferError = null;
        this.onFilesReceived = null;
        this.onTransferRequest = null;
        
        // Stan aplikacji
        this.pendingTransfers = {};  // Oczekujące transfery
        this.transferQueue = [];     // Kolejka transferów
        this.currentTransfer = null; // Aktualny transfer
        this.isConnecting = {};      // Stan połączeń (czy w trakcie łączenia)
        this.connectionStates = {};  // Stany połączeń
        this.dataChannelStates = {}; // Stany kanałów danych
        
        // Konfiguracja transmisji
        this.chunkSize = 16384;      // Rozmiar fragmentu pliku (16KB)
        this.connectionTimeout = 30000;  // Timeout połączenia (30s)
        this.iceTimeout = 15000;         // Timeout ICE (15s)
        this.baseChunkDelay = 5;         // Podstawowe opóźnienie między fragmentami
        this.adaptiveChunkDelay = true;  // Dynamiczne dostosowanie opóźnienia
        
        // Stan odbierania
        this.currentReceivingFile = null;  // Aktualnie odbierany plik
        this.incomingFiles = null;         // Lista plików przychodzących
        this.receivedFiles = [];           // Lista odebranych plików
        this.receivedChunksRegistry = {};  // Rejestr odebranych fragmentów
        
        // System potwierdzeń
        this.ackEnabled = true;     // Włączenie potwierdzeń dla fragmentów
        this.pendingAcks = {};      // Oczekujące potwierdzenia
        this.retryChunks = {};      // Fragmenty do ponowienia
        this.ackTimeout = 5000;     // Timeout oczekiwania na potwierdzenie (5s)
        
        // Ostatnio otrzymany nagłówek fragmentu
        this.lastChunkHeader = null;
    }

    /**
     * Inicjalizacja klienta - nawiązanie połączenia z serwerem sygnalizacyjnym
     * @returns {Promise} - Promise rozwiązywany po inicjalizacji
     */
    async init() {
        return new Promise((resolve, reject) => {
            try {
                console.log('[DEBUG] Inicjalizacja klienta SendIt...');
                
                // Konfiguracja Socket.IO
                const serverUrl = window.location.origin;
                console.log(`[DEBUG] Łączenie z serwerem: ${serverUrl}`);
                
                this.socket = io({
                    reconnectionDelay: 1000,
                    reconnectionDelayMax: 5000,
                    reconnectionAttempts: 10,
                    timeout: 20000,
                    transports: ['websocket', 'polling']
                });
                
                // Obsługa połączenia
                this.socket.on('connect', () => {
                    console.log('[DEBUG] Połączono z serwerem sygnalizacyjnym');
                });
                
                // Obsługa przydzielonego ID
                this.socket.on('assigned-id', (id) => {
                    this.peerId = id;
                    console.log('[DEBUG] Przydzielono ID:', id);
                    resolve();
                });
                
                // Obsługa przydzielonego ID sieci
                this.socket.on('network-id', (networkId) => {
                    this.networkId = networkId;
                    console.log('[DEBUG] Przydzielono ID sieci:', networkId);
                });
                
                // Obsługa listy aktywnych peerów
                this.socket.on('active-peers', (peers) => {
                    console.log(`[DEBUG] Otrzymano listę ${peers.length} aktywnych peerów`);
                    this.peers = {};
                    peers.forEach(peer => {
                        this.peers[peer.id] = peer;
                    });
                    
                    if (this.onPeersUpdated) {
                        this.onPeersUpdated(Object.values(this.peers));
                    }
                });
                
                // Obsługa nowego peera
                this.socket.on('peer-joined', (peer) => {
                    console.log(`[DEBUG] Nowy peer dołączył do sieci: ${peer.name} (${peer.id})`);
                    this.peers[peer.id] = peer;
                    
                    if (this.onPeerConnected) {
                        this.onPeerConnected(peer);
                    }
                    
                    if (this.onPeersUpdated) {
                        this.onPeersUpdated(Object.values(this.peers));
                    }
                });
                
                // Obsługa odłączenia peera
                this.socket.on('peer-left', (peerId) => {
                    const peer = this.peers[peerId];
                    console.log(`[DEBUG] Peer opuścił sieć: ${peer?.name || 'Nieznany'} (${peerId})`);
                    delete this.peers[peerId];
                    
                    // Czyszczenie zasobów
                    this.cleanupConnection(peerId);
                    
                    if (this.onPeerDisconnected && peer) {
                        this.onPeerDisconnected(peer);
                    }
                    
                    if (this.onPeersUpdated) {
                        this.onPeersUpdated(Object.values(this.peers));
                    }
                });
                
                // Obsługa sygnałów WebRTC
                this.socket.on('signal', async ({ peerId, signal }) => {
                    await this.handleIncomingSignal(peerId, signal);
                });
                
                // Obsługa potwierdzenia sygnału
                this.socket.on('signal-confirmation', ({ peerId }) => {
                    console.log(`[DEBUG] Potwierdzenie odebrania sygnału przez ${peerId}`);
                });
                
                // Obsługa błędów sygnalizacji
                this.socket.on('signal-error', ({ targetPeerId, error }) => {
                    console.error(`[BŁĄD] Błąd sygnalizacji dla ${targetPeerId}: ${error}`);
                    
                    if (error === 'peer-not-found') {
                        delete this.peers[targetPeerId];
                        if (this.onPeersUpdated) {
                            this.onPeersUpdated(Object.values(this.peers));
                        }
                    }
                });
                
                // Obsługa błędów połączenia
                this.socket.on('connect_error', (error) => {
                    console.error(`[BŁĄD] Błąd połączenia z serwerem: ${error.message}`);
                    reject(error);
                });
                
                // Obsługa rozłączenia
                this.socket.on('disconnect', (reason) => {
                    console.warn(`[OSTRZEŻENIE] Rozłączono z serwerem sygnalizacyjnym. Powód: ${reason}`);
                });
                
            } catch (error) {
                console.error(`[BŁĄD] Błąd inicjalizacji klienta: ${error.message}`);
                reject(error);
            }
        });
    }

    /**
     * Rejestracja urządzenia na serwerze sygnalizacyjnym
     * @param {string} name - Nazwa urządzenia
     */
    registerDevice(name) {
        this.deviceName = name;
        console.log(`[DEBUG] Rejestracja urządzenia: ${name}`);
        this.socket.emit('register-name', name);
    }

    /**
     * Obsługa przychodzącego sygnału WebRTC
     * @param {string} peerId - ID peera
     * @param {object} signal - Sygnał WebRTC
     */
    async handleIncomingSignal(peerId, signal) {
        try {
            console.log(`[DEBUG] Otrzymano sygnał od ${peerId}: ${signal.type || 'candidate'}`);
            
            // Wyślij potwierdzenie odebrania sygnału
            this.socket.emit('signal-received', { originPeerId: peerId });
            
            // Aktualizacja stanu połączenia
            this.updateConnectionState(peerId, 'signaling', { type: signal.type || 'candidate', direction: 'incoming' });
            
            // Jeśli sygnał to oferta, może być potrzebne utworzenie nowego połączenia
            if (signal.type === 'offer') {
                await this.handleOfferSignal(peerId, signal);
            } else {
                // Dla innych sygnałów, upewnij się że połączenie istnieje
                await this.handleRegularSignal(peerId, signal);
            }
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas przetwarzania sygnału: ${error.message}`);
            this.updateConnectionState(peerId, 'error', { error: error.message });
        }
    }

    /**
     * Obsługa sygnału typu 'offer'
     * @param {string} peerId - ID peera
     * @param {object} signal - Sygnał typu offer
     */
    async handleOfferSignal(peerId, signal) {
        console.log(`[DEBUG] Przetwarzanie sygnału offer od ${peerId}`);
        
        try {
            // Aktualizuj stan połączenia
            this.updateConnectionState(peerId, 'signaling', { type: 'offer' });
            
            // Jeśli jest aktywne połączenie, ale otrzymujemy ofertę, zamknij je i utwórz nowe
            if (this.activeConnections[peerId]) {
                console.log(`[DEBUG] Zamykanie istniejącego połączenia przed utworzeniem nowego dla ${peerId}`);
                this.cleanupConnection(peerId);
                
                // Krótkie opóźnienie przed utworzeniem nowego połączenia
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            
            // Tworzenie nowego połączenia jako odpowiadający (nie initiator)
            console.log(`[DEBUG] Tworzenie połączenia jako odpowiadający dla ${peerId}`);
            const connection = await this.createPeerConnection(peerId, false);
            
            // Przekazanie oferty do połączenia
            if (connection && typeof connection.signal === 'function') {
                console.log(`[DEBUG] Przekazywanie oferty do ${peerId}`);
                connection.signal(signal);
            } else {
                console.error(`[BŁĄD] Nie można przekazać oferty - brak połączenia lub metody signal`);
                this.updateConnectionState(peerId, 'error', { error: 'Brak połączenia lub metody signal' });
            }
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas obsługi oferty od ${peerId}: ${error.message}`);
            // Resetuj połączenie w przypadku błędu
            this.cleanupConnection(peerId);
            
            this.updateConnectionState(peerId, 'error', { error: error.message });
        }
    }

    /**
     * Obsługa standardowych sygnałów (nie-offer)
     * @param {string} peerId - ID peera
     * @param {object} signal - Sygnał WebRTC
     */
    async handleRegularSignal(peerId, signal) {
        try {
            // Aktualizacja stanu połączenia
            this.updateConnectionState(peerId, 'signaling', { type: signal.type || 'candidate' });
            
            // Sprawdź czy połączenie istnieje lub utwórz je, jeśli nie
            if (!this.activeConnections[peerId] && !this.isConnecting[peerId]) {
                console.log(`[DEBUG] Tworzenie nowego połączenia dla sygnału nie-offer od ${peerId}`);
                await this.createPeerConnection(peerId, false);
            }
            
            // Przekazanie sygnału do połączenia
            if (this.activeConnections[peerId] && typeof this.activeConnections[peerId].signal === 'function') {
                console.log(`[DEBUG] Przekazywanie sygnału ${signal.type || 'candidate'} do ${peerId}`);
                this.activeConnections[peerId].signal(signal);
            } else {
                console.warn(`[OSTRZEŻENIE] Nie można przekazać sygnału - połączenie nie jest gotowe`);
                // Dodaj opóźnienie przed ponowną próbą
                await new Promise(resolve => setTimeout(resolve, 500));
                
                // Spróbuj ponownie, jeśli połączenie jest już dostępne
                if (this.activeConnections[peerId] && typeof this.activeConnections[peerId].signal === 'function') {
                    this.activeConnections[peerId].signal(signal);
                }
            }
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas obsługi sygnału dla ${peerId}: ${error.message}`);
            this.updateConnectionState(peerId, 'error', { error: error.message });
        }
    }

    /**
     * Aktualizacja stanu połączenia i powiadamianie UI
     * @param {string} peerId - ID peera
     * @param {string} state - Nowy stan
     * @param {object} details - Szczegóły stanu
     */
    updateConnectionState(peerId, state, details = {}) {
        // Zachowaj poprzedni stan do porównania
        const previousState = this.connectionStates[peerId];
        
        // Aktualizuj stan połączenia
        this.connectionStates[peerId] = state;
        
        console.log(`[DEBUG] Zmiana stanu połączenia z ${peerId}: ${previousState || 'brak'} -> ${state}`);
        
        // Powiadom o zmianie stanu
        if (this.onConnectionStateChange && previousState !== state) {
            const peer = this.peers[peerId] || { id: peerId, name: 'Nieznane urządzenie' };
            this.onConnectionStateChange(peer, state, details);
        }
    }

    /**
     * Pobieranie konfiguracji serwerów ICE (STUN/TURN)
     * @returns {Promise<Array>} - Lista serwerów ICE
     */
    async getIceServers() {
        try {
            console.log('[DEBUG] Pobieranie serwerów ICE z serwera...');
            const startTime = Date.now();
            
            // Daj możliwość przerwania długotrwałego żądania
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
            
            const response = await fetch('/api/turn-credentials', {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Cache-Control': 'no-cache'
                },
                cache: 'no-store',
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            
            const responseTime = Date.now() - startTime;
            console.log(`[DEBUG] Otrzymano odpowiedź z serwera TURN w ${responseTime}ms`);
            
            if (!response.ok) {
                console.warn(`[OSTRZEŻENIE] Serwer zwrócił kod ${response.status}`);
                return this.getFallbackIceServers();
            }
            
            const data = await response.json();
            
            if (!Array.isArray(data) || data.length === 0) {
                console.warn('[OSTRZEŻENIE] Otrzymano nieprawidłowe dane z serwera TURN');
                return this.getFallbackIceServers();
            }
            
            console.log(`[DEBUG] Pobrano ${data.length} serwerów ICE`);
            
            return this.enhanceIceServers(data);
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas pobierania serwerów ICE: ${error.message}`);
            return this.getFallbackIceServers();
        }
    }

    /**
     * Dodaje dodatkowe serwery STUN do konfiguracji ICE
     * @param {Array} servers - Lista serwerów ICE
     * @returns {Array} - Rozszerzona lista serwerów ICE
     */
    enhanceIceServers(servers) {
        // Dodaj publiczne serwery STUN dla zwiększenia niezawodności
        const enhancedServers = [...servers, ...this.getPublicStunServers()];
        return enhancedServers;
    }

    /**
     * Zwraca listę publicznych serwerów STUN
     * @returns {Array} - Lista serwerów STUN
     */
    getPublicStunServers() {
        return [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
            { urls: 'stun:stun.ekiga.net' },
            { urls: 'stun:stun.ideasip.com' },
            { urls: 'stun:stun.schlund.de' }
        ];
    }

    /**
     * Zwraca awaryjne serwery ICE w przypadku problemu z pobraniem z serwera
     * @returns {Array} - Lista serwerów ICE
     */
    getFallbackIceServers() {
        console.log('[DEBUG] Używam awaryjnych, statycznych serwerów ICE');
        return [
            {
                urls: "stun:stun.relay.metered.ca:80"
            },
            {
                urls: "turn:global.relay.metered.ca:80",
                username: "041533025c7ee2fd11afa46e",
                credential: "NmredoIjnB5jEIWP"
            },
            {
                urls: "turn:global.relay.metered.ca:80?transport=tcp",
                username: "041533025c7ee2fd11afa46e",
                credential: "NmredoIjnB5jEIWP"
            },
            {
                urls: "turn:global.relay.metered.ca:443",
                username: "041533025c7ee2fd11afa46e",
                credential: "NmredoIjnB5jEIWP"
            },
            {
                urls: "turns:global.relay.metered.ca:443?transport=tcp",
                username: "041533025c7ee2fd11afa46e",
                credential: "NmredoIjnB5jEIWP"
            },
            ...this.getPublicStunServers()
        ];
    }

    /**
     * Tworzy połączenie WebRTC z peerem
     * @param {string} targetPeerId - ID peera docelowego
     * @param {boolean} isInitiator - Czy jesteśmy inicjatorem połączenia
     * @returns {Promise<RTCPeerConnection>} - Połączenie WebRTC
     */
    async createPeerConnection(targetPeerId, isInitiator = true) {
        try {
            console.log(`[DEBUG] Tworzenie połączenia peer z ${targetPeerId}, initiator: ${isInitiator}`);
            
            // Aktualizacja stanu
            this.updateConnectionState(targetPeerId, 'connecting', { isInitiator });
            
            // Oznacz, że rozpoczęto łączenie
            this.isConnecting[targetPeerId] = true;
            
            // Pobierz konfigurację ICE serwerów
            const iceServers = await this.getIceServers();
            
            // Aktualizacja stanu
            this.updateConnectionState(targetPeerId, 'configuring_ice');
            
            // Konfiguracja połączenia
            const peerConfig = {
                initiator: isInitiator,
                trickle: true,
                config: { 
                    iceServers: iceServers,
                    iceTransportPolicy: 'all',
                    sdpSemantics: 'unified-plan',
                    iceCandidatePoolSize: 10
                },
                channelConfig: {
                    ordered: true,
                    maxRetransmits: 30
                },
                channelName: 'sendfile'
            };
            
            // Sprawdzenie czy SimplePeer jest dostępny
            if (typeof SimplePeer !== 'function') {
                throw new Error('Biblioteka SimplePeer nie jest dostępna. Sprawdź, czy została poprawnie załadowana.');
            }
            
            // Aktualizacja stanu
            this.updateConnectionState(targetPeerId, 'creating_peer');
            
            // Tworzenie obiektu peer
            const peer = new SimplePeer(peerConfig);
            
            // Śledzenie stanu połączenia ICE
            let iceConnectionState = null;
            
            // Obsługa sygnałów WebRTC
            peer.on('signal', (data) => {
                console.log(`[DEBUG] Wysyłanie sygnału do ${targetPeerId}: typ=${data.type || 'candidate'}`);
                
                // Aktualizacja stanu
                this.updateConnectionState(targetPeerId, 'signaling', { 
                    type: data.type || 'candidate', 
                    direction: 'outgoing' 
                });
                
                if (this.socket && this.socket.connected) {
                    this.socket.emit('signal', {
                        peerId: targetPeerId,
                        signal: data
                    });
                } else {
                    console.error('[BŁĄD] Nie można wysłać sygnału - socket jest null lub rozłączony');
                    this.updateConnectionState(targetPeerId, 'error', { 
                        error: 'Nie można wysłać sygnału - socket jest null lub rozłączony' 
                    });
                }
            });
            
            // Obsługa błędów
            peer.on('error', (err) => {
                console.error(`[BŁĄD] Błąd połączenia peer (${targetPeerId}):`, err.message);
                
                // Raportuj stan połączenia
                console.error(`[BŁĄD] Stan połączenia: ICE=${iceConnectionState}`);
                
                // Aktualizacja stanu
                this.updateConnectionState(targetPeerId, 'error', { 
                    error: err.message,
                    iceState: iceConnectionState
                });
                
                // Resetuj połączenie
                this.cleanupConnection(targetPeerId);
            });
            
            // Obsługa nawiązania połączenia
            peer.on('connect', () => {
                console.log(`[DEBUG] Pomyślnie połączono z peerem: ${targetPeerId}`);
                
                delete this.isConnecting[targetPeerId]; // Usuń znacznik nawiązywania połączenia
                
                // Aktualizacja stanu
                this.updateConnectionState(targetPeerId, 'connected');
                
                // Sprawdź, czy mamy kanał danych
                if (peer._channel) {
                    console.log(`[DEBUG] Kanał danych jest dostępny po połączeniu z ${targetPeerId}`);
                    this.dataChannelStates[targetPeerId] = peer._channel.readyState;
                    this.updateConnectionState(targetPeerId, 'data_channel_ready', { 
                        state: peer._channel.readyState 
                    });
                } else {
                    console.warn(`[OSTRZEŻENIE] Połączenie nawiązane, ale brak kanału danych dla ${targetPeerId}`);
                    this.updateConnectionState(targetPeerId, 'no_data_channel');
                }
            });
            
            // Obsługa przychodzących danych
            peer.on('data', (data) => {
                try {
                    // Debug: raportuj rozmiar otrzymanych danych
                    const size = data.byteLength || data.length || (data.size ? data.size : 'nieznany');
                    console.log(`[DEBUG] Otrzymano dane od ${targetPeerId}, rozmiar: ${size} bajtów`);
                    
                    // Obsługa danych
                    this.handleIncomingData(targetPeerId, data);
                } catch (dataError) {
                    console.error(`[BŁĄD] Problem podczas obsługi otrzymanych danych: ${dataError.message}`);
                    this.updateConnectionState(targetPeerId, 'data_processing_error', { 
                        error: dataError.message 
                    });
                }
            });
            
            // Obsługa zamknięcia połączenia
            peer.on('close', () => {
                console.log(`[DEBUG] Zamknięto połączenie z peerem: ${targetPeerId}`);
                
                // Aktualizacja stanu
                this.updateConnectionState(targetPeerId, 'connection_closed');
                
                // Wyczyść połączenie
                this.cleanupConnection(targetPeerId);
            });
            
            // Dodatkowe monitorowanie stanu ICE
            peer.on('iceStateChange', (state) => {
                iceConnectionState = state;
                console.log(`[DEBUG] Zmiana stanu ICE dla ${targetPeerId}: ${state}`);
                
                // Aktualizacja stanu
                this.updateConnectionState(targetPeerId, 'ice_state_change', { iceState: state });
                
                // Obsługa różnych stanów ICE
                switch (state) {
                    case 'checking':
                        console.log(`[DEBUG] Sprawdzanie kandydatów ICE dla ${targetPeerId}`);
                        this.updateConnectionState(targetPeerId, 'ice_checking');
                        break;
                        
                    case 'connected':
                    case 'completed':
                        console.log(`[DEBUG] Połączenie ICE nawiązane dla ${targetPeerId}`);
                        this.updateConnectionState(targetPeerId, 'ice_connected');
                        break;
                        
                    case 'failed':
                        console.error(`[BŁĄD] Połączenie ICE nie powiodło się dla ${targetPeerId}`);
                        this.updateConnectionState(targetPeerId, 'ice_failed');
                        
                        if (this.onTransferError) {
                            this.onTransferError(targetPeerId, 'Nie udało się nawiązać połączenia ICE. Spróbuj ponownie później.');
                        }
                        break;
                        
                    case 'disconnected':
                        console.warn(`[OSTRZEŻENIE] Połączenie ICE rozłączone dla ${targetPeerId}`);
                        this.updateConnectionState(targetPeerId, 'ice_disconnected');
                        break;
                        
                    case 'closed':
                        console.log(`[DEBUG] Połączenie ICE zamknięte dla ${targetPeerId}`);
                        this.updateConnectionState(targetPeerId, 'ice_closed');
                        break;
                }
            });
            
            // Dodatkowe monitorowanie stanu WebRTC
            if (peer._pc) {
                // Obsługa zdarzenia datachannel
                peer._pc.ondatachannel = (event) => {
                    console.log(`[DEBUG] Otrzymano zdarzenie datachannel dla ${targetPeerId}`);
                    peer._channel = event.channel;
                    
                    // Aktualizacja stanu
                    this.updateConnectionState(targetPeerId, 'data_channel_received');
                    
                    event.channel.onopen = () => {
                        console.log(`[DEBUG] Kanał danych otwarty dla ${targetPeerId}`);
                        this.dataChannelStates[targetPeerId] = 'open';
                        this.updateConnectionState(targetPeerId, 'data_channel_open');
                    };
                    
                    event.channel.onclose = () => {
                        console.log(`[DEBUG] Kanał danych zamknięty dla ${targetPeerId}`);
                        this.dataChannelStates[targetPeerId] = 'closed';
                        this.updateConnectionState(targetPeerId, 'data_channel_closed');
                    };
                    
                    event.channel.onerror = (err) => {
                        console.error(`[BŁĄD] Błąd kanału danych dla ${targetPeerId}:`, err);
                        this.dataChannelStates[targetPeerId] = 'error';
                        this.updateConnectionState(targetPeerId, 'data_channel_error', { 
                            error: err.message || 'Nieznany błąd kanału danych'
                        });
                    };
                    
                    // Ważne: ustawienie odpowiednich właściwości kanału
                    event.channel.binaryType = 'arraybuffer';
                };
            }
            
            // Ustaw połączenie jako aktywne
            this.activeConnections[targetPeerId] = peer;
            
            // Timeout dla połączenia ICE, aby uniknąć zawieszenia
            const iceTimeoutTimer = setTimeout(() => {
                if (this.isConnecting[targetPeerId] && this.connectionStates[targetPeerId] !== 'connected') {
                    console.log(`[DEBUG] Timeout zbierania kandydatów ICE dla ${targetPeerId}`);
                    this.updateConnectionState(targetPeerId, 'ice_gathering_timeout');
                }
            }, this.iceTimeout);
            
            // Główny timeout całego połączenia
            const connectionTimeoutTimer = setTimeout(() => {
                if (this.isConnecting[targetPeerId] && this.connectionStates[targetPeerId] !== 'connected') {
                    console.error(`[BŁĄD] Przekroczono całkowity czas oczekiwania na połączenie z ${targetPeerId}`);
                    this.updateConnectionState(targetPeerId, 'connection_timeout');
                    
                    if (this.onTransferError) {
                        this.onTransferError(targetPeerId, 'Przekroczono czas oczekiwania na połączenie');
                    }
                    
                    this.cleanupConnection(targetPeerId);
                }
            }, this.connectionTimeout);
            
            // Czyszczenie timerów przy sukcesie połączenia
            peer.once('connect', () => {
                clearTimeout(iceTimeoutTimer);
                clearTimeout(connectionTimeoutTimer);
            });
            
            return peer;
        
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas tworzenia połączenia peer z ${targetPeerId}:`, error);
            delete this.isConnecting[targetPeerId];
            
            // Aktualizacja stanu
            this.updateConnectionState(targetPeerId, 'connection_error', { error: error.message });
            
            if (this.onTransferError) {
                this.onTransferError(targetPeerId, `Błąd konfiguracji: ${error.message}`);
            }
            throw error;
        }
    }

    /**
     * Czyszczenie i zamykanie połączenia
     * @param {string} targetPeerId - ID peera
     * @param {RTCPeerConnection} peerObject - Opcjonalny obiekt peer
     */
    cleanupConnection(targetPeerId, peerObject = null) {
        const peer = peerObject || this.activeConnections[targetPeerId];
        
        // Bezpiecznie zniszcz obiekt peer jeśli istnieje
        if (peer && typeof peer.destroy === 'function') {
            try {
                peer.destroy();
            } catch (err) {
                console.error('Błąd podczas niszczenia obiektu peer:', err);
            }
        }
        
        // Usuń z listy aktywnych połączeń
        delete this.activeConnections[targetPeerId];
        delete this.isConnecting[targetPeerId];
        delete this.connectionStates[targetPeerId];
        delete this.dataChannelStates[targetPeerId];
        
        // Wyczyść dane transferu
        if (this.currentTransfer && this.currentTransfer.peerId === targetPeerId) {
            this.currentTransfer = null;
        }

        // Usuń z kolejki transferu
        this.transferQueue = this.transferQueue.filter(item => item.peerId !== targetPeerId);
    }

    /**
     * Sprawdza czy połączenie jest gotowe do wysyłania wiadomości
     * @param {string} targetPeerId - ID peera
     * @returns {boolean} - Czy połączenie jest gotowe
     */
    isConnectionReady(targetPeerId) {
        // Najpierw sprawdź czy kanał danych jest gotowy
        if (this.activeConnections[targetPeerId] && 
            this.activeConnections[targetPeerId]._channel && 
            this.activeConnections[targetPeerId]._channel.readyState === 'open') {
            return true;
        }
        
        // Standardowa kontrola połączenia
        const isStandardReady = !!(this.activeConnections[targetPeerId] && 
                 !this.isConnecting[targetPeerId] &&
                 this.activeConnections[targetPeerId]._connected);
        
        // Sprawdź status połączenia
        const connectionState = this.connectionStates[targetPeerId];
        
        if ((isStandardReady || connectionState === 'connected') &&
            this.activeConnections[targetPeerId] && 
            this.activeConnections[targetPeerId]._channel) {
            return this.activeConnections[targetPeerId]._channel.readyState === 'open';
        }
        
        return false;
    }

    /**
     * Oczekiwanie na otwarcie kanału danych
     * @param {string} targetPeerId - ID peera
     * @param {number} timeout - Czas oczekiwania w ms
     * @returns {Promise<boolean>} - Czy kanał został otwarty
     */
    async waitForDataChannel(targetPeerId, timeout = 15000) {
        console.log(`[DEBUG] Oczekiwanie na gotowość kanału danych dla ${targetPeerId}...`);
        
        const startTime = Date.now();
        
        // Aktualizacja stanu
        this.updateConnectionState(targetPeerId, 'waiting_for_data_channel');
        
        return new Promise((resolve, reject) => {
            // Sprawdź czy kanał danych istnieje i jest otwarty
            const checkChannel = () => {
                // Sprawdź czy połączenie wciąż istnieje
                if (!this.activeConnections[targetPeerId]) {
                    this.updateConnectionState(targetPeerId, 'connection_closed');
                    reject(new Error('Połączenie zostało zamknięte podczas oczekiwania na kanał danych'));
                    return;
                }
                
                const dataChannel = this.activeConnections[targetPeerId]._channel;
                
                // Jeśli kanał danych istnieje i jest otwarty, zwróć sukces
                if (dataChannel && dataChannel.readyState === 'open') {
                    console.log(`[DEBUG] Kanał danych dla ${targetPeerId} jest gotowy`);
                    this.dataChannelStates[targetPeerId] = 'open';
                    this.updateConnectionState(targetPeerId, 'data_channel_open');
                    resolve(true);
                    return;
                }
                
                // Sprawdź, czy minął timeout
                if (Date.now() - startTime > timeout) {
                    console.warn(`[OSTRZEŻENIE] Timeout oczekiwania na otwarcie kanału danych dla ${targetPeerId}`);
                    this.updateConnectionState(targetPeerId, 'data_channel_timeout');
                    reject(new Error('Timeout oczekiwania na otwarcie kanału danych'));
                    return;
                }
                
                // Kontynuuj sprawdzanie
                setTimeout(checkChannel, 300);
            };
            
            checkChannel();
        });
    }

    /**
     * Wysłanie żądania transferu plików
     * @param {string} targetPeerId - ID peera docelowego
     * @param {FileList|Array} files - Lista plików do wysłania
     * @returns {Promise<boolean>} - Czy żądanie zostało wysłane
     */
    async requestFileTransfer(targetPeerId, files) {
        try {
            console.log(`[DEBUG] Wysyłanie żądania transferu ${files.length} plików do ${targetPeerId}`);
            
            // Aktualizacja stanu
            this.updateConnectionState(targetPeerId, 'requesting_transfer', {
                fileCount: files.length
            });
            
            // Sprawdź, czy jest aktywne połączenie i czy jest gotowe
            let connection = this.activeConnections[targetPeerId];
            let needNewConnection = !connection || !this.isConnectionReady(targetPeerId);
            
            if (needNewConnection) {
                console.log(`[DEBUG] Brak aktywnego połączenia z ${targetPeerId}, tworzę nowe połączenie`);
                
                // Aktualizacja stanu
                this.updateConnectionState(targetPeerId, 'creating_new_connection_for_transfer');
                
                // Wyczyść poprzednie połączenie, jeśli istnieje
                if (connection) {
                    this.cleanupConnection(targetPeerId, connection);
                }
                
                // Utwórz nowe połączenie
                connection = await this.createPeerConnection(targetPeerId, true);
                
                // Poczekaj na nawiązanie połączenia z timeoutem
                await new Promise((resolve, reject) => {
                    let connectionTimeout;
                    
                    // Funkcja sprawdzająca stan połączenia
                    const checkConnection = () => {
                        // Sprawdź czy połączenie zostało przerwane
                        if (!this.activeConnections[targetPeerId]) {
                            clearTimeout(connectionTimeout);
                            this.updateConnectionState(targetPeerId, 'connection_interrupted');
                            reject(new Error('Połączenie zostało zamknięte'));
                            return;
                        }
                        
                        // Sprawdź czy połączenie jest gotowe
                        if (this.activeConnections[targetPeerId]._connected || 
                           this.connectionStates[targetPeerId] === 'connected') {
                            clearTimeout(connectionTimeout);
                            console.log(`[DEBUG] Połączenie z ${targetPeerId} nawiązane`);
                            this.updateConnectionState(targetPeerId, 'ready_for_transfer_request');
                            resolve();
                            return;
                        }
                        
                        // Sprawdź stan połączenia co 500ms
                        setTimeout(checkConnection, 500);
                    };
                    
                    // Obsługa połączenia
                    const connectHandler = () => {
                        console.log(`[DEBUG] Pomyślnie nawiązano połączenie z ${targetPeerId}`);
                        clearTimeout(connectionTimeout);
                        if (connection.removeListener) {
                            connection.removeListener('connect', connectHandler);
                            connection.removeListener('error', errorHandler);
                        }
                        
                        // Aktualizacja stanu
                        this.updateConnectionState(targetPeerId, 'connection_established_for_transfer');
                        
                        resolve();
                    };
                    
                    // Obsługa błędu
                    const errorHandler = (err) => {
                        console.error(`[BŁĄD] Błąd podczas nawiązywania połączenia z ${targetPeerId}:`, err);
                        clearTimeout(connectionTimeout);
                        if (connection.removeListener) {
                            connection.removeListener('connect', connectHandler);
                            connection.removeListener('error', errorHandler);
                        }
                        
                        // Aktualizacja stanu
                        this.updateConnectionState(targetPeerId, 'connection_error_for_transfer', {
                            error: err.message || 'Nieznany błąd'
                        });
                        
                        reject(err);
                    };
                    
                    // Ustaw timeout
                    connectionTimeout = setTimeout(() => {
                        console.error(`[BŁĄD] Przekroczono czas oczekiwania na połączenie z ${targetPeerId}`);
                        if (connection.removeListener) {
                            connection.removeListener('connect', connectHandler);
                            connection.removeListener('error', errorHandler);
                        }
                        
                        // Aktualizacja stanu
                        this.updateConnectionState(targetPeerId, 'connection_timeout_for_transfer');
                        reject(new Error('Przekroczono czas oczekiwania na połączenie'));
                    }, this.connectionTimeout);
                    
                    // Rozpocznij sprawdzanie połączenia
                    checkConnection();
                    
                    // Dodaj obserwatory zdarzeń, jeśli dostępne
                    if (connection.once) {
                        connection.once('connect', connectHandler);
                        connection.once('error', errorHandler);
                    }
                });
            }
            
            // Oczekiwanie na otwarcie kanału danych
            try {
                // Aktualizacja stanu
                this.updateConnectionState(targetPeerId, 'waiting_for_data_channel');
                
                await this.waitForDataChannel(targetPeerId, 20000);
                
                // Aktualizacja stanu
                this.updateConnectionState(targetPeerId, 'data_channel_ready_for_transfer');
            } catch (channelError) {
                console.warn(`[OSTRZEŻENIE] ${channelError.message}, próbuję mimo to...`);
                
                // Aktualizacja stanu
                this.updateConnectionState(targetPeerId, 'data_channel_error_trying_manual', {
                    error: channelError.message
                });
                
                // Spróbujmy jeszcze raz z małym opóźnieniem
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                if (!this.isConnectionReady(targetPeerId)) {
                    throw new Error('Kanał danych nie jest gotowy. Spróbuj ponownie później.');
                }
            }
            
            // Zabezpieczenie - sprawdź, czy połączenie jest wciąż aktywne
            if (!this.activeConnections[targetPeerId]) {
                this.updateConnectionState(targetPeerId, 'connection_lost_before_request');
                throw new Error('Połączenie zostało zamknięte w trakcie procesu nawiązywania');
            }
            
            connection = this.activeConnections[targetPeerId];
            
            // Upewnij się, że kanał danych istnieje i jest otwarty
            if (!connection._channel || connection._channel.readyState !== 'open') {
                this.updateConnectionState(targetPeerId, 'data_channel_not_ready', {
                    readyState: connection._channel ? connection._channel.readyState : 'brak kanału'
                });
                
                throw new Error(`Kanał danych nie jest gotowy (${connection._channel ? connection._channel.readyState : 'brak kanału'})`);
            }
            
            // Przygotowanie żądania transferu plików
            const filesMetadata = Array.from(files).map(file => ({
                name: file.name,
                type: file.type,
                size: file.size,
                id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
            }));
            
            const totalSize = filesMetadata.reduce((sum, file) => sum + file.size, 0);
            
            try {
                // Wyślij żądanie transferu plików
                console.log(`[DEBUG] Wysyłanie żądania transferu do ${targetPeerId}`);
                
                // Aktualizacja stanu
                this.updateConnectionState(targetPeerId, 'sending_transfer_request', {
                    fileCount: files.length,
                    totalSize: totalSize
                });
                
                const requestData = {
                    type: 'request-transfer',
                    files: filesMetadata,
                    totalSize: totalSize,
                    senderName: this.deviceName
                };
                
                // Wyślij żądanie przez kanał danych
                connection._channel.send(JSON.stringify(requestData));
                
                console.log(`[DEBUG] Pomyślnie wysłano żądanie transferu plików do ${targetPeerId}`);
                
                // Aktualizacja stanu
                this.updateConnectionState(targetPeerId, 'waiting_for_transfer_response');
                
                // Zapisz pliki do tymczasowej kolejki oczekując na odpowiedź
                this.pendingTransfers[targetPeerId] = {
                    files: files,
                    filesMetadata: filesMetadata,
                    timestamp: Date.now()
                };
                
                // Rozpocznij timeout dla oczekiwania na odpowiedź (30 sekund)
                setTimeout(() => {
                    if (this.pendingTransfers[targetPeerId]) {
                        console.log(`[DEBUG] Timeout oczekiwania na odpowiedź od ${targetPeerId}`);
                        
                        // Aktualizacja stanu
                        this.updateConnectionState(targetPeerId, 'transfer_request_timeout');
                        
                        delete this.pendingTransfers[targetPeerId];
                        if (this.onTransferError) {
                            this.onTransferError(targetPeerId, 'Nie otrzymano odpowiedzi na żądanie transferu');
                        }
                    }
                }, 30000);
                
                return true;
            } catch (error) {
                console.error(`[BŁĄD] Błąd podczas wysyłania żądania transferu: ${error.message}`);
                
                // Aktualizacja stanu
                this.updateConnectionState(targetPeerId, 'transfer_request_error', {
                    error: error.message
                });
                
                throw new Error('Błąd podczas wysyłania żądania transferu: ' + error.message);
            }
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas przygotowania żądania transferu plików: ${error.message}`);
            
            // Aktualizacja stanu
            this.updateConnectionState(targetPeerId, 'transfer_setup_error', {
                error: error.message
            });
            
            if (this.onTransferError) {
                this.onTransferError(targetPeerId, error.message);
            }
            throw error;
        }
    }

    /**
     * Odpowiedź na żądanie transferu plików
     * @param {string} peerId - ID peera
     * @param {boolean} accepted - Czy zaakceptowano żądanie
     * @returns {boolean} - Czy odpowiedź została wysłana
     */
    respondToTransferRequest(peerId, accepted) {
        try {
            // Aktualizacja stanu
            this.updateConnectionState(peerId, accepted ? 'accepting_transfer' : 'rejecting_transfer');
            
            if (!this.isConnectionReady(peerId)) {
                console.warn(`[OSTRZEŻENIE] Próba odpowiedzi na żądanie transferu bez gotowego połączenia (stan: ${this.connectionStates[peerId]})`);
                throw new Error('Brak aktywnego połączenia z peerem');
            }
            
            const connection = this.activeConnections[peerId];
            
            // Wyślij odpowiedź
            connection._channel.send(JSON.stringify({
                type: accepted ? 'accept-transfer' : 'reject-transfer'
            }));
            
            console.log(`[DEBUG] Pomyślnie wysłano ${accepted ? 'akceptację' : 'odrzucenie'} transferu do ${peerId}`);
            
            // Aktualizacja stanu
            this.updateConnectionState(peerId, accepted ? 'transfer_accepted' : 'transfer_rejected');
            
            return true;
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas odpowiadania na żądanie transferu: ${error.message}`);
            
            // Aktualizacja stanu
            this.updateConnectionState(peerId, 'transfer_response_error', {
                error: error.message
            });
            
            if (this.onTransferError) {
                this.onTransferError(peerId, error.message);
            }
            return false;
        }
    }

    /**
     * Wysłanie plików do określonego peera
     * @param {string} targetPeerId - ID peera docelowego
     * @param {FileList|Array} files - Lista plików do wysłania
     * @returns {Promise<boolean>} - Czy transfer został zainicjowany
     */
    async sendFiles(targetPeerId, files) {
        try {
            // Aktualizacja stanu
            this.updateConnectionState(targetPeerId, 'initiating_file_transfer', {
                fileCount: files.length
            });
            
            // Najpierw wyślij żądanie transferu
            await this.requestFileTransfer(targetPeerId, files);
            
            // Faktyczny transfer plików zostanie rozpoczęty po otrzymaniu akceptacji
            // Obsługa w handleIncomingData dla wiadomości 'accept-transfer'
            
            return true;
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas inicjowania wysyłania plików: ${error.message}`);
            
            // Aktualizacja stanu
            this.updateConnectionState(targetPeerId, 'file_transfer_init_error', {
                error: error.message
            });
            
            if (this.onTransferError) {
                this.onTransferError(targetPeerId, error.message);
            }
            throw error;
        }
    }

    /**
     * Obliczanie optymalnego opóźnienia dla fragmentów
     * @param {number} bytesPerSecond - Aktualna prędkość transferu
     * @param {number} failureCount - Liczba niepowodzeń
     * @returns {number} - Opóźnienie w ms
     */
    calculateChunkDelay(bytesPerSecond, failureCount) {
        if (!this.adaptiveChunkDelay) {
            return this.baseChunkDelay; // Stałe opóźnienie, jeśli adaptacja jest wyłączona
        }
        
        // Bazowe opóźnienie: 5ms
        let delay = this.baseChunkDelay;
        
        // Zwiększ opóźnienie dla wolniejszych połączeń
        if (bytesPerSecond < 100000) { // < 100 KB/s
            delay = 30;
        } else if (bytesPerSecond < 500000) { // < 500 KB/s
            delay = 15;
        }
        
        // Zwiększ opóźnienie po błędach transferu
        if (failureCount > 0) {
            // Wykładnicze zwiększanie opóźnienia
            delay = delay * Math.pow(1.5, failureCount);
        }
        
        // Limituj maksymalne opóźnienie do 100ms
        return Math.min(delay, 100);
    }

    /**
     * Przetwarzanie kolejnego pliku z kolejki transferu
     */
    async processNextTransfer() {
        if (this.transferQueue.length === 0) {
            console.log('[DEBUG] Kolejka transferu jest pusta');
            this.currentTransfer = null;
            return;
        }
        
        this.currentTransfer = this.transferQueue.shift();
        const { peerId, file, fileId } = this.currentTransfer;
        
        console.log(`[DEBUG] Rozpoczynam transfer pliku "${file.name}" (${this.formatFileSize(file.size)}) do ${peerId}`);
        
        // Aktualizacja stanu
        this.updateConnectionState(peerId, 'starting_file_transfer', {
            fileName: file.name,
            fileSize: file.size,
            fileId: fileId
        });
        
        try {
            // Sprawdź, czy połączenie istnieje i jest gotowe
            if (!this.isConnectionReady(peerId)) {
                console.error(`[BŁĄD] Brak aktywnego połączenia z peerem ${peerId}`);
                
                // Aktualizacja stanu
                this.updateConnectionState(peerId, 'no_connection_for_transfer');
                
                // Dodaj z powrotem do kolejki na późniejszą próbę lub powiadom o błędzie
                this.transferQueue.unshift(this.currentTransfer);
                this.currentTransfer = null;
                
                if (this.onTransferError) {
                    this.onTransferError(peerId, `Nie można nawiązać połączenia`);
                }
                
                return;
            }
            
            const connection = this.activeConnections[peerId];
            
            // Licznik fragmentów dla potrzeb debugowania
            let chunkCounter = 0;
            let failureCount = 0;
            
            // Przygotuj śledzenie potwierdzeń chunków
            if (this.ackEnabled) {
                if (!this.pendingAcks[peerId]) {
                    this.pendingAcks[peerId] = {};
                }
                this.pendingAcks[peerId][fileId] = new Set();
            }
            
            const reader = new FileReader();
            let offset = 0;
            let lastUpdateTime = Date.now();
            let lastOffset = 0;
            let bytesPerSecond = 0; // Śledzone dla adaptacyjnego opóźnienia
            
            // Informacja o rozpoczęciu transferu
            try {
                console.log(`[DEBUG] Wysyłanie informacji o rozpoczęciu transferu pliku "${file.name}" do ${peerId}`);
                
                // Aktualizacja stanu
                this.updateConnectionState(peerId, 'sending_file_start_info', {
                    fileName: file.name
                });
                
                // Wyślij informację o rozpoczęciu przesyłania pliku
                connection._channel.send(JSON.stringify({
                    type: 'start-file',
                    name: file.name,
                    size: file.size,
                    type: file.type,
                    fileId: fileId
                }));
                
                // Dodaj opóźnienie, aby upewnić się, że wiadomość start-file dotrze przed fragmentami
                await new Promise(resolve => setTimeout(resolve, 500));
                console.log(`[DEBUG] Rozpoczynam wysyłanie fragmentów pliku do ${peerId}`);
                
                // Aktualizacja stanu
                this.updateConnectionState(peerId, 'sending_file_chunks', {
                    fileName: file.name
                });
                
            } catch (error) {
                console.error(`[BŁĄD] Błąd podczas wysyłania informacji o rozpoczęciu transferu: ${error.message}`);
                
                // Aktualizacja stanu
                this.updateConnectionState(peerId, 'file_start_info_error', {
                    error: error.message
                });
                
                if (this.onTransferError) {
                    this.onTransferError(peerId, `Błąd podczas rozpoczęcia transferu: ${error.message}`);
                }
                this.processNextTransfer();
                return;
            }
            
            // Funkcja do odczytu następnego fragmentu pliku
            const readNextChunk = () => {
                // Sprawdź, czy połączenie jest wciąż aktywne
                if (!this.isConnectionReady(peerId)) {
                    console.error(`[BŁĄD] Połączenie z ${peerId} zostało zamknięte w trakcie transferu`);
                    
                    // Aktualizacja stanu
                    this.updateConnectionState(peerId, 'connection_lost_during_transfer');
                    
                    if (this.onTransferError) {
                        this.onTransferError(peerId, 'Połączenie zostało zamknięte w trakcie transferu');
                    }
                    
                    // Przejdź do następnego transferu
                    this.processNextTransfer();
                    return;
                }
                
                // Logowanie co 100 fragmentów dla dużych plików
                if (chunkCounter % 100 === 0) {
                    console.log(`[DEBUG] Odczytywanie fragmentu ${chunkCounter}, offset: ${offset}/${file.size}`);
                    
                    // Aktualizacja stanu co 100 fragmentów
                    this.updateConnectionState(peerId, 'sending_file_progress', {
                        fileName: file.name,
                        chunkCounter: chunkCounter,
                        offset: offset,
                        totalSize: file.size,
                        percentage: Math.round((offset / file.size) * 100)
                    });
                }
                
                try {
                    const slice = file.slice(offset, offset + this.chunkSize);
                    reader.readAsArrayBuffer(slice);
                    chunkCounter++;
                } catch (error) {
                    console.error(`[BŁĄD] Błąd podczas odczytu fragmentu pliku: ${error.message}`);
                    
                    // Aktualizacja stanu
                    this.updateConnectionState(peerId, 'file_chunk_read_error', {
                        error: error.message
                    });
                    
                    if (this.onTransferError) {
                        this.onTransferError(peerId, `Błąd odczytu pliku: ${error.message}`);
                    }
                    this.processNextTransfer();
                }
            };
            
            // Obsługa wczytania fragmentu pliku
            reader.onload = (e) => {
                try {
                    // Sprawdź, czy połączenie jest wciąż aktywne
                    if (!this.isConnectionReady(peerId)) {
                        throw new Error(`Połączenie z ${peerId} zostało zamknięte w trakcie transferu`);
                    }
                    
                    const chunk = e.target.result;
                    
                    // Zabezpieczenie - sprawdź, czy otrzymano dane
                    if (!chunk || chunk.byteLength === 0) {
                        console.warn(`[OSTRZEŻENIE] Pusty fragment pliku przy offset ${offset}`);
                        // Kontynuuj mimo to
                        offset += this.chunkSize;
                        if (offset < file.size) {
                            readNextChunk();
                        } else {
                            finishTransfer();
                        }
                        return;
                    }
                    
                    // Obliczenie adaptacyjnego opóźnienia dla fragmentu
                    const chunkDelay = this.calculateChunkDelay(bytesPerSecond, failureCount);
                    
                    // Dodaj metadane do fragmentu
                    const chunkHeader = JSON.stringify({
                        type: 'file-chunk',
                        fileId: fileId,
                        chunkIndex: chunkCounter - 1,
                        offset: offset,
                        size: chunk.byteLength
                    });
                    
                    // Funkcja wysyłająca fragment
                    const sendChunk = () => {
                        try {
                            // Dodajemy do śledzenia potwierdzeń
                            if (this.ackEnabled) {
                                this.pendingAcks[peerId][fileId].add(chunkCounter - 1);
                                
                                // Ustawiamy timeout dla oczekiwania na potwierdzenie
                                setTimeout(() => {
                                    // Jeśli nadal oczekujemy na potwierdzenie tego fragmentu
                                    if (this.pendingAcks[peerId] && 
                                        this.pendingAcks[peerId][fileId] && 
                                        this.pendingAcks[peerId][fileId].has(chunkCounter - 1)) {
                                        
                                        console.warn(`[OSTRZEŻENIE] Brak potwierdzenia dla fragmentu ${chunkCounter - 1} pliku ${fileId}`);
                                        
                                        // Dodaj do kolejki ponownego wysłania, jeśli połączenie wciąż istnieje
                                        if (this.isConnectionReady(peerId)) {
                                            if (!this.retryChunks[peerId]) {
                                                this.retryChunks[peerId] = {};
                                            }
                                            if (!this.retryChunks[peerId][fileId]) {
                                                this.retryChunks[peerId][fileId] = [];
                                            }
                                            
                                            // Zapisz dane fragmentu i jego metadane
                                            this.retryChunks[peerId][fileId].push({
                                                chunk: new Uint8Array(chunk),
                                                chunkIndex: chunkCounter - 1,
                                                offset: offset
                                            });
                                        }
                                    }
                                }, this.ackTimeout);
                            }
                            
                            // Wysłanie nagłówka fragmentu
                            connection._channel.send(chunkHeader);
                            
                            // Krótkie opóźnienie między nagłówkiem a danymi
                            setTimeout(() => {
                                connection._channel.send(chunk);
                            }, 5);
                            
                            offset += chunk.byteLength;
                            const progress = Math.min(100, Math.floor((offset / file.size) * 100));
                            
                            // Obliczenie prędkości transferu
                            const now = Date.now();
                            const timeDiff = now - lastUpdateTime;
                            
                            if (timeDiff > 500) { // Aktualizuj co pół sekundy
                                bytesPerSecond = ((offset - lastOffset) / timeDiff) * 1000;
                                lastUpdateTime = now;
                                lastOffset = offset;
                                
                                // Logowanie co 10% postępu
                                if (progress % 10 === 0 || progress === 100) {
                                    console.log(
                                        `[DEBUG] Postęp transferu: ${progress}%, prędkość: ${this.formatFileSize(bytesPerSecond)}/s, ` +
                                        `opóźnienie fragmentu: ${chunkDelay}ms`
                                    );
                                }
                                
                                // Aktualizacja postępu
                                if (this.onTransferProgress) {
                                    this.onTransferProgress(peerId, file, progress, offset, false, bytesPerSecond);
                                }
                            }
                            
                            if (offset < file.size) {
                                // Używamy adaptacyjnego opóźnienia
                                setTimeout(readNextChunk, chunkDelay);
                            } else {
                                finishTransfer();
                            }
                            
                            // Resetuj licznik błędów jeśli udało się wysłać fragmenty
                            failureCount = 0;
                            
                        } catch (sendError) {
                            failureCount++;
                            console.error(`[BŁĄD] Błąd podczas wysyłania fragmentu: ${sendError.message}`);
                            
                            // Aktualizacja stanu
                            this.updateConnectionState(peerId, 'chunk_send_error', {
                                error: sendError.message,
                                attempt: failureCount
                            });
                            
                            if (failureCount > 5) {
                                console.error(`[BŁĄD] Zbyt wiele błędów wysyłania (${failureCount}), przerywam transfer`);
                                throw sendError;
                            }
                            
                            // Zwiększamy opóźnienie przy błędach
                            console.log(`[DEBUG] Błąd wysyłania, ponawiam za chwilę (próba ${failureCount})`);
                            setTimeout(() => {
                                // Nie zmieniamy offsetu, próbujemy ponownie ten sam fragment
                                sendChunk();
                            }, 1000 * failureCount); // Zwiększamy opóźnienie przy kolejnych błędach
                        }
                    };
                    
                    // Wysyłamy z adaptacyjnym opóźnieniem
                    setTimeout(sendChunk, chunkDelay);
                    
                } catch (error) {
                    console.error(`[BŁĄD] Błąd podczas wysyłania danych: ${error.message}`);
                    
                    // Aktualizacja stanu
                    this.updateConnectionState(peerId, 'data_send_error', {
                        error: error.message
                    });
                    
                    if (this.onTransferError) {
                        this.onTransferError(peerId, `Błąd podczas wysyłania danych: ${error.message}`);
                    }
                    this.processNextTransfer();
                }
            };
            
            // Obsługa błędu odczytu pliku
            reader.onerror = (error) => {
                console.error(`[BŁĄD] Błąd odczytu pliku:`, error);
                
                // Aktualizacja stanu
                this.updateConnectionState(peerId, 'file_read_error', {
                    error: error.message || 'Nieznany błąd'
                });
                
                if (this.onTransferError) {
                    this.onTransferError(peerId, `Błąd odczytu pliku: ${error.message || 'Nieznany błąd'}`);
                }
                this.processNextTransfer();
            };
            
            // Funkcja kończąca transfer
            const finishTransfer = () => {
                console.log(`[DEBUG] Transfer pliku "${file.name}" zakończony, wysyłanie sygnału końca pliku`);
                
                // Aktualizacja stanu
                this.updateConnectionState(peerId, 'file_transfer_completed', {
                    fileName: file.name
                });
                
                // Sprawdź, czy są fragmenty do ponownego wysłania
                const handleRetry = () => {
                    if (this.retryChunks[peerId] && 
                        this.retryChunks[peerId][fileId] && 
                        this.retryChunks[peerId][fileId].length > 0) {
                        
                        console.log(`[DEBUG] Ponowne wysyłanie ${this.retryChunks[peerId][fileId].length} fragmentów`);
                        
                        // Aktualizacja stanu
                        this.updateConnectionState(peerId, 'retrying_chunks', {
                            fileName: file.name,
                            chunkCount: this.retryChunks[peerId][fileId].length
                        });
                        
                        // Wysyłamy fragmenty ponownie, jeden po drugim z opóźnieniem
                        const retryNextChunk = () => {
                            if (!this.retryChunks[peerId] || 
                                !this.retryChunks[peerId][fileId] || 
                                this.retryChunks[peerId][fileId].length === 0) {
                                // Wszystkie fragmenty zostały ponownie wysłane
                                sendEndFileSignal();
                                return;
                            }
                            
                            const retryItem = this.retryChunks[peerId][fileId].shift();
                            
                            try {
                                if (this.isConnectionReady(peerId)) {
                                    // Wysyłanie nagłówka fragmentu
                                    const retryHeader = JSON.stringify({
                                        type: 'file-chunk-retry',
                                        fileId: fileId,
                                        chunkIndex: retryItem.chunkIndex,
                                        offset: retryItem.offset,
                                        size: retryItem.chunk.byteLength
                                    });
                                    
                                    connection._channel.send(retryHeader);
                                    // Krótkie opóźnienie między nagłówkiem a danymi
                                    setTimeout(() => {
                                        connection._channel.send(retryItem.chunk);
                                    }, 5);
                                    
                                    // Kontynuuj z kolejnym fragmentem po opóźnieniu
                                    setTimeout(retryNextChunk, 50);
                                } else {
                                    console.error(`[BŁĄD] Połączenie z ${peerId} nie jest gotowe do ponownego wysłania fragmentów`);
                                    sendEndFileSignal();
                                }
                            } catch (error) {
                                console.error(`[BŁĄD] Błąd podczas ponownego wysyłania fragmentu: ${error.message}`);
                                // Kontynuuj mimo błędów
                                setTimeout(retryNextChunk, 50);
                            }
                        };
                        
                        // Rozpocznij proces ponownego wysyłania
                        retryNextChunk();
                    } else {
                        // Nie ma fragmentów do ponownego wysłania
                        sendEndFileSignal();
                    }
                };
                
                // Funkcja do wysłania sygnału końca pliku
                const sendEndFileSignal = () => {
                    // Zakończenie transferu tego pliku z opóźnieniem
                    // aby upewnić się, że wszystkie fragmenty dotarły
                    setTimeout(() => {
                        try {
                            // Aktualizacja stanu
                            this.updateConnectionState(peerId, 'sending_end_file_signal', {
                                fileName: file.name
                            });
                            
                            // Wyślij sygnał końca pliku
                            connection._channel.send(JSON.stringify({
                                type: 'end-file',
                                name: file.name,
                                fileId: fileId
                            }));
                            
                            console.log(`[DEBUG] Sygnał końca pliku wysłany do ${peerId}`);
                            
                            // Wyczyść dane śledzenia transferu pliku
                            if (this.pendingAcks[peerId] && this.pendingAcks[peerId][fileId]) {
                                delete this.pendingAcks[peerId][fileId];
                            }
                            
                            if (this.retryChunks[peerId] && this.retryChunks[peerId][fileId]) {
                                delete this.retryChunks[peerId][fileId];
                            }
                            
                            if (this.onTransferComplete) {
                                this.onTransferComplete(peerId, file);
                            }
                            
                            // Przejdź do kolejnego pliku w kolejce
                            this.processNextTransfer();
                        } catch (error) {
                            console.error(`[BŁĄD] Błąd podczas wysyłania sygnału końca pliku: ${error.message}`);
                            
                            // Aktualizacja stanu
                            this.updateConnectionState(peerId, 'end_file_signal_error', {
                                error: error.message
                            });
                            
                            if (this.onTransferError) {
                                this.onTransferError(peerId, `Błąd podczas kończenia transferu: ${error.message}`);
                            }
                            this.processNextTransfer();
                        }
                    }, 1000);
                };
                
                // Sprawdź, czy są fragmenty do ponownego wysłania
                handleRetry();
            };
            
            // Rozpocznij proces odczytu
            readNextChunk();
            
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas przetwarzania transferu: ${error.message}`);
            
            // Aktualizacja stanu
            this.updateConnectionState(peerId, 'transfer_processing_error', {
                error: error.message
            });
            
            if (this.onTransferError) {
                this.onTransferError(peerId, error.message);
            }
            this.processNextTransfer();
        }
    }

    /**
     * Potwierdzenie odbioru fragmentu pliku
     * @param {string} peerId - ID peera
     * @param {string} fileId - ID pliku
     * @param {number} chunkIndex - Indeks fragmentu
     * @returns {boolean} - Czy potwierdzenie zostało wysłane
     */
    sendAcknowledgment(peerId, fileId, chunkIndex) {
        try {
            if (!this.isConnectionReady(peerId)) {
                console.warn(`[OSTRZEŻENIE] Nie można wysłać potwierdzenia - połączenie nie jest gotowe`);
                return false;
            }
            
            const connection = this.activeConnections[peerId];
            const ackData = {
                type: 'chunk-ack',
                fileId: fileId,
                chunkIndex: chunkIndex
            };
            
            // Wyślij potwierdzenie
            connection._channel.send(JSON.stringify(ackData));
            
            return true;
        } catch (error) {
            console.error(`[BŁĄD] Nie udało się wysłać potwierdzenia: ${error.message}`);
            return false;
        }
    }

    /**
     * Anulowanie transferu
     * @param {string} peerId - ID peera
     * @returns {boolean} - Czy anulowanie się powiodło
     */
    cancelTransfer(peerId) {
        console.log(`[DEBUG] Anulowanie transferu dla ${peerId}`);
        
        try {
            // Aktualizacja stanu
            this.updateConnectionState(peerId, 'cancelling_transfer');
            
            if (this.isConnectionReady(peerId)) {
                // Wyślij wiadomość o anulowaniu transferu
                this.activeConnections[peerId]._channel.send(JSON.stringify({
                    type: 'cancel-transfer'
                }));
            }
            
            // Usuń wszystkie transfery dla tego peera z kolejki
            this.transferQueue = this.transferQueue.filter(item => item.peerId !== peerId);
            
            // Jeśli bieżący transfer jest dla tego peera, przejdź do następnego
            if (this.currentTransfer && this.currentTransfer.peerId === peerId) {
                this.currentTransfer = null;
                this.processNextTransfer();
            }
            
            // Wyczyść pozostałe dane transferu
            if (this.pendingAcks[peerId]) {
                delete this.pendingAcks[peerId];
            }
            
            if (this.retryChunks[peerId]) {
                delete this.retryChunks[peerId];
            }
            
            // Aktualizacja stanu
            this.updateConnectionState(peerId, 'transfer_cancelled');
            
            return true;
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas anulowania transferu: ${error.message}`);
            
            // Aktualizacja stanu
            this.updateConnectionState(peerId, 'cancel_transfer_error', {
                error: error.message
            });
            
            return false;
        }
    }

    /**
     * Sprawdzenie czy dane są binarne
     * @param {*} data - Dane do sprawdzenia
     * @returns {boolean} - Czy dane są binarne
     */
    isBinaryData(data) {
        return data instanceof ArrayBuffer || 
               data instanceof Uint8Array || 
               data instanceof Blob ||
               (typeof Buffer !== 'undefined' && data instanceof Buffer) ||
               (data && typeof data === 'object' && data.constructor && 
                (data.constructor.name === 'ArrayBuffer' || 
                 data.constructor.name === 'Uint8Array' || 
                 data.constructor.name === 'Blob' || 
                 data.constructor.name === 'Buffer'));
    }

    /**
     * Obsługa przychodzących danych
     * @param {string} peerId - ID peera
     * @param {*} data - Odebrane dane
     */
    handleIncomingData(peerId, data) {
        try {
            // Sprawdź, czy dane są binarne
            if (this.isBinaryData(data)) {
                console.log(`[DEBUG] Otrzymano dane binarne od ${peerId}, rozmiar: ${data.byteLength || data.size || 'nieznany'}`);
                
                // Jeśli mamy oczekujący nagłówek fragmentu, przetworzymy otrzymane dane binarne
                if (this.lastChunkHeader && this.lastChunkHeader.peerId === peerId) {
                    const header = this.lastChunkHeader.data;
                    this.lastChunkHeader = null; // Reset aby zapobiec ponownemu użyciu
                    
                    // Jeśli to fragment pliku ale nie mamy aktywnego transferu, zainicjuj go
                    if ((header.type === 'file-chunk' || header.type === 'file-chunk-retry') && !this.currentReceivingFile) {
                        console.warn(`[OSTRZEŻENIE] Otrzymano fragment pliku bez aktywnego transferu od ${peerId}`);
                        return;
                    }
                    
                    // Obsługa standardowego fragmentu
                    if (header.type === 'file-chunk' || header.type === 'file-chunk-retry') {
                        // Dodaj fragment do rejestru
                        if (!this.receivedChunksRegistry[peerId]) {
                            this.receivedChunksRegistry[peerId] = {};
                        }
                        
                        if (!this.receivedChunksRegistry[peerId][header.fileId]) {
                            this.receivedChunksRegistry[peerId][header.fileId] = new Set();
                        }
                        
                        // Sprawdź, czy ten fragment już otrzymaliśmy
                        if (!this.receivedChunksRegistry[peerId][header.fileId].has(header.chunkIndex)) {
                            // Dodaj fragment do rejestru przetworzonych fragmentów
                            this.receivedChunksRegistry[peerId][header.fileId].add(header.chunkIndex);
                            
                            // Zapisz fragment pliku
                            this.currentReceivingFile.chunks.push(data);
                            this.currentReceivingFile.receivedSize += (data.byteLength || data.size || 0);
                            
                            // Wyślij potwierdzenie odbioru, jeśli włączone
                            if (this.ackEnabled) {
                                this.sendAcknowledgment(peerId, header.fileId, header.chunkIndex);
                            }
                            
                            // Oblicz i zaktualizuj postęp
                            const progress = Math.min(100, Math.floor((this.currentReceivingFile.receivedSize / this.currentReceivingFile.size) * 100));
                            
                            // Oblicz prędkość transferu
                            const now = Date.now();
                            if (!this.currentReceivingFile.lastUpdateTime) {
                                this.currentReceivingFile.lastUpdateTime = now;
                                this.currentReceivingFile.lastReceivedSize = 0;
                            }
                            
                            const timeDiff = now - this.currentReceivingFile.lastUpdateTime;
                            if (timeDiff > 500) { // Aktualizuj co pół sekundy
                                const bytesPerSecond = ((this.currentReceivingFile.receivedSize - this.currentReceivingFile.lastReceivedSize) / timeDiff) * 1000;
                                this.currentReceivingFile.lastUpdateTime = now;
                                this.currentReceivingFile.lastReceivedSize = this.currentReceivingFile.receivedSize;
                                
                                console.log(`[DEBUG] Postęp odbierania ${this.currentReceivingFile.name}: ${progress}%, prędkość: ${this.formatFileSize(bytesPerSecond)}/s`);
                                
                                // Aktualizacja stanu transferu
                                this.updateConnectionState(peerId, 'receiving_file_progress', {
                                    fileName: this.currentReceivingFile.name,
                                    progress: progress,
                                    speed: bytesPerSecond
                                });
                                
                                if (this.onTransferProgress) {
                                    this.onTransferProgress(
                                        peerId,
                                        {
                                            name: this.currentReceivingFile.name,
                                            size: this.currentReceivingFile.size,
                                            type: this.currentReceivingFile.type
                                        },
                                        progress,
                                        this.currentReceivingFile.receivedSize,
                                        true, // isReceiving
                                        bytesPerSecond
                                    );
                                }
                            }
                        } else {
                            console.log(`[DEBUG] Pominięto duplikat fragmentu ${header.chunkIndex} pliku ${header.fileId}`);
                        }
                    } else {
                        console.warn(`[OSTRZEŻENIE] Nieznany typ nagłówka fragmentu: ${header.type}`);
                    }
                    
                    return;
                }
                
                // Jeśli nie mamy aktywnego transferu, ale otrzymujemy dane binarne bez nagłówka
                if (!this.currentReceivingFile) {
                    console.error(`[BŁĄD] Otrzymano dane binarne bez kontekstu transferu od ${peerId}`);
                    return;
                }
                
                // Tradycyjne podejście (dla wstecznej kompatybilności)
                this.currentReceivingFile.chunks.push(data);
                this.currentReceivingFile.receivedSize += (data.byteLength || data.size || 0);
                
                const progress = Math.min(100, Math.floor((this.currentReceivingFile.receivedSize / this.currentReceivingFile.size) * 100));
                
                // Obliczenie prędkości transferu
                const now = Date.now();
                if (!this.currentReceivingFile.lastUpdateTime) {
                    this.currentReceivingFile.lastUpdateTime = now;
                    this.currentReceivingFile.lastReceivedSize = 0;
                }
                
                const timeDiff = now - this.currentReceivingFile.lastUpdateTime;
                if (timeDiff > 500) { // Aktualizuj co pół sekundy
                    const bytesPerSecond = ((this.currentReceivingFile.receivedSize - this.currentReceivingFile.lastReceivedSize) / timeDiff) * 1000;
                    this.currentReceivingFile.lastUpdateTime = now;
                    this.currentReceivingFile.lastReceivedSize = this.currentReceivingFile.receivedSize;
                    
                    console.log(`[DEBUG] Postęp odbierania ${this.currentReceivingFile.name}: ${progress}%, prędkość: ${this.formatFileSize(bytesPerSecond)}/s`);
                    
                    if (this.onTransferProgress) {
                        this.onTransferProgress(
                            peerId,
                            {
                                name: this.currentReceivingFile.name,
                                size: this.currentReceivingFile.size,
                                type: this.currentReceivingFile.type
                            },
                            progress,
                            this.currentReceivingFile.receivedSize,
                            true, // isReceiving
                            bytesPerSecond
                        );
                    }
                }
            } else {
                // Dane JSON (metadane)
                let message;
                try {
                    message = JSON.parse(data.toString());
                    console.log(`[DEBUG] Otrzymano wiadomość typu ${message.type} od ${peerId}`);
                } catch (e) {
                    console.error(`[BŁĄD] Otrzymano nieprawidłowy format JSON od ${peerId}:`, e);
                    console.error("Dane:", data.toString().substring(0, 100) + "...");
                    return;
                }
                
                // Obsługa nagłówków fragmentów plików
                if (message.type === 'file-chunk' || message.type === 'file-chunk-retry') {
                    // Zachowaj nagłówek dla kolejnych danych binarnych
                    this.lastChunkHeader = {
                        peerId: peerId,
                        data: message
                    };
                    return;
                }
                
                // Obsługa potwierdzeń fragmentów
                if (message.type === 'chunk-ack') {
                    if (this.pendingAcks[peerId] && 
                        this.pendingAcks[peerId][message.fileId] && 
                        this.pendingAcks[peerId][message.fileId].has(message.chunkIndex)) {
                        
                        // Usuń potwierdzony fragment z oczekujących
                        this.pendingAcks[peerId][message.fileId].delete(message.chunkIndex);
                        
                        // Usuń z kolejki ponownego wysłania, jeśli istnieje
                        if (this.retryChunks[peerId] && 
                            this.retryChunks[peerId][message.fileId]) {
                            
                            this.retryChunks[peerId][message.fileId] = this.retryChunks[peerId][message.fileId].filter(
                                item => item.chunkIndex !== message.chunkIndex
                            );
                        }
                    }
                    return;
                }
                
                switch (message.type) {
                    case 'request-transfer':
                        // Otrzymano żądanie transferu plików
                        console.log(`[DEBUG] Otrzymano żądanie transferu ${message.files?.length || 0} plików od ${peerId}`);
                        
                        // Aktualizacja stanu
                        this.updateConnectionState(peerId, 'transfer_request_received', {
                            fileCount: message.files?.length || 0,
                            totalSize: message.totalSize || 0
                        });
                        
                        console.log(`[DEBUG] Szczegóły żądania:`, message);
                        
                        const peerName = this.peers[peerId]?.name || "Nieznane urządzenie";
                        
                        // Powiadom UI o żądaniu transferu
                        if (this.onTransferRequest) {
                            this.onTransferRequest(peerId, {
                                files: message.files || [],
                                totalSize: message.totalSize || 0,
                                senderName: message.senderName || peerName
                            });
                        } else {
                            console.error(`[BŁĄD] Brak obsługi żądania transferu (onTransferRequest)`);
                        }
                        break;
                        
                    case 'accept-transfer':
                        // Transfer został zaakceptowany - rozpocznij wysyłanie
                        console.log(`[DEBUG] Transfer został zaakceptowany przez ${peerId}`);
                        
                        // Aktualizacja stanu
                        this.updateConnectionState(peerId, 'transfer_accepted');
                        
                        // Sprawdź, czy mamy oczekujące pliki dla tego peera
                        if (this.pendingTransfers[peerId]) {
                            const { files, filesMetadata } = this.pendingTransfers[peerId];
                            delete this.pendingTransfers[peerId];
                            
                            // Dodaj pliki do kolejki transferu
                            filesMetadata.forEach((metadata, index) => {
                                const file = files[index];
                                this.transferQueue.push({
                                    peerId: peerId,
                                    file,
                                    fileId: metadata.id,
                                    progress: 0
                                });
                            });
                            
                            console.log(`[DEBUG] Dodano ${files.length} plików do kolejki transferu dla ${peerId}`);
                            
                            // Wyślij metadane
                            const connection = this.activeConnections[peerId];
                            if (!connection) {
                                console.error(`[BŁĄD] Brak aktywnego połączenia z ${peerId} do wysłania metadanych`);
                                return;
                            }
                            
                            try {
                                // Wybierz metodę wysyłania - preferuj bezpośredni kanał danych
                                connection._channel.send(JSON.stringify({
                                    type: 'metadata',
                                    files: filesMetadata
                                }));
                                
                                console.log(`[DEBUG] Wysłano metadane plików do ${peerId}`);
                                
                                // Aktualizacja stanu
                                this.updateConnectionState(peerId, 'metadata_sent');
                                
                                // Krótka pauza przed rozpoczęciem transferu
                                setTimeout(() => {
                                    // Rozpocznij transfer, jeśli nie jest aktywny
                                    if (!this.currentTransfer) {
                                        console.log(`[DEBUG] Rozpoczynam przetwarzanie kolejki transferu dla ${peerId}`);
                                        this.processNextTransfer();
                                    }
                                }, 500);
                            } catch (metaError) {
                                console.error(`[BŁĄD] Problem podczas wysyłania metadanych: ${metaError.message}`);
                                
                                // Aktualizacja stanu
                                this.updateConnectionState(peerId, 'metadata_send_error', {
                                    error: metaError.message
                                });
                            }
                        } else {
                            console.warn(`[OSTRZEŻENIE] Otrzymano akceptację transferu, ale nie ma oczekujących plików dla ${peerId}`);
                        }
                        break;
                        
                    case 'reject-transfer':
                        // Transfer został odrzucony
                        console.log(`[DEBUG] Transfer został odrzucony przez ${peerId}`);
                        
                        // Aktualizacja stanu
                        this.updateConnectionState(peerId, 'transfer_rejected');
                        
                        // Usuń oczekujące pliki dla tego peera
                        delete this.pendingTransfers[peerId];
                        
                        // Powiadom UI o odrzuceniu
                        if (this.onTransferError) {
                            this.onTransferError(peerId, 'Transfer został odrzucony przez odbiorcę');
                        }
                        break;
                        
                    case 'cancel-transfer':
                        // Transfer został anulowany przez drugą stronę
                        console.log(`[DEBUG] Transfer został anulowany przez ${peerId}`);
                        
                        // Aktualizacja stanu
                        this.updateConnectionState(peerId, 'transfer_cancelled_by_peer');
                        
                        // Wyczyść bieżący odbierany plik
                        this.currentReceivingFile = null;
                        this.incomingFiles = null;
                        this.receivedFiles = [];
                        
                        // Wyczyść rejestry fragmentów i potwierdzeń
                        if (this.receivedChunksRegistry[peerId]) {
                            delete this.receivedChunksRegistry[peerId];
                        }
                        
                        // Powiadom UI o anulowaniu
                        if (this.onTransferError) {
                            this.onTransferError(peerId, 'Transfer został anulowany przez nadawcę');
                        }
                        break;
                        
                    case 'metadata':
                        // Otrzymano informacje o plikach, które będą przesłane
                        console.log(`[DEBUG] Początek odbierania ${message.files?.length || 0} plików od ${peerId}`);
                        
                        // Aktualizacja stanu
                        this.updateConnectionState(peerId, 'metadata_received', {
                            fileCount: message.files?.length || 0
                        });
                        
                        console.log(`[DEBUG] Szczegóły plików:`, JSON.stringify(message.files || []));
                        
                        this.incomingFiles = message.files || [];
                        this.receivedFiles = [];
                        
                        // Inicjalizacja rejestru fragmentów
                        if (!this.receivedChunksRegistry[peerId]) {
                            this.receivedChunksRegistry[peerId] = {};
                        }
                        
                        // Przygotuj rejestry fragmentów dla każdego pliku
                        message.files.forEach(file => {
                            this.receivedChunksRegistry[peerId][file.id] = new Set();
                        });
                        break;
                        
                    case 'start-file':
                        // Rozpoczęcie odbierania pliku
                        console.log(`[DEBUG] Rozpoczęcie odbierania pliku "${message.name}" (${this.formatFileSize(message.size)}) od ${peerId}`);
                        
                        // Aktualizacja stanu
                        this.updateConnectionState(peerId, 'file_reception_started', {
                            fileName: message.name,
                            fileSize: message.size
                        });
                        
                        // Resetowanie lub inicjalizacja odbiornika pliku
                        this.currentReceivingFile = {
                            name: message.name,
                            size: message.size,
                            type: message.type || 'application/octet-stream',
                            fileId: message.fileId,
                            chunks: [],
                            receivedSize: 0,
                            lastUpdateTime: null,
                            lastReceivedSize: 0
                        };
                        
                        console.log(`[DEBUG] Zainicjowano odbieranie pliku: ${JSON.stringify({
                            name: message.name,
                            size: this.formatFileSize(message.size),
                            type: message.type || 'application/octet-stream',
                            fileId: message.fileId
                        })}`);
                        break;
                        
                    case 'end-file':
                        // Zakończenie odbierania pliku
                        console.log(`[DEBUG] Otrzymano sygnał końca pliku "${message.name}" od ${peerId}`);
                        
                        // Aktualizacja stanu
                        this.updateConnectionState(peerId, 'file_reception_completed', {
                            fileName: message.name
                        });
                        
                        if (!this.currentReceivingFile) {
                            console.error(`[BŁĄD] Otrzymano sygnał końca pliku bez aktywnego transferu: ${message.name}`);
                            return;
                        }
                        
                        if (this.currentReceivingFile.name !== message.name) {
                            console.error(`[BŁĄD] Niezgodność nazw plików: oczekiwano ${this.currentReceivingFile.name}, otrzymano ${message.name}`);
                            return;
                        }
                        
                        console.log(`[DEBUG] Zakończenie odbierania pliku "${message.name}". ` +
                                    `Otrzymano: ${this.currentReceivingFile.receivedSize}/${this.currentReceivingFile.size} bajtów ` +
                                    `(${this.currentReceivingFile.chunks.length} fragmentów)`);
                        
                        try {
                            // Złączenie wszystkich fragmentów
                            const fileData = new Blob(this.currentReceivingFile.chunks, {
                                type: this.currentReceivingFile.type
                            });
                            
                            console.log(`[DEBUG] Utworzono Blob, rozmiar: ${fileData.size} bajtów`);
                            
                            this.receivedFiles.push({
                                name: this.currentReceivingFile.name,
                                size: this.currentReceivingFile.size,
                                type: this.currentReceivingFile.type,
                                data: fileData
                            });
                            
                            // Sprawdź, czy wszystkie pliki zostały odebrane
                            if (this.incomingFiles && this.receivedFiles.length === this.incomingFiles.length) {
                                console.log(`[DEBUG] Wszystkie pliki zostały odebrane (${this.receivedFiles.length})`);
                                
                                // Aktualizacja stanu
                                this.updateConnectionState(peerId, 'all_files_received', {
                                    fileCount: this.receivedFiles.length
                                });
                                
                                // Wypisz informacje o każdym odebranym pliku
                                this.receivedFiles.forEach((file, index) => {
                                    console.log(`[DEBUG] Plik #${index+1}: ${file.name}, ${this.formatFileSize(file.size)}, typ: ${file.type}`);
                                });
                                
                                if (this.onFilesReceived) {
                                    console.log(`[DEBUG] Wywołuję callback onFilesReceived z ${this.receivedFiles.length} plikami`);
                                    this.onFilesReceived(peerId, this.receivedFiles);
                                } else {
                                    console.error(`[BŁĄD] Brak callbacku onFilesReceived!`);
                                }
                                
                                this.incomingFiles = null;
                                this.receivedFiles = [];
                            }
                            
                            this.currentReceivingFile = null;
                        } catch (error) {
                            console.error(`[BŁĄD] Problem podczas tworzenia pliku z fragmentów:`, error);
                            
                            // Aktualizacja stanu
                            this.updateConnectionState(peerId, 'file_assembly_error', {
                                error: error.message
                            });
                            
                            if (this.onTransferError) {
                                this.onTransferError(peerId, `Błąd tworzenia pliku: ${error.message}`);
                            }
                        }
                        break;
                        
                    default:
                        console.warn(`[OSTRZEŻENIE] Nieznany typ wiadomości: ${message.type} od ${peerId}`);
                }
            }
        } catch (error) {
            console.error(`[BŁĄD] Nieoczekiwany błąd przetwarzania przychodzących danych od ${peerId}:`, error);
            
            // Aktualizacja stanu
            this.updateConnectionState(peerId, 'data_processing_error', {
                error: error.message
            });
        }
    }

    /**
     * Wykonuje diagnostykę WebRTC i sprawdza dostępność i konfigurację
     * @returns {Promise<Object>} Wynik diagnostyki
     */
    async diagnoseWebRTC() {
        console.log('[DEBUG] Rozpoczęcie diagnostyki WebRTC');
        
        const result = {
            browserSupport: {
                rtcPeerConnection: false,
                getUserMedia: false,
                simplePeer: false
            },
            iceServers: [],
            networkInfo: {
                ip: null,
                networkId: null
            },
            connectionTests: {
                socketConnection: false,
                timeToConnect: null
            },
            iceCandidates: []
        };
        
        // Sprawdź podstawowe wsparcie przeglądarki
        result.browserSupport.rtcPeerConnection = typeof RTCPeerConnection !== 'undefined';
        result.browserSupport.getUserMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
        result.browserSupport.simplePeer = typeof SimplePeer !== 'undefined';
        
        // Sprawdź połączenie socket.io
        if (this.socket) {
            result.connectionTests.socketConnection = this.socket.connected;
        }
        
        // Pobierz informacje o sieci
        result.networkInfo.networkId = this.networkId;
        
        // Pobierz konfigurację ICE
        try {
            const startTime = Date.now();
            const iceServers = await this.getIceServers();
            result.connectionTests.timeToConnect = Date.now() - startTime;
            
            result.iceServers = iceServers.map(server => ({
                urls: server.urls,
                hasCredentials: !!(server.username && server.credential)
            }));
        } catch (error) {
            console.error('[BŁĄD] Diagnostyka: Nie udało się pobrać serwerów ICE:', error);
        }
        
        // Testowe połączenie STUN
        try {
            // Utwórz testowe połączenie do sprawdzenia kandydatów ICE
            const pc = new RTCPeerConnection({
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
            });
            
            // Zbieraj kandydatów ICE
            const iceCandidates = [];
            pc.onicecandidate = (e) => {
                if (e.candidate) {
                    iceCandidates.push({
                        type: e.candidate.candidate.split(' ')[7],
                        protocol: e.candidate.protocol,
                        address: e.candidate.address
                    });
                }
            };
            
            // Dodaj pusty kanał danych, aby zainicjować zbieranie kandydatów
            pc.createDataChannel('diagnostic_channel');
            
            // Stwórz ofertę, aby rozpocząć proces ICE
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            
            // Poczekaj na kandydatów
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            result.iceCandidates = iceCandidates;
            
            // Sprawdź dostępność sieci
            fetch('/api/network-check')
                .then(response => response.json())
                .then(data => {
                    result.networkInfo.ip = data.ip;
                })
                .catch(err => {
                    console.error('[BŁĄD] Nie można pobrać informacji o sieci:', err);
                });
            
            // Zamknij połączenie
            pc.close();
        } catch (error) {
            console.error('[BŁĄD] Diagnostyka: Test STUN nie powiódł się:', error);
        }
        
        console.log('[DEBUG] Wynik diagnostyki WebRTC:', result);
        return result;
    }

    /**
     * Testuje połączenie WebRTC do określonego peera
     * @param {string} targetPeerId - ID peera do testu
     * @returns {Promise<Object>} Wynik testu
     */
    async testConnection(targetPeerId) {
        console.log(`[DEBUG] Rozpoczęcie testu połączenia z ${targetPeerId}`);
        
        try {
            // Sprawdź, czy peer istnieje
            if (!this.peers[targetPeerId]) {
                throw new Error(`Peer ${targetPeerId} nie istnieje`);
            }
            
            const startTime = Date.now();
            
            // Spróbuj nawiązać połączenie
            const connection = await this.createPeerConnection(targetPeerId, true);
            
            // Poczekaj na nawiązanie połączenia z timeoutem
            const connectResult = await Promise.race([
                new Promise(resolve => {
                    connection.once('connect', () => {
                        resolve({ success: true, timeTaken: Date.now() - startTime });
                    });
                    
                    connection.once('error', (err) => {
                        resolve({ success: false, error: err.message });
                    });
                }),
                new Promise(resolve => setTimeout(() => resolve({ success: false, error: 'Timeout' }), 15000))
            ]);
            
            // Wyczyść połączenie testowe
            if (connection && connection.destroy) {
                connection.destroy();
            }
            
            return connectResult;
        } catch (error) {
            console.error(`[BŁĄD] Test połączenia z ${targetPeerId} zakończony niepowodzeniem:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Testuje przesyłanie małego pliku testowego
     * @param {string} targetPeerId - ID peera do testu
     * @returns {Promise<Object>} Wynik testu transferu
     */
    async testFileTransfer(targetPeerId) {
        console.log(`[DEBUG] Rozpoczęcie testu transferu pliku z ${targetPeerId}`);
        
        try {
            // Sprawdź, czy peer istnieje
            if (!this.peers[targetPeerId]) {
                throw new Error(`Peer ${targetPeerId} nie istnieje`);
            }
            
            // Utwórz mały plik testowy (10KB losowych danych)
            const testData = new Uint8Array(10 * 1024);
            for (let i = 0; i < testData.length; i++) {
                testData[i] = Math.floor(Math.random() * 256);
            }
            
            const testFile = new File([testData], 'test-file.bin', { type: 'application/octet-stream' });
            
            // Przygotuj śledzenie testu
            const startTime = Date.now();
            let isCompleted = false;
            let transferError = null;
            
            // Śledź postęp
            const progressCallback = (peer, file, progress) => {
                console.log(`[DEBUG] Test transferu: postęp ${progress}%`);
            };
            
            // Śledź zakończenie
            const completeCallback = () => {
                isCompleted = true;
                console.log(`[DEBUG] Test transferu: zakończony, czas: ${Date.now() - startTime}ms`);
            };
            
            // Śledź błędy
            const errorCallback = (peer, error) => {
                transferError = error;
                console.error(`[BŁĄD] Test transferu: błąd: ${error}`);
            };
            
            // Ustaw tymczasowe callbacki
            const originalProgress = this.onTransferProgress;
            const originalComplete = this.onTransferComplete;
            const originalError = this.onTransferError;
            
            this.onTransferProgress = progressCallback;
            this.onTransferComplete = completeCallback;
            this.onTransferError = errorCallback;
            
            // Rozpocznij transfer testowy
            await this.sendFiles(targetPeerId, [testFile]);
            
            // Poczekaj na zakończenie transferu z timeoutem
            const result = await Promise.race([
                new Promise(resolve => {
                    const checkCompletion = () => {
                        if (isCompleted) {
                            resolve({ success: true, timeTaken: Date.now() - startTime });
                        } else if (transferError) {
                            resolve({ success: false, error: transferError });
                        } else {
                            setTimeout(checkCompletion, 100);
                        }
                    };
                    checkCompletion();
                }),
                new Promise(resolve => setTimeout(() => resolve({ success: false, error: 'Timeout transferu testowego' }), 30000))
            ]);
            
            // Przywróć oryginalne callbacki
            this.onTransferProgress = originalProgress;
            this.onTransferComplete = originalComplete;
            this.onTransferError = originalError;
            
            return result;
        } catch (error) {
            console.error(`[BŁĄD] Test transferu z ${targetPeerId} zakończony niepowodzeniem:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Zamyka wszystkie połączenia i zwalnia zasoby
     */
    disconnect() {
        console.log('[DEBUG] Zamykanie wszystkich połączeń');
        
        Object.keys(this.activeConnections).forEach(peerId => {
            this.cleanupConnection(peerId);
        });
        
        this.activeConnections = {};
        this.isConnecting = {};
        this.pendingTransfers = {};
        this.connectionStates = {};
        this.dataChannelStates = {};
        this.receivedChunksRegistry = {};
        this.pendingAcks = {};
        this.retryChunks = {};
        
        if (this.socket) {
            this.socket.disconnect();
        }
    }

    /**
     * Pomocnicza funkcja do formatowania rozmiaru pliku
     * @param {number} bytes - Rozmiar w bajtach
     * @returns {string} - Sformatowany rozmiar
     */
    formatFileSize(bytes) {
        if (bytes === undefined || bytes === null) return '0 B';
        if (bytes < 1024) return bytes + ' B';
        else if (bytes < 1048576) return (bytes / 1024).toFixed(2) + ' KB';
        else if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + ' MB';
        else return (bytes / 1073741824).toFixed(2) + ' GB';
    }
}