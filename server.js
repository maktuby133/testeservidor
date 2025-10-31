const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Armazena conexões ativas
const espConnections = new Map();

// Servir arquivos estáticos da pasta 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Rota principal - serve a página HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check para o Render monitorar
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'ESP32 WebSocket Server',
    connectedDevices: espConnections.size,
    timestamp: new Date().toISOString()
  });
});

// API para enviar comandos para o ESP32
app.post('/command/:espId/:command', (req, res) => {
  const { espId, command } = req.params;
  const ws = espConnections.get(espId);
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(command);
    res.json({ 
      success: true, 
      message: `Comando "${command}" enviado para ESP32 ${espId}`,
      timestamp: new Date().toISOString()
    });
  } else {
    res.status(404).json({ 
      success: false, 
      message: 'ESP32 não conectado ou offline'
    });
  }
});

// Lista todos os ESPs conectados
app.get('/devices', (req, res) => {
  const devices = Array.from(espConnections.entries()).map(([id, ws]) => ({
    id,
    connected: ws.readyState === WebSocket.OPEN,
    connectionTime: ws.timestamp
  }));
  
  res.json({
    total: devices.length,
    devices: devices
  });
});

// Conexão WebSocket - quando ESP32 conecta
wss.on('connection', function connection(ws, req) {
  const espId = `ESP32_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  console.log(`✅ Nova conexão WebSocket: ${espId}`);
  
  // Armazena a conexão
  ws.espId = espId;
  ws.timestamp = new Date().toISOString();
  espConnections.set(espId, ws);
  
  // Envia ID para o ESP32
  ws.send(`SET_ID:${espId}`);
  
  // Mensagens recebidas do ESP32
  ws.on('message', function message(data) {
    const message = data.toString();
    console.log(`📨 [${espId}]: ${message}`);
  });
  
  ws.on('close', function close() {
    console.log(`❌ Conexão fechada: ${espId}`);
    espConnections.delete(espId);
  });
});

// Inicialização do servidor
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Servidor ESP32 WebSocket Iniciado!');
  console.log(`📡 Porta: ${PORT}`);
  console.log(`🌐 Acesse: http://localhost:${PORT}`);
});
