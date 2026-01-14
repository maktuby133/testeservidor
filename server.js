// server.js - Servidor WebSocket completo para ESP32 LoRa
const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();

// ====== CONFIGURAÇÕES ======
const HTTP_PORT = process.env.HTTP_PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 443;
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_TOKENS = process.env.ALLOWED_TOKENS ? process.env.ALLOWED_TOKENS.split(',') : ['esp32_token_secreto_2024'];

// ====== SERVIDORES ======
const httpServer = http.createServer(app);
let httpsServer = null;

// Verificar se temos certificados SSL (para produção)
const sslOptions = {
  key: process.env.SSL_KEY_PATH ? fs.readFileSync(process.env.SSL_KEY_PATH) : null,
  cert: process.env.SSL_CERT_PATH ? fs.readFileSync(process.env.SSL_CERT_PATH) : null
};

if (sslOptions.key && sslOptions.cert) {
  httpsServer = https.createServer(sslOptions, app);
  console.log('🔐 Certificados SSL carregados');
} else {
  console.log('⚠️ Sem certificados SSL - usando apenas HTTP');
}

// ====== WEBSOCKET SERVERS ======
const wssHTTP = new WebSocket.Server({ 
  server: httpServer,
  perMessageDeflate: false  // Importante para ESP32
});

let wssHTTPS = null;
if (httpsServer) {
  wssHTTPS = new WebSocket.Server({ 
    server: httpsServer,
    perMessageDeflate: false
  });
}

// ====== DADOS DO SISTEMA ======
const systemData = {
  startTime: new Date(),
  clients: {
    transmitters: new Map(),
    receivers: new Map(),
    dashboards: new Map()
  },
  caixaAgua: {
    distance: 0,
    level: 0,
    percentage: 0,
    liters: 0,
    sensorOK: false,
    lastUpdate: null,
    deviceID: ''
  },
  consumo: {
    hora: 0,
    hoje: 0,
    diario: Array(24).fill(0),
    ultimoReset: null
  },
  loraStats: {
    rssi: 0,
    snr: 0,
    rxCount: 0,
    lastDevice: '',
    lastUpdate: null
  },
  metrics: {
    totalConnections: 0,
    messagesReceived: 0,
    messagesSent: 0,
    errors: 0
  }
};

// ====== MIDDLEWARE ======
app.use(express.json());
app.use(express.static('public'));

// ====== ROTAS API ======

// Rota de saúde
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    environment: NODE_ENV,
    uptime: process.uptime(),
    serverTime: new Date().toISOString(),
    connections: {
      http: wssHTTP.clients.size,
      https: wssHTTPS ? wssHTTPS.clients.size : 0,
      total: wssHTTP.clients.size + (wssHTTPS ? wssHTTPS.clients.size : 0)
    },
    data: {
      caixaAgua: systemData.caixaAgua,
      consumo: systemData.consumo,
      loraStats: systemData.loraStats
    }
  });
});

// Rota principal
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Monitor Caixa d'Água - WebSocket Server</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .status { padding: 20px; border-radius: 10px; margin: 10px 0; }
        .online { background: #d4edda; color: #155724; }
        .offline { background: #f8d7da; color: #721c24; }
        .info { background: #d1ecf1; color: #0c5460; }
      </style>
    </head>
    <body>
      <h1>💧 Monitor Caixa d'Água - WebSocket Server</h1>
      <div class="status info">
        <strong>Status do Servidor:</strong> ONLINE<br>
        <strong>Ambiente:</strong> ${NODE_ENV}<br>
        <strong>HTTP Port:</strong> ${HTTP_PORT}<br>
        <strong>HTTPS Port:</strong> ${HTTPS_PORT}<br>
        <strong>Uptime:</strong> ${process.uptime().toFixed(0)} segundos<br>
        <strong>Iniciado em:</strong> ${systemData.startTime.toLocaleString()}
      </div>
      <div class="status ${systemData.caixaAgua.sensorOK ? 'online' : 'offline'}">
        <h3>📊 Dados da Caixa d'Água</h3>
        <strong>Dispositivo:</strong> ${systemData.caixaAgua.deviceID || 'Nenhum'}<br>
        <strong>Nível:</strong> ${systemData.caixaAgua.percentage}%<br>
        <strong>Litros:</strong> ${systemData.caixaAgua.liters}L<br>
        <strong>Sensor:</strong> ${systemData.caixaAgua.sensorOK ? '✅ OK' : '❌ FALHA'}<br>
        <strong>Última atualização:</strong> ${systemData.caixaAgua.lastUpdate ? new Date(systemData.caixaAgua.lastUpdate).toLocaleTimeString() : 'Nunca'}
      </div>
      <div class="status info">
        <h3>🔗 Conexões WebSocket</h3>
        <strong>HTTP (ws://):</strong> ${wssHTTP.clients.size} clientes<br>
        <strong>HTTPS (wss://):</strong> ${wssHTTPS ? wssHTTPS.clients.size : 0} clientes<br>
        <strong>Total:</strong> ${wssHTTP.clients.size + (wssHTTPS ? wssHTTPS.clients.size : 0)} clientes
      </div>
      <div class="status info">
        <h3>📡 LoRa Stats</h3>
        <strong>Último dispositivo:</strong> ${systemData.loraStats.lastDevice}<br>
        <strong>RSSI:</strong> ${systemData.loraStats.rssi} dBm<br>
        <strong>SNR:</strong> ${systemData.loraStats.snr} dB<br>
        <strong>Pacotes recebidos:</strong> ${systemData.loraStats.rxCount}
      </div>
      <div>
        <h3>🔗 Endpoints:</h3>
        <ul>
          <li><a href="/health">/health</a> - Status do servidor</li>
          <li><a href="/api/data">/api/data</a> - Dados JSON</li>
          <li><a href="/dashboard">/dashboard</a> - Dashboard (se disponível)</li>
        </ul>
      </div>
    </body>
    </html>
  `);
});

// API para dados JSON
app.get('/api/data', (req, res) => {
  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    data: systemData.caixaAgua,
    consumo: systemData.consumo,
    loraStats: systemData.loraStats,
    metrics: {
      clients: {
        transmitters: Array.from(systemData.clients.transmitters.keys()),
        receivers: Array.from(systemData.clients.receivers.keys()),
        dashboards: Array.from(systemData.clients.dashboards.keys())
      },
      totals: systemData.metrics
    }
  });
});

// API para reset de consumo
app.post('/api/reset-consumo', (req, res) => {
  const { token } = req.body;
  
  if (!token || !ALLOWED_TOKENS.includes(token)) {
    return res.status(401).json({
      success: false,
      message: 'Token inválido'
    });
  }
  
  // Resetar consumo
  systemData.consumo = {
    hora: 0,
    hoje: 0,
    diario: Array(24).fill(0),
    ultimoReset: new Date().toISOString()
  };
  
  // Enviar comando para todos os receptores
  broadcastToReceivers('reset_consumo');
  
  res.json({
    success: true,
    message: 'Consumo resetado com sucesso',
    timestamp: new Date().toISOString()
  });
});

// API para histórico
app.get('/api/history', (req, res) => {
  res.json({
    success: true,
    consumo: systemData.consumo,
    loraStats: systemData.loraStats,
    lastUpdate: systemData.caixaAgua.lastUpdate
  });
});

// ====== FUNÇÕES WEBSOCKET ======

function setupWebSocketServer(wss, protocol) {
  wss.on('connection', (ws, req) => {
    const clientId = generateClientId();
    const clientIp = req.socket.remoteAddress;
    let clientType = 'unknown';
    let authenticated = false;
    let deviceId = '';
    
    console.log(`🔗 [${protocol}] Nova conexão: ${clientId} from ${clientIp}`);
    systemData.metrics.totalConnections++;
    
    // Heartbeat
    let isAlive = true;
    const heartbeatInterval = setInterval(() => {
      if (!isAlive) {
        console.log(`💔 [${protocol}] Cliente ${clientId} inativo - desconectando`);
        ws.terminate();
        return;
      }
      
      isAlive = false;
      ws.ping();
    }, 30000);
    
    ws.on('pong', () => {
      isAlive = true;
    });
    
    ws.on('message', (message) => {
      try {
        systemData.metrics.messagesReceived++;
        const data = JSON.parse(message.toString());
        
        // Autenticação
        if (data.type === 'auth') {
          return handleAuth(ws, data, clientId, clientIp, protocol);
        }
        
        // Apenas processar mensagens de clientes autenticados
        if (!authenticated) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Não autenticado',
            code: 'UNAUTHORIZED'
          }));
          return;
        }
        
        // Processar diferentes tipos de mensagens
        switch(data.type) {
          case 'lora_data':
            handleLoRaData(data, deviceId);
            broadcastToDashboards(data);
            break;
            
          case 'status':
            updateClientStatus(clientId, clientType, data);
            break;
            
          case 'ping':
            ws.send(JSON.stringify({
              type: 'pong',
              timestamp: Date.now()
            }));
            break;
            
          case 'get_data':
            sendSystemData(ws, deviceId);
            break;
            
          case 'get_consumo':
            sendConsumoData(ws);
            break;
            
          case 'reset_consumo':
            handleResetConsumo(ws, deviceId);
            break;
            
          default:
            console.log(`📨 [${protocol}] Mensagem não reconhecida de ${deviceId}:`, data.type);
        }
        
      } catch (error) {
        console.error(`❌ [${protocol}] Erro ao processar mensagem de ${clientId}:`, error);
        systemData.metrics.errors++;
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Erro ao processar mensagem',
          error: error.message
        }));
      }
    });
    
    ws.on('close', () => {
      console.log(`🔌 [${protocol}] Conexão fechada: ${clientId} (${clientType})`);
      clearInterval(heartbeatInterval);
      
      // Remover dos grupos
      systemData.clients.transmitters.delete(clientId);
      systemData.clients.receivers.delete(clientId);
      systemData.clients.dashboards.delete(clientId);
    });
    
    ws.on('error', (error) => {
      console.error(`❌ [${protocol}] Erro no cliente ${clientId}:`, error);
      systemData.metrics.errors++;
    });
    
    // Enviar mensagem de boas-vindas
    setTimeout(() => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'welcome',
          message: 'Conectado ao servidor WebSocket',
          serverTime: new Date().toISOString(),
          protocol: protocol,
          requiresAuth: true
        }));
      }
    }, 1000);
  });
}

// ====== HANDLERS ======

function handleAuth(ws, data, clientId, clientIp, protocol) {
  const { token, device, role } = data;
  
  console.log(`🔐 [${protocol}] Tentativa de autenticação: ${device} (${role})`);
  
  // Verificar token
  if (!token || !ALLOWED_TOKENS.includes(token)) {
    console.log(`❌ [${protocol}] Token inválido de ${device}: ${token}`);
    ws.send(JSON.stringify({
      type: 'auth_error',
      message: 'Token de autenticação inválido'
    }));
    ws.close();
    return;
  }
  
  // Verificar dispositivo e role
  if (!device || !role) {
    ws.send(JSON.stringify({
      type: 'auth_error',
      message: 'Dispositivo ou role não especificados'
    }));
    ws.close();
    return;
  }
  
  const clientType = role;
  const deviceId = device;
  
  // Adicionar ao grupo correto
  switch(clientType) {
    case 'transmitter':
      systemData.clients.transmitters.set(clientId, { 
        ws, 
        deviceId, 
        ip: clientIp,
        protocol,
        lastSeen: new Date(),
        connectedAt: new Date()
      });
      console.log(`📡 [${protocol}] Transmissor conectado: ${deviceId}`);
      break;
      
    case 'receiver':
      systemData.clients.receivers.set(clientId, { 
        ws, 
        deviceId, 
        ip: clientIp,
        protocol,
        lastSeen: new Date(),
        connectedAt: new Date()
      });
      console.log(`🏠 [${protocol}] Receptor conectado: ${deviceId}`);
      break;
      
    case 'dashboard':
      systemData.clients.dashboards.set(clientId, { 
        ws, 
        deviceId, 
        ip: clientIp,
        protocol,
        lastSeen: new Date(),
        connectedAt: new Date()
      });
      console.log(`📊 [${protocol}] Dashboard conectado: ${deviceId}`);
      break;
      
    default:
      console.log(`❓ [${protocol}] Cliente desconhecido: ${deviceId} (${clientType})`);
  }
  
  // Enviar confirmação
  ws.send(JSON.stringify({
    type: 'auth_success',
    message: 'Autenticado com sucesso',
    clientId: clientId,
    deviceId: deviceId,
    role: clientType,
    timestamp: new Date().toISOString(),
    serverInfo: {
      version: '2.0.0',
      environment: NODE_ENV,
      supports: ['lora_data', 'status', 'consumo_data', 'reset_consumo']
    }
  }));
  
  // Se for dashboard, enviar dados atuais
  if (clientType === 'dashboard') {
    setTimeout(() => {
      sendSystemData(ws, deviceId);
    }, 500);
  }
}

function handleLoRaData(data, deviceId) {
  console.log(`📡 Dados LoRa de ${deviceId}: ${data.liters}L (${data.percentage}%)`);
  
  // Atualizar dados da caixa d'água
  systemData.caixaAgua = {
    distance: data.distance || 0,
    level: data.level || 0,
    percentage: data.percentage || 0,
    liters: data.liters || 0,
    sensorOK: data.sensor_ok || false,
    lastUpdate: new Date().toISOString(),
    deviceID: deviceId
  };
  
  // Atualizar stats LoRa
  if (data.rssi !== undefined) {
    systemData.loraStats = {
      rssi: data.rssi,
      snr: data.snr || 0,
      rxCount: data.rx_count || 0,
      lastDevice: deviceId,
      lastUpdate: new Date().toISOString()
    };
  }
  
  // Atualizar consumo se veio do receptor
  if (data.consumo_hora !== undefined) {
    systemData.consumo.hora = data.consumo_hora;
  }
  
  if (data.consumo_hoje !== undefined) {
    systemData.consumo.hoje = data.consumo_hoje;
  }
  
  // Log detalhado
  console.log(`💧 Atualização: ${data.liters}L | ${data.percentage}% | RSSI: ${data.rssi || 'N/A'} dBm`);
}

function handleResetConsumo(ws, deviceId) {
  console.log(`🔄 Reset de consumo solicitado por ${deviceId}`);
  
  systemData.consumo = {
    hora: 0,
    hoje: 0,
    diario: Array(24).fill(0),
    ultimoReset: new Date().toISOString()
  };
  
  // Confirmar para o cliente
  ws.send(JSON.stringify({
    type: 'reset_confirmation',
    message: 'Consumo resetado com sucesso',
    timestamp: new Date().toISOString()
  }));
  
  // Notificar dashboards
  broadcastToDashboards({
    type: 'consumo_reset',
    resetBy: deviceId,
    timestamp: new Date().toISOString()
  });
}

// ====== FUNÇÕES AUXILIARES ======

function generateClientId() {
  return Math.random().toString(36).substring(2, 15) + 
         Math.random().toString(36).substring(2, 15);
}

function updateClientStatus(clientId, clientType, data) {
  const clientGroup = getClientGroup(clientType);
  if (clientGroup && clientGroup.has(clientId)) {
    const client = clientGroup.get(clientId);
    client.lastSeen = new Date();
    client.status = data;
  }
}

function getClientGroup(clientType) {
  switch(clientType) {
    case 'transmitter': return systemData.clients.transmitters;
    case 'receiver': return systemData.clients.receivers;
    case 'dashboard': return systemData.clients.dashboards;
    default: return null;
  }
}

function broadcastToDashboards(data) {
  systemData.clients.dashboards.forEach((client, id) => {
    if (client.ws.readyState === client.ws.OPEN) {
      client.ws.send(JSON.stringify({
        ...data,
        broadcast: true,
        timestamp: new Date().toISOString()
      }));
      systemData.metrics.messagesSent++;
    }
  });
}

function broadcastToReceivers(command) {
  systemData.clients.receivers.forEach((client, id) => {
    if (client.ws.readyState === client.ws.OPEN) {
      client.ws.send(command);
      systemData.metrics.messagesSent++;
    }
  });
}

function sendSystemData(ws, deviceId) {
  ws.send(JSON.stringify({
    type: 'system_data',
    data: systemData.caixaAgua,
    consumo: systemData.consumo,
    loraStats: systemData.loraStats,
    timestamp: new Date().toISOString(),
    forDevice: deviceId
  }));
  systemData.metrics.messagesSent++;
}

function sendConsumoData(ws) {
  ws.send(JSON.stringify({
    type: 'consumo_data',
    consumo: systemData.consumo,
    timestamp: new Date().toISOString()
  }));
  systemData.metrics.messagesSent++;
}

// ====== LIMPEZA DE CLIENTES INATIVOS ======
setInterval(() => {
  const now = new Date();
  const inactiveTime = 120000; // 2 minutos
  
  [systemData.clients.transmitters, systemData.clients.receivers, systemData.clients.dashboards].forEach(group => {
    group.forEach((client, id) => {
      if (now - client.lastSeen > inactiveTime) {
        console.log(`🧹 Removendo cliente inativo: ${id} (${client.deviceId})`);
        if (client.ws.readyState === client.ws.OPEN) {
          client.ws.close();
        }
        group.delete(id);
      }
    });
  });
}, 60000); // Verificar a cada minuto

// ====== INICIALIZAR SERVIDORES ======

// Configurar WebSocket para HTTP
setupWebSocketServer(wssHTTP, 'HTTP');

// Configurar WebSocket para HTTPS (se disponível)
if (wssHTTPS) {
  setupWebSocketServer(wssHTTPS, 'HTTPS');
}

// Iniciar servidor HTTP
httpServer.listen(HTTP_PORT, () => {
  console.log(`🚀 Servidor HTTP WebSocket iniciado na porta ${HTTP_PORT}`);
  console.log(`🔗 WebSocket URL: ws://localhost:${HTTP_PORT}`);
  console.log(`🌍 Ambiente: ${NODE_ENV}`);
  console.log(`🔐 Tokens permitidos: ${ALLOWED_TOKENS.length}`);
  console.log(`⏰ Iniciado em: ${systemData.startTime.toLocaleString()}`);
  console.log(`📡 Aguardando conexões de ESP32...`);
});

// Iniciar servidor HTTPS (se disponível)
if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, () => {
    console.log(`🔐 Servidor HTTPS WebSocket iniciado na porta ${HTTPS_PORT}`);
    console.log(`🔗 WebSocket Secure URL: wss://localhost:${HTTPS_PORT}`);
  });
}

// ====== TRATAMENTO DE SHUTDOWN ======
process.on('SIGTERM', () => {
  console.log('🛑 Recebido SIGTERM, encerrando...');
  
  // Fechar todas as conexões WebSocket
  wssHTTP.clients.forEach(client => {
    if (client.readyState === client.OPEN) {
      client.close();
    }
  });
  
  if (wssHTTPS) {
    wssHTTPS.clients.forEach(client => {
      if (client.readyState === client.OPEN) {
        client.close();
      }
    });
  }
  
  server.close(() => {
    console.log('✅ Servidor encerrado');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 Recebido SIGINT, encerrando...');
  process.exit(0);
});
