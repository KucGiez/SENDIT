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
        this.connectionRetryCount = 0;
        this.maxConnectionRetries = 3;
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
                        this.activeConnections[peerId].close();
                        delete this.activeConnections[peerId];
                    }
                    
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
                        console.log(`Otrzymano sygnał od ${peerId}`);
                        
                        if (!this.activeConnections[peerId]) {
                            await this.createPeerConnection(peerId, false);
                        }
                        
                        await this.activeConnections[peerId].signal(signal);
                    } catch (error) {
                        console.error('Błąd podczas przetwarzania sygnału:', error);
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

    // Utworzenie połączenia peer-to-peer
    async createPeerConnection(targetPeerId, isInitiator = true) {
        try {
            console.log(`Tworzenie połączenia peer z ${targetPeerId}, initiator: ${isInitiator}`);
            
            // Pobranie dynamicznych poświadczeń TURN
            let iceServers = [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ];
            
            try {
                console.log('Pobieranie dynamicznych poświadczeń TURN...');
                const response = await fetch('/api/turn-credentials');
                if (response.ok) {
                    const turnCredentials = await response.json();
                    console.log('Pobrano dynamiczne poświadczenia TURN');
                    iceServers = turnCredentials;
                } else {
                    console.warn('Nie udało się pobrać poświadczeń TURN, używam tylko serwerów STUN');
                }
            } catch (error) {
                console.error('Błąd podczas pobierania poświadczeń TURN:', error);
                console.warn('Używam tylko serwerów STUN jako fallback');
            }
            
            const peer = new SimplePeer({
                initiator: isInitiator,
                trickle: true,
                config: { iceServers },
                sdpTransform: (sdp) => {
                    console.log('Transformacja SDP dla lepszej kompatybilności');
                    sdp = sdp.replace('useinbandfec=1', 'useinbandfec=1; stereo=1; maxaveragebitrate=510000');
                    return sdp;
                }
            });
            
            peer.on('error', (err) => {
                console.error(`Błąd połączenia peer (${targetPeerId}):`, err);
                
                // Spróbuj ponownie nawiązać połączenie jeśli to możliwe
                if (this.connectionRetryCount < this.maxConnectionRetries) {
                    console.log(`Próba ponownego połączenia ${this.connectionRetryCount + 1}/${this.maxConnectionRetries}`);
                    this.connectionRetryCount++;
                    
                    // Usuń obecne połączenie i utwórz nowe
                    delete this.activeConnections[targetPeerId];
                    
                    // Sprawdź czy obiekt peer istnieje i zniszcz go przed ponowną próbą
                    if (peer && typeof peer.destroy === 'function') {
                        peer.destroy();
                    }
                    
                    // Oczekuj chwilę przed ponowną próbą
                    setTimeout(() => {
                        this.createPeerConnection(targetPeerId, isInitiator)
                        .catch(retryError => {
                            console.error('Nieudana próba ponownego połączenia:', retryError);
                            if (this.onTransferError) {
                                this.onTransferError(targetPeerId, 'Nie udało się nawiązać połączenia po kilku próbach.');
                            }
                        });
                    }, 1000);
                } else {
                    // Powiadom o błędzie po wyczerpaniu prób
                    this.connectionRetryCount = 0;
                    if (this.onTransferError) {
                        this.onTransferError(targetPeerId, err.message);
                    }
                }
            });
            
            peer.on('signal', (data) => {
                console.log(`Wysyłanie sygnału do ${targetPeerId}`);
                this.socket.emit('signal', {
                    peerId: targetPeerId,
                    signal: data
                });
            });
            
            peer.on('connect', () => {
                console.log(`Połączono z peerem: ${targetPeerId}`);
                // Resetuj licznik prób po udanym połączeniu
                this.connectionRetryCount = 0;
            });
            
            peer.on('data', (data) => {
                this.handleIncomingData(targetPeerId, data);
            });
            
            peer.on('close', () => {
                console.log(`Zamknięto połączenie z peerem: ${targetPeerId}`);
                delete this.activeConnections[targetPeerId];
            });
            
            peer.on('iceStateChange', (state) => {
                console.log(`Zmiana stanu ICE dla ${targetPeerId}:`, state);
            });
            
            this.activeConnections[targetPeerId] = peer;
            return peer;
            
        } catch (error) {
            console.error(`Błąd podczas tworzenia połączenia peer z ${targetPeerId}:`, error);
            if (this.onTransferError) {
                this.onTransferError(targetPeerId, `Błąd konfiguracji: ${error.message}`);
            }
            throw error;
        }
    }

    // Wysłanie plików do określonego peera
    async sendFiles(targetPeerId, files) {
        try {
            console.log(`Rozpoczynam wysyłanie ${files.length} plików do ${targetPeerId}`);
            let connection = this.activeConnections[targetPeerId];
            
            if (!connection) {
                console.log(`Brak aktywnego połączenia z ${targetPeerId}, tworzę nowe połączenie`);
                connection = await this.createPeerConnection(targetPeerId, true);
                
                // Poczekaj na nawiązanie połączenia
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        reject(new Error('Przekroczono czas oczekiwania na połączenie'));
                    }, 30000);
                    
                    // Utworzenie funkcji obsługi zdarzeń, które zostaną usunięte po zakończeniu
                    const connectHandler = () => {
                        clearTimeout(timeout);
                        resolve();
                    };
                    
                    const errorHandler = (err) => {
                        clearTimeout(timeout);
                        reject(err);
                    };
                    
                    connection.once('connect', connectHandler);
                    connection.once('error', errorHandler);
                    
                    // Obsługa czyszczenia po zakończeniu
                    setTimeout(() => {
                        connection.removeListener('connect', connectHandler);
                        connection.removeListener('error', errorHandler);
                    }, 30000);
                });
            }
            
            console.log(`Połączenie ustanowione, przygotowuję metadane dla ${files.length} plików`);
            
            // Przygotowanie metadanych o plikach
            const filesMetadata = Array.from(files).map(file => ({
                name: file.name,
                type: file.type,
                size: file.size
            }));
            
            // Wysłanie metadanych
            connection.send(JSON.stringify({
                type: 'metadata',
                files: filesMetadata
            }));
            
            console.log('Metadane wysłane, dodaję pliki do kolejki transferu');
            
            // Dodanie plików do kolejki transferu
            Array.from(files).forEach(file => {
                this.transferQueue.push({
                    peerId: targetPeerId,
                    file,
                    progress: 0
                });
            });
            
            // Rozpoczęcie transferu, jeśli nie jest aktywny
            if (!this.currentTransfer) {
                console.log('Rozpoczynam transfer plików z kolejki');
                this.processNextTransfer();
            }
            
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
            const connection = this.activeConnections[peerId];
            if (!connection) {
                throw new Error('Brak połączenia z peerem');
            }
            
            // Rozpocznij transfer pliku
            const chunkSize = 16384; // 16KB chunks
            const reader = new FileReader();
            let offset = 0;
            let lastUpdateTime = Date.now();
            let lastOffset = 0;
            
            // Informacja o rozpoczęciu transferu
            connection.send(JSON.stringify({
                type: 'start-file',
                name: file.name,
                size: file.size,
                type: file.type
            }));
            
            const readNextChunk = () => {
                const slice = file.slice(offset, offset + chunkSize);
                reader.readAsArrayBuffer(slice);
            };
            
            reader.onload = (e) => {
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
        Object.values(this.activeConnections).forEach(connection => {
            connection.destroy();
        });
        
        this.activeConnections = {};
        
        if (this.socket) {
            this.socket.disconnect();
        }
    }
}