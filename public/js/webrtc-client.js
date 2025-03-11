class SendItClient {
    constructor() {
        this.socket = null;
        this.peerId = null;
        this.deviceName = null;
        this.peers = {};
        this.activeConnections = {};
        this.transferQueue = [];
        this.currentTransfer = null;
        this.onPeerConnected = null;
        this.onPeerDisconnected = null;
        this.onTransferProgress = null;
        this.onTransferComplete = null;
        this.onTransferError = null;
        this.onFilesReceived = null;
        this.onPeersUpdated = null;
        this.onTransferRequest = null; // Callback dla żądań transferu
        this.onConnectionStateChange = null; // NOWE: Callback do powiadamiania o zmianach stanu połączenia
        this.connectionRetryCount = 0;
        this.maxConnectionRetries = 10; // Zwiększona liczba prób
        this.useFallbackIceServers = false;
        this.isConnecting = {}; // Śledzenie stanu łączenia dla każdego ID peera
        this.pendingTransfers = {}; // Śledzenie oczekujących transferów
        this.iceFailedPeers = new Set(); // Śledzenie peerów z problemami ICE
        this.connectionStates = {}; // Śledzenie stanów połączeń
        this.signalQueue = {}; // Kolejka sygnałów do przetworzenia
        this.isProcessingSignals = {}; // Flaga przetwarzania kolejki sygnałów
        this.dataChannelStates = {}; // Śledzenie stanu kanałów danych
        this.transferStates = {}; // NOWE: Śledzenie stanów transferów
        
        // Konfiguracja timeoutów i limitów z dłuższymi wartościami dla większej niezawodności
        this.connectionTimeout = 300000; // 5 minut na nawiązanie połączenia (z 3 minut)
        this.iceTimeout = 20000;        // 20 sekund na kandydatów ICE (z 10 sekund)
        this.signalTimeout = 30000;     // 30 sekund na odebranie sygnału (z 15 sekund)
        this.chunkSize = 16384;         // 16KB dla fragmentów plików
        this.adaptiveChunkDelay = true; // Dynamiczne dostosowanie opóźnienia
        this.baseChunkDelay = 20;       // Podstawowe opóźnienie między fragmentami (zwiększone z 5ms)
        this.dataChannelTimeout = 30000; // 30 sekund na otwarcie kanału danych
        
        // Stan gotowości do odbioru wiadomości (nawet jeśli połączenie nie jest w pełni gotowe)
        this.earlyMessageEnabled = true;
        
        // Licznik ponownych prób dla każdego peera
        this.peerRetryCount = {};
        
        // Blokada przed równoczesnym tworzeniem wielu połączeń
        this.connectionLocks = {};
        
        // NOWE: Dodanie listy odebranych fragmentów plików do weryfikacji kompletności
        this.receivedChunksRegistry = {};
        
        // NOWE: Dodanie obsługi potwierdzeń fragmentów
        this.ackEnabled = true;
        this.pendingAcks = {};
        
        // NOWE: Kolejka fragmentów do ponownego wysłania w przypadku braku potwierdzenia
        this.retryChunks = {};
        
        // NOWE: Timeout dla potwierdzeń
        this.ackTimeout = 5000; // 5 sekund na potwierdzenie fragmentu
    }

    // Inicjalizacja połączenia z serwerem sygnalizacyjnym
    init() {
        return new Promise((resolve, reject) => {
            try {
                console.log('[DEBUG] Inicjalizacja klienta SendIt...');
                
                // Próba detekcji URL serwera
                const serverUrl = window.location.origin;
                console.log(`[DEBUG] Łączenie z serwerem: ${serverUrl}`);
                
                // Połączenie z serwerem z rozszerzonymi opcjami
                this.socket = io({
                    reconnectionDelay: 1000,
                    reconnectionDelayMax: 5000,
                    reconnectionAttempts: 15,        // Zwiększone z 10
                    timeout: 30000,                  // Zwiększony timeout z 20000
                    forceNew: true,                  // Wymuszenie nowego połączenia
                    transports: ['websocket', 'polling'] // Preferuj WebSocket, fallback do long-polling
                });
                
                this.socket.on('connect', () => {
                    console.log('[DEBUG] Połączono z serwerem sygnalizacyjnym');
                });
                
                this.socket.on('assigned-id', (id) => {
                    this.peerId = id;
                    console.log('[DEBUG] Przydzielono ID:', id);
                    resolve();
                });
                
                this.socket.on('network-id', (networkId) => {
                    console.log('[DEBUG] Przydzielono ID sieci:', networkId);
                    this.networkId = networkId;
                });
                
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
                
                this.socket.on('peer-left', (peerId) => {
                    const peer = this.peers[peerId];
                    console.log(`[DEBUG] Peer opuścił sieć: ${peer?.name || 'Nieznany'} (${peerId})`);
                    delete this.peers[peerId];
                    
                    // Zamknij wszystkie istniejące połączenia z tym peerem
                    if (this.activeConnections[peerId]) {
                        try {
                            console.log(`[DEBUG] Zamykanie połączenia z ${peerId}`);
                            this.activeConnections[peerId].destroy();
                        } catch (err) {
                            console.error('[BŁĄD] Błąd podczas zamykania połączenia:', err);
                        }
                        delete this.activeConnections[peerId];
                        delete this.isConnecting[peerId];
                        delete this.connectionStates[peerId];
                        delete this.signalQueue[peerId];
                        delete this.isProcessingSignals[peerId];
                        delete this.peerRetryCount[peerId];
                        delete this.connectionLocks[peerId];
                        delete this.dataChannelStates[peerId];
                        
                        // NOWE: Usuń stany transferu
                        delete this.transferStates[peerId];
                        delete this.receivedChunksRegistry[peerId];
                        delete this.pendingAcks[peerId];
                        delete this.retryChunks[peerId];
                    }
                    
                    // Usuń oczekujące transfery
                    delete this.pendingTransfers[peerId];
                    this.iceFailedPeers.delete(peerId);
                    
                    if (this.onPeerDisconnected && peer) {
                        this.onPeerDisconnected(peer);
                    }
                    
                    if (this.onPeersUpdated) {
                        this.onPeersUpdated(Object.values(this.peers));
                    }
                });
                
                // Obsługa wiadomości sygnalizacyjnych z bardziej szczegółowym logowaniem i kolejkowaniem
                this.socket.on('signal', async ({ peerId, signal }) => {
                    try {
                        console.log(`[DEBUG] Otrzymano sygnał od ${peerId}: ${signal.type || 'candidate'}`);
                        
                        // Wyślij potwierdzenie odebrania sygnału
                        this.socket.emit('signal-received', { originPeerId: peerId });
                        
                        // Dodaj sygnał do kolejki dla tego peera
                        if (!this.signalQueue[peerId]) {
                            this.signalQueue[peerId] = [];
                        }
                        
                        this.signalQueue[peerId].push(signal);
                        
                        // Przetwarzaj kolejkę sygnałów, jeśli nie jest już przetwarzana
                        if (!this.isProcessingSignals[peerId]) {
                            this.processSignalQueue(peerId);
                        }
                    } catch (error) {
                        console.error(`[BŁĄD] Błąd podczas odbierania sygnału: ${error.message}`);
                    }
                });
                
                // Obsługa potwierdzenia odebrania sygnału
                this.socket.on('signal-confirmation', ({ peerId }) => {
                    console.log(`[DEBUG] Potwierdzenie odebrania sygnału przez ${peerId}`);
                });
                
                // Obsługa błędów sygnalizacji
                this.socket.on('signal-error', ({ targetPeerId, error }) => {
                    console.error(`[BŁĄD] Błąd sygnalizacji dla ${targetPeerId}: ${error}`);
                    
                    if (error === 'peer-not-found') {
                        // Usuń peera z listy jeśli już nie istnieje
                        delete this.peers[targetPeerId];
                        if (this.onPeersUpdated) {
                            this.onPeersUpdated(Object.values(this.peers));
                        }
                    }
                });
                
                this.socket.on('connect_error', (error) => {
                    console.error(`[BŁĄD] Błąd połączenia z serwerem: ${error.message}`);
                    reject(error);
                });
                
                this.socket.on('disconnect', (reason) => {
                    console.warn(`[OSTRZEŻENIE] Rozłączono z serwerem sygnalizacyjnym. Powód: ${reason}`);
                    // Automatyczne ponowne połączenie jest obsługiwane przez Socket.IO
                });
                
                this.socket.on('reconnect', (attemptNumber) => {
                    console.log(`[DEBUG] Ponowne połączenie z serwerem udane (próba #${attemptNumber})`);
                });
                
                this.socket.on('reconnect_attempt', (attemptNumber) => {
                    console.log(`[DEBUG] Próba ponownego połączenia #${attemptNumber}...`);
                });
                
                this.socket.on('reconnect_error', (error) => {
                    console.error(`[BŁĄD] Błąd podczas ponownego łączenia: ${error.message}`);
                });
                
                this.socket.on('reconnect_failed', () => {
                    console.error('[BŁĄD] Nie udało się ponownie połączyć z serwerem po wszystkich próbach');
                    reject(new Error('Nie udało się ponownie połączyć z serwerem po wszystkich próbach'));
                });
                
            } catch (error) {
                console.error(`[BŁĄD] Błąd inicjalizacji klienta: ${error.message}`);
                reject(error);
            }
        });
    }

    // NOWE: Metoda do aktualizacji stanu połączenia i powiadamiania interfejsu użytkownika
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

    // Przetwarzanie kolejki sygnałów
    async processSignalQueue(peerId) {
        // Ustaw flagę przetwarzania
        this.isProcessingSignals[peerId] = true;
        
        try {
            while (this.signalQueue[peerId] && this.signalQueue[peerId].length > 0) {
                const signal = this.signalQueue[peerId][0];
                
                if (signal.type === 'offer') {
                    // Offer wymaga specjalnego traktowania - może wymagać inicjalizacji nowego połączenia
                    await this.handleOfferSignal(peerId, signal);
                } else {
                    // Dla innych sygnałów, upewnij się że połączenie istnieje
                    await this.handleRegularSignal(peerId, signal);
                }
                
                // Usuń przetworzony sygnał z kolejki
                this.signalQueue[peerId].shift();
                
                // Dodajemy małe opóźnienie między przetwarzaniem sygnałów
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas przetwarzania kolejki sygnałów dla ${peerId}: ${error.message}`);
            
            // NOWE: Aktualizacja stanu połączenia w przypadku błędu
            this.updateConnectionState(peerId, 'error', { error: error.message });
        } finally {
            // Wyczyść flagę przetwarzania
            this.isProcessingSignals[peerId] = false;
        }
    }

    // Obsługa sygnału typu offer
    async handleOfferSignal(peerId, signal) {
        console.log(`[DEBUG] Przetwarzanie sygnału offer od ${peerId}`);
        
        try {
            // Aktualizuj stan połączenia
            this.updateConnectionState(peerId, 'signaling', { type: 'offer' });
            
            // Sprawdź blokadę połączenia
            if (this.connectionLocks[peerId]) {
                console.log(`[DEBUG] Oczekiwanie na zwolnienie blokady połączenia dla ${peerId}`);
                await this.waitForConnectionLock(peerId);
            }
            
            // Ustaw blokadę
            this.connectionLocks[peerId] = true;
            
            // Jeśli jest aktywne połączenie, ale otrzymujemy ofertę, zamknij je i utwórz nowe
            if (this.activeConnections[peerId]) {
                console.log(`[DEBUG] Zamykanie istniejącego połączenia przed utworzeniem nowego dla ${peerId}`);
                this.cleanupConnection(peerId);
                
                // Krótkie opóźnienie przed utworzeniem nowego połączenia
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            // Tworzenie nowego połączenia jako odpowiadający (nie initiator)
            console.log(`[DEBUG] Tworzenie połączenia jako odpowiadający dla ${peerId}`);
            const connection = await this.createPeerConnection(peerId, false);
            
            // Upewnij się, że SimplePeer będzie miał kanał danych
            if (connection._pc && !connection._pc.ondatachannel) {
                console.log(`[DEBUG] Dodawanie obsługi zdarzenia ondatachannel dla ${peerId}`);
                connection._pc.ondatachannel = (event) => {
                    console.log(`[DEBUG] Otrzymano zdarzenie ondatachannel dla ${peerId}`);
                    connection._channel = event.channel;
                    
                    event.channel.onopen = () => {
                        console.log(`[DEBUG] Kanał danych otwarty dla ${peerId}`);
                        this.dataChannelStates[peerId] = 'open';
                        
                        // NOWE: Aktualizacja stanu połączenia
                        this.updateConnectionState(peerId, 'data_channel_open');
                        
                        // Wywołaj 'connect' jeśli nie było jeszcze wywołane
                        if (!connection._connected) {
                            connection.emit('connect');
                        }
                    };
                    
                    event.channel.onclose = () => {
                        console.log(`[DEBUG] Kanał danych zamknięty dla ${peerId}`);
                        this.dataChannelStates[peerId] = 'closed';
                        
                        // NOWE: Aktualizacja stanu połączenia
                        this.updateConnectionState(peerId, 'data_channel_closed');
                    };
                    
                    event.channel.onerror = (err) => {
                        console.error(`[BŁĄD] Błąd kanału danych dla ${peerId}:`, err);
                        this.dataChannelStates[peerId] = 'error';
                        
                        // NOWE: Aktualizacja stanu połączenia
                        this.updateConnectionState(peerId, 'data_channel_error', { error: err.message });
                    };
                };
            }
            
            // Przekazanie oferty do połączenia
            if (connection && typeof connection.signal === 'function') {
                console.log(`[DEBUG] Przekazywanie oferty do ${peerId}`);
                await connection.signal(signal);
            } else {
                console.error(`[BŁĄD] Nie można przekazać oferty - brak połączenia lub metody signal`);
                this.updateConnectionState(peerId, 'error', { error: 'Brak połączenia lub metody signal' });
            }
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas obsługi oferty od ${peerId}: ${error.message}`);
            // Resetuj połączenie w przypadku błędu
            this.cleanupConnection(peerId);
            
            // NOWE: Aktualizacja stanu połączenia
            this.updateConnectionState(peerId, 'error', { error: error.message });
        } finally {
            // Zwolnij blokadę
            this.connectionLocks[peerId] = false;
        }
    }

    // Obsługa standardowych sygnałów (nie-offer)
    async handleRegularSignal(peerId, signal) {
        try {
            // NOWE: Aktualizacja stanu połączenia
            this.updateConnectionState(peerId, 'signaling', { type: signal.type || 'candidate' });
            
            // Sprawdź czy połączenie istnieje lub utwórz je, jeśli nie
            if (!this.activeConnections[peerId] && !this.isConnecting[peerId]) {
                console.log(`[DEBUG] Tworzenie nowego połączenia dla sygnału nie-offer od ${peerId}`);
                await this.createPeerConnection(peerId, false);
            }
            
            // Przekazanie sygnału do połączenia
            if (this.activeConnections[peerId] && typeof this.activeConnections[peerId].signal === 'function') {
                console.log(`[DEBUG] Przekazywanie sygnału ${signal.type || 'candidate'} do ${peerId}`);
                await this.activeConnections[peerId].signal(signal);
            } else {
                console.warn(`[OSTRZEŻENIE] Nie można przekazać sygnału - połączenie nie jest gotowe`);
                // Dodaj sygnał z powrotem na początek kolejki
                if (this.signalQueue[peerId]) {
                    this.signalQueue[peerId].unshift(signal);
                }
                // Dodaj opóźnienie przed ponowną próbą
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas obsługi sygnału dla ${peerId}: ${error.message}`);
            
            // NOWE: Aktualizacja stanu połączenia
            this.updateConnectionState(peerId, 'error', { error: error.message });
        }
    }

    // Oczekiwanie na zwolnienie blokady połączenia
    async waitForConnectionLock(peerId) {
        const maxWaitTime = 10000; // 10 sekund
        const checkInterval = 100; // Co 100 ms
        let waitTime = 0;
        
        return new Promise((resolve, reject) => {
            const checkLock = () => {
                if (!this.connectionLocks[peerId]) {
                    resolve();
                    return;
                }
                
                waitTime += checkInterval;
                if (waitTime >= maxWaitTime) {
                    console.warn(`[OSTRZEŻENIE] Timeout oczekiwania na blokadę połączenia dla ${peerId}`);
                    this.connectionLocks[peerId] = false;
                    resolve();
                    return;
                }
                
                setTimeout(checkLock, checkInterval);
            };
            
            checkLock();
        });
    }

    // Rejestracja nazwy urządzenia
    registerDevice(name) {
        this.deviceName = name;
        console.log(`[DEBUG] Rejestracja urządzenia: ${name}`);
        this.socket.emit('register-name', name);
    }

    // Pobieranie konfiguracji ICE serwerów z gwarancją fallbacku
    async getIceServers() {
        // Rozszerzony zestaw publicznych serwerów STUN/TURN jako fallback
        const publicServers = [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
            // Dodane więcej publicznych serwerów STUN
            { urls: 'stun:stun.ekiga.net' },
            { urls: 'stun:stun.ideasip.com' },
            { urls: 'stun:stun.schlund.de' },
            {
                urls: 'turn:numb.viagenie.ca',
                username: 'webrtc@live.com',
                credential: 'muazkh'
            },
            {
                urls: 'turn:openrelay.metered.ca:80',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            },
            {
                urls: 'turn:openrelay.metered.ca:443',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            },
            {
                urls: 'turn:openrelay.metered.ca:443?transport=tcp',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            }
        ];

        // Jeśli ustawiono flagę awaryjną, użyj tylko podstawowych serwerów STUN/TURN
        if (this.useFallbackIceServers) {
            console.log('[DEBUG] Używam awaryjnych serwerów ICE');
            return publicServers;
        }

        try {
            console.log('[DEBUG] Pobieranie poświadczeń TURN z serwera...');
            const startTime = Date.now();
            
            // Użyj AbortController dla obsługi timeoutu
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 sekund timeout
            
            try {
                const response = await fetch('/api/turn-credentials', {
                    method: 'GET',
                    headers: {
                        'Accept': 'application/json',
                        'Cache-Control': 'no-cache',
                        'Pragma': 'no-cache' // Dodatkowa flaga dla starszych przeglądarek
                    },
                    cache: 'no-store',
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                const responseTime = Date.now() - startTime;
                console.log(`[DEBUG] Otrzymano odpowiedź z serwera TURN w ${responseTime}ms`);
                
                if (!response.ok) {
                    console.warn(`[OSTRZEŻENIE] Serwer zwrócił kod ${response.status}`);
                    return publicServers;
                }
                
                const data = await response.json();
                
                if (!Array.isArray(data) || data.length === 0) {
                    console.warn('[OSTRZEŻENIE] Otrzymano nieprawidłowe dane z serwera TURN:', data);
                    return publicServers;
                }
                
                console.log(`[DEBUG] Pobrano ${data.length} serwerów ICE:`, 
                    data.map(server => server.urls).join(', '));
                
                // NOWE: Najpierw dodaj serwery STUN, następnie TURN
                // Rozdzielenie serwerów STUN i TURN dla lepszego zarządzania połączeniami
                const stunServers = publicServers.filter(server => 
                    typeof server.urls === 'string' && server.urls.startsWith('stun:')
                );
                const turnServers = data.concat(
                    publicServers.filter(server => 
                        typeof server.urls === 'string' && server.urls.startsWith('turn:')
                    )
                );
                
                // Zawsze zwracaj najpierw serwery STUN, potem TURN - preferuj połączenia P2P
                return [...stunServers, ...turnServers];
            } catch (error) {
                clearTimeout(timeoutId);
                throw error;
            }
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas pobierania poświadczeń TURN: ${error.message}`);
            return publicServers;
        }
    }

    /**
     * Rozszerzona identyfikacja typów danych binarnych
     * @param {*} data - Dane do sprawdzenia
     * @returns {boolean} - Czy dane są binarne
     */
    isBinaryData(data) {
        // Sprawdzamy wszystkie możliwe typy danych binarnych
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

    // Nowa funkcja do oczekiwania na otwarcie kanału danych
    async waitForDataChannel(targetPeerId, timeout = 15000) {
        console.log(`[DEBUG] Oczekiwanie na gotowość kanału danych dla ${targetPeerId}...`);
        
        const startTime = Date.now();
        
        // NOWE: Aktualizacja stanu
        this.updateConnectionState(targetPeerId, 'waiting_for_data_channel');
        
        return new Promise((resolve, reject) => {
            // Sprawdź czy kanał danych istnieje i jest otwarty
            const checkChannel = () => {
                // Sprawdź czy połączenie wciąż istnieje
                if (!this.activeConnections[targetPeerId]) {
                    
                    // NOWE: Aktualizacja stanu
                    this.updateConnectionState(targetPeerId, 'connection_closed');
                    
                    reject(new Error('Połączenie zostało zamknięte podczas oczekiwania na kanał danych'));
                    return;
                }
                
                const dataChannel = this.activeConnections[targetPeerId]._channel;
                
                // Jeśli kanał danych istnieje i jest otwarty, zwróć sukces
                if (dataChannel && dataChannel.readyState === 'open') {
                    console.log(`[DEBUG] Kanał danych dla ${targetPeerId} jest gotowy`);
                    this.dataChannelStates[targetPeerId] = 'open';
                    
                    // NOWE: Aktualizacja stanu
                    this.updateConnectionState(targetPeerId, 'data_channel_open');
                    
                    resolve(true);
                    return;
                }
                
                // Sprawdź, czy minął timeout
                if (Date.now() - startTime > timeout) {
                    console.warn(`[OSTRZEŻENIE] Timeout oczekiwania na otwarcie kanału danych dla ${targetPeerId}`);
                    
                    // NOWE: Aktualizacja stanu
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

    // Utworzenie połączenia peer-to-peer
    async createPeerConnection(targetPeerId, isInitiator = true) {
        try {
            console.log(`[DEBUG] Tworzenie połączenia peer z ${targetPeerId}, initiator: ${isInitiator}`);
            
            // NOWE: Aktualizacja stanu
            this.updateConnectionState(targetPeerId, 'connecting', { isInitiator });
            
            // Sprawdź czy nie ma już blokady na to połączenie
            if (this.connectionLocks[targetPeerId]) {
                console.log(`[DEBUG] Oczekiwanie na zwolnienie blokady połączenia dla ${targetPeerId}`);
                await this.waitForConnectionLock(targetPeerId);
            }
            
            // Ustaw blokadę
            this.connectionLocks[targetPeerId] = true;
            
            try {
                // Oznacz, że rozpoczęto łączenie
                this.isConnecting[targetPeerId] = true;
                
                // Sprawdź czy ten peer miał wcześniej problemy z ICE
                if (this.iceFailedPeers.has(targetPeerId)) {
                    console.log(`[DEBUG] Używam ostrożniejszej konfiguracji dla ${targetPeerId} z powodu wcześniejszych problemów ICE`);
                    // Użyj bardziej zachowawczej konfiguracji
                    this.useFallbackIceServers = true;
                }
                
                // Pobierz konfigurację ICE serwerów
                const iceServers = await this.getIceServers();
                
                // Zapisz używane serwery ICE do debugowania
                console.log('[DEBUG] Używane serwery ICE:', 
                    iceServers.map(server => ({
                        urls: server.urls,
                        ...(server.username ? { username: '***' } : {}),
                        ...(server.credential ? { credential: '***' } : {})
                    }))
                );
                
                // NOWE: Aktualizacja stanu
                this.updateConnectionState(targetPeerId, 'configuring_ice');
                
                // Konfiguracja peer connection z poprawionymi opcjami (usunięto duplikaty)
                const peerConfig = {
                    initiator: isInitiator,
                    trickle: true,
                    config: { 
                        iceServers: iceServers,
                        iceTransportPolicy: 'all',
                        sdpSemantics: 'unified-plan',
                        iceCandidatePoolSize: 10,
                        bundlePolicy: 'max-bundle',
                        rtcpMuxPolicy: 'require'
                    },
                    // Konfiguracja czasów oczekiwania i ponownych prób
                    reconnectTimer: 3000,
                    iceCompleteTimeout: 5000,
                    offerOptions: {
                        offerToReceiveAudio: false,
                        offerToReceiveVideo: false
                    },
                    channelConfig: {
                        ordered: true,       // Gwarantuje kolejność dostarczania pakietów
                        maxRetransmits: 30   // Maksymalna liczba ponownych prób dla niezawodności
                    },
                    channelName: 'sendfile',  // Konkretna nazwa kanału
                    // Wskazówki dla negocjacji ICE
                    sdpTransform: (sdp) => {
                        // Zwiększenie priorytetów dla różnych typów kandydatów ICE
                        sdp = sdp.replace(/a=candidate:.*udp.*typ host.*\r\n/g, (match) => {
                            return match.replace(/generation [0-9]+ /, 'generation 0 ');
                        });
                        
                        // Poprawki dla różnych typów sieci i przeglądarek
                        sdp = sdp.replace(/a=ice-options:trickle\r\n/g, 'a=ice-options:trickle renomination\r\n');
                        
                        // Dodanie bardziej szczegółowego logu
                        console.log(`[DEBUG] Transformacja SDP dla ${targetPeerId}, rozmiar: ${sdp.length} znaków`);
                        return sdp;
                    }
                };
                
                // Sprawdzenie czy SimplePeer jest dostępny
                if (typeof SimplePeer !== 'function') {
                    throw new Error('Biblioteka SimplePeer nie jest dostępna. Sprawdź, czy została poprawnie załadowana.');
                }
                
                // NOWE: Aktualizacja stanu
                this.updateConnectionState(targetPeerId, 'creating_peer');
                
                // Tworzenie obiektu peer
                const peer = new SimplePeer(peerConfig);
                
                // Śledź stan połączenia ICE
                let iceConnectionState = null;
                let iceGatheringState = null;
                let signalingState = null;
                
                // Śledzenie czasu nawiązywania połączenia
                const connectionStartTime = Date.now();
                
                // Obsługa sygnałów WebRTC
                peer.on('signal', (data) => {
                    console.log(`[DEBUG] Wysyłanie sygnału do ${targetPeerId}: typ=${data.type || 'candidate'}`);
                    
                    // NOWE: Aktualizacja stanu
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
                        
                        // NOWE: Aktualizacja stanu
                        this.updateConnectionState(targetPeerId, 'error', { 
                            error: 'Nie można wysłać sygnału - socket jest null lub rozłączony' 
                        });
                    }
                });
                
                // Rozszerzona obsługa błędów
                peer.on('error', (err) => {
                    console.error(`[BŁĄD] Błąd połączenia peer (${targetPeerId}):`, err.message);
                    
                    // Zgłoś szczegóły stanu połączenia
                    console.error(`[BŁĄD] Stan połączenia: ICE=${iceConnectionState}, gathering=${iceGatheringState}, signaling=${signalingState}`);
                    
                    // Logowanie szczegółów połączenia
                    if (peer._pc) {
                        console.error(`[BŁĄD] Connection state: ${peer._pc.connectionState}`);
                        console.error(`[BŁĄD] ICE connection state: ${peer._pc.iceConnectionState}`);
                        console.error(`[BŁĄD] ICE gathering state: ${peer._pc.iceGatheringState}`);
                        console.error(`[BŁĄD] Signaling state: ${peer._pc.signalingState}`);
                    }
                    
                    // NOWE: Aktualizacja stanu
                    this.updateConnectionState(targetPeerId, 'error', { 
                        error: err.message,
                        iceState: iceConnectionState,
                        gatheringState: iceGatheringState,
                        signalingState: signalingState
                    });
                    
                    // Decyzja o przełączeniu na awaryjne serwery ICE
                    if (!this.useFallbackIceServers && 
                        (err.message.includes('ICE') || 
                         iceConnectionState === 'failed' || 
                         (peer._pc && peer._pc.iceConnectionState === 'failed'))) {
                        
                        console.log('[DEBUG] Wykryto problem z ICE, przełączam na awaryjne serwery ICE');
                        this.useFallbackIceServers = true;
                        
                        // NOWE: Aktualizacja stanu
                        this.updateConnectionState(targetPeerId, 'switching_to_fallback_ice');
                        
                        // Zresetuj licznik ponownych prób
                        if (!this.peerRetryCount[targetPeerId]) {
                            this.peerRetryCount[targetPeerId] = 0;
                        }
                        
                        // Oznacz tego peera jako problematycznego
                        this.iceFailedPeers.add(targetPeerId);
                        
                        // Usuń obecne połączenie
                        this.cleanupConnection(targetPeerId, peer);
                        
                        // Zwolnij blokadę połączenia
                        this.connectionLocks[targetPeerId] = false;
                        
                        // Spróbuj ponownie z awaryjnymi serwerami
                        setTimeout(() => {
                            this.createPeerConnection(targetPeerId, isInitiator)
                            .catch(fallbackError => {
                                console.error('[BŁĄD] Nieudana próba z awaryjnymi serwerami:', fallbackError);
                                
                                // NOWE: Aktualizacja stanu
                                this.updateConnectionState(targetPeerId, 'fallback_failed', { 
                                    error: fallbackError.message 
                                });
                                
                                if (this.onTransferError) {
                                    this.onTransferError(targetPeerId, 'Nie udało się nawiązać połączenia nawet z awaryjnymi serwerami.');
                                }
                                delete this.isConnecting[targetPeerId];
                                this.connectionLocks[targetPeerId] = false;
                            });
                        }, 2000); // Zwiększony czas oczekiwania przed ponowną próbą
                        
                        return;
                    }
                    
                    // Mechanizm ponownych prób połączenia specyficzny dla peera
                    if (!this.peerRetryCount[targetPeerId]) {
                        this.peerRetryCount[targetPeerId] = 0;
                    }
                    
                    const maxRetries = 5; // Limit ponownych prób dla pojedynczego peera
                    
                    if (this.peerRetryCount[targetPeerId] < maxRetries) {
                        console.log(`[DEBUG] Próba ponownego połączenia dla ${targetPeerId}: ${this.peerRetryCount[targetPeerId] + 1}/${maxRetries}`);
                        this.peerRetryCount[targetPeerId]++;
                        
                        // NOWE: Aktualizacja stanu
                        this.updateConnectionState(targetPeerId, 'retrying', { 
                            attempt: this.peerRetryCount[targetPeerId],
                            maxRetries: maxRetries
                        });
                        
                        // Usuń obecne połączenie i utwórz nowe
                        this.cleanupConnection(targetPeerId, peer);
                        
                        // Zwolnij blokadę połączenia
                        this.connectionLocks[targetPeerId] = false;
                        
                        // Oczekuj chwilę przed ponowną próbą - zwiększaj opóźnienie wykładniczo
                        const retryDelay = Math.min(2000 * Math.pow(1.5, this.peerRetryCount[targetPeerId]), 30000);
                        setTimeout(() => {
                            this.createPeerConnection(targetPeerId, isInitiator)
                            .catch(retryError => {
                                console.error('[BŁĄD] Nieudana próba ponownego połączenia:', retryError);
                                
                                // NOWE: Aktualizacja stanu
                                this.updateConnectionState(targetPeerId, 'retry_failed', { 
                                    error: retryError.message,
                                    attempt: this.peerRetryCount[targetPeerId]
                                });
                                
                                if (this.onTransferError) {
                                    this.onTransferError(targetPeerId, 'Nie udało się nawiązać połączenia po kilku próbach.');
                                }
                                delete this.isConnecting[targetPeerId];
                                this.connectionLocks[targetPeerId] = false;
                            });
                        }, retryDelay);
                    } else {
                        // Powiadom o błędzie po wyczerpaniu prób
                        console.error(`[BŁĄD] Wyczerpano ${maxRetries} prób połączenia z ${targetPeerId}`);
                        this.peerRetryCount[targetPeerId] = 0;
                        delete this.isConnecting[targetPeerId];
                        
                        // NOWE: Aktualizacja stanu
                        this.updateConnectionState(targetPeerId, 'max_retries_exceeded');
                        
                        this.connectionLocks[targetPeerId] = false;
                        if (this.onTransferError) {
                            this.onTransferError(targetPeerId, err.message);
                        }
                    }
                });
                
                // Obsługa nawiązania połączenia
                peer.on('connect', () => {
                    const connectionTime = Date.now() - connectionStartTime;
                    console.log(`[DEBUG] Pomyślnie połączono z peerem: ${targetPeerId} (czas: ${connectionTime}ms)`);
                    
                    // Resetuj licznik prób po udanym połączeniu
                    this.peerRetryCount[targetPeerId] = 0;
                    
                    // Jeśli to był peer z problemami ICE, możemy zresetować flagę
                    if (this.iceFailedPeers.has(targetPeerId)) {
                        this.iceFailedPeers.delete(targetPeerId);
                        console.log(`[DEBUG] Usunięto ${targetPeerId} z listy peerów z problemami ICE`);
                    }
                    
                    delete this.isConnecting[targetPeerId]; // Usuń znacznik nawiązywania połączenia
                    
                    // NOWE: Aktualizacja stanu
                    this.updateConnectionState(targetPeerId, 'connected', { connectionTime });
                    
                    this.connectionLocks[targetPeerId] = false; // Zwolnij blokadę połączenia
                    
                    // Dodaj obsługę kanału danych, jeśli istnieje
                    if (peer._channel) {
                        console.log(`[DEBUG] Kanał danych jest dostępny po połączeniu z ${targetPeerId}`);
                        this.dataChannelStates[targetPeerId] = peer._channel.readyState;
                        
                        // NOWE: Aktualizacja stanu kanału danych
                        this.updateConnectionState(targetPeerId, 'data_channel_ready', { 
                            state: peer._channel.readyState 
                        });
                    } else {
                        console.warn(`[OSTRZEŻENIE] Połączenie nawiązane, ale brak kanału danych dla ${targetPeerId}`);
                        
                        // NOWE: Aktualizacja stanu
                        this.updateConnectionState(targetPeerId, 'no_data_channel');
                        
                        // Spróbuj utworzyć kanał danych ręcznie
                        try {
                            if (peer._pc) {
                                const dataChannel = peer._pc.createDataChannel('sendFile');
                                console.log(`[DEBUG] Ręcznie utworzono kanał danych dla ${targetPeerId}`);
                                
                                // Obserwuj stan kanału
                                dataChannel.onopen = () => {
                                    console.log(`[DEBUG] Ręcznie utworzony kanał danych otwarty dla ${targetPeerId}`);
                                    this.dataChannelStates[targetPeerId] = 'open';
                                    
                                    // NOWE: Aktualizacja stanu
                                    this.updateConnectionState(targetPeerId, 'data_channel_open');
                                }
                                dataChannel.onclose = () => {
                                    console.log(`[DEBUG] Ręcznie utworzony kanał danych zamknięty dla ${targetPeerId}`);
                                    this.dataChannelStates[targetPeerId] = 'closed';
                                    
                                    // NOWE: Aktualizacja stanu
                                    this.updateConnectionState(targetPeerId, 'data_channel_closed');
                                }
                                dataChannel.onerror = (e) => {
                                    console.error(`[BŁĄD] Błąd ręcznie utworzonego kanału danych: ${e.message}`);
                                    this.dataChannelStates[targetPeerId] = 'error';
                                    
                                    // NOWE: Aktualizacja stanu
                                    this.updateConnectionState(targetPeerId, 'data_channel_error', { 
                                        error: e.message 
                                    });
                                }
                                
                                peer._channel = dataChannel;
                            }
                        } catch (e) {
                            console.error(`[BŁĄD] Nie udało się utworzyć kanału danych ręcznie: ${e.message}`);
                            
                            // NOWE: Aktualizacja stanu
                            this.updateConnectionState(targetPeerId, 'manual_data_channel_failed', { 
                                error: e.message 
                            });
                        }
                    }
                });
                
                // Obsługa przychodzących danych
                peer.on('data', (data) => {
                    try {
                        // Debug: raportuj rozmiar otrzymanych danych
                        const size = data.byteLength || data.length || (data.size ? data.size : 'nieznany');
                        console.log(`[DEBUG] Otrzymano dane od ${targetPeerId}, rozmiar: ${size} bajtów`);
                        
                        // NOWE: Aktualizacja stanu jeśli to pierwszy fragment danych
                        if (!this.transferStates[targetPeerId] || this.transferStates[targetPeerId] !== 'receiving') {
                            this.transferStates[targetPeerId] = 'receiving';
                            this.updateConnectionState(targetPeerId, 'receiving_data', { size });
                        }
                        
                        // Użyj metody handleIncomingData do przetwarzania danych
                        this.handleIncomingData(targetPeerId, data);
                    } catch (dataError) {
                        console.error(`[BŁĄD] Problem podczas obsługi otrzymanych danych: ${dataError.message}`);
                        
                        // NOWE: Aktualizacja stanu
                        this.updateConnectionState(targetPeerId, 'data_processing_error', { 
                            error: dataError.message 
                        });
                    }
                });
                
                // Obsługa zamknięcia połączenia
                peer.on('close', () => {
                    console.log(`[DEBUG] Zamknięto połączenie z peerem: ${targetPeerId}`);
                    
                    // NOWE: Aktualizacja stanu
                    this.updateConnectionState(targetPeerId, 'connection_closed');
                    
                    // Jeśli mamy kanał danych, zamknij go
                    if (peer._channel && peer._channel.readyState === 'open') {
                        try {
                            peer._channel.close();
                        } catch (err) {
                            console.error(`[BŁĄD] Błąd podczas zamykania kanału danych: ${err.message}`);
                        }
                    }
                    
                    delete this.connectionStates[targetPeerId];
                    delete this.dataChannelStates[targetPeerId];
                    this.cleanupConnection(targetPeerId);
                    // Zwolnij blokadę połączenia
                    this.connectionLocks[targetPeerId] = false;
                });
                
                // Dodatkowe monitorowanie stanu ICE
                peer.on('iceStateChange', (state) => {
                    iceConnectionState = state;
                    console.log(`[DEBUG] Zmiana stanu ICE dla ${targetPeerId}: ${state}`);
                    
                    // NOWE: Aktualizacja stanu
                    this.updateConnectionState(targetPeerId, 'ice_state_change', { iceState: state });
                    
                    // Obsługa różnych stanów ICE
                    switch (state) {
                        case 'checking':
                            console.log(`[DEBUG] Sprawdzanie kandydatów ICE dla ${targetPeerId}`);
                            
                            // NOWE: Aktualizacja stanu
                            this.updateConnectionState(targetPeerId, 'ice_checking');
                            break;
                            
                        case 'connected':
                        case 'completed':
                            console.log(`[DEBUG] Połączenie ICE nawiązane dla ${targetPeerId}`);
                            this.iceFailedPeers.delete(targetPeerId);
                            
                            // NOWE: Aktualizacja stanu
                            this.updateConnectionState(targetPeerId, 'ice_connected');
                            
                            // Ustaw połączenie jako gotowe do użycia, nawet jeśli jeszcze nie otrzymaliśmy zdarzenia 'connect'
                            if (this.connectionStates[targetPeerId] !== 'connected') {
                                this.updateConnectionState(targetPeerId, 'ice_ready');
                                delete this.isConnecting[targetPeerId];
                                this.connectionLocks[targetPeerId] = false; // Zwolnij blokadę połączenia
                            }
                            break;
                            
                        case 'failed':
                            console.error(`[BŁĄD] Połączenie ICE nie powiodło się dla ${targetPeerId}`);
                            this.iceFailedPeers.add(targetPeerId);
                            
                            // NOWE: Aktualizacja stanu
                            this.updateConnectionState(targetPeerId, 'ice_failed');
                            
                            if (this.onTransferError) {
                                this.onTransferError(targetPeerId, 'Nie udało się nawiązać połączenia ICE. Spróbuj ponownie później.');
                            }
                            
                            // Zwolnij blokadę połączenia
                            this.connectionLocks[targetPeerId] = false;
                            break;
                            
                        case 'disconnected':
                            console.warn(`[OSTRZEŻENIE] Połączenie ICE rozłączone dla ${targetPeerId}`);
                            
                            // NOWE: Aktualizacja stanu
                            this.updateConnectionState(targetPeerId, 'ice_disconnected');
                            break;
                            
                        case 'closed':
                            console.log(`[DEBUG] Połączenie ICE zamknięte dla ${targetPeerId}`);
                            
                            // NOWE: Aktualizacja stanu
                            this.updateConnectionState(targetPeerId, 'ice_closed');
                            
                            // Zwolnij blokadę połączenia
                            this.connectionLocks[targetPeerId] = false;
                            break;
                    }
                });
                
                // Dodatkowe monitorowanie jeśli peer udostępnia te informacje
                if (peer._pc) {
                    // Dodaj obsługę zdarzenia datachannel
                    peer._pc.ondatachannel = (event) => {
                        console.log(`[DEBUG] Otrzymano zdarzenie datachannel dla ${targetPeerId}`);
                        peer._channel = event.channel;
                        
                        // NOWE: Aktualizacja stanu
                        this.updateConnectionState(targetPeerId, 'data_channel_received');
                        
                        event.channel.onopen = () => {
                            console.log(`[DEBUG] Kanał danych otwarty dla ${targetPeerId}`);
                            this.dataChannelStates[targetPeerId] = 'open';
                            
                            // NOWE: Aktualizacja stanu
                            this.updateConnectionState(targetPeerId, 'data_channel_open');
                        };
                        
                        event.channel.onclose = () => {
                            console.log(`[DEBUG] Kanał danych zamknięty dla ${targetPeerId}`);
                            this.dataChannelStates[targetPeerId] = 'closed';
                            
                            // NOWE: Aktualizacja stanu
                            this.updateConnectionState(targetPeerId, 'data_channel_closed');
                        };
                        
                        event.channel.onerror = (err) => {
                            console.error(`[BŁĄD] Błąd kanału danych dla ${targetPeerId}:`, err);
                            this.dataChannelStates[targetPeerId] = 'error';
                            
                            // NOWE: Aktualizacja stanu
                            this.updateConnectionState(targetPeerId, 'data_channel_error', { 
                                error: err.message || 'Nieznany błąd kanału danych'
                            });
                        };
                    };
                    
                    // Bezpośrednie monitorowanie stanu RTCPeerConnection
                    const monitorConnectionState = () => {
                        try {
                            if (!peer._pc) return;
                            
                            const pc = peer._pc;
                            
                            iceGatheringState = pc.iceGatheringState;
                            signalingState = pc.signalingState;
                            
                            console.log(`[DEBUG] Stan połączenia dla ${targetPeerId}:`, {
                                connectionState: pc.connectionState,
                                iceConnectionState: pc.iceConnectionState,
                                iceGatheringState: pc.iceGatheringState,
                                signalingState: pc.signalingState
                            });
                            
                            // NOWE: Aktualizacja stanu z większą szczegółowością
                            this.updateConnectionState(targetPeerId, 'connection_state_update', {
                                connectionState: pc.connectionState,
                                iceConnectionState: pc.iceConnectionState,
                                iceGatheringState: pc.iceGatheringState,
                                signalingState: pc.signalingState
                            });
                            
                            // Obsługa stanu połączenia WebRTC
                            if (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected') {
                                this.updateConnectionState(targetPeerId, 'webrtc_connected');
                                delete this.isConnecting[targetPeerId];
                                this.connectionLocks[targetPeerId] = false; // Zwolnij blokadę połączenia
                            }
                            
                            // Kontynuuj monitorowanie co 2 sekundy, jeśli połączenie nadal istnieje
                            if (this.activeConnections[targetPeerId]) {
                                setTimeout(monitorConnectionState, 2000);
                            }
                        } catch (e) {
                            console.error(`[BŁĄD] Problem podczas monitorowania stanu połączenia: ${e.message}`);
                        }
                    };
                    
                    // Rozpocznij monitorowanie
                    monitorConnectionState();
                    
                    // Dodaj obserwatory zdarzeń
                    peer._pc.addEventListener('icegatheringstatechange', () => {
                        iceGatheringState = peer._pc.iceGatheringState;
                        console.log(`[DEBUG] Zmiana stanu zbierania ICE dla ${targetPeerId}: ${peer._pc.iceGatheringState}`);
                        
                        // NOWE: Aktualizacja stanu
                        this.updateConnectionState(targetPeerId, 'ice_gathering_change', {
                            state: peer._pc.iceGatheringState
                        });
                        
                        // Gdy zbieranie kandydatów jest zakończone, możemy zacząć używać połączenia
                        // nawet jeśli jeszcze nie otrzymaliśmy zdarzenia 'connect'
                        if (peer._pc.iceGatheringState === 'complete' && this.earlyMessageEnabled) {
                            // Poczekaj dodatkowy moment przed ustaleniem połączenia jako gotowe
                            setTimeout(() => {
                                if (this.activeConnections[targetPeerId] && this.isConnecting[targetPeerId]) {
                                    console.log(`[DEBUG] Zbieranie ICE zakończone dla ${targetPeerId}, oznaczanie połączenia jako wstępnie gotowe`);
                                    
                                    // NOWE: Aktualizacja stanu
                                    this.updateConnectionState(targetPeerId, 'early_ready');
                                }
                            }, 1000);
                        }
                    });
                    
                    peer._pc.addEventListener('signalingstatechange', () => {
                        signalingState = peer._pc.signalingState;
                        console.log(`[DEBUG] Zmiana stanu sygnalizacji dla ${targetPeerId}: ${peer._pc.signalingState}`);
                        
                        // NOWE: Aktualizacja stanu
                        this.updateConnectionState(targetPeerId, 'signaling_state_change', {
                            state: peer._pc.signalingState
                        });
                    });
                    
                    peer._pc.addEventListener('connectionstatechange', () => {
                        console.log(`[DEBUG] Zmiana stanu połączenia dla ${targetPeerId}: ${peer._pc.connectionState}`);
                        
                        // NOWE: Aktualizacja stanu
                        this.updateConnectionState(targetPeerId, 'webrtc_state_change', {
                            state: peer._pc.connectionState
                        });
                        
                        // Obsługa zmiany stanu połączenia
                        switch (peer._pc.connectionState) {
                            case 'connected':
                                this.updateConnectionState(targetPeerId, 'webrtc_connected');
                                delete this.isConnecting[targetPeerId];
                                this.connectionLocks[targetPeerId] = false; // Zwolnij blokadę połączenia
                                break;
                                
                            case 'failed':
                                console.error(`[BŁĄD] Połączenie WebRTC failed dla ${targetPeerId}`);
                                this.updateConnectionState(targetPeerId, 'webrtc_failed');
                                this.connectionLocks[targetPeerId] = false; // Zwolnij blokadę połączenia
                                
                                if (this.onTransferError) {
                                    this.onTransferError(targetPeerId, `Połączenie WebRTC ${peer._pc.connectionState}`);
                                }
                                break;
                                
                            case 'disconnected':
                                console.error(`[BŁĄD] Połączenie WebRTC disconnected dla ${targetPeerId}`);
                                this.updateConnectionState(targetPeerId, 'webrtc_disconnected');
                                this.connectionLocks[targetPeerId] = false; // Zwolnij blokadę połączenia
                                
                                if (this.onTransferError) {
                                    this.onTransferError(targetPeerId, `Połączenie WebRTC ${peer._pc.connectionState}`);
                                }
                                break;
                        }
                    });
                    
                    // Dodanie obserwatora kandydatów ICE z rozszerzonym logowaniem
                    peer._pc.onicecandidate = (event) => {
                        if (event.candidate) {
                            console.log(`[DEBUG] Nowy kandydat ICE dla ${targetPeerId}:`, 
                                event.candidate.candidate || 'brak szczegółów',
                                `typ: ${event.candidate.type || 'nieznany'}`, 
                                `protokół: ${event.candidate.protocol || 'nieznany'}`);
                            
                            // NOWE: Aktualizacja stanu tylko dla lokalnych kandydatów z bardziej szczegółową informacją
                            this.updateConnectionState(targetPeerId, 'new_ice_candidate', {
                                type: event.candidate.type || 'nieznany',
                                protocol: event.candidate.protocol || 'nieznany'
                            });
                        }
                    };
                }
                
                // Ustaw połączenie jako aktywne
                this.activeConnections[targetPeerId] = peer;
                
                // Timeout dla połączenia ICE, aby uniknąć zawieszenia
                const iceTimeoutTimer = setTimeout(() => {
                    if (this.isConnecting[targetPeerId] && this.connectionStates[targetPeerId] !== 'connected') {
                        console.log(`[DEBUG] Timeout zbierania kandydatów ICE dla ${targetPeerId}, przechodzę do trybu wczesnej komunikacji`);
                        
                        // NOWE: Aktualizacja stanu
                        this.updateConnectionState(targetPeerId, 'ice_gathering_timeout');
                        
                        // Jeśli włączona jest opcja wczesnej komunikacji, oznacz połączenie jako gotowe do użycia
                        if (this.earlyMessageEnabled) {
                            this.updateConnectionState(targetPeerId, 'early_ready');
                        }
                    }
                }, this.iceTimeout);
                
                // Główny timeout całego połączenia
                const connectionTimeoutTimer = setTimeout(() => {
                    if (this.isConnecting[targetPeerId] && this.connectionStates[targetPeerId] !== 'connected') {
                        console.error(`[BŁĄD] Przekroczono całkowity czas oczekiwania na połączenie z ${targetPeerId}`);
                        
                        // NOWE: Aktualizacja stanu
                        this.updateConnectionState(targetPeerId, 'connection_timeout');
                        
                        if (this.onTransferError) {
                            this.onTransferError(targetPeerId, 'Przekroczono czas oczekiwania na połączenie');
                        }
                        
                        this.cleanupConnection(targetPeerId, peer);
                        this.connectionLocks[targetPeerId] = false; // Zwolnij blokadę połączenia
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
                delete this.isConnecting[targetPeerId]; // Usuń znacznik nawiązywania połączenia
                
                // NOWE: Aktualizacja stanu
                this.updateConnectionState(targetPeerId, 'connection_error', { error: error.message });
                
                this.connectionLocks[targetPeerId] = false; // Zwolnij blokadę połączenia
                
                if (this.onTransferError) {
                    this.onTransferError(targetPeerId, `Błąd konfiguracji: ${error.message}`);
                }
                throw error;
            }
        } finally {
            // Zapewnienie zwolnienia blokady w przypadku błędu
            this.connectionLocks[targetPeerId] = false;
        }
    }

    // Procedura czyszczenia połączenia
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
    }

    // Sprawdzenie czy połączenie jest gotowe do wysyłania wiadomości
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
        
        // Sprawdzenie stanu z naszego śledzenia
        const connectionState = this.connectionStates[targetPeerId];
        
        // Sprawdzenie, czy jesteśmy w trybie wczesnej komunikacji i stan połączenia sugeruje, że może być gotowe
        // ALE zwracamy true tylko jeśli kanał danych jest również otwarty
        if ((isStandardReady || 
             connectionState === 'connected' || 
             (this.earlyMessageEnabled && connectionState === 'early_ready')) &&
            this.activeConnections[targetPeerId] && 
            this.activeConnections[targetPeerId]._channel) {
            return this.activeConnections[targetPeerId]._channel.readyState === 'open';
        }
        
        return false;
    }

    // NOWE: Potwierdzenie odbioru fragmentu pliku
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
            
            // Wyślij potwierdzenie najlepszą dostępną metodą
            if (connection._channel && connection._channel.readyState === 'open') {
                connection._channel.send(JSON.stringify(ackData));
            } else {
                connection.send(JSON.stringify(ackData));
            }
            
            console.log(`[DEBUG] Wysłano potwierdzenie dla fragmentu ${chunkIndex} pliku ${fileId}`);
            return true;
        } catch (error) {
            console.error(`[BŁĄD] Nie udało się wysłać potwierdzenia: ${error.message}`);
            return false;
        }
    }

    // Wysłanie żądania transferu plików
    async requestFileTransfer(targetPeerId, files) {
        try {
            console.log(`[DEBUG] Wysyłanie żądania transferu ${files.length} plików do ${targetPeerId}`);
            
            // NOWE: Aktualizacja stanu
            this.updateConnectionState(targetPeerId, 'requesting_transfer', {
                fileCount: files.length
            });
            
            // Jeśli ten peer miał wcześniej problemy z ICE, użyj od razu serwerów awaryjnych
            if (this.iceFailedPeers.has(targetPeerId)) {
                this.useFallbackIceServers = true;
                console.log(`[DEBUG] Używam serwerów awaryjnych dla ${targetPeerId} z powodu wcześniejszych problemów ICE`);
            }
            
            // Sprawdź, czy jest aktywne połączenie i czy jest gotowe
            let connection = this.activeConnections[targetPeerId];
            let needNewConnection = !connection || !this.isConnectionReady(targetPeerId);
            
            if (needNewConnection) {
                console.log(`[DEBUG] Brak aktywnego połączenia z ${targetPeerId}, tworzę nowe połączenie`);
                
                // NOWE: Aktualizacja stanu
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
                    
                    // Funkcja sprawdzająca stan połączenia co 500ms
                    const checkConnection = () => {
                        // Sprawdź czy połączenie zostało przerwane
                        if (!this.activeConnections[targetPeerId]) {
                            clearTimeout(connectionTimeout);
                            
                            // NOWE: Aktualizacja stanu
                            this.updateConnectionState(targetPeerId, 'connection_interrupted');
                            
                            reject(new Error('Połączenie zostało zamknięte'));
                            return;
                        }
                        
                        // Sprawdź czy połączenie jest gotowe
                        if (this.activeConnections[targetPeerId]._connected || 
                           this.connectionStates[targetPeerId] === 'connected' || 
                           this.connectionStates[targetPeerId] === 'early_ready') {
                            clearTimeout(connectionTimeout);
                            console.log(`[DEBUG] Połączenie z ${targetPeerId} nawiązane (stan: ${this.connectionStates[targetPeerId]})`);
                            
                            // NOWE: Aktualizacja stanu
                            this.updateConnectionState(targetPeerId, 'ready_for_transfer_request');
                            
                            resolve();
                            return;
                        }
                        
                        // Sprawdź stan połączenia co 500ms
                        setTimeout(checkConnection, 500);
                    };
                    
                    // Funkcja obsługi połączenia
                    const connectHandler = () => {
                        console.log(`[DEBUG] Pomyślnie nawiązano połączenie z ${targetPeerId}`);
                        clearTimeout(connectionTimeout);
                        if (connection.removeListener) {
                            connection.removeListener('connect', connectHandler);
                            connection.removeListener('error', errorHandler);
                        }
                        
                        // NOWE: Aktualizacja stanu
                        this.updateConnectionState(targetPeerId, 'connection_established_for_transfer');
                        
                        resolve();
                    };
                    
                    // Funkcja obsługi błędu
                    const errorHandler = (err) => {
                        console.error(`[BŁĄD] Błąd podczas nawiązywania połączenia z ${targetPeerId}:`, err);
                        clearTimeout(connectionTimeout);
                        if (connection.removeListener) {
                            connection.removeListener('connect', connectHandler);
                            connection.removeListener('error', errorHandler);
                        }
                        
                        // NOWE: Aktualizacja stanu
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
                        
                        // NOWE: Aktualizacja stanu
                        this.updateConnectionState(targetPeerId, 'connection_timeout_for_transfer');
                        
                        // Sprawdź, czy mamy połączenie w trybie wczesnej komunikacji
                        if (this.earlyMessageEnabled && this.connectionStates[targetPeerId] === 'early_ready') {
                            console.log(`[DEBUG] Używanie wczesnego trybu komunikacji dla ${targetPeerId}`);
                            
                            // NOWE: Aktualizacja stanu
                            this.updateConnectionState(targetPeerId, 'using_early_connection');
                            
                            resolve(); // Kontynuuj mimo braku pełnego połączenia
                        } else {
                            reject(new Error('Przekroczono czas oczekiwania na połączenie'));
                        }
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
                // NOWE: Aktualizacja stanu
                this.updateConnectionState(targetPeerId, 'waiting_for_data_channel');
                
                await this.waitForDataChannel(targetPeerId, this.dataChannelTimeout);
                
                // NOWE: Aktualizacja stanu
                this.updateConnectionState(targetPeerId, 'data_channel_ready_for_transfer');
            } catch (channelError) {
                console.warn(`[OSTRZEŻENIE] ${channelError.message}, próbuję mimo to...`);
                
                // NOWE: Aktualizacja stanu
                this.updateConnectionState(targetPeerId, 'data_channel_error_trying_manual', {
                    error: channelError.message
                });
                
                // Jeśli mamy do czynienia z przypadkiem, gdy kanał danych nie jest jeszcze otwarty,
                // spróbujmy kilka razy utworzyć nowy kanał ręcznie
                if (connection && connection._pc && !connection._channel) {
                    for (let attempt = 0; attempt < 3; attempt++) {
                        try {
                            console.log(`[DEBUG] Próba #${attempt+1} utworzenia kanału danych ręcznie...`);
                            
                            // NOWE: Aktualizacja stanu
                            this.updateConnectionState(targetPeerId, 'manual_data_channel_attempt', {
                                attempt: attempt + 1
                            });
                            
                            const dataChannel = connection._pc.createDataChannel('sendFile-' + Date.now());
                            
                            // Poczekaj na otwarcie kanału
                            await new Promise((resolve, reject) => {
                                const timeout = setTimeout(() => reject(new Error('Timeout otwarcia kanału')), 5000);
                                
                                dataChannel.onopen = () => {
                                    clearTimeout(timeout);
                                    
                                    // NOWE: Aktualizacja stanu
                                    this.updateConnectionState(targetPeerId, 'manual_data_channel_open');
                                    
                                    resolve();
                                };
                                
                                dataChannel.onerror = (err) => {
                                    clearTimeout(timeout);
                                    
                                    // NOWE: Aktualizacja stanu
                                    this.updateConnectionState(targetPeerId, 'manual_data_channel_error', {
                                        error: err.message || 'Nieznany błąd'
                                    });
                                    
                                    reject(err);
                                };
                            });
                            
                            connection._channel = dataChannel;
                            this.dataChannelStates[targetPeerId] = 'open';
                            console.log('[DEBUG] Ręcznie utworzony kanał danych jest otwarty!');
                            break;
                        } catch (err) {
                            console.error(`[BŁĄD] Próba #${attempt+1} utworzenia kanału nie powiodła się:`, err);
                            
                            // NOWE: Aktualizacja stanu
                            this.updateConnectionState(targetPeerId, 'manual_data_channel_failed', {
                                attempt: attempt + 1,
                                error: err.message
                            });
                            
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }
                    }
                }
            }
            
            // Zabezpieczenie - sprawdź, czy połączenie jest wciąż aktywne
            if (!this.activeConnections[targetPeerId]) {
                
                // NOWE: Aktualizacja stanu
                this.updateConnectionState(targetPeerId, 'connection_lost_before_request');
                
                throw new Error('Połączenie zostało zamknięte w trakcie procesu nawiązywania');
            }
            
            connection = this.activeConnections[targetPeerId];
            
            // Kolejne zabezpieczenie - sprawdź, czy połączenie posiada metodę send
            if (!connection.send || typeof connection.send !== 'function') {
                
                // NOWE: Aktualizacja stanu
                this.updateConnectionState(targetPeerId, 'connection_invalid');
                
                throw new Error('Połączenie nie obsługuje metody wysyłania danych');
            }
            
            // Upewnij się, że kanał danych istnieje i jest otwarty
            if (!connection._channel || connection._channel.readyState !== 'open') {
                
                // NOWE: Aktualizacja stanu
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
                id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}` // NOWE: Unikalne ID pliku
            }));
            
            const totalSize = filesMetadata.reduce((sum, file) => sum + file.size, 0);
            
            try {
                // Wyślij żądanie transferu plików
                console.log(`[DEBUG] Wysyłanie żądania transferu do ${targetPeerId}`);
                
                // NOWE: Aktualizacja stanu
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
                
                console.log(`[DEBUG] Dane żądania:`, requestData);
                
                // Sprawdź stan kanału danych przed wysyłką
                if (connection._channel && connection._channel.readyState === 'open') {
                    connection._channel.send(JSON.stringify(requestData));
                } else {
                    connection.send(JSON.stringify(requestData));
                }
                
                console.log(`[DEBUG] Pomyślnie wysłano żądanie transferu plików do ${targetPeerId}`);
                
                // NOWE: Aktualizacja stanu
                this.updateConnectionState(targetPeerId, 'waiting_for_transfer_response');
                
                // Zapisz pliki do tymczasowej kolejki oczekując na odpowiedź
                this.pendingTransfers[targetPeerId] = {
                    files: files,
                    filesMetadata: filesMetadata, // NOWE: Zapisz także metadane z ID plików
                    timestamp: Date.now()
                };
                
                // Rozpocznij timeout dla oczekiwania na odpowiedź (60 sekund)
                setTimeout(() => {
                    if (this.pendingTransfers[targetPeerId]) {
                        console.log(`[DEBUG] Timeout oczekiwania na odpowiedź od ${targetPeerId}`);
                        
                        // NOWE: Aktualizacja stanu
                        this.updateConnectionState(targetPeerId, 'transfer_request_timeout');
                        
                        delete this.pendingTransfers[targetPeerId];
                        if (this.onTransferError) {
                            this.onTransferError(targetPeerId, 'Nie otrzymano odpowiedzi na żądanie transferu');
                        }
                    }
                }, 60000); // Zwiększony timeout
                
                return true;
            } catch (error) {
                console.error(`[BŁĄD] Błąd podczas wysyłania żądania transferu: ${error.message}`);
                
                // NOWE: Aktualizacja stanu
                this.updateConnectionState(targetPeerId, 'transfer_request_error', {
                    error: error.message
                });
                
                throw new Error('Błąd podczas wysyłania żądania transferu: ' + error.message);
            }
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas przygotowania żądania transferu plików: ${error.message}`);
            
            // NOWE: Aktualizacja stanu
            this.updateConnectionState(targetPeerId, 'transfer_setup_error', {
                error: error.message
            });
            
            if (this.onTransferError) {
                this.onTransferError(targetPeerId, error.message);
            }
            throw error;
        }
    }
    
    // Odpowiedź na żądanie transferu plików
    respondToTransferRequest(peerId, accepted) {
        try {
            // NOWE: Aktualizacja stanu
            this.updateConnectionState(peerId, accepted ? 'accepting_transfer' : 'rejecting_transfer');
            
            if (!this.isConnectionReady(peerId)) {
                console.warn(`[OSTRZEŻENIE] Próba odpowiedzi na żądanie transferu bez gotowego połączenia (stan: ${this.connectionStates[peerId]})`);
                
                // Jeśli połączenie nie jest w pełni gotowe, ale mamy wczesne połączenie, spróbujmy mimo to
                if (!this.earlyMessageEnabled || 
                    (this.connectionStates[peerId] !== 'early_ready' && 
                     this.connectionStates[peerId] !== 'connected')) {
                    
                    // NOWE: Aktualizacja stanu
                    this.updateConnectionState(peerId, 'connection_not_ready_for_response');
                    
                    throw new Error('Brak aktywnego połączenia z peerem');
                }
            }
            
            const connection = this.activeConnections[peerId];
            
            // Dodatkowe sprawdzenie stanu kanału danych
            if (connection && connection._channel && connection._channel.readyState === 'open') {
                console.log(`[DEBUG] Wysyłanie ${accepted ? 'akceptacji' : 'odrzucenia'} transferu do ${peerId} przez kanał danych`);
                connection._channel.send(JSON.stringify({
                    type: accepted ? 'accept-transfer' : 'reject-transfer'
                }));
            } else {
                console.log(`[DEBUG] Wysyłanie ${accepted ? 'akceptacji' : 'odrzucenia'} transferu do ${peerId} przez SimplePeer`);
                connection.send(JSON.stringify({
                    type: accepted ? 'accept-transfer' : 'reject-transfer'
                }));
            }
            
            console.log(`[DEBUG] Pomyślnie wysłano ${accepted ? 'akceptację' : 'odrzucenie'} transferu do ${peerId}`);
            
            // NOWE: Aktualizacja stanu
            this.updateConnectionState(peerId, accepted ? 'transfer_accepted' : 'transfer_rejected');
            
            return true;
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas odpowiadania na żądanie transferu: ${error.message}`);
            
            // NOWE: Aktualizacja stanu
            this.updateConnectionState(peerId, 'transfer_response_error', {
                error: error.message
            });
            
            if (this.onTransferError) {
                this.onTransferError(peerId, error.message);
            }
            return false;
        }
    }

    // Wysłanie plików do określonego peera
    async sendFiles(targetPeerId, files) {
        try {
            // NOWE: Aktualizacja stanu
            this.updateConnectionState(targetPeerId, 'initiating_file_transfer', {
                fileCount: files.length
            });
            
            // Najpierw wyślij żądanie transferu
            await this.requestFileTransfer(targetPeerId, files);
            
            // Faktyczny transfer plików zostanie rozpoczęty po otrzymaniu akceptacji
            // Obsługa w handleIncomingData dla wiadomości 'accept-transfer'
            
            return true;
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas wysyłania plików: ${error.message}`);
            
            // NOWE: Aktualizacja stanu
            this.updateConnectionState(targetPeerId, 'file_transfer_init_error', {
                error: error.message
            });
            
            if (this.onTransferError) {
                this.onTransferError(targetPeerId, error.message);
            }
            throw error;
        }
    }

    // Obliczanie optymalnego opóźnienia dla fragmentów bazując na wydajności połączenia
    calculateChunkDelay(bytesPerSecond, failureCount) {
        if (!this.adaptiveChunkDelay) {
            return this.baseChunkDelay; // Stałe opóźnienie, jeśli adaptacja jest wyłączona
        }
        
        // Bazowe opóźnienie: 20ms
        let delay = this.baseChunkDelay;
        
        // Zwiększ opóźnienie dla wolniejszych połączeń
        if (bytesPerSecond < 100000) { // < 100 KB/s
            delay = 50;
        } else if (bytesPerSecond < 500000) { // < 500 KB/s
            delay = 30;
        }
        
        // Zwiększ opóźnienie po błędach transferu
        if (failureCount > 0) {
            // Wykładnicze zwiększanie opóźnienia
            delay = delay * Math.pow(1.5, failureCount);
        }
        
        // Limituj maksymalne opóźnienie do 200ms
        return Math.min(delay, 200);
    }

    // Przetwarzanie kolejnego pliku z kolejki
    async processNextTransfer() {
        if (this.transferQueue.length === 0) {
            console.log('[DEBUG] Kolejka transferu jest pusta');
            this.currentTransfer = null;
            return;
        }
        
        this.currentTransfer = this.transferQueue.shift();
        const { peerId, file, fileId } = this.currentTransfer;
        
        console.log(`[DEBUG] Rozpoczynam transfer pliku "${file.name}" (${this.formatFileSize(file.size)}) do ${peerId}`);
        
        // NOWE: Aktualizacja stanu
        this.updateConnectionState(peerId, 'starting_file_transfer', {
            fileName: file.name,
            fileSize: file.size,
            fileId: fileId
        });
        
        try {
            // Sprawdź, czy połączenie istnieje i jest gotowe
            if (!this.isConnectionReady(peerId)) {
                console.error(`[BŁĄD] Brak aktywnego połączenia z peerem ${peerId}`);
                
                // NOWE: Aktualizacja stanu
                this.updateConnectionState(peerId, 'no_connection_for_transfer');
                
                // Próba naprawy połączenia
                try {
                    console.log(`[DEBUG] Próba ponownego nawiązania połączenia z ${peerId}`);
                    await this.createPeerConnection(peerId, true);
                    
                    // Poczekaj na nawiązanie połączenia
                    await new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => {
                            reject(new Error('Timeout ponownego łączenia'));
                        }, 30000); // Dłuższy czas oczekiwania
                        
                        const checkConnection = () => {
                            if (this.isConnectionReady(peerId)) {
                                clearTimeout(timeout);
                                resolve();
                            } else if (!this.isConnecting[peerId]) {
                                clearTimeout(timeout);
                                reject(new Error('Połączenie zakończone niepowodzeniem'));
                            } else {
                                setTimeout(checkConnection, 500);
                            }
                        };
                        
                        checkConnection();
                    });
                    
                    console.log(`[DEBUG] Pomyślnie ponownie nawiązano połączenie z ${peerId}`);
                    
                    // NOWE: Aktualizacja stanu
                    this.updateConnectionState(peerId, 'connection_reestablished');
                } catch (error) {
                    console.error(`[BŁĄD] Nie udało się ponownie nawiązać połączenia z ${peerId}:`, error);
                    
                    // NOWE: Aktualizacja stanu
                    this.updateConnectionState(peerId, 'connection_repair_failed', {
                        error: error.message
                    });
                    
                    // Dodaj z powrotem do kolejki na późniejszą próbę lub powiadom o błędzie
                    this.transferQueue.unshift(this.currentTransfer);
                    this.currentTransfer = null;
                    
                    if (this.onTransferError) {
                        this.onTransferError(peerId, `Nie można nawiązać połączenia: ${error.message}`);
                    }
                    
                    return;
                }
            }
            
            const connection = this.activeConnections[peerId];
            
            // Upewnij się, że kanał danych jest otwarty
            await this.waitForDataChannel(peerId, 10000).catch(e => {
                console.warn(`[OSTRZEŻENIE] Nie udało się otworzyć kanału danych: ${e.message}`);
                
                // NOWE: Aktualizacja stanu
                this.updateConnectionState(peerId, 'data_channel_warning', {
                    error: e.message
                });
            });
            
            // Licznik fragmentów dla potrzeb debugowania
            let chunkCounter = 0;
            let failureCount = 0;
            
            // NOWE: Przygotuj tablicę do śledzenia potwierdzeń chunków
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
            
            // Informacja o rozpoczęciu transferu z dodatkowym logowaniem
            try {
                console.log(`[DEBUG] Wysyłanie informacji o rozpoczęciu transferu pliku "${file.name}" do ${peerId}`);
                
                // NOWE: Aktualizacja stanu
                this.updateConnectionState(peerId, 'sending_file_start_info', {
                    fileName: file.name
                });
                
                // Wybierz metodę wysyłania - preferuj bezpośredni kanał danych
                if (connection._channel && connection._channel.readyState === 'open') {
                    connection._channel.send(JSON.stringify({
                        type: 'start-file',
                        name: file.name,
                        size: file.size,
                        type: file.type,
                        fileId: fileId // NOWE: Dodanie ID pliku do lepszego śledzenia
                    }));
                } else {
                    connection.send(JSON.stringify({
                        type: 'start-file',
                        name: file.name,
                        size: file.size,
                        type: file.type,
                        fileId: fileId // NOWE: Dodanie ID pliku do lepszego śledzenia
                    }));
                }
                
                // Dodaj dłuższe opóźnienie, aby upewnić się, że wiadomość start-file dotrze przed fragmentami
                await new Promise(resolve => setTimeout(resolve, 1000));
                console.log(`[DEBUG] Rozpoczynam wysyłanie fragmentów pliku do ${peerId}`);
                
                // NOWE: Aktualizacja stanu
                this.updateConnectionState(peerId, 'sending_file_chunks', {
                    fileName: file.name
                });
                
            } catch (error) {
                console.error(`[BŁĄD] Błąd podczas wysyłania informacji o rozpoczęciu transferu: ${error.message}`);
                
                // NOWE: Aktualizacja stanu
                this.updateConnectionState(peerId, 'file_start_info_error', {
                    error: error.message
                });
                
                if (this.onTransferError) {
                    this.onTransferError(peerId, `Błąd podczas rozpoczęcia transferu: ${error.message}`);
                }
                this.processNextTransfer();
                return;
            }
            
            const readNextChunk = () => {
                // Sprawdź, czy połączenie jest wciąż aktywne
                if (!this.isConnectionReady(peerId)) {
                    console.error(`[BŁĄD] Połączenie z ${peerId} zostało zamknięte w trakcie transferu`);
                    
                    // NOWE: Aktualizacja stanu
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
                    
                    // NOWE: Aktualizacja stanu co 100 fragmentów
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
                    
                    // NOWE: Aktualizacja stanu
                    this.updateConnectionState(peerId, 'file_chunk_read_error', {
                        error: error.message
                    });
                    
                    if (this.onTransferError) {
                        this.onTransferError(peerId, `Błąd odczytu pliku: ${error.message}`);
                    }
                    this.processNextTransfer();
                }
            };
            
            reader.onload = (e) => {
                try {
                    // Sprawdź, czy połączenie jest wciąż aktywne
                    if (!this.isConnectionReady(peerId)) {
                        throw new Error(`Połączenie z ${peerId} zostało zamknięte w trakcie transferu`);
                    }
                    
                    const chunk = e.target.result;
                    
                    // Dodatkowe zabezpieczenie - sprawdź, czy otrzymano dane
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
                    
                    // NOWE: Dodaj metadane do fragmentu dla lepszego śledzenia transferu
                    const chunkHeader = JSON.stringify({
                        type: 'file-chunk',
                        fileId: fileId,
                        chunkIndex: chunkCounter - 1,
                        offset: offset,
                        size: chunk.byteLength
                    });
                    
                    // Dodajemy dynamiczne opóźnienie między wysyłaniem dużych fragmentów
                    const sendChunk = () => {
                        try {
                            // NOWE: Dodajemy do śledzenia potwierdzeń jeśli włączone
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
                            if (connection._channel && connection._channel.readyState === 'open') {
                                connection._channel.send(chunkHeader);
                                // Krótkie opóźnienie między nagłówkiem a danymi
                                setTimeout(() => {
                                    connection._channel.send(chunk);
                                }, 10);
                            } else {
                                connection.send(chunkHeader);
                                // Krótkie opóźnienie między nagłówkiem a danymi
                                setTimeout(() => {
                                    connection.send(chunk);
                                }, 10);
                            }
                            
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
                            
                            // NOWE: Aktualizacja stanu
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
                    
                    // NOWE: Aktualizacja stanu
                    this.updateConnectionState(peerId, 'data_send_error', {
                        error: error.message
                    });
                    
                    if (this.onTransferError) {
                        this.onTransferError(peerId, `Błąd podczas wysyłania danych: ${error.message}`);
                    }
                    this.processNextTransfer();
                }
            };
            
            const finishTransfer = () => {
                console.log(`[DEBUG] Transfer pliku "${file.name}" zakończony, wysyłanie sygnału końca pliku`);
                
                // NOWE: Aktualizacja stanu
                this.updateConnectionState(peerId, 'file_transfer_completed', {
                    fileName: file.name
                });
                
                // NOWE: Sprawdź, czy są fragmenty do ponownego wysłania
                const handleRetry = () => {
                    if (this.retryChunks[peerId] && 
                        this.retryChunks[peerId][fileId] && 
                        this.retryChunks[peerId][fileId].length > 0) {
                        
                        console.log(`[DEBUG] Ponowne wysyłanie ${this.retryChunks[peerId][fileId].length} fragmentów`);
                        
                        // NOWE: Aktualizacja stanu
                        this.updateConnectionState(peerId, 'retrying_chunks', {
                            fileName: file.name,
                            chunkCount: this.retryChunks[peerId][fileId].length
                        });
                        
                        // Wysyłamy fragmenty ponownie, jeden po drugim z opóźnieniem
                        const retryNextChunk = () => {
                            if (this.retryChunks[peerId][fileId].length === 0) {
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
                                    
                                    if (connection._channel && connection._channel.readyState === 'open') {
                                        connection._channel.send(retryHeader);
                                        // Krótkie opóźnienie między nagłówkiem a danymi
                                        setTimeout(() => {
                                            connection._channel.send(retryItem.chunk);
                                        }, 10);
                                    } else {
                                        connection.send(retryHeader);
                                        // Krótkie opóźnienie między nagłówkiem a danymi
                                        setTimeout(() => {
                                            connection.send(retryItem.chunk);
                                        }, 10);
                                    }
                                    
                                    // Kontynuuj z kolejnym fragmentem po opóźnieniu
                                    setTimeout(retryNextChunk, 100);
                                } else {
                                    console.error(`[BŁĄD] Połączenie z ${peerId} nie jest gotowe do ponownego wysłania fragmentów`);
                                    sendEndFileSignal();
                                }
                            } catch (error) {
                                console.error(`[BŁĄD] Błąd podczas ponownego wysyłania fragmentu: ${error.message}`);
                                // Kontynuuj mimo błędów
                                setTimeout(retryNextChunk, 100);
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
                    // Zakończenie transferu tego pliku z dłuższym opóźnieniem
                    // aby upewnić się, że wszystkie fragmenty dotarły
                    setTimeout(() => {
                        try {
                            // NOWE: Aktualizacja stanu
                            this.updateConnectionState(peerId, 'sending_end_file_signal', {
                                fileName: file.name
                            });
                            
                            // Wybierz metodę wysyłania - preferuj bezpośredni kanał danych
                            if (connection._channel && connection._channel.readyState === 'open') {
                                connection._channel.send(JSON.stringify({
                                    type: 'end-file',
                                    name: file.name,
                                    fileId: fileId // NOWE: Dodaj ID pliku
                                }));
                            } else {
                                connection.send(JSON.stringify({
                                    type: 'end-file',
                                    name: file.name,
                                    fileId: fileId // NOWE: Dodaj ID pliku
                                }));
                            }
                            
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
                            
                            // NOWE: Aktualizacja stanu
                            this.updateConnectionState(peerId, 'end_file_signal_error', {
                                error: error.message
                            });
                            
                            if (this.onTransferError) {
                                this.onTransferError(peerId, `Błąd podczas kończenia transferu: ${error.message}`);
                            }
                            this.processNextTransfer();
                        }
                    }, 2000); // Zwiększone opóźnienie dla lepszej niezawodności
                };
                
                // Sprawdź, czy są fragmenty do ponownego wysłania
                handleRetry();
            };
            
            reader.onerror = (error) => {
                console.error(`[BŁĄD] Błąd odczytu pliku:`, error);
                
                // NOWE: Aktualizacja stanu
                this.updateConnectionState(peerId, 'file_read_error', {
                    error: error.message || 'Nieznany błąd'
                });
                
                if (this.onTransferError) {
                    this.onTransferError(peerId, `Błąd odczytu pliku: ${error.message || 'Nieznany błąd'}`);
                }
                this.processNextTransfer();
            };
            
            // Rozpocznij proces odczytu
            readNextChunk();
            
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas przetwarzania transferu: ${error.message}`);
            
            // NOWE: Aktualizacja stanu
            this.updateConnectionState(peerId, 'transfer_processing_error', {
                error: error.message
            });
            
            if (this.onTransferError) {
                this.onTransferError(peerId, error.message);
            }
            this.processNextTransfer();
        }
    }

    // Anulowanie transferu (można wywołać z UI)
    cancelTransfer(peerId) {
        console.log(`[DEBUG] Anulowanie transferu dla ${peerId}`);
        
        try {
            // NOWE: Aktualizacja stanu
            this.updateConnectionState(peerId, 'cancelling_transfer');
            
            if (this.isConnectionReady(peerId)) {
                // Wyślij wiadomość o anulowaniu transferu
                this.activeConnections[peerId].send(JSON.stringify({
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
            
            // NOWE: Aktualizacja stanu
            this.updateConnectionState(peerId, 'transfer_cancelled');
            
            return true;
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas anulowania transferu: ${error.message}`);
            
            // NOWE: Aktualizacja stanu
            this.updateConnectionState(peerId, 'cancel_transfer_error', {
                error: error.message
            });
            
            return false;
        }
    }

    // Obsługa przychodzących danych
    handleIncomingData(peerId, data) {
        try {
            // Bardziej rozbudowana detekcja danych binarnych
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
                
                // NOWE: Obsługa nagłówków fragmentów plików
                if (message.type === 'file-chunk' || message.type === 'file-chunk-retry') {
                    // Zachowaj nagłówek dla kolejnych danych binarnych
                    this.lastChunkHeader = {
                        peerId: peerId,
                        data: message
                    };
                    return;
                }
                
                // NOWE: Obsługa potwierdzeń fragmentów
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
                        
                        // NOWE: Aktualizacja stanu
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
                        
                        // NOWE: Aktualizacja stanu
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
                                    fileId: metadata.id, // NOWE: Dodaje ID pliku
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
                                if (connection._channel && connection._channel.readyState === 'open') {
                                    connection._channel.send(JSON.stringify({
                                        type: 'metadata',
                                        files: filesMetadata
                                    }));
                                } else {
                                    connection.send(JSON.stringify({
                                        type: 'metadata',
                                        files: filesMetadata
                                    }));
                                }
                                
                                console.log(`[DEBUG] Wysłano metadane plików do ${peerId}`);
                                
                                // NOWE: Aktualizacja stanu
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
                                
                                // NOWE: Aktualizacja stanu
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
                        
                        // NOWE: Aktualizacja stanu
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
                        
                        // NOWE: Aktualizacja stanu
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
                        
                        // NOWE: Aktualizacja stanu
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
                        
                        // NOWE: Aktualizacja stanu
                        this.updateConnectionState(peerId, 'file_reception_started', {
                            fileName: message.name,
                            fileSize: message.size
                        });
                        
                        // Resetowanie lub inicjalizacja odbiornika pliku
                        this.currentReceivingFile = {
                            name: message.name,
                            size: message.size,
                            type: message.type || 'application/octet-stream',
                            fileId: message.fileId, // NOWE: Zapisz ID pliku
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
                        
                        // NOWE: Aktualizacja stanu
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
                                
                                // NOWE: Aktualizacja stanu
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
                            
                            // NOWE: Aktualizacja stanu
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
            
            // NOWE: Aktualizacja stanu
            this.updateConnectionState(peerId, 'data_processing_error', {
                error: error.message
            });
        }
    }

    // Pomocnicza funkcja do formatowania rozmiaru pliku
    formatFileSize(bytes) {
        if (bytes === undefined || bytes === null) return '0 B';
        if (bytes < 1024) return bytes + ' B';
        else if (bytes < 1048576) return (bytes / 1024).toFixed(2) + ' KB';
        else if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + ' MB';
        else return (bytes / 1073741824).toFixed(2) + ' GB';
    }

    // Zamknięcie wszystkich połączeń
    disconnect() {
        console.log('[DEBUG] Zamykanie wszystkich połączeń');
        Object.keys(this.activeConnections).forEach(peerId => {
            this.cleanupConnection(peerId);
        });
        
        this.activeConnections = {};
        this.isConnecting = {};
        this.pendingTransfers = {};
        this.iceFailedPeers.clear();
        this.connectionStates = {};
        this.dataChannelStates = {};
        this.transferStates = {};
        this.receivedChunksRegistry = {};
        this.pendingAcks = {};
        this.retryChunks = {};
        
        if (this.socket) {
            this.socket.disconnect();
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
            
            // Dodaj statystyki ICE, jeśli są dostępne
            if (connection._pc) {
                try {
                    const stats = await connection._pc.getStats();
                    connectResult.iceStats = Array.from(stats.values())
                        .filter(stat => stat.type === 'candidate-pair' || stat.type === 'local-candidate' || stat.type === 'remote-candidate');
                } catch (e) {
                    console.warn('[OSTRZEŻENIE] Nie udało się pobrać statystyk ICE:', e);
                }
            }
            
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
}