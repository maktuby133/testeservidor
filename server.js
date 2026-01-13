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
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'token_secreto_receptor';

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
  
  // Adicionar ao array de clientes web
  const clientId = Date.now();
  dataStore.webClients.push({
    id: clientId,
    ws: ws,
    type: 'web',
    connectedAt: new Date()
  });
  
  // Enviar dados iniciais
  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Conectado ao servidor de monitoramento',
    timestamp: new Date().toISOString(),
    devices: Object.keys(dataStore.loraDevices).length,
    receivers: Object.keys(dataStore.receivers).length
  }));
  
  // Enviar histórico de dispositivos
  if (Object.keys(dataStore.loraDevices).length > 0) {
    ws.send(JSON.stringify({
      type: 'devices_list',
      devices: dataStore.loraDevices,
      timestamp: new Date().toISOString()
    }));
  }
  
  // Mensagens do cliente
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleWebSocketMessage(ws, data, clientId);
    } catch (error) {
      console.error('❌ Erro ao processar mensagem:', error);
    }
  });
  
  // Desconexão
  ws.on('close', () => {
    console.log('🔌 Cliente WebSocket desconectado');
    dataStore.webClients = dataStore.webClients.filter(c => c.id !== clientId);
  });
  
  ws.on('error', (error) => {
    console.error('❌ Erro WebSocket:', error);
  });
});

// Manipular mensagens WebSocket
function handleWebSocketMessage(ws, data, clientId) {
  switch(data.type) {
    case 'auth':
      if (data.token === AUTH_TOKEN) {
        console.log(`🔐 Autenticação bem-sucedida: ${data.device}`);
        
        // Atualizar tipo do cliente
        const client = dataStore.webClients.find(c => c.id === clientId);
        if (client) {
          client.type = data.device === 'LORA_RECEIVER' ? 'receiver' : 'web';
          client.deviceId = data.device;
        }
        
        ws.send(JSON.stringify({
          type: 'auth_success',
          message: 'Autenticado com sucesso',
          timestamp: new Date().toISOString()
        }));
      }
      break;
      
    case 'lora_data':
      handleLoraData(data);
      broadcastToWebClients(data);
      break;
      
    case 'receiver_status':
      handleReceiverStatus(data);
      broadcastToWebClients({
        type: 'receiver_update',
        data: data,
        timestamp: new Date().toISOString()
      });
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
        timestamp: new Date().toISOString()
      }));
      break;
  }
}

// Processar dados LoRa
function handleLoraData(data) {
  const deviceId = data.device_id;
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
  
  // Adicionar ao histórico (mantém últimos 100 registros)
  device.history.push({
    timestamp: timestamp,
    distance: data.distance,
    level: data.level,
    percentage: data.percertage || data.percentage,
    liters: data.liters,
    rssi: data.rssi,
    snr: data.snr
  });
  
  if (device.history.length > 100) {
    device.history = device.history.slice(-100);
  }
  
  // Atualizar qualidade do sinal
  if (data.rssi) {
    device.signalQuality.push({
      timestamp: timestamp,
      rssi: data.rssi,
      snr: data.snr
    });
    
    if (device.signalQuality.length > 50) {
      device.signalQuality = device.signalQuality.slice(-50);
    }
  }
  
  // Atualizar métricas
  dataStore.metrics.totalPackets++;
  dataStore.metrics.validPackets++;
  dataStore.metrics.lastUpdate = new Date();
  
  console.log(`📊 Dados de ${deviceId}: ${data.percentage}% | ${data.liters}L | RSSI: ${data.rssi}dBm`);
}

// Processar status do receptor
function handleReceiverStatus(data) {
  const receiverId = `RECEIVER_${data.wifi_rssi || Date.now()}`;
  
  dataStore.receivers[receiverId] = {
    id: receiverId,
    lastUpdate: new Date(),
    status: data,
    uptime: data.uptime || 0
  };
  
  // Limitar quantidade de receptores armazenados
  if (Object.keys(dataStore.receivers).length > 10) {
    const oldestKey = Object.keys(dataStore.receivers)[0];
    delete dataStore.receivers[oldestKey];
  }
}

// Broadcast para clientes web
function broadcastToWebClients(data) {
  const message = JSON.stringify(data);
  
  dataStore.webClients.forEach(client => {
    if (client.ws.readyState === WebSocket.OPEN && client.type === 'web') {
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
    uptime: process.uptime()
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

app.get('/api/device/:id/history', (req, res) => {
  const deviceId = req.params.id;
  const device = dataStore.loraDevices[deviceId];
  const limit = parseInt(req.query.limit) || 50;
  
  if (device) {
    const history = device.history.slice(-limit);
    res.json({
      deviceId: deviceId,
      count: history.length,
      history: history
    });
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
      receivers: dataStore.webClients.filter(c => c.type === 'receiver').length
    }
  });
});

app.get('/api/metrics', (req, res) => {
  // Calcular estatísticas
  const devices = Object.values(dataStore.loraDevices);
  const stats = {
    totalDevices: devices.length,
    totalPackets: dataStore.metrics.totalPackets,
    averageSignal: null,
    devicesLowBattery: 0,
    lastUpdates: devices.map(d => ({
      id: d.id,
      lastSeen: d.lastSeen,
      percentage: d.lastData?.percentage || 0
    }))
  };
  
  // Calcular RSSI médio
  const allRssi = devices
    .flatMap(d => d.signalQuality.map(q => q.rssi))
    .filter(r => r != null);
    
  if (allRssi.length > 0) {
    const sum = allRssi.reduce((a, b) => a + b, 0);
    stats.averageSignal = sum / allRssi.length;
  }
  
  res.json(stats);
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
});

module.exports = { app, server, wss, dataStore };
