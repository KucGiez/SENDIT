const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const https = require('https');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serwowanie plików statycznych
app.use(express.static(path.join(__dirname, 'public')));

// Funkcja do pobierania poświadczeń TURN
function fetchTurnCredentials() {
  return new Promise((resolve, reject) => {
    const apiKey = '606e2f3b5aabd4c33e1b5c5cce474f2b17f8';
    const url = `https://owoc.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`;
    
    https.get(url, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            console.error('Błąd podczas pobierania poświadczeń TURN:', res.statusCode, data);
            // Zwracamy awaryjne, statyczne poświadczenia TURN
            resolve([
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
              }
            ]);
            return;
          }
          
          const credentials = JSON.parse(data);
          console.log('Pobrano poświadczenia TURN:', credentials.length, 'serwerów');
          resolve(credentials);
        } catch (error) {
          console.error('Błąd przetwarzania odpowiedzi TURN:', error);
          reject(error);
        }
      });
    }).on('error', (error) => {
      console.error('Błąd połączenia z API Metered:', error);
      reject(error);
    });
  });
}

// Endpoint do pobierania poświadczeń TURN
app.get('/api/turn-credentials', async (req, res) => {
  try {
    const credentials = await fetchTurnCredentials();
    res.json(credentials);
    console.log('Wysłano poświadczenia TURN do klienta');
  } catch (error) {
    console.error('Błąd pobierania poświadczeń TURN:', error);
    res.status(500).json({
      error: 'Nie udało się pobrać poświadczeń TURN',
      fallback: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });
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
            console.log(`Przekazywanie sygnału od ${networks[networkId][socket.id].id} do ${peerId}`);
            
            // Przekaż sygnał do docelowego klienta w tej samej sieci
            io.to(targetSocketId).emit('signal', {
                peerId: networks[networkId][socket.id].id,
                signal
            });
        } else {
            console.warn(`Nie znaleziono odbiorcy sygnału: ${peerId} w sieci ${networkId}`);
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