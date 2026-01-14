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
  transmitters: new Map(), // Dispositivos transmissores (LoRa TX)
  receivers: new Map(),    // Dispositivos receptores (LoRa RX + WebSocket)
  dashboards: new Map()    // Dashboards web
};

// Dados do sistema
let systemData = {
  lastTransmission: null,
  caixaAgua: {
    distance: 0,
    level: 0,
    percentage: 0,
    liters: 0,
    sensorOK: false,
    lastUpdate: null
  },
  consumo: {
    hora: 0,
    hoje: 0,
    diario: Array(24).fill(0)
  },
  loraStats: {
    rssi: 0,
    snr: 0,
    rxCount: 0,
    lastDevice: ''
  }
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
  systemData.consumo = {
    hora: 0,
    hoje: 0,
    diario: Array(24).fill(0)
  };
  
  // Enviar comando para todos os receptores
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

  // Extrair token da query string ou headers
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token') || '';
  clientToken = token;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      metrics.messagesReceived++;

      // Primeira mensagem deve ser de autenticação
      if (data.type === 'auth') {
        if (!authenticateClient(data.token, data.device, data.role)) {
          ws.send(JSON.stringify({
            type: 'auth_error',
            message: 'Autenticação falhou'
          }));
          ws.close();
          return;
        }

        authenticated = true;
        clientType = data.role || 'unknown';
        deviceId = data.device || clientId;

        // Adicionar ao grupo correto
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

        // Enviar confirmação
        ws.send(JSON.stringify({
          type: 'auth_success',
          message: 'Autenticado com sucesso',
          clientId: clientId,
          timestamp: new Date().toISOString()
        }));

        // Se for dashboard, enviar dados atuais
        if (clientType === 'dashboard') {
          ws.send(JSON.stringify({
            type: 'system_data',
            ...systemData,
            timestamp: new Date().toISOString()
          }));
        }

        return;
      }

      // Apenas processar mensagens de clientes autenticados
      if (!authenticated) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Não autenticado'
        }));
        return;
      }

      // Processar diferentes tipos de mensagens
      switch(data.type) {
        case 'lora_data':
          // Dados recebidos via LoRa
          processLoRaData(data);
          broadcastToDashboards(data);
          break;

        case 'status':
          // Status do dispositivo
          updateClientStatus(clientId, clientType, data);
          break;

        case 'ping':
          // Heartbeat
          ws.send(JSON.stringify({
            type: 'pong',
            timestamp: new Date().toISOString()
          }));
          break;

        default:
          console.log(`📨 Mensagem não reconhecida de ${deviceId}:`, data.type);
      }

    } catch (error) {
      console.error('❌ Erro ao processar mensagem:', error);
      metrics.errors++;
    }
  });

  ws.on('close', () => {
    console.log(`🔌 Conexão fechada: ${clientId} (${clientType})`);
    
    // Remover dos grupos
    clients.transmitters.delete(clientId);
    clients.receivers.delete(clientId);
    clients.dashboards.delete(clientId);
    
    metrics.connections--;
  });

  ws.on('error', (error) => {
    console.error(`❌ Erro no WebSocket ${clientId}:`, error);
    metrics.errors++;
  });

  // Enviar ping a cada 30 segundos
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);

  ws.on('close', () => {
    clearInterval(pingInterval);
  });
});

// Função para processar dados LoRa
function processLoRaData(data) {
  systemData.lastTransmission = new Date().toISOString();
  
  // Atualizar dados da caixa d'água
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
  
  // Atualizar consumo
  if (data.consumo_hora !== undefined) {
    systemData.consumo.hora = data.consumo_hora;
  }
  
  if (data.consumo_hoje !== undefined) {
    systemData.consumo.hoje = data.consumo_hoje;
  }
  
  // Atualizar stats LoRa
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

// Função para atualizar status do cliente
function updateClientStatus(clientId, clientType, data) {
  const clientGroup = getClientGroup(clientType);
  if (clientGroup && clientGroup.has(clientId)) {
    const client = clientGroup.get(clientId);
    client.lastSeen = new Date();
    client.status = data;
    
    // Se for receptor, verificar se tem dados LoRa recentes
    if (clientType === 'receiver' && data.last_rssi) {
      systemData.loraStats.rssi = data.last_rssi;
      systemData.loraStats.snr = data.last_snr || 0;
      systemData.loraStats.rxCount = data.lora_rx_count || 0;
      systemData.loraStats.lastDevice = data.last_device || '';
    }
  }
}

// Função para broadcast para dashboards
function broadcastToDashboards(data) {
  clients.dashboards.forEach((client, id) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({
        type: 'update',
        ...data,
        timestamp: new Date().toISOString()
      }));
    }
  });
}

// Funções auxiliares
function authenticateClient(token, device, role) {
  if (!token || !device) return false;
  
  // Verificar token
  const isValidToken = ALLOWED_TOKENS.includes(token);
  
  if (!isValidToken) {
    console.log(`❌ Token inválido de ${device}: ${token}`);
    return false;
  }
  
  return true;
}

function generateClientId() {
  return Math.random().toString(36).substring(2, 15) + 
         Math.random().toString(36).substring(2, 15);
}

function getClientGroup(clientType) {
  switch(clientType) {
    case 'transmitter': return clients.transmitters;
    case 'receiver': return clients.receivers;
    case 'dashboard': return clients.dashboards;
    default: return null;
  }
}

// Limpeza de clientes inativos
setInterval(() => {
  const now = new Date();
  const inactiveTime = 120000; // 2 minutos

  [clients.transmitters, clients.receivers, clients.dashboards].forEach(group => {
    group.forEach((client, id) => {
      if (now - client.lastSeen > inactiveTime) {
        console.log(`🧹 Removendo cliente inativo: ${id}`);
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.close();
        }
        group.delete(id);
      }
    });
  });
}, 60000); // Verificar a cada minuto

// Iniciar servidor
server.listen(PORT, () => {
  console.log(`🚀 Servidor WebSocket iniciado na porta ${PORT}`);
  console.log(`🌍 Ambiente: ${NODE_ENV}`);
  console.log(`🔐 Tokens permitidos: ${ALLOWED_TOKENS.length}`);
  console.log(`⏰ Iniciado em: ${metrics.startTime.toISOString()}`);
});

// Tratamento de shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Recebido SIGTERM, encerrando...');
  server.close(() => {
    console.log('✅ Servidor encerrado');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 Recebido SIGINT, encerrando...');
  server.close(() => {
    console.log('✅ Servidor encerrado');
    process.exit(0);
  });
});
