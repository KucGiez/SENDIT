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
        this.onTransferRequest = null; // Nowy callback dla żądań transferu
        this.connectionRetryCount = 0;
        this.maxConnectionRetries = 3;
        this.useFallbackIceServers = false;
        this.isConnecting = {}; // Śledzenie stanu łączenia dla każdego ID peera
        this.pendingTransfers = {}; // Śledzenie oczekujących transferów
    }

    // Inicjalizacja połączenia z serwerem sygnalizacyjnym
    init() {
        return new Promise((resolve, reject) => {
            try {
                this.socket = io();
                
                this.socket.on('connect', () => {
                    console.log('Połączono z serwerem sygnalizacyjnym');
                });
                
                this.socket.on('assigned-id', (id) => {
                    this.peerId = id;
                    console.log('Przydzielono ID:', id);
                    resolve();
                });
                
                this.socket.on('network-id', (networkId) => {
                    console.log('Przydzielono ID sieci:', networkId);
                    this.networkId = networkId;
                });
                
                this.socket.on('active-peers', (peers) => {
                    this.peers = {};
                    peers.forEach(peer => {
                        this.peers[peer.id] = peer;
                    });
                    
                    if (this.onPeersUpdated) {
                        this.onPeersUpdated(Object.values(this.peers));
                    }
                });
                
                this.socket.on('peer-joined', (peer) => {
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
                    delete this.peers[peerId];
                    
                    // Zamknij wszystkie istniejące połączenia z tym peerem
                    if (this.activeConnections[peerId]) {
                        try {
                            this.activeConnections[peerId].destroy();
                        } catch (err) {
                            console.error('Błąd podczas zamykania połączenia:', err);
                        }
                        delete this.activeConnections[peerId];
                        delete this.isConnecting[peerId];
                    }
                    
                    // Usuń oczekujące transfery
                    delete this.pendingTransfers[peerId];
                    
                    if (this.onPeerDisconnected && peer) {
                        this.onPeerDisconnected(peer);
                    }
                    
                    if (this.onPeersUpdated) {
                        this.onPeersUpdated(Object.values(this.peers));
                    }
                });
                
                // Obsługa wiadomości sygnalizacyjnych
                this.socket.on('signal', async ({ peerId, signal }) => {
                    try {
                        console.log(`Otrzymano sygnał od ${peerId}:`, signal.type || 'unknown');
                        
                        // Sprawdź czy połączenie już istnieje lub jest w trakcie tworzenia
                        if (!this.activeConnections[peerId] && !this.isConnecting[peerId]) {
                            // Oznacz, że rozpoczęto łączenie
                            this.isConnecting[peerId] = true;
                            try {
                                await this.createPeerConnection(peerId, false);
                            } catch (error) {
                                console.error('Błąd podczas tworzenia połączenia po otrzymaniu sygnału:', error);
                                delete this.isConnecting[peerId];
                                return;
                            }
                        }
                        
                        // Zabezpieczenie przed przypadkiem, gdy połączenie mogło zostać usunięte w międzyczasie
                        if (this.activeConnections[peerId]) {
                            await this.activeConnections[peerId].signal(signal);
                        } else {
                            console.warn(`Nie można przetworzyć sygnału dla ${peerId} - brak połączenia`);
                        }
                    } catch (error) {
                        console.error('Błąd podczas przetwarzania sygnału:', error);
                        // Usuń znacznik tworzenia połączenia w przypadku błędu
                        delete this.isConnecting[peerId];
                    }
                });
                
                this.socket.on('connect_error', (error) => {
                    console.error('Błąd połączenia z serwerem:', error);
                    reject(error);
                });
            } catch (error) {
                console.error('Błąd inicjalizacji klienta:', error);
                reject(error);
            }
        });
    }

    // Rejestracja nazwy urządzenia
    registerDevice(name) {
        this.deviceName = name;
        this.socket.emit('register-name', name);
    }

    // Pobieranie konfiguracji ICE serwerów z gwarancją fallbacku
    async getIceServers() {
        // Awaryjne serwery ICE - zawsze działające podstawowe STUN
        const fallbackServers = [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ];

        // Jeśli ustawiono flagę awaryjną, użyj tylko podstawowych serwerów STUN
        if (this.useFallbackIceServers) {
            console.log('Używam awaryjnych serwerów ICE (tylko STUN)');
            return fallbackServers;
        }

        try {
            console.log('Pobieranie poświadczeń TURN z serwera...');
            const startTime = Date.now();
            
            const response = await fetch('/api/turn-credentials');
            const responseTime = Date.now() - startTime;
            console.log(`Otrzymano odpowiedź z serwera TURN w ${responseTime}ms`);
            
            const data = await response.json();
            
            if (!response.ok) {
                console.warn('Serwer zwrócił błąd:', data.error);
                return fallbackServers;
            }
            
            if (!Array.isArray(data) || data.length === 0) {
                console.warn('Otrzymano nieprawidłowe dane z serwera TURN:', data);
                return fallbackServers;
            }
            
            console.log(`Pobrano ${data.length} serwerów ICE:`, 
                data.map(server => server.urls).join(', '));
            
            return data;
        } catch (error) {
            console.error('Błąd podczas pobierania poświadczeń TURN:', error);
            return fallbackServers;
        }
    }

    // Utworzenie połączenia peer-to-peer
    async createPeerConnection(targetPeerId, isInitiator = true) {
        try {
            console.log(`Tworzenie połączenia peer z ${targetPeerId}, initiator: ${isInitiator}`);
            
            // Oznacz, że rozpoczęto łączenie
            this.isConnecting[targetPeerId] = true;
            
            // Pobierz konfigurację ICE serwerów
            const iceServers = await this.getIceServers();
            
            // Wyświetl pełną konfigurację do debugowania
            console.log('Konfiguracja połączenia WebRTC:', {
                initiator: isInitiator,
                trickle: true,
                iceTransportPolicy: 'all',
                sdpSemantics: 'unified-plan',
                iceServers: iceServers.map(server => ({ 
                    urls: server.urls,
                    // Ukryj dane uwierzytelniające z logów dla bezpieczeństwa
                    ...(server.username ? { username: '***' } : {}),
                    ...(server.credential ? { credential: '***' } : {})
                }))
            });
            
            const peer = new SimplePeer({
                initiator: isInitiator,
                trickle: true,
                config: { 
                    iceServers,
                    iceTransportPolicy: 'all',
                    sdpSemantics: 'unified-plan'
                }
            });
            
            // Śledź stan połączenia ICE
            let iceConnectionState = null;
            let iceGatheringState = null;
            let signalingState = null;
            
            peer.on('signal', (data) => {
                console.log(`Wysyłanie sygnału do ${targetPeerId}:`, data.type || 'unknown');
                if (this.socket && this.socket.connected) {
                    this.socket.emit('signal', {
                        peerId: targetPeerId,
                        signal: data
                    });
                } else {
                    console.error('Nie można wysłać sygnału - socket jest null lub rozłączony');
                }
            });
            
            peer.on('error', (err) => {
                console.error(`Błąd połączenia peer (${targetPeerId}):`, err.message);
                
                // Zgłoś szczegóły stanu połączenia
                console.error(`Stan połączenia: ICE=${iceConnectionState}, gathering=${iceGatheringState}, signaling=${signalingState}`);
                
                // Jeśli połączenie nie powiodło się z obecnymi serwerami ICE, spróbuj z awaryjnymi
                if (!this.useFallbackIceServers && this.connectionRetryCount >= this.maxConnectionRetries) {
                    console.log('Przełączam na awaryjne serwery ICE');
                    this.useFallbackIceServers = true;
                    this.connectionRetryCount = 0;
                    
                    // Usuń obecne połączenie
                    this.cleanupConnection(targetPeerId, peer);
                    
                    // Spróbuj ponownie z awaryjnymi serwerami
                    setTimeout(() => {
                        this.createPeerConnection(targetPeerId, isInitiator)
                        .catch(fallbackError => {
                            console.error('Nieudana próba z awaryjnymi serwerami:', fallbackError);
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
                    console.log(`Próba ponownego połączenia ${this.connectionRetryCount + 1}/${this.maxConnectionRetries}`);
                    this.connectionRetryCount++;
                    
                    // Usuń obecne połączenie i utwórz nowe
                    this.cleanupConnection(targetPeerId, peer);
                    
                    // Oczekuj chwilę przed ponowną próbą
                    setTimeout(() => {
                        this.createPeerConnection(targetPeerId, isInitiator)
                        .catch(retryError => {
                            console.error('Nieudana próba ponownego połączenia:', retryError);
                            if (this.onTransferError) {
                                this.onTransferError(targetPeerId, 'Nie udało się nawiązać połączenia po kilku próbach.');
                            }
                            delete this.isConnecting[targetPeerId];
                        });
                    }, 1000);
                } else {
                    // Powiadom o błędzie po wyczerpaniu prób
                    this.connectionRetryCount = 0;
                    delete this.isConnecting[targetPeerId];
                    if (this.onTransferError) {
                        this.onTransferError(targetPeerId, err.message);
                    }
                }
            });
            
            peer.on('connect', () => {
                console.log(`Połączono z peerem: ${targetPeerId}`);
                // Resetuj licznik prób po udanym połączeniu
                this.connectionRetryCount = 0;
                this.useFallbackIceServers = false; // Resetuj flagę awaryjną
                delete this.isConnecting[targetPeerId]; // Usuń znacznik nawiązywania połączenia
            });
            
            peer.on('data', (data) => {
                this.handleIncomingData(targetPeerId, data);
            });
            
            peer.on('close', () => {
                console.log(`Zamknięto połączenie z peerem: ${targetPeerId}`);
                this.cleanupConnection(targetPeerId);
            });
            
            // Dodatkowe monitorowanie stanu ICE
            peer.on('iceStateChange', (state) => {
                iceConnectionState = state;
                console.log(`Zmiana stanu ICE dla ${targetPeerId}:`, state);
                
                // Jeśli stan ICE to 'failed', oznacza to problem z połączeniem
                if (state === 'failed') {
                    console.error(`Połączenie ICE nie powiodło się dla ${targetPeerId}`);
                    if (this.onTransferError) {
                        this.onTransferError(targetPeerId, 'Nie udało się nawiązać połączenia ICE.');
                    }
                }
            });
            
            // Dodatkowe monitorowanie jeśli peer udostępnia te informacje
            if (peer._pc) {
                peer._pc.addEventListener('icegatheringstatechange', () => {
                    iceGatheringState = peer._pc.iceGatheringState;
                    console.log(`Zmiana stanu zbierania ICE dla ${targetPeerId}:`, peer._pc.iceGatheringState);
                });
                
                peer._pc.addEventListener('signalingstatechange', () => {
                    signalingState = peer._pc.signalingState;
                    console.log(`Zmiana stanu sygnalizacji dla ${targetPeerId}:`, peer._pc.signalingState);
                });
                
                peer._pc.addEventListener('connectionstatechange', () => {
                    console.log(`Zmiana stanu połączenia dla ${targetPeerId}:`, peer._pc.connectionState);
                    
                    // Reaguj na stan "failed" lub "disconnected"
                    if (peer._pc.connectionState === 'failed' || peer._pc.connectionState === 'disconnected') {
                        console.error(`Połączenie WebRTC ${peer._pc.connectionState} dla ${targetPeerId}`);
                        if (this.onTransferError) {
                            this.onTransferError(targetPeerId, `Połączenie WebRTC ${peer._pc.connectionState}`);
                        }
                    }
                });
            }
            
            // Ustaw połączenie jako aktywne
            this.activeConnections[targetPeerId] = peer;
            return peer;
            
        } catch (error) {
            console.error(`Błąd podczas tworzenia połączenia peer z ${targetPeerId}:`, error);
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
            console.log(`Wysyłanie żądania transferu ${files.length} plików do ${targetPeerId}`);
            
            // Sprawdź, czy jest aktywne połączenie i czy jest gotowe
            let connection = this.activeConnections[targetPeerId];
            let needNewConnection = !this.isConnectionReady(targetPeerId);
            
            if (needNewConnection) {
                console.log(`Brak aktywnego gotowego połączenia z ${targetPeerId}, tworzę nowe połączenie`);
                
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
                        console.log(`Pomyślnie nawiązano połączenie z ${targetPeerId}`);
                        clearTimeout(connectionTimeout);
                        connection.removeListener('connect', connectHandler);
                        connection.removeListener('error', errorHandler);
                        resolve();
                    };
                    
                    // Funkcja obsługi błędu
                    const errorHandler = (err) => {
                        console.error(`Błąd podczas nawiązywania połączenia z ${targetPeerId}:`, err);
                        clearTimeout(connectionTimeout);
                        connection.removeListener('connect', connectHandler);
                        connection.removeListener('error', errorHandler);
                        reject(err);
                    };
                    
                    // Ustaw timeout
                    connectionTimeout = setTimeout(() => {
                        connection.removeListener('connect', connectHandler);
                        connection.removeListener('error', errorHandler);
                        reject(new Error('Przekroczono czas oczekiwania na połączenie'));
                    }, 30000);
                    
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
                connection.send(JSON.stringify({
                    type: 'request-transfer',
                    files: filesMetadata,
                    totalSize: totalSize,
                    senderName: this.deviceName
                }));
                
                console.log(`Wysłano żądanie transferu plików do ${targetPeerId}`);
                
                // Zapisz pliki do tymczasowej kolejki oczekując na odpowiedź
                this.pendingTransfers[targetPeerId] = {
                    files: files,
                    timestamp: Date.now()
                };
                
                // Rozpocznij timeout dla oczekiwania na odpowiedź (30 sekund)
                setTimeout(() => {
                    if (this.pendingTransfers[targetPeerId]) {
                        console.log(`Timeout oczekiwania na odpowiedź od ${targetPeerId}`);
                        delete this.pendingTransfers[targetPeerId];
                        if (this.onTransferError) {
                            this.onTransferError(targetPeerId, 'Nie otrzymano odpowiedzi na żądanie transferu');
                        }
                    }
                }, 30000);
                
                return true;
            } catch (error) {
                console.error('Błąd podczas wysyłania żądania transferu:', error);
                throw new Error('Błąd podczas wysyłania żądania transferu: ' + error.message);
            }
        } catch (error) {
            console.error('Błąd podczas przygotowania żądania transferu plików:', error);
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
            
            connection.send(JSON.stringify({
                type: accepted ? 'accept-transfer' : 'reject-transfer'
            }));
            
            console.log(`Wysłano ${accepted ? 'akceptację' : 'odrzucenie'} transferu do ${peerId}`);
            return true;
        } catch (error) {
            console.error('Błąd podczas odpowiadania na żądanie transferu:', error);
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
            console.error('Błąd podczas wysyłania plików:', error);
            if (this.onTransferError) {
                this.onTransferError(targetPeerId, error.message);
            }
            throw error;
        }
    }

    // Przetwarzanie kolejnego pliku z kolejki
    async processNextTransfer() {
        if (this.transferQueue.length === 0) {
            console.log('Kolejka transferu jest pusta');
            this.currentTransfer = null;
            return;
        }
        
        this.currentTransfer = this.transferQueue.shift();
        const { peerId, file } = this.currentTransfer;
        
        console.log(`Rozpoczynam transfer pliku "${file.name}" (${this.formatFileSize(file.size)}) do ${peerId}`);
        
        try {
            // Sprawdź, czy połączenie istnieje i jest gotowe
            if (!this.isConnectionReady(peerId)) {
                throw new Error('Brak aktywnego połączenia z peerem');
            }
            
            const connection = this.activeConnections[peerId];
            
            // Rozpocznij transfer pliku
            const chunkSize = 16384; // 16KB chunks
            const reader = new FileReader();
            let offset = 0;
            let lastUpdateTime = Date.now();
            let lastOffset = 0;
            
            // Informacja o rozpoczęciu transferu
            try {
                connection.send(JSON.stringify({
                    type: 'start-file',
                    name: file.name,
                    size: file.size,
                    type: file.type
                }));
            } catch (error) {
                console.error('Błąd podczas wysyłania informacji o rozpoczęciu transferu:', error);
                throw new Error('Błąd podczas wysyłania informacji o rozpoczęciu transferu: ' + error.message);
            }
            
            const readNextChunk = () => {
                // Sprawdź, czy połączenie jest wciąż aktywne
                if (!this.isConnectionReady(peerId)) {
                    throw new Error('Połączenie zostało zamknięte w trakcie transferu');
                }
                
                const slice = file.slice(offset, offset + chunkSize);
                reader.readAsArrayBuffer(slice);
            };
            
            reader.onload = (e) => {
                try {
                    // Sprawdź, czy połączenie jest wciąż aktywne
                    if (!this.isConnectionReady(peerId)) {
                        throw new Error('Połączenie zostało zamknięte w trakcie transferu');
                    }
                    
                    const chunk = e.target.result;
                    
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
                        
                        // Aktualizacja postępu
                        if (this.onTransferProgress) {
                            this.onTransferProgress(peerId, file, progress, offset, false, bytesPerSecond);
                        }
                    }
                    
                    if (offset < file.size) {
                        // Odczytaj kolejny fragment
                        readNextChunk();
                    } else {
                        console.log(`Transfer pliku "${file.name}" zakończony`);
                        
                        // Zakończenie transferu tego pliku
                        connection.send(JSON.stringify({
                            type: 'end-file',
                            name: file.name
                        }));
                        
                        if (this.onTransferComplete) {
                            this.onTransferComplete(peerId, file);
                        }
                        
                        // Przejdź do kolejnego pliku w kolejce
                        this.processNextTransfer();
                    }
                } catch (error) {
                    console.error('Błąd podczas wysyłania danych:', error);
                    if (this.onTransferError) {
                        this.onTransferError(peerId, 'Błąd podczas wysyłania danych: ' + error.message);
                    }
                    this.processNextTransfer();
                }
            };
            
            reader.onerror = (error) => {
                console.error('Błąd odczytu pliku:', error);
                if (this.onTransferError) {
                    this.onTransferError(peerId, 'Błąd odczytu pliku');
                }
                this.processNextTransfer();
            };
            
            // Rozpocznij proces odczytu
            readNextChunk();
            
        } catch (error) {
            console.error('Błąd podczas przetwarzania transferu:', error);
            if (this.onTransferError) {
                this.onTransferError(peerId, error.message);
            }
            this.processNextTransfer();
        }
    }

    // Anulowanie transferu (można wywołać z UI)
    cancelTransfer(peerId) {
        console.log(`Anulowanie transferu dla ${peerId}`);
        
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
            console.error('Błąd podczas anulowania transferu:', error);
            return false;
        }
    }

    // Obsługa przychodzących danych
    handleIncomingData(peerId, data) {
        try {
            // Sprawdź, czy dane są typu Buffer (fragment pliku) czy JSON (metadane)
            if (data.constructor === ArrayBuffer || data instanceof Uint8Array) {
                // Fragment pliku - dodaj do bieżącego odbieranego pliku
                if (this.currentReceivingFile) {
                    this.currentReceivingFile.chunks.push(data);
                    this.currentReceivingFile.receivedSize += data.byteLength;
                    
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
                    console.warn('Otrzymano fragment pliku bez aktywnego transferu');
                }
            } else {
                // Metadane JSON
                const message = JSON.parse(data.toString());
                console.log(`Otrzymano wiadomość typu ${message.type} od ${peerId}`);
                
                switch (message.type) {
                    case 'request-transfer':
                        // Otrzymano żądanie transferu plików
                        console.log(`Otrzymano żądanie transferu ${message.files.length} plików od ${peerId}`);
                        
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
                        console.log(`Transfer został zaakceptowany przez ${peerId}`);
                        
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
                            
                            // Wyślij metadane
                            const connection = this.activeConnections[peerId];
                            connection.send(JSON.stringify({
                                type: 'metadata',
                                files: filesMetadata
                            }));
                            
                            // Rozpocznij transfer, jeśli nie jest aktywny
                            if (!this.currentTransfer) {
                                this.processNextTransfer();
                            }
                        } else {
                            console.warn(`Otrzymano akceptację transferu, ale nie ma oczekujących plików dla ${peerId}`);
                        }
                        break;
                        
                    case 'reject-transfer':
                        // Transfer został odrzucony
                        console.log(`Transfer został odrzucony przez ${peerId}`);
                        
                        // Usuń oczekujące pliki dla tego peera
                        delete this.pendingTransfers[peerId];
                        
                        // Powiadom UI o odrzuceniu
                        if (this.onTransferError) {
                            this.onTransferError(peerId, 'Transfer został odrzucony przez odbiorcę');
                        }
                        break;
                        
                    case 'cancel-transfer':
                        // Transfer został anulowany przez drugą stronę
                        console.log(`Transfer został anulowany przez ${peerId}`);
                        
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
                        console.log(`Początek odbierania ${message.files.length} plików`);
                        this.incomingFiles = message.files;
                        this.receivedFiles = [];
                        break;
                        
                    case 'start-file':
                        // Rozpoczęcie odbierania pliku
                        console.log(`Rozpoczęcie odbierania pliku "${message.name}" (${this.formatFileSize(message.size)})`);
                        this.currentReceivingFile = {
                            name: message.name,
                            size: message.size,
                            type: message.type || 'application/octet-stream',
                            chunks: [],
                            receivedSize: 0,
                            lastUpdateTime: null,
                            lastReceivedSize: 0
                        };
                        break;
                        
                    case 'end-file':
                        // Zakończenie odbierania pliku
                        if (this.currentReceivingFile && this.currentReceivingFile.name === message.name) {
                            console.log(`Zakończenie odbierania pliku "${message.name}"`);
                            
                            // Złączenie wszystkich fragmentów
                            const fileData = new Blob(this.currentReceivingFile.chunks, {
                                type: this.currentReceivingFile.type
                            });
                            
                            this.receivedFiles.push({
                                name: this.currentReceivingFile.name,
                                size: this.currentReceivingFile.size,
                                type: this.currentReceivingFile.type,
                                data: fileData
                            });
                            
                            // Sprawdź, czy wszystkie pliki zostały odebrane
                            if (this.incomingFiles && this.receivedFiles.length === this.incomingFiles.length) {
                                console.log(`Wszystkie pliki zostały odebrane (${this.receivedFiles.length})`);
                                if (this.onFilesReceived) {
                                    this.onFilesReceived(peerId, this.receivedFiles);
                                }
                                
                                this.incomingFiles = null;
                                this.receivedFiles = [];
                            }
                            
                            this.currentReceivingFile = null;
                        } else {
                            console.warn(`Otrzymano sygnał końca pliku "${message.name}", ale nie ma aktywnego transferu lub nazwa się nie zgadza`);
                        }
                        break;
                        
                    default:
                        console.warn(`Nieznany typ wiadomości: ${message.type}`);
                }
            }
        } catch (error) {
            console.error('Błąd przetwarzania przychodzących danych:', error);
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
        console.log('Zamykanie wszystkich połączeń');
        Object.keys(this.activeConnections).forEach(peerId => {
            this.cleanupConnection(peerId);
        });
        
        this.activeConnections = {};
        this.isConnecting = {};
        this.pendingTransfers = {};
        
        if (this.socket) {
            this.socket.disconnect();
        }
    }
}