/**
 * SendIt - Klient WebRTC
 * 
 * Klasa implementująca funkcjonalność połączenia P2P i transferu plików
 * między urządzeniami w sieci lokalnej za pomocą WebRTC.
 */
class SendItClient {
    constructor() {
        // Podstawowa konfiguracja
        this.socket = null;
        this.peerId = null;
        this.deviceName = null;
        this.networkId = null;
        
        // Przechowywanie połączeń i urządzeń
        this.peers = {};                   // Informacje o urządzeniach w sieci
        this.connections = {};             // Aktywne połączenia WebRTC
        this.dataChannels = {};            // Kanały danych
        
        // Zarządzanie transferem plików
        this.pendingTransfers = {};        // Oczekujące transfery
        this.currentIncomingFile = null;   // Obecnie odbierany plik
        this.incomingFiles = [];           // Pliki gotowe do odebrania
        this.transfers = [];               // Pliki w kolejce do wysłania
        this.currentTransfer = null;       // Aktualnie wysyłany plik
        this.receivedChunks = {};          // Rejestry otrzymanych fragmentów
        
        // Callbacki
        this.onPeerConnected = null;       // Nowe urządzenie dołączyło
        this.onPeerDisconnected = null;    // Urządzenie opuściło sieć
        this.onPeersUpdated = null;        // Aktualizacja listy urządzeń
        this.onConnectionStateChange = null; // Zmiana stanu połączenia
        this.onTransferProgress = null;     // Postęp transferu
        this.onTransferComplete = null;     // Transfer zakończony
        this.onTransferError = null;        // Błąd transferu
        this.onFilesReceived = null;        // Odebrano pliki
        this.onTransferRequest = null;      // Żądanie transferu plików
        
        // Konfiguracja
        this.iceServers = null;            // Konfiguracja serwerów ICE
        this.chunkSize = 16384;            // Rozmiar fragmentu pliku (16KB)
        this.maxRetries = 3;               // Maksymalna liczba ponownych prób
        this.connectionTimeout = 30000;    // Timeout połączenia (30s)
        this.iceTimeout = 10000;           // Timeout negocjacji ICE (10s)
        this.signalTimeout = 10000;        // Timeout przetwarzania sygnału (10s)
        this.dataChannelTimeout = 10000;   // Timeout otwarcia kanału danych (10s)
        
        // Diagnostyka
        this.debug = true;                 // Tryb debugowania
        this.connectionState = {};         // Stan połączeń
    }

    /**
     * Inicjalizacja klienta
     * Nawiązuje połączenie z serwerem sygnalizacyjnym i konfiguruje obsługę zdarzeń
     */
    async init() {
        this.log('Inicjalizacja klienta SendIt...');

        return new Promise((resolve, reject) => {
            try {
                // Inicjalizacja połączenia z serwerem sygnalizacyjnym
                this.socket = io({
                    reconnectionDelayMax: 5000,
                    reconnectionAttempts: 10,
                    timeout: 20000
                });

                // Obsługa zdarzeń połączenia
                this.socket.on('connect', () => {
                    this.log('Połączono z serwerem sygnalizacyjnym');
                });

                // Otrzymanie przydzielonego ID
                this.socket.on('assigned-id', (id) => {
                    this.peerId = id;
                    this.log('Przydzielono ID:', id);
                    resolve();
                });

                // Otrzymanie ID sieci
                this.socket.on('network-id', (networkId) => {
                    this.networkId = networkId;
                    this.log('Przydzielono ID sieci:', networkId);
                });

                // Obsługa aktywnych urządzeń w sieci
                this.socket.on('active-peers', (peers) => {
                    this.log(`Otrzymano listę ${peers.length} aktywnych urządzeń`);
                    this.peers = {};
                    peers.forEach(peer => {
                        this.peers[peer.id] = peer;
                    });
                    
                    // Powiadom o aktualizacji listy urządzeń
                    if (this.onPeersUpdated) {
                        this.onPeersUpdated(Object.values(this.peers));
                    }
                });

                // Nowe urządzenie dołączyło do sieci
                this.socket.on('peer-joined', (peer) => {
                    this.log(`Nowe urządzenie w sieci: ${peer.name} (${peer.id})`);
                    this.peers[peer.id] = peer;
                    
                    if (this.onPeerConnected) {
                        this.onPeerConnected(peer);
                    }
                    
                    if (this.onPeersUpdated) {
                        this.onPeersUpdated(Object.values(this.peers));
                    }
                });

                // Urządzenie opuściło sieć
                this.socket.on('peer-left', (peerId) => {
                    const peer = this.peers[peerId];
                    const peerName = peer ? peer.name : 'Nieznane urządzenie';
                    this.log(`Urządzenie opuściło sieć: ${peerName} (${peerId})`);
                    
                    // Zamknij połączenie, jeśli istnieje
                    this.closeConnection(peerId);
                    
                    // Usuń z listy urządzeń
                    delete this.peers[peerId];
                    
                    if (this.onPeerDisconnected && peer) {
                        this.onPeerDisconnected(peer);
                    }
                    
                    if (this.onPeersUpdated) {
                        this.onPeersUpdated(Object.values(this.peers));
                    }
                });

                // Obsługa wiadomości sygnalizacyjnych
                this.socket.on('signal', async (data) => {
                    try {
                        const { peerId, signal } = data;
                        const signalType = signal.type || 'candidate';
                        this.log(`Otrzymano sygnał od ${peerId}: ${signalType}`);
                        
                        // Potwierdzenie odebrania sygnału
                        this.socket.emit('signal-received', { originPeerId: peerId });
                        
                        // Przetwarzanie sygnału
                        await this.handleSignal(peerId, signal);
                    } catch (error) {
                        this.error('Błąd podczas obsługi sygnału:', error);
                    }
                });

                // Potwierdzenie odebrania sygnału
                this.socket.on('signal-confirmation', ({ peerId }) => {
                    this.log(`Potwierdzenie odebrania sygnału przez ${peerId}`);
                });

                // Obsługa błędów sygnalizacji
                this.socket.on('signal-error', ({ targetPeerId, error }) => {
                    this.error(`Błąd sygnalizacji dla ${targetPeerId}:`, error);
                    
                    if (error === 'peer-not-found') {
                        delete this.peers[targetPeerId];
                        if (this.onPeersUpdated) {
                            this.onPeersUpdated(Object.values(this.peers));
                        }
                    }
                });

                // Obsługa błędów połączenia
                this.socket.on('connect_error', (error) => {
                    this.error('Błąd połączenia z serwerem:', error);
                    reject(error);
                });

                // Obsługa rozłączenia
                this.socket.on('disconnect', (reason) => {
                    this.log('Rozłączono z serwerem. Powód:', reason);
                });

                // Obsługa ponownego połączenia
                this.socket.on('reconnect', (attemptNumber) => {
                    this.log(`Ponowne połączenie z serwerem (próba #${attemptNumber})`);
                });

            } catch (error) {
                this.error('Błąd inicjalizacji klienta:', error);
                reject(error);
            }
        });
    }

    /**
     * Rejestracja nazwy urządzenia
     * @param {string} name - Nazwa urządzenia
     */
    registerDevice(name) {
        this.deviceName = name;
        this.log(`Rejestracja urządzenia: ${name}`);
        this.socket.emit('register-name', name);
    }

    /**
     * Pobieranie konfiguracji serwerów ICE
     * @returns {Promise<Array>} - Tablica serwerów ICE
     */
    async fetchIceServers() {
        try {
            this.log('Pobieranie konfiguracji serwerów ICE...');
            
            // Spróbuj pobrać konfigurację z serwera
            const response = await fetch('/api/turn-credentials', {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Cache-Control': 'no-cache'
                },
                cache: 'no-store'
            });
            
            if (!response.ok) {
                throw new Error(`Serwer zwrócił kod ${response.status}`);
            }
            
            const iceServers = await response.json();
            
            if (!Array.isArray(iceServers) || iceServers.length === 0) {
                throw new Error('Otrzymano nieprawidłowe dane serwerów ICE');
            }
            
            this.log(`Pobrano ${iceServers.length} serwerów ICE`);
            
            // Zachowaj konfigurację serwerów
            this.iceServers = iceServers;
            return iceServers;
            
        } catch (error) {
            this.error('Błąd podczas pobierania serwerów ICE:', error);
            
            // Gdy wystąpi błąd, użyj domyślnych serwerów
            const fallbackServers = this.getFallbackIceServers();
            this.log('Używam awaryjnych serwerów ICE');
            
            this.iceServers = fallbackServers;
            return fallbackServers;
        }
    }

    /**
     * Awaryjne serwery ICE używane, gdy nie można pobrać konfiguracji z serwera
     * @returns {Array} - Tablica serwerów ICE
     */
    getFallbackIceServers() {
        return [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
            { urls: 'stun:stun.ekiga.net' },
            { urls: 'stun:stun.ideasip.com' },
            { urls: 'stun:stun.schlund.de' },
            {
                urls: 'turn:global.relay.metered.ca:80',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            },
            {
                urls: 'turn:global.relay.metered.ca:443',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            },
            {
                urls: 'turn:global.relay.metered.ca:443?transport=tcp',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            }
        ];
    }

    /**
     * Obsługa otrzymanego sygnału
     * @param {string} peerId - ID urządzenia, które wysłało sygnał
     * @param {Object} signal - Sygnał WebRTC
     */
    async handleSignal(peerId, signal) {
        try {
            // Aktualizacja stanu połączenia
            this.updateConnectionState(peerId, 'signaling', {
                type: signal.type || 'candidate',
                direction: 'incoming'
            });

            // Sprawdź, czy już istnieje połączenie
            let connection = this.connections[peerId];
            
            // Jeśli to sygnał typu 'offer' i połączenie już istnieje,
            // zamknij je, aby utworzyć nowe
            if (signal.type === 'offer' && connection) {
                this.log(`Zamykanie istniejącego połączenia dla nowej oferty od ${peerId}`);
                this.closeConnection(peerId);
                connection = null;
            }
            
            // Jeśli nie ma połączenia, a otrzymano sygnał typu 'offer',
            // utwórz nowe jako odpowiadający (nie initiator)
            if (!connection && signal.type === 'offer') {
                this.log(`Tworzenie nowego połączenia jako odpowiadający dla ${peerId}`);
                connection = await this.createConnection(peerId, false);
                this.connections[peerId] = connection;
            }
            
            // Jeśli wciąż nie ma połączenia, a to sygnał typu 'answer' lub 'candidate',
            // nie możemy go przetworzyć
            if (!connection) {
                if (signal.type === 'answer') {
                    this.error(`Otrzymano odpowiedź, ale brak aktywnego połączenia dla ${peerId}`);
                    return;
                }
                
                if (!signal.type) { // candidate
                    this.log(`Ignorowanie kandydata ICE - brak aktywnego połączenia dla ${peerId}`);
                    return;
                }
                
                // Utwórz nowe połączenie jako initiator
                this.log(`Tworzenie nowego połączenia jako initiator dla ${peerId}`);
                connection = await this.createConnection(peerId, true);
                this.connections[peerId] = connection;
            }
            
            // Przekaż sygnał do połączenia SimplePeer
            this.log(`Przekazywanie sygnału do połączenia ${peerId}`);
            await connection.signal(signal);
            
        } catch (error) {
            this.error(`Błąd podczas obsługi sygnału od ${peerId}:`, error);
            this.updateConnectionState(peerId, 'error', { error: error.message });
        }
    }

    /**
     * Tworzenie nowego połączenia P2P
     * @param {string} peerId - ID urządzenia, z którym nawiązujemy połączenie
     * @param {boolean} isInitiator - Czy to my inicjujemy połączenie
     * @returns {Promise<Object>} - Obiekt połączenia SimplePeer
     */
    async createConnection(peerId, isInitiator) {
        try {
            this.updateConnectionState(peerId, 'connecting', { isInitiator });
            
            // Pobierz konfigurację serwerów ICE, jeśli jeszcze nie ma
            if (!this.iceServers) {
                await this.fetchIceServers();
            }
            
            this.log(`Tworzenie połączenia peer z ${peerId}, initiator: ${isInitiator}`);
            
            // Konfiguracja połączenia SimplePeer
            const peerConfig = {
                initiator: isInitiator,
                trickle: true,
                config: {
                    iceServers: this.iceServers,
                    iceTransportPolicy: 'all',
                    sdpSemantics: 'unified-plan',
                    iceCandidatePoolSize: 5
                },
                channelName: 'sendfile',
                channelConfig: {
                    ordered: true,     // Gwarantuje kolejność dostarczania
                    maxRetransmits: 15 // Maksymalna liczba ponownych prób
                },
                reconnectTimer: 3000,  // Czas pomiędzy próbami ponownego połączenia
                iceCompleteTimeout: this.iceTimeout, // Timeout ICE
                offerOptions: {
                    offerToReceiveAudio: false,
                    offerToReceiveVideo: false
                }
            };
            
            // Utwórz nowe połączenie SimplePeer
            const connection = new SimplePeer(peerConfig);
            
            // Ustawienie timeoutu dla całego procesu połączenia
            const connectionTimeoutId = setTimeout(() => {
                if (this.connectionState[peerId] !== 'connected') {
                    this.error(`Timeout nawiązywania połączenia z ${peerId}`);
                    this.updateConnectionState(peerId, 'timeout');
                    this.closeConnection(peerId);
                }
            }, this.connectionTimeout);
            
            // Obsługa sygnałów
            connection.on('signal', (data) => {
                this.sendSignal(peerId, data);
            });
            
            // Obsługa nawiązania połączenia
            connection.on('connect', () => {
                this.log(`Połączono z ${peerId}`);
                clearTimeout(connectionTimeoutId);
                
                this.updateConnectionState(peerId, 'connected');
                
                // Sprawdź, czy istnieje kanał danych
                if (connection._channel) {
                    this.dataChannels[peerId] = connection._channel;
                    this.log(`Kanał danych dla ${peerId} jest dostępny`);
                } else {
                    this.log(`Brak kanału danych dla ${peerId}, próbuję utworzyć...`);
                    try {
                        // Ręczne utworzenie kanału danych
                        if (connection._pc) {
                            const dataChannel = connection._pc.createDataChannel('sendfile');
                            this.setupDataChannel(peerId, dataChannel);
                        }
                    } catch (error) {
                        this.error(`Nie można utworzyć kanału danych dla ${peerId}:`, error);
                    }
                }
                
                // Jeśli są oczekujące transfery, rozpocznij je
                if (this.pendingTransfers[peerId]) {
                    this.log(`Rozpoczynam oczekujący transfer dla ${peerId}`);
                    const { files, accept } = this.pendingTransfers[peerId];
                    delete this.pendingTransfers[peerId];
                    
                    if (accept) {
                        // Wysyłamy akceptację transferu
                        this.respondToTransferRequest(peerId, true);
                    } else {
                        // Inicjujemy transfer
                        this.startFileTransfer(peerId, files);
                    }
                }
            });
            
            // Obsługa przychodzących danych
            connection.on('data', (data) => {
                try {
                    this.handleIncomingData(peerId, data);
                } catch (error) {
                    this.error(`Błąd podczas przetwarzania przychodzących danych:`, error);
                }
            });
            
            // Obsługa błędów
            connection.on('error', (error) => {
                this.error(`Błąd połączenia z ${peerId}:`, error);
                clearTimeout(connectionTimeoutId);
                
                this.updateConnectionState(peerId, 'error', { 
                    error: error.message || 'Nieznany błąd' 
                });
                
                // Spróbuj naprawić połączenie, jeśli to możliwe
                this.maybeReconnect(peerId);
            });
            
            // Obsługa zamknięcia połączenia
            connection.on('close', () => {
                this.log(`Połączenie z ${peerId} zostało zamknięte`);
                clearTimeout(connectionTimeoutId);
                
                this.updateConnectionState(peerId, 'closed');
                
                // Wyczyść wszystkie związane zasoby
                delete this.connections[peerId];
                delete this.dataChannels[peerId];
                
                // Anuluj wszelkie transfery
                this.cancelTransfersForPeer(peerId);
            });
            
            // Dodatkowe monitorowanie stan ICE, jeśli dostępne
            if (connection._pc) {
                // Obserwuj stan ICE
                connection._pc.oniceconnectionstatechange = () => {
                    const state = connection._pc.iceConnectionState;
                    this.log(`Zmiana stanu ICE dla ${peerId}: ${state}`);
                    
                    this.updateConnectionState(peerId, 'ice_state', { state });
                    
                    if (state === 'failed') {
                        this.error(`Negocjacja ICE nieudana dla ${peerId}`);
                        this.updateConnectionState(peerId, 'ice_failed');
                        
                        // Spróbuj naprawić połączenie
                        this.maybeReconnect(peerId);
                    }
                };
                
                // Obserwuj kanały danych
                connection._pc.ondatachannel = (event) => {
                    this.log(`Otrzymano kanał danych dla ${peerId}`);
                    this.setupDataChannel(peerId, event.channel);
                };
                
                // Timeout dla negocjacji ICE
                setTimeout(() => {
                    if (connection._pc.iceConnectionState === 'checking' || 
                        connection._pc.iceConnectionState === 'new') {
                        this.log(`Timeout negocjacji ICE dla ${peerId}`);
                        
                        // Przejdź w tryb awaryjny
                        this.updateConnectionState(peerId, 'ice_timeout');
                        
                        // Spróbuj zestawić połączenie mimo timeoutu,
                        // może uda się w trybie awaryjnym
                        if (connection._pc.iceConnectionState === 'checking') {
                            this.log(`Połączenie w stanie checking, kontynuuję mimo timeoutu dla ${peerId}`);
                        } else {
                            // Spróbuj ponownie nawiązać połączenie
                            this.maybeReconnect(peerId);
                        }
                    }
                }, this.iceTimeout);
            }
            
            return connection;
            
        } catch (error) {
            this.error(`Błąd podczas tworzenia połączenia z ${peerId}:`, error);
            this.updateConnectionState(peerId, 'creation_error', { error: error.message });
            throw error;
        }
    }

    /**
     * Konfiguracja kanału danych
     * @param {string} peerId - ID urządzenia
     * @param {RTCDataChannel} dataChannel - Kanał danych WebRTC
     */
    setupDataChannel(peerId, dataChannel) {
        this.log(`Konfiguracja kanału danych dla ${peerId}`);
        
        this.dataChannels[peerId] = dataChannel;
        
        // Obserwuj stan kanału
        dataChannel.onopen = () => {
            this.log(`Kanał danych otwarty dla ${peerId}`);
            this.updateConnectionState(peerId, 'data_channel_open');
            
            // Jeśli są oczekujące transfery, rozpocznij je
            if (this.pendingTransfers[peerId]) {
                this.log(`Rozpoczynam oczekujący transfer dla ${peerId}`);
                const { files, accept } = this.pendingTransfers[peerId];
                delete this.pendingTransfers[peerId];
                
                if (accept) {
                    // Wysyłamy akceptację transferu
                    this.respondToTransferRequest(peerId, true);
                } else {
                    // Inicjujemy transfer
                    this.startFileTransfer(peerId, files);
                }
            }
        };
        
        dataChannel.onclose = () => {
            this.log(`Kanał danych zamknięty dla ${peerId}`);
            this.updateConnectionState(peerId, 'data_channel_closed');
            delete this.dataChannels[peerId];
        };
        
        dataChannel.onerror = (error) => {
            this.error(`Błąd kanału danych dla ${peerId}:`, error);
            this.updateConnectionState(peerId, 'data_channel_error', { 
                error: error.message || 'Nieznany błąd kanału danych' 
            });
        };
        
        dataChannel.onmessage = (event) => {
            try {
                const data = event.data;
                this.handleIncomingData(peerId, data);
            } catch (error) {
                this.error(`Błąd podczas przetwarzania wiadomości z kanału danych:`, error);
            }
        };
    }

    /**
     * Wysyłanie sygnału do urządzenia
     * @param {string} peerId - ID urządzenia
     * @param {Object} signal - Sygnał WebRTC
     */
    sendSignal(peerId, signal) {
        try {
            const signalType = signal.type || 'candidate';
            this.log(`Wysyłanie sygnału do ${peerId}: ${signalType}`);
            
            this.updateConnectionState(peerId, 'signaling', {
                type: signalType,
                direction: 'outgoing'
            });
            
            if (this.socket && this.socket.connected) {
                this.socket.emit('signal', {
                    peerId: peerId,
                    signal: signal
                });
            } else {
                throw new Error('Socket jest nieaktywny lub rozłączony');
            }
        } catch (error) {
            this.error(`Błąd podczas wysyłania sygnału do ${peerId}:`, error);
            this.updateConnectionState(peerId, 'signal_error', { error: error.message });
        }
    }

    /**
     * Sprawdzenie, czy połączenie jest gotowe do transferu danych
     * @param {string} peerId - ID urządzenia
     * @returns {boolean} - Czy połączenie jest gotowe
     */
    isConnectionReady(peerId) {
        // Sprawdź, czy istnieje połączenie
        if (!this.connections[peerId]) {
            return false;
        }
        
        // Sprawdź stan kanału danych
        if (this.dataChannels[peerId] && this.dataChannels[peerId].readyState === 'open') {
            return true;
        }
        
        // Sprawdź stan połączenia SimplePeer
        return this.connections[peerId]._connected === true;
    }

    /**
     * Próba ponownego nawiązania połączenia
     * @param {string} peerId - ID urządzenia
     */
    maybeReconnect(peerId) {
        const state = this.connectionState[peerId];
        
        // Nie próbuj ponownie łączyć, jeśli połączenie zostało zamknięte celowo
        if (state && state.state === 'closed' && state.intentional) {
            return;
        }
        
        // Limit prób ponownego łączenia
        const retry = state && state.retryCount ? state.retryCount : 0;
        if (retry >= this.maxRetries) {
            this.log(`Osiągnięto maksymalną liczbę prób połączenia z ${peerId}`);
            return;
        }
        
        this.log(`Próba ponownego połączenia z ${peerId} (${retry + 1}/${this.maxRetries})`);
        
        // Aktualizacja stanu
        this.updateConnectionState(peerId, 'reconnecting', { 
            attempt: retry + 1, 
            maxRetries: this.maxRetries 
        });
        
        // Zamknij obecne połączenie
        this.closeConnection(peerId, false);
        
        // Rozpocznij nowe połączenie po krótkim opóźnieniu
        setTimeout(async () => {
            try {
                const connection = await this.createConnection(peerId, true);
                this.connections[peerId] = connection;
            } catch (error) {
                this.error(`Błąd podczas ponownego łączenia z ${peerId}:`, error);
                this.updateConnectionState(peerId, 'reconnect_error', { error: error.message });
            }
        }, 1000 * (retry + 1)); // Zwiększaj opóźnienie z każdą próbą
    }

    /**
     * Zamknięcie połączenia z urządzeniem
     * @param {string} peerId - ID urządzenia
     * @param {boolean} intentional - Czy zamknięcie jest celowe
     */
    closeConnection(peerId, intentional = true) {
        const connection = this.connections[peerId];
        if (!connection) return;
        
        this.log(`Zamykanie połączenia z ${peerId}`);
        
        // Aktualizacja stanu
        this.updateConnectionState(peerId, 'closing', { intentional });
        
        try {
            connection.destroy();
        } catch (error) {
            this.error(`Błąd podczas zamykania połączenia z ${peerId}:`, error);
        }
        
        // Wyczyść zasoby
        delete this.connections[peerId];
        delete this.dataChannels[peerId];
        
        this.updateConnectionState(peerId, 'closed', { intentional });
    }

    /**
     * Aktualizacja stanu połączenia i powiadamianie UI
     * @param {string} peerId - ID urządzenia
     * @param {string} state - Nowy stan połączenia
     * @param {Object} details - Dodatkowe informacje o stanie
     */
    updateConnectionState(peerId, state, details = {}) {
        const previousState = this.connectionState[peerId] ? 
            this.connectionState[peerId].state : null;
        
        // Aktualizuj stan w pamięci
        this.connectionState[peerId] = {
            state,
            timestamp: Date.now(),
            ...details,
            retryCount: details.attempt || 
                (this.connectionState[peerId] ? 
                 (this.connectionState[peerId].retryCount || 0) : 0)
        };
        
        // Logowanie zmiany stanu
        if (previousState !== state) {
            this.log(`Zmiana stanu połączenia z ${peerId}: ${previousState || 'brak'} -> ${state}`, details);
        }
        
        // Powiadom interfejs użytkownika o zmianie stanu
        if (this.onConnectionStateChange) {
            const peer = this.peers[peerId] || { id: peerId, name: 'Nieznane urządzenie' };
            this.onConnectionStateChange(peer, state, details);
        }
    }

    /**
     * Obsługa przychodzących danych
     * @param {string} peerId - ID urządzenia, które wysłało dane
     * @param {*} data - Otrzymane dane
     */
    handleIncomingData(peerId, data) {
        try {
            // Sprawdź, czy dane są binarne (fragment pliku)
            if (this.isBinaryData(data)) {
                this.handleBinaryData(peerId, data);
                return;
            }
            
            // Dane tekstowe (JSON) - przetwórz wiadomość
            let message;
            try {
                message = JSON.parse(data.toString());
            } catch (e) {
                this.error(`Otrzymano nieprawidłowy format JSON od ${peerId}:`, e);
                return;
            }
            
            this.log(`Otrzymano wiadomość typu ${message.type || 'unknown'} od ${peerId}`);
            
            // Obsługa różnych typów wiadomości
            switch (message.type) {
                case 'request-transfer':
                    this.handleTransferRequest(peerId, message);
                    break;
                    
                case 'accept-transfer':
                    this.handleTransferResponse(peerId, true);
                    break;
                    
                case 'reject-transfer':
                    this.handleTransferResponse(peerId, false);
                    break;
                    
                case 'cancel-transfer':
                    this.handleTransferCancellation(peerId);
                    break;
                    
                case 'start-file':
                    this.handleStartFile(peerId, message);
                    break;
                    
                case 'end-file':
                    this.handleEndFile(peerId, message);
                    break;
                    
                default:
                    this.log(`Nieznany typ wiadomości od ${peerId}: ${message.type}`);
            }
        } catch (error) {
            this.error(`Błąd podczas obsługi przychodzących danych od ${peerId}:`, error);
        }
    }

    /**
     * Sprawdzenie, czy dane są binarne
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
     * Obsługa danych binarnych (fragmentów pliku)
     * @param {string} peerId - ID urządzenia, które wysłało dane
     * @param {*} data - Dane binarne
     */
    handleBinaryData(peerId, data) {
        // Ignoruj dane binarne, jeśli nie ma aktywnego odbierania pliku
        if (!this.currentIncomingFile) {
            this.error(`Otrzymano dane binarne bez aktywnego transferu od ${peerId}`);
            return;
        }
        
        // Dodaj fragment do odbieranego pliku
        this.currentIncomingFile.chunks.push(data);
        const chunkSize = data.byteLength || data.size || 0;
        this.currentIncomingFile.receivedSize += chunkSize;
        
        // Oblicz postęp
        const progress = Math.min(100, Math.floor((this.currentIncomingFile.receivedSize / this.currentIncomingFile.size) * 100));
        
        // Oblicz prędkość transferu
        const now = Date.now();
        if (!this.currentIncomingFile.lastUpdateTime) {
            this.currentIncomingFile.lastUpdateTime = now;
            this.currentIncomingFile.lastReceivedSize = 0;
        }
        
        const timeDiff = now - this.currentIncomingFile.lastUpdateTime;
        let bytesPerSecond = 0;
        
        if (timeDiff > 500) { // Aktualizuj co pół sekundy
            bytesPerSecond = ((this.currentIncomingFile.receivedSize - this.currentIncomingFile.lastReceivedSize) / timeDiff) * 1000;
            this.currentIncomingFile.lastUpdateTime = now;
            this.currentIncomingFile.lastReceivedSize = this.currentIncomingFile.receivedSize;
            
            this.log(`Postęp odbierania ${this.currentIncomingFile.name}: ${progress}%, prędkość: ${this.formatFileSize(bytesPerSecond)}/s`);
            
            // Aktualizuj postęp
            if (this.onTransferProgress) {
                this.onTransferProgress(
                    peerId,
                    {
                        name: this.currentIncomingFile.name,
                        size: this.currentIncomingFile.size,
                        type: this.currentIncomingFile.type
                    },
                    progress,
                    this.currentIncomingFile.receivedSize,
                    true, // isReceiving
                    bytesPerSecond
                );
            }
        }
    }

    /**
     * Obsługa żądania transferu plików
     * @param {string} peerId - ID urządzenia proszącego o transfer
     * @param {Object} request - Informacje o żądaniu
     */
    handleTransferRequest(peerId, request) {
        this.log(`Otrzymano żądanie transferu ${request.files?.length || 0} plików od ${peerId}`);
        
        // Aktualizacja stanu
        this.updateConnectionState(peerId, 'transfer_request_received', {
            fileCount: request.files?.length || 0,
            totalSize: request.totalSize || 0
        });
        
        const peerName = this.peers[peerId]?.name || "Nieznane urządzenie";
        
        // Powiadom UI o żądaniu transferu
        if (this.onTransferRequest) {
            this.onTransferRequest(peerId, {
                files: request.files || [],
                totalSize: request.totalSize || 0,
                senderName: request.senderName || peerName
            });
        } else {
            this.error(`Brak obsługi żądania transferu (onTransferRequest)`);
        }
    }

    /**
     * Obsługa odpowiedzi na żądanie transferu
     * @param {string} peerId - ID urządzenia, które odpowiedziało
     * @param {boolean} accepted - Czy transfer został zaakceptowany
     */
    handleTransferResponse(peerId, accepted) {
        if (accepted) {
            this.log(`Transfer został zaakceptowany przez ${peerId}`);
            this.updateConnectionState(peerId, 'transfer_accepted');
            
            // Inicjuj transfer plików, jeśli są w kolejce
            if (this.transfers.length > 0) {
                this.processFileTransfers(peerId);
            }
        } else {
            this.log(`Transfer został odrzucony przez ${peerId}`);
            this.updateConnectionState(peerId, 'transfer_rejected');
            
            // Wyczyść kolejkę transferów
            this.transfers = [];
            this.currentTransfer = null;
            
            // Powiadom o odrzuceniu
            if (this.onTransferError) {
                this.onTransferError(peerId, 'Transfer został odrzucony przez odbiorcę');
            }
        }
    }

    /**
     * Obsługa anulowania transferu
     * @param {string} peerId - ID urządzenia, które anulowało transfer
     */
    handleTransferCancellation(peerId) {
        this.log(`Transfer został anulowany przez ${peerId}`);
        this.updateConnectionState(peerId, 'transfer_cancelled_by_peer');
        
        // Wyczyść dane transferu
        this.currentIncomingFile = null;
        this.incomingFiles = [];
        
        // Powiadom o anulowaniu
        if (this.onTransferError) {
            this.onTransferError(peerId, 'Transfer został anulowany przez nadawcę');
        }
    }

    /**
     * Obsługa rozpoczęcia odbierania pliku
     * @param {string} peerId - ID urządzenia wysyłającego plik
     * @param {Object} fileInfo - Informacje o pliku
     */
    handleStartFile(peerId, fileInfo) {
        this.log(`Rozpoczęcie odbierania pliku "${fileInfo.name}" (${this.formatFileSize(fileInfo.size)}) od ${peerId}`);
        
        // Aktualizacja stanu
        this.updateConnectionState(peerId, 'file_reception_started', {
            fileName: fileInfo.name,
            fileSize: fileInfo.size
        });
        
        // Inicjalizacja odbiornika pliku
        this.currentIncomingFile = {
            name: fileInfo.name,
            size: fileInfo.size,
            type: fileInfo.type || 'application/octet-stream',
            chunks: [],
            receivedSize: 0,
            lastUpdateTime: null,
            lastReceivedSize: 0
        };
        
        // Jeśli to pierwszy plik, zainicjuj tablicę odebranych plików
        if (!this.incomingFiles) {
            this.incomingFiles = [];
        }
    }

    /**
     * Obsługa zakończenia odbierania pliku
     * @param {string} peerId - ID urządzenia wysyłającego
     * @param {Object} fileInfo - Informacje o pliku
     */
    handleEndFile(peerId, fileInfo) {
        this.log(`Otrzymano sygnał końca pliku "${fileInfo.name}" od ${peerId}`);
        
        // Aktualizacja stanu
        this.updateConnectionState(peerId, 'file_reception_completed', {
            fileName: fileInfo.name
        });
        
        if (!this.currentIncomingFile) {
            this.error(`Otrzymano sygnał końca pliku bez aktywnego transferu: ${fileInfo.name}`);
            return;
        }
        
        if (this.currentIncomingFile.name !== fileInfo.name) {
            this.error(`Niezgodność nazw plików: oczekiwano ${this.currentIncomingFile.name}, otrzymano ${fileInfo.name}`);
            return;
        }
        
        try {
            // Utwórz Blob z odebranych fragmentów
            const fileData = new Blob(this.currentIncomingFile.chunks, {
                type: this.currentIncomingFile.type
            });
            
            this.log(`Utworzono Blob, rozmiar: ${fileData.size} bajtów`);
            
            // Dodaj plik do listy odebranych
            this.incomingFiles.push({
                name: this.currentIncomingFile.name,
                size: this.currentIncomingFile.size,
                type: this.currentIncomingFile.type,
                data: fileData
            });
            
            // Resetuj bieżący plik
            this.currentIncomingFile = null;
            
            // Jeśli odebrano wszystkie pliki, powiadom
            if (this.incomingFiles.length > 0) {
                this.log(`Odebrano ${this.incomingFiles.length} plików`);
                
                // Aktualizacja stanu
                this.updateConnectionState(peerId, 'all_files_received', {
                    fileCount: this.incomingFiles.length
                });
                
                // Powiadom o odebraniu plików
                if (this.onFilesReceived) {
                    this.onFilesReceived(peerId, this.incomingFiles);
                }
                
                // Resetuj tablicę odebranych plików
                this.incomingFiles = [];
            }
        } catch (error) {
            this.error(`Problem podczas tworzenia pliku z fragmentów:`, error);
            
            // Aktualizacja stanu
            this.updateConnectionState(peerId, 'file_assembly_error', {
                error: error.message
            });
            
            if (this.onTransferError) {
                this.onTransferError(peerId, `Błąd tworzenia pliku: ${error.message}`);
            }
        }
    }

    /**
     * Wysłanie żądania transferu plików
     * @param {string} peerId - ID urządzenia, do którego chcemy wysłać pliki
     * @param {FileList|Array} files - Pliki do wysłania
     */
    async requestFileTransfer(peerId, files) {
        try {
            this.log(`Wysyłanie żądania transferu ${files.length} plików do ${peerId}`);
            
            // Aktualizacja stanu
            this.updateConnectionState(peerId, 'requesting_transfer', {
                fileCount: files.length
            });
            
            // Sprawdź, czy połączenie istnieje i jest gotowe
            if (!this.isConnectionReady(peerId)) {
                // Jeśli nie ma połączenia, utwórz je
                if (!this.connections[peerId]) {
                    this.log(`Brak połączenia z ${peerId}, tworzę nowe`);
                    this.updateConnectionState(peerId, 'creating_connection');
                    
                    // Zapisz pliki do wysłania po nawiązaniu połączenia
                    this.pendingTransfers[peerId] = { files, accept: false };
                    
                    // Utwórz nowe połączenie
                    const connection = await this.createConnection(peerId, true);
                    this.connections[peerId] = connection;
                    
                    // Transfer rozpocznie się automatycznie po nawiązaniu połączenia
                    return true;
                } else {
                    // Połączenie istnieje, ale nie jest gotowe
                    this.log(`Połączenie z ${peerId} istnieje, ale nie jest gotowe`);
                    this.updateConnectionState(peerId, 'waiting_for_connection');
                    
                    // Zapisz pliki do wysłania po nawiązaniu połączenia
                    this.pendingTransfers[peerId] = { files, accept: false };
                    
                    // Transfer rozpocznie się automatycznie po nawiązaniu połączenia
                    return true;
                }
            }
            
            // Przygotowanie metadanych plików
            const filesMetadata = Array.from(files).map(file => ({
                name: file.name,
                type: file.type,
                size: file.size
            }));
            
            const totalSize = filesMetadata.reduce((sum, file) => sum + file.size, 0);
            
            // Wyślij żądanie transferu
            this.sendData(peerId, {
                type: 'request-transfer',
                files: filesMetadata,
                totalSize: totalSize,
                senderName: this.deviceName
            });
            
            this.log(`Wysłano żądanie transferu do ${peerId}`);
            this.updateConnectionState(peerId, 'waiting_for_response');
            
            // Zapisz pliki do transferu
            this.transfers = Array.from(files);
            
            // Ustaw timeout na odpowiedź
            setTimeout(() => {
                if (this.transfers.length > 0 && !this.currentTransfer) {
                    this.error(`Nie otrzymano odpowiedzi na żądanie transferu od ${peerId}`);
                    this.updateConnectionState(peerId, 'response_timeout');
                    
                    // Wyczyść kolejkę transferów
                    this.transfers = [];
                    
                    if (this.onTransferError) {
                        this.onTransferError(peerId, 'Nie otrzymano odpowiedzi na żądanie transferu');
                    }
                }
            }, 60000); // 60 sekund
            
            return true;
            
        } catch (error) {
            this.error(`Błąd podczas wysyłania żądania transferu:`, error);
            this.updateConnectionState(peerId, 'request_error', { error: error.message });
            
            if (this.onTransferError) {
                this.onTransferError(peerId, error.message);
            }
            
            return false;
        }
    }

    /**
     * Odpowiedź na żądanie transferu plików
     * @param {string} peerId - ID urządzenia, które wysłało żądanie
     * @param {boolean} accepted - Czy akceptujemy transfer
     */
    respondToTransferRequest(peerId, accepted) {
        try {
            this.log(`Wysyłanie ${accepted ? 'akceptacji' : 'odrzucenia'} transferu do ${peerId}`);
            this.updateConnectionState(peerId, accepted ? 'accepting_transfer' : 'rejecting_transfer');
            
            // Sprawdź, czy połączenie jest gotowe
            if (!this.isConnectionReady(peerId)) {
                this.log(`Połączenie z ${peerId} nie jest gotowe, zapisuję odpowiedź na później`);
                
                // Zachowaj odpowiedź na później
                this.pendingTransfers[peerId] = { accept: accepted };
                
                // Jeśli nie ma połączenia, utwórz je
                if (!this.connections[peerId]) {
                    this.log(`Brak połączenia z ${peerId}, tworzę nowe`);
                    this.createConnection(peerId, false)
                        .then(connection => {
                            this.connections[peerId] = connection;
                        })
                        .catch(error => {
                            this.error(`Błąd podczas tworzenia połączenia:`, error);
                        });
                }
                
                return true;
            }
            
            // Wyślij odpowiedź
            this.sendData(peerId, {
                type: accepted ? 'accept-transfer' : 'reject-transfer'
            });
            
            this.log(`Wysłano ${accepted ? 'akceptację' : 'odrzucenie'} transferu do ${peerId}`);
            this.updateConnectionState(peerId, accepted ? 'transfer_accepted' : 'transfer_rejected');
            
            return true;
            
        } catch (error) {
            this.error(`Błąd podczas odpowiadania na żądanie transferu:`, error);
            this.updateConnectionState(peerId, 'response_error', { error: error.message });
            
            if (this.onTransferError) {
                this.onTransferError(peerId, error.message);
            }
            
            return false;
        }
    }

    /**
     * Rozpoczęcie transferu plików po akceptacji
     * @param {string} peerId - ID urządzenia odbierającego
     */
    processFileTransfers(peerId) {
        // Jeśli nie ma plików do transferu, zakończ
        if (this.transfers.length === 0) {
            this.log(`Brak plików do transferu dla ${peerId}`);
            return;
        }
        
        // Jeśli już trwa transfer, nie rozpoczynaj nowego
        if (this.currentTransfer) {
            this.log(`Transfer już trwa, nie rozpoczynam nowego`);
            return;
        }
        
        // Pobierz pierwszy plik z kolejki
        const file = this.transfers.shift();
        this.currentTransfer = { file, peerId };
        
        this.log(`Rozpoczynam transfer pliku "${file.name}" (${this.formatFileSize(file.size)}) do ${peerId}`);
        this.updateConnectionState(peerId, 'transfer_starting', { fileName: file.name });
        
        // Wyślij informację o rozpoczęciu pliku
        this.sendData(peerId, {
            type: 'start-file',
            name: file.name,
            size: file.size,
            type: file.type
        });
        
        // Rozpocznij wysyłanie fragmentów pliku
        this.sendFileChunks(peerId, file);
    }

    /**
     * Wysyłanie fragmentów pliku
     * @param {string} peerId - ID urządzenia odbierającego
     * @param {File} file - Plik do wysłania
     */
    async sendFileChunks(peerId, file) {
        try {
            this.updateConnectionState(peerId, 'sending_file', { fileName: file.name });
            
            const reader = new FileReader();
            let offset = 0;
            let chunkNumber = 0;
            let lastUpdateTime = Date.now();
            let lastOffset = 0;
            
            // Czytanie kolejnego fragmentu pliku
            const readNextChunk = () => {
                // Sprawdź, czy połączenie nadal istnieje
                if (!this.isConnectionReady(peerId)) {
                    this.error(`Połączenie z ${peerId} zostało przerwane podczas transferu`);
                    this.updateConnectionState(peerId, 'connection_lost_during_transfer');
                    
                    if (this.onTransferError) {
                        this.onTransferError(peerId, 'Połączenie zostało przerwane podczas transferu');
                    }
                    
                    this.currentTransfer = null;
                    
                    // Spróbuj wysłać następny plik, jeśli jest
                    if (this.transfers.length > 0) {
                        this.processFileTransfers(peerId);
                    }
                    
                    return;
                }
                
                // Pobierz fragment pliku
                const slice = file.slice(offset, offset + this.chunkSize);
                reader.readAsArrayBuffer(slice);
                chunkNumber++;
            };
            
            // Obsługa wczytania fragmentu
            reader.onload = async (e) => {
                try {
                    const chunk = e.target.result;
                    
                    // Wysyłanie fragmentu
                    await this.sendData(peerId, chunk);
                    
                    // Aktualizacja offsetu
                    offset += chunk.byteLength;
                    
                    // Obliczenie postępu
                    const progress = Math.min(100, Math.floor((offset / file.size) * 100));
                    
                    // Obliczenie prędkości transferu
                    const now = Date.now();
                    const timeDiff = now - lastUpdateTime;
                    
                    if (timeDiff > 500) { // Aktualizuj co pół sekundy
                        const bytesPerSecond = ((offset - lastOffset) / timeDiff) * 1000;
                        lastUpdateTime = now;
                        lastOffset = offset;
                        
                        this.log(`Postęp wysyłania ${file.name}: ${progress}%, prędkość: ${this.formatFileSize(bytesPerSecond)}/s`);
                        
                        // Aktualizacja postępu
                        if (this.onTransferProgress) {
                            this.onTransferProgress(
                                peerId,
                                file,
                                progress,
                                offset,
                                false, // isReceiving = false
                                bytesPerSecond
                            );
                        }
                    }
                    
                    // Jeśli to nie koniec pliku, czytaj następny fragment
                    if (offset < file.size) {
                        // Dodaj małe opóźnienie między fragmentami dla stabilności
                        setTimeout(readNextChunk, 10);
                    } else {
                        // Plik został w całości wysłany
                        await this.finishFileTransfer(peerId, file);
                    }
                } catch (error) {
                    this.error(`Błąd podczas wysyłania fragmentu pliku:`, error);
                    this.updateConnectionState(peerId, 'chunk_send_error', { error: error.message });
                    
                    if (this.onTransferError) {
                        this.onTransferError(peerId, `Błąd podczas wysyłania danych: ${error.message}`);
                    }
                    
                    this.currentTransfer = null;
                    
                    // Spróbuj wysłać następny plik, jeśli jest
                    if (this.transfers.length > 0) {
                        this.processFileTransfers(peerId);
                    }
                }
            };
            
            // Obsługa błędu czytania pliku
            reader.onerror = (error) => {
                this.error(`Błąd czytania pliku:`, error);
                this.updateConnectionState(peerId, 'file_read_error');
                
                if (this.onTransferError) {
                    this.onTransferError(peerId, `Błąd odczytu pliku: ${error.message || 'Nieznany błąd'}`);
                }
                
                this.currentTransfer = null;
                
                // Spróbuj wysłać następny plik, jeśli jest
                if (this.transfers.length > 0) {
                    this.processFileTransfers(peerId);
                }
            };
            
            // Rozpocznij czytanie pierwszego fragmentu
            readNextChunk();
            
        } catch (error) {
            this.error(`Błąd podczas wysyłania pliku:`, error);
            this.updateConnectionState(peerId, 'file_send_error', { error: error.message });
            
            if (this.onTransferError) {
                this.onTransferError(peerId, error.message);
            }
            
            this.currentTransfer = null;
            
            // Spróbuj wysłać następny plik, jeśli jest
            if (this.transfers.length > 0) {
                this.processFileTransfers(peerId);
            }
        }
    }

    /**
     * Zakończenie transferu pliku
     * @param {string} peerId - ID urządzenia odbierającego
     * @param {File} file - Wysłany plik
     */
    async finishFileTransfer(peerId, file) {
        this.log(`Transfer pliku "${file.name}" zakończony, wysyłanie sygnału końca pliku`);
        this.updateConnectionState(peerId, 'file_transfer_completed', { fileName: file.name });
        
        // Wyślij sygnał końca pliku
        await this.sendData(peerId, {
            type: 'end-file',
            name: file.name
        });
        
        this.log(`Sygnał końca pliku wysłany do ${peerId}`);
        
        // Powiadom o zakończeniu transferu
        if (this.onTransferComplete) {
            this.onTransferComplete(peerId, file);
        }
        
        // Resetuj bieżący transfer
        this.currentTransfer = null;
        
        // Jeśli są kolejne pliki, wyślij je
        if (this.transfers.length > 0) {
            // Dodaj małe opóźnienie przed wysłaniem następnego pliku
            setTimeout(() => {
                this.processFileTransfers(peerId);
            }, 500);
        }
    }

    /**
     * Wysłanie danych do urządzenia
     * @param {string} peerId - ID urządzenia
     * @param {*} data - Dane do wysłania
     */
    async sendData(peerId, data) {
        return new Promise((resolve, reject) => {
            try {
                // Sprawdź, czy połączenie istnieje
                if (!this.connections[peerId]) {
                    throw new Error(`Brak połączenia z ${peerId}`);
                }
                
                // Preferuj kanał danych, jeśli jest dostępny
                if (this.dataChannels[peerId] && this.dataChannels[peerId].readyState === 'open') {
                    this.dataChannels[peerId].send(data instanceof Object && !(data instanceof ArrayBuffer || data instanceof Blob) ? 
                                                 JSON.stringify(data) : data);
                } else {
                    // Użyj metody send obiektu SimplePeer
                    this.connections[peerId].send(data instanceof Object && !(data instanceof ArrayBuffer || data instanceof Blob) ? 
                                                JSON.stringify(data) : data);
                }
                
                resolve();
            } catch (error) {
                this.error(`Błąd podczas wysyłania danych do ${peerId}:`, error);
                reject(error);
            }
        });
    }

    /**
     * Anulowanie transferu plików
     * @param {string} peerId - ID urządzenia, z którym anulujemy transfer
     */
    cancelTransfer(peerId) {
        this.log(`Anulowanie transferu dla ${peerId}`);
        this.updateConnectionState(peerId, 'cancelling_transfer');
        
        try {
            // Wyślij wiadomość o anulowaniu transferu
            if (this.isConnectionReady(peerId)) {
                this.sendData(peerId, { type: 'cancel-transfer' });
            }
            
            // Anuluj bieżący transfer
            if (this.currentTransfer && this.currentTransfer.peerId === peerId) {
                this.currentTransfer = null;
            }
            
            // Usuń z kolejki transferów
            this.transfers = this.transfers.filter(file => 
                !this.currentTransfer || this.currentTransfer.peerId !== peerId);
            
            // Wyczyść dane odbierania plików
            if (this.currentIncomingFile) {
                this.currentIncomingFile = null;
            }
            
            this.updateConnectionState(peerId, 'transfer_cancelled');
            
            return true;
        } catch (error) {
            this.error(`Błąd podczas anulowania transferu:`, error);
            this.updateConnectionState(peerId, 'cancel_error', { error: error.message });
            
            return false;
        }
    }

    /**
     * Anulowanie wszystkich transferów dla określonego urządzenia
     * @param {string} peerId - ID urządzenia
     */
    cancelTransfersForPeer(peerId) {
        // Anuluj bieżący transfer
        if (this.currentTransfer && this.currentTransfer.peerId === peerId) {
            this.currentTransfer = null;
        }
        
        // Usuń z kolejki transferów
        this.transfers = this.transfers.filter(file => 
            !this.currentTransfer || this.currentTransfer.peerId !== peerId);
        
        // Wyczyść dane odbierania plików
        if (this.currentIncomingFile) {
            this.currentIncomingFile = null;
        }
    }

    /**
     * Wysłanie plików do urządzenia
     * @param {string} peerId - ID urządzenia odbierającego
     * @param {FileList|Array} files - Pliki do wysłania
     */
    async sendFiles(peerId, files) {
        try {
            this.log(`Inicjowanie transferu ${files.length} plików do ${peerId}`);
            this.updateConnectionState(peerId, 'initiating_file_transfer', { fileCount: files.length });
            
            // Wyślij żądanie transferu
            return await this.requestFileTransfer(peerId, files);
            
        } catch (error) {
            this.error(`Błąd podczas wysyłania plików:`, error);
            this.updateConnectionState(peerId, 'file_transfer_init_error', { error: error.message });
            
            if (this.onTransferError) {
                this.onTransferError(peerId, error.message);
            }
            
            return false;
        }
    }

    /**
     * Rozłączenie wszystkich połączeń i zamknięcie klienta
     */
    disconnect() {
        this.log('Zamykanie wszystkich połączeń...');
        
        // Zamknij wszystkie połączenia
        Object.keys(this.connections).forEach(peerId => {
            this.closeConnection(peerId);
        });
        
        // Rozłącz socket
        if (this.socket) {
            this.socket.disconnect();
        }
        
        // Wyczyść wszystkie dane
        this.connections = {};
        this.dataChannels = {};
        this.peers = {};
        this.connectionState = {};
        this.transfers = [];
        this.currentTransfer = null;
        this.currentIncomingFile = null;
        this.incomingFiles = [];
        
        this.log('Klient SendIt został rozłączony');
    }

    /**
     * Formatowanie rozmiaru pliku w czytelny sposób
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

    /**
     * Tworzenie diagnostyki połączenia WebRTC
     * @returns {Object} - Raport diagnostyczny
     */
    async diagnoseWebRTC() {
        this.log('Rozpoczęcie diagnostyki WebRTC');
        
        const result = {
            browserSupport: {
                rtcPeerConnection: typeof RTCPeerConnection !== 'undefined',
                getUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
                simplePeer: typeof SimplePeer !== 'undefined'
            },
            iceServers: this.iceServers || await this.fetchIceServers(),
            networkInfo: {
                ip: null,
                networkId: this.networkId
            },
            connectionTests: {
                socketConnection: this.socket ? this.socket.connected : false
            },
            iceCandidates: []
        };
        
        // Testowanie połączenia STUN dla generowania kandydatów ICE
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
            
            // Pobierz informacje o sieci
            fetch('/api/network-check')
                .then(response => response.json())
                .then(data => {
                    result.networkInfo.ip = data.ip;
                })
                .catch(err => {
                    this.error('Nie można pobrać informacji o sieci:', err);
                });
            
            // Zamknij połączenie
            pc.close();
        } catch (error) {
            this.error('Błąd podczas testu STUN:', error);
        }
        
        return result;
    }

    /**
     * Testowanie połączenia z określonym urządzeniem
     * @param {string} peerId - ID urządzenia do testu
     * @returns {Promise<Object>} - Wynik testu
     */
    async testConnection(peerId) {
        this.log(`Rozpoczęcie testu połączenia z ${peerId}`);
        
        try {
            const startTime = Date.now();
            
            // Sprawdź, czy urządzenie istnieje
            if (!this.peers[peerId]) {
                throw new Error(`Urządzenie ${peerId} nie istnieje`);
            }
            
            // Utwórz tymczasowe połączenie testowe
            const connection = await this.createConnection(peerId, true);
            
            // Poczekaj na nawiązanie połączenia z timeoutem
            const result = await Promise.race([
                new Promise(resolve => {
                    connection.once('connect', () => {
                        const timeTaken = Date.now() - startTime;
                        resolve({ success: true, timeTaken });
                    });
                    
                    connection.once('error', (err) => {
                        resolve({ success: false, error: err.message });
                    });
                }),
                new Promise(resolve => setTimeout(() => resolve({ success: false, error: 'Timeout' }), 15000))
            ]);
            
            // Zamknij połączenie testowe
            connection.destroy();
            
            return result;
            
        } catch (error) {
            this.error(`Błąd podczas testowania połączenia z ${peerId}:`, error);
            return { success: false, error: error.message };
        }
    }
    
    /**
     * Testowanie transferu plików
     * @param {string} peerId - ID urządzenia do testu
     * @returns {Promise<Object>} - Wynik testu
     */
    async testFileTransfer(peerId) {
        this.log(`Rozpoczęcie testu transferu plików z ${peerId}`);
        
        try {
            // Sprawdź, czy urządzenie istnieje
            if (!this.peers[peerId]) {
                throw new Error(`Urządzenie ${peerId} nie istnieje`);
            }
            
            // Utwórz mały plik testowy (10KB losowych danych)
            const testData = new Uint8Array(10 * 1024);
            for (let i = 0; i < testData.length; i++) {
                testData[i] = Math.floor(Math.random() * 256);
            }
            
            const testFile = new File([testData], 'test-file.bin', { type: 'application/octet-stream' });
            
            // Śledź stan testu
            const startTime = Date.now();
            let isCompleted = false;
            let transferError = null;
            
            // Tymczasowo zastąp callbacki
            const originalProgress = this.onTransferProgress;
            const originalComplete = this.onTransferComplete;
            const originalError = this.onTransferError;
            
            // Ustaw tymczasowe callbacki
            this.onTransferProgress = () => {};
            this.onTransferComplete = () => { isCompleted = true; };
            this.onTransferError = (_, error) => { transferError = error; };
            
            // Rozpocznij transfer testowy
            await this.sendFiles(peerId, [testFile]);
            
            // Poczekaj na zakończenie z timeoutem
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
                new Promise(resolve => setTimeout(() => resolve({ 
                    success: false, 
                    error: 'Timeout testu transferu' 
                }), 30000))
            ]);
            
            // Przywróć oryginalne callbacki
            this.onTransferProgress = originalProgress;
            this.onTransferComplete = originalComplete;
            this.onTransferError = originalError;
            
            return result;
            
        } catch (error) {
            this.error(`Błąd podczas testu transferu z ${peerId}:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Logowanie informacji
     * @param {...*} args - Argumenty do logowania
     */
    log(...args) {
        if (this.debug) {
            console.log('[SendIt]', ...args);
        }
    }

    /**
     * Logowanie błędów
     * @param {...*} args - Argumenty do logowania
     */
    error(...args) {
        console.error('[SendIt ERROR]', ...args);
    }
}
