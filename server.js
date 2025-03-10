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

// Cache dla poświadczeń TURN z czasem wygaśnięcia
let cachedTurnCredentials = null;
let credentialsExpiry = 0;
const CREDENTIALS_TTL = 12 * 60 * 60 * 1000; // 12 godzin w milisekundach

// Funkcja do pobierania poświadczeń TURN
function fetchTurnCredentials() {
  return new Promise((resolve, reject) => {
    // Jeśli mamy ważne poświadczenia w cache, zwróć je
    const now = Date.now();
    if (cachedTurnCredentials && now < credentialsExpiry) {
      console.log('Używam poświadczeń TURN z cache', cachedTurnCredentials.length, 'serwerów');
      resolve(cachedTurnCredentials);
      return;
    }

    const apiKey = '606e2f3b5aabd4c33e1b5c5cce474f2b17f8';
    const url = `https://owoc.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`;
    
    // Dodanie timeoutu 5 sekund dla żądania HTTP
    const req = https.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            console.error('Błąd podczas pobierania poświadczeń TURN:', res.statusCode, data);
            // Jeśli mamy jakiekolwiek poświadczenia w cache, użyj ich mimo wygaśnięcia
            if (cachedTurnCredentials) {
              console.log('Używam wygasłych poświadczeń TURN z cache jako fallback');
              resolve(cachedTurnCredentials);
              return;
            }
            
            // Zwracamy awaryjne, statyczne poświadczenia TURN
            const fallbackCredentials = getFallbackTurnCredentials();
            resolve(fallbackCredentials);
            return;
          }
          
          const credentials = JSON.parse(data);
          console.log('Pobrano poświadczenia TURN:', credentials.length, 'serwerów');
          
          // Dodajemy publiczne serwery jako dodatkowe zabezpieczenie
          const enhancedCredentials = [...credentials, ...getPublicStunServers()];
          
          // Zapisz do cache z czasem ważności
          cachedTurnCredentials = enhancedCredentials;
          credentialsExpiry = now + CREDENTIALS_TTL;
          
          resolve(enhancedCredentials);
        } catch (error) {
          console.error('Błąd przetwarzania odpowiedzi TURN:', error);
          
          // Jeśli mamy jakiekolwiek poświadczenia w cache, użyj ich mimo wygaśnięcia
          if (cachedTurnCredentials) {
            console.log('Używam wygasłych poświadczeń TURN z cache po błędzie parsowania');
            resolve(cachedTurnCredentials);
            return;
          }
          
          // Zwracamy awaryjne, statyczne poświadczenia TURN
          const fallbackCredentials = getFallbackTurnCredentials();
          resolve(fallbackCredentials);
        }
      });
    });
    
    req.on('error', (error) => {
      console.error('Błąd połączenia z API Metered:', error);
      
      // Jeśli mamy jakiekolwiek poświadczenia w cache, użyj ich mimo wygaśnięcia
      if (cachedTurnCredentials) {
        console.log('Używam wygasłych poświadczeń TURN z cache po błędzie połączenia');
        resolve(cachedTurnCredentials);
        return;
      }
      
      // Zwracamy awaryjne, statyczne poświadczenia TURN
      const fallbackCredentials = getFallbackTurnCredentials();
      resolve(fallbackCredentials);
    });
    
    req.on('timeout', () => {
      req.abort();
      console.error('Timeout podczas pobierania poświadczeń TURN');
      
      // Jeśli mamy jakiekolwiek poświadczenia w cache, użyj ich mimo wygaśnięcia
      if (cachedTurnCredentials) {
        console.log('Używam wygasłych poświadczeń TURN z cache po timeoucie');
        resolve(cachedTurnCredentials);
        return;
      }
      
      // Zwracamy awaryjne, statyczne poświadczenia TURN
      const fallbackCredentials = getFallbackTurnCredentials();
      resolve(fallbackCredentials);
    });
  });
}

// Funkcja zwracająca awaryjne statyczne poświadczenia TURN
function getFallbackTurnCredentials() {
  console.log('Używam awaryjnych, statycznych poświadczeń TURN');
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
    // Dodajemy publiczne serwery STUN dla zwiększenia niezawodności
    ...getPublicStunServers()
  ];
}

// Funkcja zwracająca listę publicznych serwerów STUN
function getPublicStunServers() {
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

// Endpoint do pobierania poświadczeń TURN z obsługą retry
app.get('/api/turn-credentials', async (req, res) => {
  let retries = 0;
  const maxRetries = 2;
  
  async function attemptFetch() {
    try {
      const credentials = await fetchTurnCredentials();
      res.json(credentials);
      console.log('Wysłano poświadczenia TURN do klienta');
    } catch (error) {
      if (retries < maxRetries) {
        retries++;
        console.log(`Próba ponownego pobrania poświadczeń TURN (${retries}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        await attemptFetch();
      } else {
        console.error('Wyczerpano próby pobierania poświadczeń TURN:', error);
        res.status(500).json({
          error: 'Nie udało się pobrać poświadczeń TURN',
          fallback: getPublicStunServers()
        });
      }
    }
  }
  
  await attemptFetch();
});

// Dodatkowy endpoint do testowania połączenia i pobierania informacji o sieci
app.get('/api/network-check', (req, res) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const networkSegments = clientIp.split('.').slice(0, 3).join('.');
  
  res.json({
    ip: clientIp,
    networkId: networkSegments,
    server: {
      time: new Date().toISOString(),
      uptime: process.uptime()
    }
  });
});

// Mapowanie aktywnych gniazd (socket) do identyfikatorów urządzeń
// Organizacja: peers[networkId][socketId] = {id, name}
const networks = {};

// Statystyki aktywności sieci
const networkStats = {};

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
        networkStats[networkId] = {
            created: new Date(),
            connectionCount: 0,
            signalCount: 0
        };
    }
    
    // Aktualizuj statystyki
    networkStats[networkId].connectionCount++;
    
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
        // Aktualizuj statystyki
        networkStats[networkId].signalCount++;
        
        // Znajdź gniazdo dla docelowego ID w tej samej sieci
        const targetSocketId = Object.keys(networks[networkId])
            .find(key => networks[networkId][key].id === peerId);
        
        if (targetSocketId) {
            console.log(`Przekazywanie sygnału od ${networks[networkId][socket.id].id} do ${peerId} (typ: ${signal.type || 'candidate'})`);
            
            // Przekaż sygnał do docelowego klienta w tej samej sieci
            io.to(targetSocketId).emit('signal', {
                peerId: networks[networkId][socket.id].id,
                signal
            });
        } else {
            console.warn(`Nie znaleziono odbiorcy sygnału: ${peerId} w sieci ${networkId}`);
            
            // Powiadom nadawcę o braku odbiorcy
            socket.emit('signal-error', {
                targetPeerId: peerId,
                error: 'peer-not-found'
            });
        }
    });
    
    // Nowy endpoint dla potwierdzenia odebrania sygnału
    socket.on('signal-received', ({ originPeerId }) => {
        // Znajdź gniazdo dla źródłowego ID w tej samej sieci
        const sourceSocketId = Object.keys(networks[networkId])
            .find(key => networks[networkId][key].id === originPeerId);
        
        if (sourceSocketId) {
            io.to(sourceSocketId).emit('signal-confirmation', {
                peerId: networks[networkId][socket.id].id
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
                delete networkStats[networkId];
                console.log(`Usunięto pustą sieć: ${networkId}`);
            }
        }
    });
});

// Funkcja do okresowego czyszczenia niewykorzystywanych sieci (uruchamiana co godzinę)
setInterval(() => {
    const now = Date.now();
    const inactiveThreshold = 3 * 60 * 60 * 1000; // 3 godziny
    
    Object.keys(networkStats).forEach(networkId => {
        const lastActivity = new Date(networkStats[networkId].created).getTime();
        if (now - lastActivity > inactiveThreshold && Object.keys(networks[networkId]).length === 0) {
            console.log(`Czyszczenie nieaktywnej sieci: ${networkId}`);
            delete networks[networkId];
            delete networkStats[networkId];
        }
    });
}, 60 * 60 * 1000); // Sprawdzaj co godzinę

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