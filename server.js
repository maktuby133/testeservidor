// server.js - Versão para Render.com
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configurações
const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = 'esp32_token_secreto_2024'; // SEU TOKEN

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Armazenamento de dados
const dataStore = {
  loraDevices: {},
  receivers: {},
  webClients: [],
  metrics: {
    totalPackets: 0,
    validPackets: 0,
    invalidPackets: 0,
    lastUpdate: new Date()
  }
};

// WebSocket Server
wss.on('connection', (ws, req) => {
  console.log('🔗 Nova conexão WebSocket');
  
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
  
  // Enviar mensagem de boas-vindas
  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Conectado ao servidor de monitoramento',
    timestamp: new Date().toISOString(),
    requiresAuth: true
  }));
  
  // Receber mensagens
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleWebSocketMessage(ws, data, clientInfo);
    } catch (error) {
      console.error('❌ Erro ao processar mensagem:', error);
    }
  });
  
  // Desconexão
  ws.on('close', () => {
    console.log(`🔌 Cliente desconectado: ${clientInfo.deviceId || 'Desconhecido'}`);
    dataStore.webClients = dataStore.webClients.filter(c => c.id !== clientId);
  });
  
  ws.on('error', (error) => {
    console.error('❌ Erro WebSocket:', error);
  });
});

// Manipular mensagens WebSocket
function handleWebSocketMessage(ws, data, clientInfo) {
  console.log(`📨 Mensagem [${data.type || 'unknown'}]:`, data.device || 'Unknown');
  
  switch(data.type) {
    case 'auth':
      if (data.token === AUTH_TOKEN) {
        clientInfo.authenticated = true;
        clientInfo.type = data.device === 'LORA_RECEIVER' ? 'receiver' : 'web';
        clientInfo.deviceId = data.device || 'Unknown';
        
        console.log(`✅ Cliente autenticado: ${data.device} (${clientInfo.ip})`);
        
        ws.send(JSON.stringify({
          type: 'auth_success',
          message: 'Autenticado com sucesso',
          timestamp: new Date().toISOString()
        }));
        
        // Se for receptor LoRa, enviar confirmação
        if (clientInfo.type === 'receiver') {
          console.log('📡 Receptor LoRa autenticado e pronto');
        }
        
        // Se for cliente web, enviar dados existentes
        if (clientInfo.type === 'web') {
          setTimeout(() => {
            if (Object.keys(dataStore.loraDevices).length > 0) {
              ws.send(JSON.stringify({
                type: 'devices_list',
                devices: dataStore.loraDevices,
                timestamp: new Date().toISOString()
              }));
            }
          }, 1000);
        }
      } else {
        console.log('❌ Token inválido recebido');
        ws.send(JSON.stringify({
          type: 'auth_error',
          message: 'Token inválido',
          timestamp: new Date().toISOString()
        }));
      }
      break;
      
    case 'lora_data':
      if (clientInfo.authenticated && clientInfo.type === 'receiver') {
        handleLoraData(data);
        broadcastToWebClients(data);
      }
      break;
      
    case 'receiver_status':
      if (clientInfo.authenticated && clientInfo.type === 'receiver') {
        handleReceiverStatus(data, clientInfo);
        broadcastToWebClients({
          type: 'receiver_status_update',
          data: data,
          receiverId: clientInfo.deviceId,
          timestamp: new Date().toISOString()
        });
      }
      break;
      
    case 'ping':
      ws.send(JSON.stringify({
        type: 'pong',
        timestamp: data.timestamp || Date.now(),
        serverTime: new Date().toISOString()
      }));
      break;
      
    case 'get_devices':
      if (clientInfo.authenticated) {
        ws.send(JSON.stringify({
          type: 'devices_list',
          devices: dataStore.loraDevices,
          timestamp: new Date().toISOString()
        }));
      }
      break;
      
    case 'get_status':
      ws.send(JSON.stringify({
        type: 'server_status',
        metrics: dataStore.metrics,
        connectedClients: dataStore.webClients.length,
        authenticatedClients: dataStore.webClients.filter(c => c.authenticated).length,
        receivers: dataStore.webClients.filter(c => c.type === 'receiver').length,
        webClients: dataStore.webClients.filter(c => c.type === 'web').length,
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      }));
      break;
      
    default:
      console.log('📝 Tipo desconhecido:', data.type);
  }
}

// Processar dados LoRa
function handleLoraData(data) {
  const deviceId = data.device_id || 'unknown';
  const timestamp = new Date(data.real_timestamp * 1000 || Date.now());
  
  // Atualizar ou criar dispositivo
  if (!dataStore.loraDevices[deviceId]) {
    dataStore.loraDevices[deviceId] = {
      id: deviceId,
      firstSeen: timestamp,
      lastSeen: timestamp,
      totalPackets: 0,
      history: [],
      lastData: null,
      signalQuality: []
    };
    console.log(`📱 NOVO dispositivo: ${deviceId}`);
  }
  
  // Atualizar dispositivo
  const device = dataStore.loraDevices[deviceId];
  device.lastSeen = timestamp;
  device.totalPackets++;
  device.lastData = data;
  
  // Adicionar ao histórico
  device.history.push({
    timestamp: timestamp,
    distance: data.distance,
    level: data.level,
    percentage: data.percentage,
    liters: data.liters,
    rssi: data.rssi,
    snr: data.snr
  });
  
  if (device.history.length > 50) {
    device.history = device.history.slice(-50);
  }
  
  // Atualizar qualidade do sinal
  if (data.rssi) {
    device.signalQuality.push({
      timestamp: timestamp,
      rssi: data.rssi,
      snr: data.snr
    });
    
    if (device.signalQuality.length > 20) {
      device.signalQuality = device.signalQuality.slice(-20);
    }
  }
  
  // Atualizar métricas
  dataStore.metrics.totalPackets++;
  dataStore.metrics.validPackets++;
  dataStore.metrics.lastUpdate = new Date();
  
  console.log(`📊 ${deviceId}: ${data.percentage}% | ${data.liters}L | RSSI: ${data.rssi}dBm`);
}

// Processar status do receptor
function handleReceiverStatus(data, clientInfo) {
  const receiverId = clientInfo.deviceId || `RECEIVER_${Date.now()}`;
  
  dataStore.receivers[receiverId] = {
    id: receiverId,
    lastUpdate: new Date(),
    status: data,
    uptime: data.uptime || 0,
    ip: clientInfo.ip
  };
  
  console.log(`📡 Receptor ${receiverId}: ${data.packets_received} pacotes | ${data.wifi_rssi}dBm`);
}

// Broadcast para clientes web
function broadcastToWebClients(data) {
  const message = JSON.stringify(data);
  
  dataStore.webClients.forEach(client => {
    if (client.ws.readyState === WebSocket.OPEN && 
        client.type === 'web' && 
        client.authenticated) {
      try {
        client.ws.send(message);
      } catch (error) {
        console.error('❌ Erro ao enviar para cliente:', error);
      }
    }
  });
}

// ====== ROTAS HTTP ======

// Rota principal
app.get('/', (req, res) => {
  res.json({
    service: 'LoRa Water Tank Monitor',
    version: '2.0.0',
    status: 'online',
    environment: process.env.NODE_ENV || 'development',
    serverTime: new Date().toISOString(),
    uptime: process.uptime(),
    connections: {
      total: dataStore.webClients.length,
      receivers: dataStore.webClients.filter(c => c.type === 'receiver').length,
      webClients: dataStore.webClients.filter(c => c.type === 'web').length,
      authenticated: dataStore.webClients.filter(c => c.authenticated).length
    },
    devices: {
      total: Object.keys(dataStore.loraDevices).length,
      active: Object.values(dataStore.loraDevices).filter(d => 
        (new Date() - d.lastSeen) < 5 * 60 * 1000
      ).length
    },
    metrics: dataStore.metrics
  });
});

// Health check para Render
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// API de dispositivos
app.get('/api/devices', (req, res) => {
  res.json({
    count: Object.keys(dataStore.loraDevices).length,
    devices: dataStore.loraDevices,
    lastUpdate: dataStore.metrics.lastUpdate
  });
});

// API de status
app.get('/api/status', (req, res) => {
  res.json({
    server: {
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV
    },
    metrics: dataStore.metrics,
    connections: {
      total: dataStore.webClients.length,
      authenticated: dataStore.webClients.filter(c => c.authenticated).length
    }
  });
});

// Limpeza de dispositivos inativos
setInterval(() => {
  const now = new Date();
  const inactiveThreshold = 30 * 60 * 1000; // 30 minutos
  
  Object.keys(dataStore.loraDevices).forEach(deviceId => {
    const device = dataStore.loraDevices[deviceId];
    if (now - device.lastSeen > inactiveThreshold) {
      console.log(`🗑️  Removendo dispositivo inativo: ${deviceId}`);
      delete dataStore.loraDevices[deviceId];
    }
  });
}, 5 * 60 * 1000); // A cada 5 minutos

// Limpeza de clientes desconectados
setInterval(() => {
  dataStore.webClients = dataStore.webClients.filter(client => {
    if (client.ws.readyState === WebSocket.CLOSED) {
      console.log(`🧹 Limpando cliente desconectado: ${client.deviceId || 'Unknown'}`);
      return false;
    }
    return true;
  });
}, 60 * 1000); // A cada 1 minuto

// Iniciar servidor
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🔗 WebSocket: wss://testeservidor-6opr.onrender.com`);
  console.log(`🌐 HTTP: https://testeservidor-6opr.onrender.com`);
  console.log(`🔐 Token: ${AUTH_TOKEN}`);
  console.log(`📊 Dashboard: https://testeservidor-6opr.onrender.com/index.html`);
});
