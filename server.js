const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serwowanie plików statycznych
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint do pobierania poświadczeń TURN
app.get('/api/turn-credentials', async (req, res) => {
  try {
    // Pobieranie tymczasowych poświadczeń z serwera Metered
    const response = await fetch(
      "https://owoc.metered.live/api/v1/turn/credentials?apiKey=606e2f3b5aabd4c33e1b5c5cce474f2b17f8"
    );
    
    if (!response.ok) {
      throw new Error('Błąd podczas pobierania poświadczeń TURN');
    }
    
    // Przekazanie poświadczeń do klienta
    const credentials = await response.json();
    res.json(credentials);
  } catch (error) {
    console.error('Błąd pobierania poświadczeń TURN:', error);
    res.status(500).json({ error: 'Nie udało się pobrać poświadczeń TURN' });
  }
});

// Mapowanie aktywnych gniazd (socket) do identyfikatorów urządzeń
// Organizacja: peers[networkId][socketId] = {id, name}
const networks = {};

// Generacja ID dla sieci na podstawie adresu IP
function getNetworkId(socket) {
    // Pobierz adres IP klienta
    const clientIp = socket.handshake.headers['x-forwarded-for'] || 
                    socket.handshake.address;
    
    // Używamy pierwszych 3 oktetów adresu IP jako identyfikator sieci
    // Np. dla 192.168.1.100, identyfikatorem sieci będzie 192.168.1
    const ipSegments = clientIp.split('.');
    const networkSegments = ipSegments.slice(0, 3);
    return networkSegments.join('.');
}

// Losowa generacja unikalnego ID dla każdego urządzenia
function generateId() {
    return Math.random().toString(36).substr(2, 9);
}

// Obsługa połączeń WebSocket
io.on('connection', (socket) => {
    // Identyfikacja sieci klienta
    const networkId = getNetworkId(socket);
    console.log(`Nowe połączenie: ${socket.id} (sieć: ${networkId})`);
    
    // Inicjalizacja struktury dla sieci, jeśli nie istnieje
    if (!networks[networkId]) {
        networks[networkId] = {};
    }
    
    // Przypisanie unikalnego ID dla klienta
    const peerId = generateId();
    networks[networkId][socket.id] = { id: peerId, name: null, networkId };
    
    // Dodanie klienta do pokoju odpowiadającego jego sieci
    socket.join(networkId);
    
    // Wysłanie przypisanego ID do klienta
    socket.emit('assigned-id', peerId);
    socket.emit('network-id', networkId);
    
    // Rejestracja nazwy urządzenia
    socket.on('register-name', (name) => {
        console.log(`Zarejestrowano urządzenie: ${name} (${peerId}) w sieci ${networkId}`);
        networks[networkId][socket.id].name = name;
        
        // Informowanie urządzeń w tej samej sieci o nowym urządzeniu
        socket.to(networkId).emit('peer-joined', { id: peerId, name });
        
        // Wysłanie listy aktualnie połączonych urządzeń w tej samej sieci
        const activePeers = Object.values(networks[networkId])
            .filter(peer => peer.id !== peerId && peer.name)
            .map(peer => ({ id: peer.id, name: peer.name }));
        
        socket.emit('active-peers', activePeers);
    });
    
    // Obsługa wiadomości sygnalizacyjnych WebRTC
    socket.on('signal', ({ peerId, signal }) => {
        // Znajdź gniazdo dla docelowego ID w tej samej sieci
        const targetSocketId = Object.keys(networks[networkId])
            .find(key => networks[networkId][key].id === peerId);
        
        if (targetSocketId) {
            // Przekaż sygnał do docelowego klienta w tej samej sieci
            io.to(targetSocketId).emit('signal', {
                peerId: networks[networkId][socket.id].id,
                signal
            });
        }
    });
    
    // Obsługa rozłączenia
    socket.on('disconnect', () => {
        if (networks[networkId] && networks[networkId][socket.id]) {
            const peerName = networks[networkId][socket.id].name || 'Nieznane urządzenie';
            console.log(`Rozłączono: ${peerName} (sieć: ${networkId})`);
            
            // Powiadom innych w tej samej sieci o odłączeniu urządzenia
            socket.to(networkId).emit('peer-left', networks[networkId][socket.id].id);
            
            // Usuń urządzenie z listy
            delete networks[networkId][socket.id];
            
            // Usuń sieć, jeśli jest pusta
            if (Object.keys(networks[networkId]).length === 0) {
                delete networks[networkId];
            }
        }
    });
});

// Uruchomienie serwera na porcie 3000
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    // Wyświetl dostępne adresy IP w sieci lokalnej
    const networkInterfaces = os.networkInterfaces();
    const addresses = [];
    
    Object.keys(networkInterfaces).forEach(interfaceName => {
        networkInterfaces[interfaceName].forEach(interfaceInfo => {
            if (interfaceInfo.family === 'IPv4' && !interfaceInfo.internal) {
                addresses.push(interfaceInfo.address);
            }
        });
    });
    
    console.log(`Serwer SendIt uruchomiony na porcie ${PORT}`);
    console.log('Dostęp w sieci lokalnej poprzez:');
    addresses.forEach(address => {
        console.log(`http://${address}:${PORT}`);
    });
});