const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serwowanie plików statycznych
app.use(express.static(path.join(__dirname, 'public')));

// Funkcja zwracająca listę publicznych serwerów STUN
function getPublicStunServers() {
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.stunprotocol.org:3478' },
    { urls: 'stun:stun.voiparound.com' },
    { urls: 'stun:stun.voipbuster.com' },
    { urls: 'stun:stun.voipstunt.com' },
    { urls: 'stun:stun.voxgratia.org' },
    { urls: 'stun:stun.ekiga.net' },
    { urls: 'stun:stun.ideasip.com' },
    { urls: 'stun:stun.schlund.de' }
  ];
}

// Endpoint dla konfiguracji ICE (tylko serwery STUN)
app.get('/api/ice-servers', async (req, res) => {
  try {
    const stunServers = getPublicStunServers();
    res.json(stunServers);
    console.log('Wysłano listę serwerów STUN do klienta');
  } catch (error) {
    console.error('Błąd podczas pobierania serwerów STUN:', error);
    res.status(500).json({
      error: 'Nie udało się pobrać serwerów STUN',
      fallback: []
    });
  }
});

// Dodatkowy endpoint do testowania połączenia i pobierania informacji o sieci
app.get('/api/network-check', (req, res) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  
  res.json({
    ip: clientIp,
    server: {
      time: new Date().toISOString(),
      uptime: process.uptime()
    }
  });
});

// Przechowywanie aktywnych urządzeń i relacji peer-to-peer
const devices = {}; // Wszystkie urządzenia: devices[deviceId] = {id, name, socketId}
const peerConnections = {}; // Relacje peer-to-peer: peerConnections[deviceId] = [connectedPeerIds]

// Generacja unikalnego ID dla każdego urządzenia
function generateId() {
  return crypto.randomBytes(4).toString('hex');
}

// Obsługa połączeń WebSocket
io.on('connection', (socket) => {
  console.log(`Nowe połączenie: ${socket.id}`);
  
  // Przydziel ID dla nowego urządzenia
  const peerId = generateId();
  
  // Powiadom nowego klienta o jego ID
  socket.emit('assigned-id', peerId);
  
  // Zarejestruj urządzenie w rejestrze globalnym
  devices[peerId] = { id: peerId, name: null, socketId: socket.id };
  
  // Obsługa rejestracji urządzenia z nazwą
  socket.on('register-device', (name) => {
    console.log(`Zarejestrowano urządzenie: ${name} (${peerId})`);
    devices[peerId].name = name;
    
    // Powiadom wszystkich o nowym urządzeniu
    socket.broadcast.emit('peer-joined', { id: peerId, name });
    
    // Wyślij listę wszystkich aktywnych urządzeń
    const activePeers = Object.values(devices)
      .filter(peer => peer.id !== peerId && peer.name) // Tylko urządzenia z nazwą
      .map(peer => ({ id: peer.id, name: peer.name }));
    
    socket.emit('active-peers', activePeers);
    
    // Inicjalizuj tablicę połączeń dla tego peera
    peerConnections[peerId] = [];
  });
  
  // Obsługa wiadomości sygnalizacyjnych WebRTC
  socket.on('signal', ({ peerId: targetPeerId, signal }) => {
    // Znajdź socketId dla docelowego ID
    const targetDevice = devices[targetPeerId];
    
    if (targetDevice) {
      console.log(`Przekazywanie sygnału od ${peerId} do ${targetPeerId} (typ: ${signal.type || 'candidate'})`);
      
      // Dodaj połączenie do rejestru, jeśli to nowe połączenie (oferta)
      if (signal.type === 'offer' && !peerConnections[peerId].includes(targetPeerId)) {
        peerConnections[peerId].push(targetPeerId);
        // Połączenie w drugą stronę zostanie dodane gdy peer odpowie
      }
      
      // Przekaż sygnał do docelowego klienta
      io.to(targetDevice.socketId).emit('signal', {
        peerId: peerId,
        signal
      });
    } else {
      console.warn(`Nie znaleziono odbiorcy sygnału: ${targetPeerId}`);
      
      // Powiadom nadawcę o braku odbiorcy
      socket.emit('signal-error', {
        targetPeerId: targetPeerId,
        error: 'peer-not-found'
      });
    }
  });
  
  // Potwierdzenie odebrania sygnału
  socket.on('signal-received', ({ originPeerId }) => {
    // Znajdź socket dla źródłowego ID
    const sourceDevice = devices[originPeerId];
    
    if (sourceDevice) {
      io.to(sourceDevice.socketId).emit('signal-confirmation', {
        peerId: peerId
      });
    }
  });
  
  // Obsługa rozłączenia
  socket.on('disconnect', () => {
    if (devices[peerId]) {
      const peerName = devices[peerId].name || 'Nieznane urządzenie';
      console.log(`Rozłączono: ${peerName}`);
      
      // Powiadom wszystkich o wyjściu urządzenia
      socket.broadcast.emit('peer-left', peerId);
      
      // Usuń z rejestru połączeń peer-to-peer
      delete peerConnections[peerId];
      
      // Usuń z rejestru urządzeń
      delete devices[peerId];
    }
  });
});

// Nasłuchiwanie na porcie
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serwer uruchomiony: http://localhost:${PORT}`);
  console.log(`Wersja UDP Hole Punching / Tylko STUN`);
});