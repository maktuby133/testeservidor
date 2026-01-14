// server.js - Servidor WebSocket com suporte a LoRa
const WebSocket = require('ws');
const express = require('express');
const http = require('http');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Variáveis de ambiente
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_TOKENS = process.env.ALLOWED_TOKENS ? process.env.ALLOWED_TOKENS.split(',') : ['esp32_token_secreto_2024'];

// Clientes conectados
let clients = {
  transmitters: new Map(),
  receivers: new Map(),
  dashboards: new Map()
};

// Dados do sistema
let systemData = {
  lastTransmission: null,
  caixaAgua: { distance: 0, level: 0, percentage: 0, liters: 0, sensorOK: false, lastUpdate: null },
  consumo: { hora: 0, hoje: 0, diario: Array(24).fill(0) },
  loraStats: { rssi: 0, snr: 0, rxCount: 0, lastDevice: '' }
};

// Métricas
const metrics = {
  connections: 0,
  messagesReceived: 0,
  messagesSent: 0,
  errors: 0,
  startTime: new Date()
};

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Rota de saúde
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    environment: NODE_ENV,
    uptime: process.uptime(),
    metrics: {
      connections: metrics.connections,
      messagesReceived: metrics.messagesReceived,
      messagesSent: metrics.messagesSent,
      errors: metrics.errors,
      clients: {
        transmitters: clients.transmitters.size,
        receivers: clients.receivers.size,
        dashboards: clients.dashboards.size
      }
    }
  });
});

// Rota para dados do sistema
app.get('/api/system', (req, res) => {
  res.json({
    success: true,
    data: systemData,
    lastUpdate: systemData.lastTransmission,
    environment: NODE_ENV
  });
});

// Rota para histórico
app.get('/api/history', (req, res) => {
  res.json({
    success: true,
    consumo: systemData.consumo,
    loraStats: systemData.loraStats,
    environment: NODE_ENV
  });
});

// Rota para reset de consumo
app.post('/api/reset-consumo', (req, res) => {
  systemData.consumo = { hora: 0, hoje: 0, diario: Array(24).fill(0) };
  
  clients.receivers.forEach((client, id) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send('reset_consumo');
    }
  });
  
  res.json({
    success: true,
    message: 'Consumo resetado',
    timestamp: new Date().toISOString()
  });
});

// WebSocket Server
wss.on('connection', (ws, req) => {
  const clientId = generateClientId();
  let clientType = 'unknown';
  let authenticated = false;
  let deviceId = '';
  let clientToken = '';

  console.log(`🔗 Nova conexão: ${clientId}`);
  metrics.connections++;

  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token') || '';
  clientToken = token;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      metrics.messagesReceived++;

      if (data.type === 'auth') {
        if (!authenticateClient(data.token, data.device, data.role)) {
          ws.send(JSON.stringify({ type: 'auth_error', message: 'Autenticação falhou' }));
          ws.close();
          return;
        }

        authenticated = true;
        clientType = data.role || 'unknown';
        deviceId = data.device || clientId;

        switch(clientType) {
          case 'transmitter':
            clients.transmitters.set(clientId, { ws, deviceId, token: data.token, lastSeen: new Date() });
            console.log(`📡 Transmissor conectado: ${deviceId} (${clientId})`);
            break;
          case 'receiver':
            clients.receivers.set(clientId, { ws, deviceId, token: data.token, lastSeen: new Date() });
            console.log(`🏠 Receptor conectado: ${deviceId} (${clientId})`);
            break;
          case 'dashboard':
            clients.dashboards.set(clientId, { ws, deviceId, token: data.token, lastSeen: new Date() });
            console.log(`📊 Dashboard conectado: ${deviceId} (${clientId})`);
            break;
          default:
            console.log(`❓ Cliente desconhecido: ${deviceId}`);
        }

        ws.send(JSON.stringify({
          type: 'auth_success',
          message: 'Autenticado com sucesso',
          clientId: clientId,
          timestamp: new Date().toISOString()
        }));

        if (clientType === 'dashboard') {
          ws.send(JSON.stringify({
            type: 'system_data',
            ...systemData,
            timestamp: new Date().toISOString()
          }));
        }

        return;
      }

      if (!authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Não autenticado' }));
        return;
      }

      switch(data.type) {
        case 'lora_data':
          processLoRaData(data);
          broadcastToDashboards(data);
          break;
        case 'status':
          updateClientStatus(clientId, clientType, data);
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
          break;
        default:
          console.log(`📨 Mensagem não reconhecida de ${deviceId}:`, data.type);
      }

    } catch (error) {
      console.error('❌ Erro ao processar mensagem:', error);
      metrics.errors++;
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`🔌 Conexão fechada: ${clientId} (${clientType}) Código: ${code}, Motivo: ${reason}`);
    clients.transmitters.delete(clientId);
    clients.receivers.delete(clientId);
    clients.dashboards.delete(clientId);
    metrics.connections--;
  });

  ws.on('error', (error) => {
    console.error(`❌ Erro no WebSocket ${clientId}:`, error);
    metrics.errors++;
  });

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);

  ws.on('close', () => clearInterval(pingInterval));
});

// Funções auxiliares
function processLoRaData(data) {
  systemData.lastTransmission = new Date().toISOString();
  if (data.distance !== undefined) {
    systemData.caixaAgua = {
      distance: data.distance,
      level: data.level || 0,
      percentage: data.percentage || 0,
      liters: data.liters || 0,
      sensorOK: data.sensor_ok || false,
      lastUpdate: new Date().toISOString()
    };
  }
  if (data.rssi !== undefined) {
    systemData.loraStats = {
      rssi: data.rssi,
      snr: data.snr || 0,
      rxCount: data.rx_count || 0,
      lastDevice: data.device || ''
    };
  }
  console.log(`📡 Dados LoRa atualizados de ${data.device}: ${data.liters}L (${data.percentage}%)`);
}

function updateClientStatus(clientId, clientType, data) {
  const clientGroup = getClientGroup(clientType);
  if (clientGroup && clientGroup.has(clientId)) {
    const client = clientGroup.get(clientId);
    client.lastSeen = new Date();
    client.status = data;
    if (clientType === 'receiver' && data.last_rssi) {
      systemData.loraStats.rssi = data.last_rssi;
      systemData.loraStats.snr = data.last_snr || 0;
      systemData.loraStats.rxCount = data.lora_rx_count || 0;
      systemData.loraStats.lastDevice = data.last_device || '';
    }
  }
}

function broadcastToDashboards(data) {
  clients.dashboards.forEach((client) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({ type: 'update', ...data, timestamp: new Date().toISOString() }));
    }
  });
}

function authenticateClient(token, device, role) {
  if (!token || !device) return false;
  const isValidToken = ALLOWED_TOKENS.includes(token);
  if (!isValidToken) {
    console.log(`❌ Token inválido de ${device}: ${token}`);
    return false;
  }
  return true;
}

function generateClientId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function getClientGroup(clientType)
