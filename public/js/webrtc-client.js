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
            // Konfiguracja serwerów STUN/TURN dla NAT traversal
            const iceServers = [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ];
            
            const peer = new SimplePeer({
                initiator: isInitiator,
                trickle: true,
                config: { iceServers }
            });
            
            peer.on('error', (err) => {
                console.error('Błąd połączenia peer:', err);
                if (this.onTransferError) {
                    this.onTransferError(targetPeerId, err.message);
                }
            });
            
            peer.on('signal', (data) => {
                this.socket.emit('signal', {
                    peerId: targetPeerId,
                    signal: data
                });
            });
            
            peer.on('connect', () => {
                console.log('Połączono z peerem:', targetPeerId);
            });
            
            peer.on('data', (data) => {
                this.handleIncomingData(targetPeerId, data);
            });
            
            peer.on('close', () => {
                console.log('Zamknięto połączenie z peerem:', targetPeerId);
                delete this.activeConnections[targetPeerId];
            });
            
            this.activeConnections[targetPeerId] = peer;
            return peer;
            
        } catch (error) {
            console.error('Błąd podczas tworzenia połączenia peer:', error);
            throw error;
        }
    }

    // Wysłanie plików do określonego peera
    async sendFiles(targetPeerId, files) {
        try {
            let connection = this.activeConnections[targetPeerId];
            
            if (!connection) {
                connection = await this.createPeerConnection(targetPeerId, true);
                
                // Poczekaj na nawiązanie połączenia
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        reject(new Error('Przekroczono czas oczekiwania na połączenie'));
                    }, 30000);
                    
                    connection.on('connect', () => {
                        clearTimeout(timeout);
                        resolve();
                    });
                    
                    connection.on('error', (err) => {
                        clearTimeout(timeout);
                        reject(err);
                    });
                });
            }
            
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
            this.currentTransfer = null;
            return;
        }
        
        this.currentTransfer = this.transferQueue.shift();
        const { peerId, file } = this.currentTransfer;
        
        try {
            const connection = this.activeConnections[peerId];
            if (!connection) {
                throw new Error('Brak połączenia z peerem');
            }
            
            // Rozpocznij transfer pliku
            const chunkSize = 16384; // 16KB chunks
            const reader = new FileReader();
            let offset = 0;
            
            // Informacja o rozpoczęciu transferu
            connection.send(JSON.stringify({
                type: 'start-file',
                name: file.name,
                size: file.size
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
                
                // Aktualizacja postępu
                if (this.onTransferProgress) {
                    this.onTransferProgress(peerId, file, progress, offset);
                }
                
                if (offset < file.size) {
                    // Odczytaj kolejny fragment
                    readNextChunk();
                } else {
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
                            true // isReceiving
                        );
                    }
                }
            } else {
                // Metadane JSON
                const message = JSON.parse(data.toString());
                
                switch (message.type) {
                    case 'metadata':
                        // Otrzymano informacje o plikach, które będą przesłane
                        this.incomingFiles = message.files;
                        this.receivedFiles = [];
                        break;
                        
                    case 'start-file':
                        // Rozpoczęcie odbierania pliku
                        this.currentReceivingFile = {
                            name: message.name,
                            size: message.size,
                            type: '', // Typ może być nieznany
                            chunks: [],
                            receivedSize: 0
                        };
                        break;
                        
                    case 'end-file':
                        // Zakończenie odbierania pliku
                        if (this.currentReceivingFile && this.currentReceivingFile.name === message.name) {
                            // Złączenie wszystkich fragmentów
                            const fileData = new Blob(this.currentReceivingFile.chunks, {
                                type: this.currentReceivingFile.type || 'application/octet-stream'
                            });
                            
                            this.receivedFiles.push({
                                name: this.currentReceivingFile.name,
                                size: this.currentReceivingFile.size,
                                data: fileData
                            });
                            
                            // Sprawdź, czy wszystkie pliki zostały odebrane
                            if (this.incomingFiles && this.receivedFiles.length === this.incomingFiles.length) {
                                if (this.onFilesReceived) {
                                    this.onFilesReceived(peerId, this.receivedFiles);
                                }
                                
                                this.incomingFiles = null;
                                this.receivedFiles = [];
                            }
                            
                            this.currentReceivingFile = null;
                        }
                        break;
                }
            }
        } catch (error) {
            console.error('Błąd przetwarzania przychodzących danych:', error);
        }
    }

    // Zamknięcie wszystkich połączeń
    disconnect() {
        Object.values(this.activeConnections).forEach(connection => {
            connection.destroy();
        });
        
        this.activeConnections = {};
        
        if (this.socket) {
            this.socket.disconnect();
        }
    }
}
