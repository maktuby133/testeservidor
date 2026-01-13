// server.js
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configurações
const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = 'esp32_token_secreto_2024'; // SEU TOKEN AQUI

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
    connectedAt: new Date()
  };
  
  dataStore.webClients.push(clientInfo);
  
  // Enviar mensagem de boas-vindas
  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Conectado ao servidor de monitoramento',
    timestamp: new Date().toISOString()
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
    console.log('🔌 Cliente desconectado');
    dataStore.webClients = dataStore.webClients.filter(c => c.id !== clientId);
  });
  
  ws.on('error', (error) => {
    console.error('❌ Erro WebSocket:', error);
  });
});

// Manipular mensagens WebSocket
function handleWebSocketMessage(ws, data, clientInfo) {
  console.log(`📨 Mensagem recebida [${data.type}]:`, data.device || 'Unknown');
  
  switch(data.type) {
    case 'auth':
      if (data.token === AUTH_TOKEN) {
        clientInfo.authenticated = true;
        clientInfo.type = data.device === 'LORA_RECEIVER' ? 'receiver' : 'web';
        clientInfo.deviceId = data.device || 'Unknown';
        
        console.log(`✅ Cliente autenticado: ${data.device}`);
        
        ws.send(JSON.stringify({
          type: 'auth_success',
          message: 'Autenticado com sucesso',
          timestamp: new Date().toISOString()
        }));
        
        // Enviar dados existentes para novo cliente web
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
      if (clientInfo.authenticated) {
        handleLoraData(data);
        broadcastToWebClients(data);
      }
      break;
      
    case 'receiver_status':
      if (clientInfo.authenticated) {
        handleReceiverStatus(data);
        broadcastToWebClients({
          type: 'receiver_update',
          data: data,
          timestamp: new Date().toISOString()
        });
      }
      break;
      
    case 'ping':
      ws.send(JSON.stringify({
        type: 'pong',
        timestamp: data.timestamp || Date.now()
      }));
      break;
      
    case 'get_devices':
      ws.send(JSON.stringify({
        type: 'devices_list',
        devices: dataStore.loraDevices,
        timestamp: new Date().toISOString()
      }));
      break;
      
    case 'get_status':
      ws.send(JSON.stringify({
        type: 'server_status',
        ...dataStore.metrics,
        connectedClients: dataStore.webClients.length,
        authenticatedClients: dataStore.webClients.filter(c => c.authenticated).length,
        timestamp: new Date().toISOString()
      }));
      break;
      
    default:
      console.log('📝 Tipo de mensagem desconhecido:', data.type);
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
    console.log(`📱 Novo dispositivo detectado: ${deviceId}`);
  }
  
  // Atualizar dispositivo
  const device = dataStore.loraDevices[deviceId];
  device.lastSeen = timestamp;
  device.totalPackets++;
  device.lastData = data;
  
  // Adicionar ao histórico (mantém últimos 50 registros)
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
function handleReceiverStatus(data) {
  const receiverId = `RECEIVER_${Date.now()}`;
  
  dataStore.receivers[receiverId] = {
    id: receiverId,
    lastUpdate: new Date(),
    status: data,
    uptime: data.uptime || 0
  };
  
  console.log(`📡 Status receptor: ${data.packets_received} pacotes recebidos`);
}

// Broadcast para clientes web autenticados
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

// Rotas HTTP
app.get('/', (req, res) => {
  res.json({
    service: 'LoRa Water Tank Monitor',
    version: '1.0.0',
    status: 'online',
    devices: Object.keys(dataStore.loraDevices).length,
    receivers: Object.keys(dataStore.receivers).length,
    webClients: dataStore.webClients.filter(c => c.type === 'web').length,
    receiversConnected: dataStore.webClients.filter(c => c.type === 'receiver').length,
    uptime: process.uptime(),
    token: AUTH_TOKEN ? 'Configurado' : 'Não configurado'
  });
});

app.get('/api/devices', (req, res) => {
  res.json({
    count: Object.keys(dataStore.loraDevices).length,
    devices: dataStore.loraDevices,
    lastUpdate: dataStore.metrics.lastUpdate
  });
});

app.get('/api/device/:id', (req, res) => {
  const deviceId = req.params.id;
  const device = dataStore.loraDevices[deviceId];
  
  if (device) {
    res.json(device);
  } else {
    res.status(404).json({ error: 'Dispositivo não encontrado' });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    server: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString()
    },
    metrics: dataStore.metrics,
    connections: {
      total: dataStore.webClients.length,
      web: dataStore.webClients.filter(c => c.type === 'web').length,
      receivers: dataStore.webClients.filter(c => c.type === 'receiver').length,
      authenticated: dataStore.webClients.filter(c => c.authenticated).length
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Limpeza periódica de dispositivos inativos
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

// Iniciar servidor
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🔗 WebSocket: ws://localhost:${PORT}`);
  console.log(`🌐 HTTP: http://localhost:${PORT}`);
  console.log(`🔐 Token: ${AUTH_TOKEN}`);
  console.log(`📁 Dashboard: http://localhost:${PORT}/index.html`);
});
