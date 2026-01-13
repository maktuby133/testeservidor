// server.js - VERSÃO COMPLETA CORRIGIDA
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// IMPORTANTE: Configurar CORS para Render.com
const wss = new WebSocket.Server({ 
  server,
  // Configurar para aceitar conexões de qualquer origem no Render
  clientTracking: true,
  verifyClient: (info, cb) => {
    console.log(`🌐 Nova conexão de: ${info.origin}`);
    cb(true); // Aceitar todas as conexões
  }
});

// Configurações
const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = 'esp32_token_secreto_2024';

// Middleware para Render.com
app.use(cors({
  origin: '*', // Permitir todas as origens
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true
}));

app.use(express.json());
app.use(express.static('public'));

// Armazenamento de dados
const dataStore = {
  loraDevices: {},
  receivers: {},
  webClients: [],
  metrics: {
    totalPackets: 0,
    lastUpdate: new Date()
  }
};

// WebSocket Server
wss.on('connection', (ws, req) => {
  console.log('🔗 NOVA CONEXÃO WebSocket estabelecida!');
  console.log(`📡 Origem: ${req.headers.origin || 'Direct'}`);
  console.log(`🌐 User-Agent: ${req.headers['user-agent'] || 'Unknown'}`);
  
  const clientId = Date.now();
  const clientInfo = {
    id: clientId,
    ws: ws,
    type: 'unknown',
    deviceId: null,
    authenticated: false,
    connectedAt: new Date(),
    ip: req.socket.remoteAddress
  };
  
  dataStore.webClients.push(clientInfo);
  
  // Enviar mensagem de boas-vindas IMEDIATAMENTE
  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Servidor WebSocket conectado!',
    timestamp: new Date().toISOString(),
    server: 'Render.com',
    requiresAuth: true
  }));
  
  // Heartbeat para manter conexão ativa
  const heartbeatInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'heartbeat',
        timestamp: new Date().toISOString()
      }));
    }
  }, 30000);
  
  // Receber mensagens
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log(`📨 Mensagem recebida [${data.type}]:`, data.device || 'Unknown');
      handleWebSocketMessage(ws, data, clientInfo);
    } catch (error) {
      console.error('❌ Erro ao processar mensagem:', error);
      console.log('📝 Mensagem raw:', message.toString());
    }
  });
  
  // Desconexão
  ws.on('close', () => {
    clearInterval(heartbeatInterval);
    console.log(`🔌 Cliente desconectado: ${clientInfo.deviceId || 'Desconhecido'}`);
    dataStore.webClients = dataStore.webClients.filter(c => c.id !== clientId);
  });
  
  ws.on('error', (error) => {
    console.error('❌ Erro WebSocket:', error);
  });
});

// Manipular mensagens WebSocket
function handleWebSocketMessage(ws, data, clientInfo) {
  switch(data.type) {
    case 'auth':
      console.log(`🔐 Tentativa de autenticação: ${data.device}`);
      
      if (data.token === AUTH_TOKEN) {
        clientInfo.authenticated = true;
        clientInfo.type = data.device === 'LORA_RECEIVER' ? 'receiver' : 'web';
        clientInfo.deviceId = data.device || `DEVICE_${Date.now()}`;
        
        console.log(`✅✅✅ CLIENTE AUTENTICADO: ${clientInfo.deviceId}`);
        
        ws.send(JSON.stringify({
          type: 'auth_success',
          message: 'Autenticação bem-sucedida!',
          device: clientInfo.deviceId,
          timestamp: new Date().toISOString(),
          welcome: 'Bem-vindo ao sistema de monitoramento LoRa'
        }));
        
        // Se for receptor, enviar confirmação especial
        if (clientInfo.type === 'receiver') {
          console.log(`📡 Receptor LoRa registrado: ${clientInfo.deviceId}`);
          ws.send(JSON.stringify({
            type: 'receiver_ready',
            message: 'Receptor pronto para receber dados',
            timestamp: new Date().toISOString()
          }));
        }
      } else {
        console.log('❌ Token inválido recebido');
        ws.send(JSON.stringify({
          type: 'auth_error',
          message: 'Token de autenticação inválido',
          timestamp: new Date().toISOString()
        }));
      }
      break;
      
    case 'lora_data':
      if (clientInfo.authenticated && clientInfo.type === 'receiver') {
        console.log(`📡 Dados LoRa recebidos de: ${data.device_id}`);
        handleLoraData(data);
        broadcastToWebClients(data);
      }
      break;
      
    case 'receiver_status':
      if (clientInfo.authenticated && clientInfo.type === 'receiver') {
        console.log(`📊 Status receptor: ${data.packets_received} pacotes`);
        handleReceiverStatus(data, clientInfo);
      }
      break;
      
    case 'ping':
      console.log('🔄 Ping recebido');
      ws.send(JSON.stringify({
        type: 'pong',
        timestamp: data.timestamp || Date.now(),
        serverTime: new Date().toISOString()
      }));
      break;
      
    default:
      console.log('📝 Tipo de mensagem:', data.type);
  }
}

// Processar dados LoRa
function handleLoraData(data) {
  const deviceId = data.device_id || 'unknown';
  const timestamp = new Date();
  
  if (!dataStore.loraDevices[deviceId]) {
    dataStore.loraDevices[deviceId] = {
      id: deviceId,
      firstSeen: timestamp,
      lastSeen: timestamp,
      totalPackets: 0,
      lastData: null
    };
    console.log(`🎉 NOVO DISPOSITIVO DETECTADO: ${deviceId}`);
  }
  
  const device = dataStore.loraDevices[deviceId];
  device.lastSeen = timestamp;
  device.totalPackets++;
  device.lastData = data;
  
  dataStore.metrics.totalPackets++;
  dataStore.metrics.lastUpdate = new Date();
  
  console.log(`📊 ${deviceId}: ${data.percentage}% | ${data.liters}L | RSSI: ${data.rssi}dBm`);
}

function handleReceiverStatus(data, clientInfo) {
  console.log(`📡 Receptor ${clientInfo.deviceId}: WiFi=${data.wifi_rssi}dBm | Pacotes=${data.packets_received}`);
}

function broadcastToWebClients(data) {
  const message = JSON.stringify(data);
  const webClients = dataStore.webClients.filter(c => 
    c.type === 'web' && c.authenticated && c.ws.readyState === WebSocket.OPEN
  );
  
  webClients.forEach(client => {
    try {
      client.ws.send(message);
    } catch (error) {
      console.error('❌ Erro ao enviar para cliente web:', error);
    }
  });
}

// ====== ROTAS HTTP ======

app.get('/', (req, res) => {
  res.json({
    service: 'Monitor LoRa - Caixa d\'Água',
    status: 'online',
    version: '2.0.0',
    serverTime: new Date().toISOString(),
    uptime: process.uptime(),
    connections: {
      total: dataStore.webClients.length,
      authenticated: dataStore.webClients.filter(c => c.authenticated).length
    },
    devices: Object.keys(dataStore.loraDevices).length,
    metrics: dataStore.metrics
  });
});

// Health check para Render
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// WebSocket test endpoint
app.get('/ws-test', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Teste WebSocket</title>
    </head>
    <body>
      <h1>Teste de Conexão WebSocket</h1>
      <div id="status">Conectando...</div>
      <div id="messages"></div>
      <script>
        const ws = new WebSocket('wss://${req.headers.host}');
        ws.onopen = () => {
          document.getElementById('status').innerHTML = '✅ CONECTADO!';
          ws.send(JSON.stringify({
            type: 'auth',
            device: 'TEST_CLIENT',
            token: 'esp32_token_secreto_2024'
          }));
        };
        ws.onmessage = (e) => {
          const msg = document.createElement('div');
          msg.textContent = '📨: ' + e.data;
          document.getElementById('messages').appendChild(msg);
        };
        ws.onerror = (e) => {
          document.getElementById('status').innerHTML = '❌ ERRO: ' + e;
        };
      </script>
    </body>
    </html>
  `);
});

// Iniciar servidor
server.listen(PORT, () => {
  console.log(`
🚀 SERVIDOR INICIADO NO RENDER.COM
================================
🌐 HTTP: https://testeservidor-6opr.onrender.com
🔗 WebSocket: wss://testeservidor-6opr.onrender.com
🔐 Token: ${AUTH_TOKEN}
📊 Dashboard: https://testeservidor-6opr.onrender.com
🔄 Porta: ${PORT}
✅ Pronto para conexões!
`);
});

// Exportar para Render.com
module.exports = { app, server };
