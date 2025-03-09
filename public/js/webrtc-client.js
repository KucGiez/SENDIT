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
        this.connectionRetryCount = 0;
        this.maxConnectionRetries = 5; // Liczba prób połączenia
        this.useFallbackIceServers = false;
        this.isConnecting = {}; // Śledzenie stanu łączenia dla każdego ID peera
        this.pendingTransfers = {}; // Śledzenie oczekujących transferów
        this.iceFailedPeers = new Set(); // Śledzenie peerów z problemami ICE
        
        // Konfiguracja timeoutów i limitów
        this.connectionTimeout = 60000; // 60 sekund na nawiązanie połączenia (zwiększone z 30s)
        this.signalTimeout = 10000;    // 10 sekund na odebranie sygnału
        this.chunkSize = 16384;        // 16KB dla fragmentów plików
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
                    reconnectionAttempts: 10,
                    timeout: 20000 // Zwiększony timeout
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
                
                // Obsługa wiadomości sygnalizacyjnych z bardziej szczegółowym logowaniem
                this.socket.on('signal', async ({ peerId, signal }) => {
                    try {
                        console.log(`[DEBUG] Otrzymano sygnał od ${peerId}: ${signal.type || 'candidate'}`);
                        
                        // Sprawdź czy połączenie już istnieje lub jest w trakcie tworzenia
                        if (!this.activeConnections[peerId] && !this.isConnecting[peerId]) {
                            // Oznacz, że rozpoczęto łączenie
                            console.log(`[DEBUG] Tworzenie nowego połączenia po otrzymaniu sygnału od ${peerId}`);
                            this.isConnecting[peerId] = true;
                            try {
                                await this.createPeerConnection(peerId, false);
                            } catch (error) {
                                console.error(`[BŁĄD] Błąd podczas tworzenia połączenia po otrzymaniu sygnału: ${error.message}`);
                                delete this.isConnecting[peerId];
                                return;
                            }
                        }
                        
                        // Zabezpieczenie przed przypadkiem, gdy połączenie mogło zostać usunięte w międzyczasie
                        if (this.activeConnections[peerId]) {
                            console.log(`[DEBUG] Przekazanie sygnału do obiektu peer dla ${peerId}`);
                            await this.activeConnections[peerId].signal(signal);
                        } else {
                            console.warn(`[OSTRZEŻENIE] Nie można przetworzyć sygnału dla ${peerId} - brak połączenia`);
                        }
                    } catch (error) {
                        console.error(`[BŁĄD] Błąd podczas przetwarzania sygnału: ${error.message}`);
                        // Usuń znacznik tworzenia połączenia w przypadku błędu
                        delete this.isConnecting[peerId];
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
            
            const response = await fetch('/api/turn-credentials', {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Cache-Control': 'no-cache'
                },
                cache: 'no-store',
                timeout: 5000 // 5 sekund timeout
            });
            
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
            
            // Połącz serwery z API z publicznymi serwerami dla większej niezawodności
            return [...data, ...publicServers];
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

    // Utworzenie połączenia peer-to-peer
    async createPeerConnection(targetPeerId, isInitiator = true) {
        try {
            console.log(`[DEBUG] Tworzenie połączenia peer z ${targetPeerId}, initiator: ${isInitiator}`);
            
            // Oznacz, że rozpoczęto łączenie
            this.isConnecting[targetPeerId] = true;
            
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
            
            // Konfiguracja peer connection z rozszerzonymi opcjami
            const peerConfig = {
                initiator: isInitiator,
                trickle: true,
                config: { 
                    iceServers,
                    iceTransportPolicy: 'all',
                    sdpSemantics: 'unified-plan',
                    iceCandidatePoolSize: 10,
                    bundlePolicy: 'max-bundle'
                },
                offerOptions: {
                    offerToReceiveAudio: false,
                    offerToReceiveVideo: false
                },
                // Wskazówki dla negocjacji ICE
                sdpTransform: (sdp) => {
                    // Zwiększenie priorytetów dla różnych typów kandydatów ICE
                    sdp = sdp.replace(/a=candidate:.*udp.*typ host.*\r\n/g, (match) => {
                        return match.replace(/generation [0-9]+ /, 'generation 0 ');
                    });
                    
                    // Dodanie bardziej szczegółowego logu
                    console.log(`[DEBUG] Transformacja SDP dla ${targetPeerId}, rozmiar: ${sdp.length} znaków`);
                    return sdp;
                }
            };
            
            // Sprawdzenie czy SimplePeer jest dostępny
            if (typeof SimplePeer !== 'function') {
                throw new Error('Biblioteka SimplePeer nie jest dostępna. Sprawdź, czy została poprawnie załadowana.');
            }
            
            // Tworzenie obiektu peer
            const peer = new SimplePeer(peerConfig);
            
            // Śledź stan połączenia ICE
            let iceConnectionState = null;
            let iceGatheringState = null;
            let signalingState = null;
            
            // Obsługa sygnałów WebRTC
            peer.on('signal', (data) => {
                console.log(`[DEBUG] Wysyłanie sygnału do ${targetPeerId}: typ=${data.type || 'candidate'}`);
                
                if (this.socket && this.socket.connected) {
                    this.socket.emit('signal', {
                        peerId: targetPeerId,
                        signal: data
                    });
                } else {
                    console.error('[BŁĄD] Nie można wysłać sygnału - socket jest null lub rozłączony');
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
                
                // Decyzja o przełączeniu na awaryjne serwery ICE
                if (!this.useFallbackIceServers && 
                    (err.message.includes('ICE') || 
                     iceConnectionState === 'failed' || 
                     (peer._pc && peer._pc.iceConnectionState === 'failed'))) {
                    
                    console.log('[DEBUG] Wykryto problem z ICE, przełączam na awaryjne serwery ICE');
                    this.useFallbackIceServers = true;
                    this.connectionRetryCount = 0;
                    
                    // Oznacz tego peera jako problematycznego
                    this.iceFailedPeers.add(targetPeerId);
                    
                    // Usuń obecne połączenie
                    this.cleanupConnection(targetPeerId, peer);
                    
                    // Spróbuj ponownie z awaryjnymi serwerami
                    setTimeout(() => {
                        this.createPeerConnection(targetPeerId, isInitiator)
                        .catch(fallbackError => {
                            console.error('[BŁĄD] Nieudana próba z awaryjnymi serwerami:', fallbackError);
                            if (this.onTransferError) {
                                this.onTransferError(targetPeerId, 'Nie udało się nawiązać połączenia nawet z awaryjnymi serwerami.');
                            }
                            delete this.isConnecting[targetPeerId];
                        });
                    }, 1000);
                    
                    return;
                }
                
                // Standardowa procedura ponownych prób
                if (this.connectionRetryCount < this.maxConnectionRetries) {
                    console.log(`[DEBUG] Próba ponownego połączenia ${this.connectionRetryCount + 1}/${this.maxConnectionRetries}`);
                    this.connectionRetryCount++;
                    
                    // Usuń obecne połączenie i utwórz nowe
                    this.cleanupConnection(targetPeerId, peer);
                    
                    // Oczekuj chwilę przed ponowną próbą
                    setTimeout(() => {
                        this.createPeerConnection(targetPeerId, isInitiator)
                        .catch(retryError => {
                            console.error('[BŁĄD] Nieudana próba ponownego połączenia:', retryError);
                            if (this.onTransferError) {
                                this.onTransferError(targetPeerId, 'Nie udało się nawiązać połączenia po kilku próbach.');
                            }
                            delete this.isConnecting[targetPeerId];
                        });
                    }, 1000);
                } else {
                    // Powiadom o błędzie po wyczerpaniu prób
                    console.error(`[BŁĄD] Wyczerpano ${this.maxConnectionRetries} prób połączenia z ${targetPeerId}`);
                    this.connectionRetryCount = 0;
                    delete this.isConnecting[targetPeerId];
                    if (this.onTransferError) {
                        this.onTransferError(targetPeerId, err.message);
                    }
                }
            });
            
            // Obsługa nawiązania połączenia
            peer.on('connect', () => {
                console.log(`[DEBUG] Pomyślnie połączono z peerem: ${targetPeerId}`);
                // Resetuj licznik prób po udanym połączeniu
                this.connectionRetryCount = 0;
                
                // Jeśli to był peer z problemami ICE, możemy zresetować flagę
                if (this.iceFailedPeers.has(targetPeerId)) {
                    this.iceFailedPeers.delete(targetPeerId);
                    console.log(`[DEBUG] Usunięto ${targetPeerId} z listy peerów z problemami ICE`);
                }
                
                delete this.isConnecting[targetPeerId]; // Usuń znacznik nawiązywania połączenia
            });
            
            // Obsługa przychodzących danych
            peer.on('data', (data) => {
                // Debug: raportuj rozmiar otrzymanych danych
                const size = data.byteLength || data.length || (data.size ? data.size : 'nieznany');
                console.log(`[DEBUG] Otrzymano dane od ${targetPeerId}, rozmiar: ${size} bajtów`);
                this.handleIncomingData(targetPeerId, data);
            });
            
            // Obsługa zamknięcia połączenia
            peer.on('close', () => {
                console.log(`[DEBUG] Zamknięto połączenie z peerem: ${targetPeerId}`);
                this.cleanupConnection(targetPeerId);
            });
            
            // Dodatkowe monitorowanie stanu ICE
            peer.on('iceStateChange', (state) => {
                iceConnectionState = state;
                console.log(`[DEBUG] Zmiana stanu ICE dla ${targetPeerId}: ${state}`);
                
                // Jeśli stan ICE to 'failed', oznacza to problem z połączeniem
                if (state === 'failed') {
                    console.error(`[BŁĄD] Połączenie ICE nie powiodło się dla ${targetPeerId}`);
                    
                    // Oznacz tego peera jako problematycznego
                    this.iceFailedPeers.add(targetPeerId);
                    
                    if (this.onTransferError) {
                        this.onTransferError(targetPeerId, 'Nie udało się nawiązać połączenia ICE. Spróbuj ponownie później.');
                    }
                }
                
                // Jeśli połączenie przeszło do stanu connected, możemy zresetować flagi
                if (state === 'connected' || state === 'completed') {
                    this.iceFailedPeers.delete(targetPeerId);
                }
            });
            
            // Dodatkowe monitorowanie jeśli peer udostępnia te informacje
            if (peer._pc) {
                peer._pc.addEventListener('icegatheringstatechange', () => {
                    iceGatheringState = peer._pc.iceGatheringState;
                    console.log(`[DEBUG] Zmiana stanu zbierania ICE dla ${targetPeerId}: ${peer._pc.iceGatheringState}`);
                });
                
                peer._pc.addEventListener('signalingstatechange', () => {
                    signalingState = peer._pc.signalingState;
                    console.log(`[DEBUG] Zmiana stanu sygnalizacji dla ${targetPeerId}: ${peer._pc.signalingState}`);
                });
                
                peer._pc.addEventListener('connectionstatechange', () => {
                    console.log(`[DEBUG] Zmiana stanu połączenia dla ${targetPeerId}: ${peer._pc.connectionState}`);
                    
                    // Reaguj na stan "failed" lub "disconnected"
                    if (peer._pc.connectionState === 'failed' || peer._pc.connectionState === 'disconnected') {
                        console.error(`[BŁĄD] Połączenie WebRTC ${peer._pc.connectionState} dla ${targetPeerId}`);
                        if (this.onTransferError) {
                            this.onTransferError(targetPeerId, `Połączenie WebRTC ${peer._pc.connectionState}`);
                        }
                    }
                });
                
                // Dodanie obserwatora kandydatów ICE z rozszerzonym logowaniem
                peer._pc.onicecandidate = (event) => {
                    if (event.candidate) {
                        console.log(`[DEBUG] Nowy kandydat ICE dla ${targetPeerId}:`, 
                            event.candidate.candidate || 'brak szczegółów');
                    }
                };
            }
            
            // Ustaw połączenie jako aktywne
            this.activeConnections[targetPeerId] = peer;
            return peer;
            
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas tworzenia połączenia peer z ${targetPeerId}:`, error);
            delete this.isConnecting[targetPeerId]; // Usuń znacznik nawiązywania połączenia
            if (this.onTransferError) {
                this.onTransferError(targetPeerId, `Błąd konfiguracji: ${error.message}`);
            }
            throw error;
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

    // Sprawdzenie czy połączenie jest gotowe
    isConnectionReady(targetPeerId) {
        return !!(this.activeConnections[targetPeerId] && 
                 !this.isConnecting[targetPeerId] &&
                 this.activeConnections[targetPeerId]._connected);
    }

    // Wysłanie żądania transferu plików
    async requestFileTransfer(targetPeerId, files) {
        try {
            console.log(`[DEBUG] Wysyłanie żądania transferu ${files.length} plików do ${targetPeerId}`);
            
            // Jeśli ten peer miał wcześniej problemy z ICE, użyj od razu serwerów awaryjnych
            if (this.iceFailedPeers.has(targetPeerId)) {
                this.useFallbackIceServers = true;
                console.log(`[DEBUG] Używam serwerów awaryjnych dla ${targetPeerId} z powodu wcześniejszych problemów ICE`);
            }
            
            // Sprawdź, czy jest aktywne połączenie i czy jest gotowe
            let connection = this.activeConnections[targetPeerId];
            let needNewConnection = !this.isConnectionReady(targetPeerId);
            
            if (needNewConnection) {
                console.log(`[DEBUG] Brak aktywnego połączenia z ${targetPeerId}, tworzę nowe połączenie`);
                
                // Wyczyść poprzednie połączenie, jeśli istnieje
                if (connection) {
                    this.cleanupConnection(targetPeerId, connection);
                }
                
                // Utwórz nowe połączenie
                connection = await this.createPeerConnection(targetPeerId, true);
                
                // Poczekaj na nawiązanie połączenia z timeoutem
                await new Promise((resolve, reject) => {
                    let connectionTimeout;
                    
                    // Funkcja obsługi połączenia
                    const connectHandler = () => {
                        console.log(`[DEBUG] Pomyślnie nawiązano połączenie z ${targetPeerId}`);
                        clearTimeout(connectionTimeout);
                        connection.removeListener('connect', connectHandler);
                        connection.removeListener('error', errorHandler);
                        resolve();
                    };
                    
                    // Funkcja obsługi błędu
                    const errorHandler = (err) => {
                        console.error(`[BŁĄD] Błąd podczas nawiązywania połączenia z ${targetPeerId}:`, err);
                        clearTimeout(connectionTimeout);
                        connection.removeListener('connect', connectHandler);
                        connection.removeListener('error', errorHandler);
                        reject(err);
                    };
                    
                    // Ustaw timeout
                    connectionTimeout = setTimeout(() => {
                        console.error(`[BŁĄD] Przekroczono czas oczekiwania na połączenie z ${targetPeerId}`);
                        connection.removeListener('connect', connectHandler);
                        connection.removeListener('error', errorHandler);
                        reject(new Error('Przekroczono czas oczekiwania na połączenie'));
                    }, this.connectionTimeout); // Używamy zdefiniowanego timeout
                    
                    // Dodaj obserwatory zdarzeń
                    connection.once('connect', connectHandler);
                    connection.once('error', errorHandler);
                });
            }
            
            // Zabezpieczenie - sprawdź, czy połączenie jest wciąż aktywne
            if (!this.activeConnections[targetPeerId]) {
                throw new Error('Połączenie zostało zamknięte w trakcie procesu nawiązywania');
            }
            
            connection = this.activeConnections[targetPeerId];
            
            // Kolejne zabezpieczenie - sprawdź, czy połączenie posiada metodę send
            if (!connection.send || typeof connection.send !== 'function') {
                throw new Error('Połączenie nie obsługuje metody wysyłania danych');
            }
            
            // Przygotowanie żądania transferu plików
            const filesMetadata = Array.from(files).map(file => ({
                name: file.name,
                type: file.type,
                size: file.size
            }));
            
            const totalSize = filesMetadata.reduce((sum, file) => sum + file.size, 0);
            
            try {
                // Wyślij żądanie transferu plików
                console.log(`[DEBUG] Wysyłanie żądania transferu do ${targetPeerId}`);
                connection.send(JSON.stringify({
                    type: 'request-transfer',
                    files: filesMetadata,
                    totalSize: totalSize,
                    senderName: this.deviceName
                }));
                
                console.log(`[DEBUG] Pomyślnie wysłano żądanie transferu plików do ${targetPeerId}`);
                
                // Zapisz pliki do tymczasowej kolejki oczekując na odpowiedź
                this.pendingTransfers[targetPeerId] = {
                    files: files,
                    timestamp: Date.now()
                };
                
                // Rozpocznij timeout dla oczekiwania na odpowiedź (30 sekund)
                setTimeout(() => {
                    if (this.pendingTransfers[targetPeerId]) {
                        console.log(`[DEBUG] Timeout oczekiwania na odpowiedź od ${targetPeerId}`);
                        delete this.pendingTransfers[targetPeerId];
                        if (this.onTransferError) {
                            this.onTransferError(targetPeerId, 'Nie otrzymano odpowiedzi na żądanie transferu');
                        }
                    }
                }, 30000);
                
                return true;
            } catch (error) {
                console.error(`[BŁĄD] Błąd podczas wysyłania żądania transferu: ${error.message}`);
                throw new Error('Błąd podczas wysyłania żądania transferu: ' + error.message);
            }
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas przygotowania żądania transferu plików: ${error.message}`);
            if (this.onTransferError) {
                this.onTransferError(targetPeerId, error.message);
            }
            throw error;
        }
    }
    
    // Odpowiedź na żądanie transferu plików
    respondToTransferRequest(peerId, accepted) {
        try {
            if (!this.isConnectionReady(peerId)) {
                throw new Error('Brak aktywnego połączenia z peerem');
            }
            
            const connection = this.activeConnections[peerId];
            
            console.log(`[DEBUG] Wysyłanie ${accepted ? 'akceptacji' : 'odrzucenia'} transferu do ${peerId}`);
            connection.send(JSON.stringify({
                type: accepted ? 'accept-transfer' : 'reject-transfer'
            }));
            
            console.log(`[DEBUG] Pomyślnie wysłano ${accepted ? 'akceptację' : 'odrzucenie'} transferu do ${peerId}`);
            return true;
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas odpowiadania na żądanie transferu: ${error.message}`);
            if (this.onTransferError) {
                this.onTransferError(peerId, error.message);
            }
            return false;
        }
    }

    // Wysłanie plików do określonego peera
    async sendFiles(targetPeerId, files) {
        try {
            // Najpierw wyślij żądanie transferu
            await this.requestFileTransfer(targetPeerId, files);
            
            // Faktyczny transfer plików zostanie rozpoczęty po otrzymaniu akceptacji
            // Obsługa w handleIncomingData dla wiadomości 'accept-transfer'
            
            return true;
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas wysyłania plików: ${error.message}`);
            if (this.onTransferError) {
                this.onTransferError(targetPeerId, error.message);
            }
            throw error;
        }
    }

    // Przetwarzanie kolejnego pliku z kolejki
    async processNextTransfer() {
        if (this.transferQueue.length === 0) {
            console.log('[DEBUG] Kolejka transferu jest pusta');
            this.currentTransfer = null;
            return;
        }
        
        this.currentTransfer = this.transferQueue.shift();
        const { peerId, file } = this.currentTransfer;
        
        console.log(`[DEBUG] Rozpoczynam transfer pliku "${file.name}" (${this.formatFileSize(file.size)}) do ${peerId}`);
        
        try {
            // Sprawdź, czy połączenie istnieje i jest gotowe
            if (!this.isConnectionReady(peerId)) {
                console.error(`[BŁĄD] Brak aktywnego połączenia z peerem ${peerId}`);
                
                // Próba naprawy połączenia
                try {
                    console.log(`[DEBUG] Próba ponownego nawiązania połączenia z ${peerId}`);
                    await this.createPeerConnection(peerId, true);
                    
                    // Poczekaj na nawiązanie połączenia
                    await new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => {
                            reject(new Error('Timeout ponownego łączenia'));
                        }, 10000);
                        
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
                } catch (error) {
                    console.error(`[BŁĄD] Nie udało się ponownie nawiązać połączenia z ${peerId}:`, error);
                    
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
            
            // Licznik fragmentów dla potrzeb debugowania
            let chunkCounter = 0;
            
            const reader = new FileReader();
            let offset = 0;
            let lastUpdateTime = Date.now();
            let lastOffset = 0;
            
            // Informacja o rozpoczęciu transferu z dodatkowym logowaniem
            try {
                console.log(`[DEBUG] Wysyłanie informacji o rozpoczęciu transferu pliku "${file.name}" do ${peerId}`);
                
                connection.send(JSON.stringify({
                    type: 'start-file',
                    name: file.name,
                    size: file.size,
                    type: file.type
                }));
                
                // Dodaj krótkie opóźnienie, aby upewnić się, że wiadomość start-file dotrze przed fragmentami
                await new Promise(resolve => setTimeout(resolve, 500));
                console.log(`[DEBUG] Rozpoczynam wysyłanie fragmentów pliku do ${peerId}`);
                
            } catch (error) {
                console.error(`[BŁĄD] Błąd podczas wysyłania informacji o rozpoczęciu transferu: ${error.message}`);
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
                }
                
                try {
                    const slice = file.slice(offset, offset + this.chunkSize);
                    reader.readAsArrayBuffer(slice);
                    chunkCounter++;
                } catch (error) {
                    console.error(`[BŁĄD] Błąd podczas odczytu fragmentu pliku: ${error.message}`);
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
                    
                    // Dodajemy mały delay między wysyłaniem dużych fragmentów, aby uniknąć przepełnienia bufora
                    const sendChunk = () => {
                        try {
                            // Wysłanie fragmentu danych
                            connection.send(chunk);
                            
                            offset += chunk.byteLength;
                            const progress = Math.min(100, Math.floor((offset / file.size) * 100));
                            
                            // Obliczenie prędkości transferu
                            const now = Date.now();
                            const timeDiff = now - lastUpdateTime;
                            if (timeDiff > 500) { // Aktualizuj co pół sekundy
                                const bytesPerSecond = ((offset - lastOffset) / timeDiff) * 1000;
                                lastUpdateTime = now;
                                lastOffset = offset;
                                
                                // Logowanie co 10% postępu
                                if (progress % 10 === 0 || progress === 100) {
                                    console.log(`[DEBUG] Postęp transferu: ${progress}%, prędkość: ${this.formatFileSize(bytesPerSecond)}/s`);
                                }
                                
                                // Aktualizacja postępu
                                if (this.onTransferProgress) {
                                    this.onTransferProgress(peerId, file, progress, offset, false, bytesPerSecond);
                                }
                            }
                            
                            if (offset < file.size) {
                                // Małe opóźnienie między fragmentami dla lepszej stabilności
                                setTimeout(readNextChunk, 10);
                            } else {
                                finishTransfer();
                            }
                        } catch (sendError) {
                            console.error(`[BŁĄD] Błąd podczas wysyłania fragmentu: ${sendError.message}`);
                            throw sendError;
                        }
                    };
                    
                    // Wysyłamy od razu, ale możemy dodać opóźnienie, jeśli są problemy ze stabilnością
                    sendChunk();
                    
                } catch (error) {
                    console.error(`[BŁĄD] Błąd podczas wysyłania danych: ${error.message}`);
                    if (this.onTransferError) {
                        this.onTransferError(peerId, `Błąd podczas wysyłania danych: ${error.message}`);
                    }
                    this.processNextTransfer();
                }
            };
            
            const finishTransfer = () => {
                console.log(`[DEBUG] Transfer pliku "${file.name}" zakończony, wysyłanie sygnału końca pliku`);
                
                // Zakończenie transferu tego pliku z krótkim opóźnieniem
                // aby upewnić się, że wszystkie fragmenty dotarły
                setTimeout(() => {
                    try {
                        connection.send(JSON.stringify({
                            type: 'end-file',
                            name: file.name
                        }));
                        
                        if (this.onTransferComplete) {
                            this.onTransferComplete(peerId, file);
                        }
                        
                        // Przejdź do kolejnego pliku w kolejce
                        this.processNextTransfer();
                    } catch (error) {
                        console.error(`[BŁĄD] Błąd podczas wysyłania sygnału końca pliku: ${error.message}`);
                        if (this.onTransferError) {
                            this.onTransferError(peerId, `Błąd podczas kończenia transferu: ${error.message}`);
                        }
                        this.processNextTransfer();
                    }
                }, 500); // Zwiększone opóźnienie dla lepszej niezawodności
            };
            
            reader.onerror = (error) => {
                console.error(`[BŁĄD] Błąd odczytu pliku:`, error);
                if (this.onTransferError) {
                    this.onTransferError(peerId, `Błąd odczytu pliku: ${error.message || 'Nieznany błąd'}`);
                }
                this.processNextTransfer();
            };
            
            // Rozpocznij proces odczytu
            readNextChunk();
            
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas przetwarzania transferu: ${error.message}`);
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
            
            return true;
        } catch (error) {
            console.error(`[BŁĄD] Błąd podczas anulowania transferu: ${error.message}`);
            return false;
        }
    }

    // Obsługa przychodzących danych
    handleIncomingData(peerId, data) {
        try {
            // Bardziej rozbudowana detekcja danych binarnych
            if (this.isBinaryData(data)) {
                console.log(`[DEBUG] Otrzymano dane binarne od ${peerId}, rozmiar: ${data.byteLength || data.size || 'nieznany'}`);
                
                // Jeśli nie mamy aktywnego transferu, ale otrzymujemy dane binarne
                if (!this.currentReceivingFile) {
                    console.error(`[BŁĄD] Otrzymano fragment pliku bez aktywnego transferu od ${peerId}`);
                    // Możesz dodać buforowanie tutaj
                    return;
                }
                
                // Debugowanie - sprawdzanie statusu bieżącego pliku
                console.log(`[DEBUG] Status odbierania pliku: ${this.currentReceivingFile.name}, ` +
                            `otrzymano: ${this.currentReceivingFile.receivedSize}/${this.currentReceivingFile.size} bajtów`);
                            
                // Normalizacja danych do Uint8Array dla spójności
                let chunk;
                if (data instanceof ArrayBuffer) {
                    chunk = new Uint8Array(data);
                } else if (data instanceof Blob) {
                    // Konwersja Blob do ArrayBuffer wymaga operacji asynchronicznej
                    // Tutaj musimy obsłużyć to synchronicznie, więc pomijamy tę optymalizację
                    chunk = data;
                } else {
                    chunk = data;
                }
                
                this.currentReceivingFile.chunks.push(chunk);
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
                
                // Sprawdź, czy plik został już w całości odebrany
                if (this.currentReceivingFile.receivedSize >= this.currentReceivingFile.size) {
                    console.log(`[DEBUG] Otrzymano wszystkie dane dla pliku ${this.currentReceivingFile.name}, oczekiwanie na sygnał end-file`);
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
                
                switch (message.type) {
                    case 'request-transfer':
                        // Otrzymano żądanie transferu plików
                        console.log(`[DEBUG] Otrzymano żądanie transferu ${message.files.length} plików od ${peerId}`);
                        
                        const peerName = this.peers[peerId]?.name || "Nieznane urządzenie";
                        
                        // Powiadom UI o żądaniu transferu
                        if (this.onTransferRequest) {
                            this.onTransferRequest(peerId, {
                                files: message.files,
                                totalSize: message.totalSize,
                                senderName: message.senderName || peerName
                            });
                        }
                        break;
                        
                    case 'accept-transfer':
                        // Transfer został zaakceptowany - rozpocznij wysyłanie
                        console.log(`[DEBUG] Transfer został zaakceptowany przez ${peerId}`);
                        
                        // Sprawdź, czy mamy oczekujące pliki dla tego peera
                        if (this.pendingTransfers[peerId]) {
                            const { files } = this.pendingTransfers[peerId];
                            delete this.pendingTransfers[peerId];
                            
                            // Dodaj pliki do kolejki transferu
                            Array.from(files).forEach(file => {
                                this.transferQueue.push({
                                    peerId: peerId,
                                    file,
                                    progress: 0
                                });
                            });
                            
                            // Przygotowanie metadanych o plikach
                            const filesMetadata = Array.from(files).map(file => ({
                                name: file.name,
                                type: file.type,
                                size: file.size
                            }));
                            
                            console.log(`[DEBUG] Dodano ${files.length} plików do kolejki transferu dla ${peerId}`);
                            
                            // Wyślij metadane
                            const connection = this.activeConnections[peerId];
                            if (!connection || !connection.send) {
                                console.error(`[BŁĄD] Brak aktywnego połączenia z ${peerId} do wysłania metadanych`);
                                return;
                            }
                            
                            connection.send(JSON.stringify({
                                type: 'metadata',
                                files: filesMetadata
                            }));
                            
                            // Rozpocznij transfer, jeśli nie jest aktywny
                            if (!this.currentTransfer) {
                                console.log(`[DEBUG] Rozpoczynam przetwarzanie kolejki transferu dla ${peerId}`);
                                this.processNextTransfer();
                            }
                        } else {
                            console.warn(`[OSTRZEŻENIE] Otrzymano akceptację transferu, ale nie ma oczekujących plików dla ${peerId}`);
                        }
                        break;
                        
                    case 'reject-transfer':
                        // Transfer został odrzucony
                        console.log(`[DEBUG] Transfer został odrzucony przez ${peerId}`);
                        
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
                        
                        // Wyczyść bieżący odbierany plik
                        this.currentReceivingFile = null;
                        this.incomingFiles = null;
                        this.receivedFiles = [];
                        
                        // Powiadom UI o anulowaniu
                        if (this.onTransferError) {
                            this.onTransferError(peerId, 'Transfer został anulowany przez nadawcę');
                        }
                        break;
                        
                    case 'metadata':
                        // Otrzymano informacje o plikach, które będą przesłane
                        console.log(`[DEBUG] Początek odbierania ${message.files.length} plików od ${peerId}`);
                        console.log(`[DEBUG] Szczegóły plików:`, JSON.stringify(message.files));
                        
                        this.incomingFiles = message.files;
                        this.receivedFiles = [];
                        break;
                        
                    case 'start-file':
                        // Rozpoczęcie odbierania pliku
                        console.log(`[DEBUG] Rozpoczęcie odbierania pliku "${message.name}" (${this.formatFileSize(message.size)}) od ${peerId}`);
                        
                        // Resetowanie lub inicjalizacja odbiornika pliku
                        this.currentReceivingFile = {
                            name: message.name,
                            size: message.size,
                            type: message.type || 'application/octet-stream',
                            chunks: [],
                            receivedSize: 0,
                            lastUpdateTime: null,
                            lastReceivedSize: 0
                        };
                        
                        console.log(`[DEBUG] Zainicjowano odbieranie pliku: ${JSON.stringify({
                            name: message.name,
                            size: this.formatFileSize(message.size),
                            type: message.type || 'application/octet-stream'
                        })}`);
                        break;
                        
                    case 'end-file':
                        // Zakończenie odbierania pliku
                        console.log(`[DEBUG] Otrzymano sygnał końca pliku "${message.name}" od ${peerId}`);
                        
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
            }
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
                        type: e.candidate.type,
                        protocol: e.candidate.protocol,
                        address: e.candidate.address
                    });
                }
            };
            
            // Dodaj pusty kanał danych, aby zainicjować zbieranie kandydatów
            pc.createDataChannel('diagnostic_channel');
            
            // Stwórz ofertę, aby rozpocząć proces ICE
            await pc.createOffer();
            await pc.setLocalDescription();
            
            // Poczekaj na kandydatów
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            result.iceCandidates = iceCandidates;
            
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