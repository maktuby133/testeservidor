// server.js - Servidor WebSocket para Render (HTTPS/WSS)
const WebSocket = require('ws');
const express = require('express');
const http = require('http');
require('dotenv').config();

const app = express();

// ====== CONFIGURAÇÕES ======
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const ALLOWED_TOKENS = process.env.ALLOWED_TOKENS ? 
  process.env.ALLOWED_TOKENS.split(',') : 
  ['esp32_token_secreto_2024'];

console.log('🚀 Iniciando servidor...');
console.log(`📝 Porta: ${PORT}`);
console.log(`🌍 Ambiente: ${NODE_ENV}`);
console.log(`🔐 Tokens permitidos: ${ALLOWED_TOKENS.length}`);

// ====== SERVIDOR HTTP (Render fornece HTTPS automaticamente) ======
const server = http.createServer(app);

// ====== WEBSOCKET SERVER ======
// No Render, usamos HTTP porque o Render faz o upgrade para HTTPS
const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: false,  // Importante para ESP32
  clientTracking: true
});

console.log('✅ WebSocket Server criado');

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

// Logging middleware
app.use((req, res, next) => {
  console.log(`📨 ${req.method} ${req.path} - ${req.ip}`);
  next();
});

// ====== ROTAS API ======

// Rota de saúde
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    environment: NODE_ENV,
    uptime: process.uptime(),
    serverTime: new Date().toISOString(),
    connections: {
      total: wss.clients.size,
      transmitters: systemData.clients.transmitters.size,
      receivers: systemData.clients.receivers.size,
      dashboards: systemData.clients.dashboards.size
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
  const isSecure = req.headers['x-forwarded-proto'] === 'https';
  const protocol = isSecure ? 'wss' : 'ws';
  const host = req.headers.host;
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Monitor Caixa d'Água - WebSocket Server</title>
      <meta charset="UTF-8">
      <style>
        body { 
          font-family: Arial, sans-serif; 
          margin: 40px;
          background: #f5f5f5;
        }
        .container {
          max-width: 800px;
          margin: 0 auto;
          background: white;
          padding: 30px;
          border-radius: 10px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 { color: #2c3e50; }
        .status { 
          padding: 20px; 
          border-radius: 10px; 
          margin: 15px 0; 
        }
        .online { background: #d4edda; color: #155724; }
        .offline { background: #f8d7da; color: #721c24; }
        .info { background: #d1ecf1; color: #0c5460; }
        .warning { background: #fff3cd; color: #856404; }
        .stat { margin: 10px 0; }
        .stat strong { display: inline-block; width: 200px; }
        code { 
          background: #f4f4f4; 
          padding: 2px 8px; 
          border-radius: 4px;
          font-family: monospace;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>💧 Monitor Caixa d'Água</h1>
        
        <div class="status info">
          <h3>🌐 Informações do Servidor</h3>
          <div class="stat"><strong>Status:</strong> 🟢 ONLINE</div>
          <div class="stat"><strong>Ambiente:</strong> ${NODE_ENV}</div>
          <div class="stat"><strong>Porta:</strong> ${PORT}</div>
          <div class="stat"><strong>Protocolo:</strong> ${isSecure ? '🔐 HTTPS/WSS' : '⚠️ HTTP/WS'}</div>
          <div class="stat"><strong>Uptime:</strong> ${process.uptime().toFixed(0)} segundos</div>
          <div class="stat"><strong>Iniciado em:</strong> ${systemData.startTime.toLocaleString('pt-BR')}</div>
        </div>

        <div class="status ${isSecure ? 'online' : 'warning'}">
          <h3>🔗 Conexão WebSocket</h3>
          <div class="stat"><strong>URL:</strong> <code>${protocol}://${host}</code></div>
          <div class="stat"><strong>Seguro:</strong> ${isSecure ? '✅ SIM (SSL/TLS)' : '⚠️ NÃO'}</div>
          <div class="stat"><strong>Clientes conectados:</strong> ${wss.clients.size}</div>
        </div>
        
        <div class="status ${systemData.caixaAgua.sensorOK ? 'online' : 'offline'}">
          <h3>📊 Dados da Caixa d'Água</h3>
          <div class="stat"><strong>Dispositivo:</strong> ${systemData.caixaAgua.deviceID || 'Nenhum'}</div>
          <div class="stat"><strong>Nível:</strong> ${systemData.caixaAgua.percentage}%</div>
          <div class="stat"><strong>Litros:</strong> ${systemData.caixaAgua.liters}L</div>
          <div class="stat"><strong>Sensor:</strong> ${systemData.caixaAgua.sensorOK ? '✅ OK' : '❌ FALHA'}</div>
          <div class="stat"><strong>Última atualização:</strong> ${systemData.caixaAgua.lastUpdate ? new Date(systemData.caixaAgua.lastUpdate).toLocaleString('pt-BR') : 'Nunca'}</div>
        </div>
        
        <div class="status info">
          <h3>🔗 Conexões Ativas</h3>
          <div class="stat"><strong>Transmissores:</strong> ${systemData.clients.transmitters.size}</div>
          <div class="stat"><strong>Receptores:</strong> ${systemData.clients.receivers.size}</div>
          <div class="stat"><strong>Dashboards:</strong> ${systemData.clients.dashboards.size}</div>
          <div class="stat"><strong>Total:</strong> ${wss.clients.size}</div>
        </div>
        
        <div class="status info">
          <h3>📡 LoRa Stats</h3>
          <div class="stat"><strong>Último dispositivo:</strong> ${systemData.loraStats.lastDevice || 'N/A'}</div>
          <div class="stat"><strong>RSSI:</strong> ${systemData.loraStats.rssi} dBm</div>
          <div class="stat"><strong>SNR:</strong> ${systemData.loraStats.snr} dB</div>
          <div class="stat"><strong>Pacotes recebidos:</strong> ${systemData.loraStats.rxCount}</div>
        </div>

        <div class="status info">
          <h3>📈 Métricas</h3>
          <div class="stat"><strong>Total de conexões:</strong> ${systemData.metrics.totalConnections}</div>
          <div class="stat"><strong>Mensagens recebidas:</strong> ${systemData.metrics.messagesReceived}</div>
          <div class="stat"><strong>Mensagens enviadas:</strong> ${systemData.metrics.messagesSent}</div>
          <div class="stat"><strong>Erros:</strong> ${systemData.metrics.errors}</div>
        </div>
        
        <div>
          <h3>🔗 Endpoints API:</h3>
          <ul>
            <li><a href="/health">/health</a> - Status do servidor (JSON)</li>
            <li><a href="/api/data">/api/data</a> - Dados completos (JSON)</li>
          </ul>
        </div>

        <div class="status warning">
          <h3>⚙️ Configuração ESP32</h3>
          <p>Para conectar o ESP32, use:</p>
          <code>
            const char* server = "${host.split(':')[0]}";<br>
            const int port = 443;<br>
            webSocket.beginSSL(server, port, "/", "", "");
          </code>
        </div>
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

// ====== WEBSOCKET CONNECTION HANDLER ======
wss.on('connection', (ws, req) => {
  const clientId = generateClientId();
  const clientIp = req.socket.remoteAddress || req.headers['x-forwarded-for'];
  let clientType = 'unknown';
  let authenticated = false;
  let deviceId = '';
  
  console.log(`🔗 Nova conexão WebSocket: ${clientId} de ${clientIp}`);
  systemData.metrics.totalConnections++;
  
  // Heartbeat
  let isAlive = true;
  
  const heartbeatInterval = setInterval(() => {
    if (!isAlive) {
      console.log(`💔 Cliente ${clientId} inativo - desconectando`);
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
      
      console.log(`📨 Mensagem de ${deviceId || clientId}: ${data.type}`);
      
      // Autenticação
      if (data.type === 'auth') {
        const { token, device, role } = data;
        
        console.log(`🔐 Autenticação: ${device} (${role}) com token: ${token}`);
        
        // Verificar token
        if (!token || !ALLOWED_TOKENS.includes(token)) {
          console.log(`❌ Token inválido: ${token}`);
          ws.send(JSON.stringify({
            type: 'auth_error',
            message: 'Token de autenticação inválido'
          }));
          ws.close();
          return;
        }
        
        authenticated = true;
        clientType = role;
        deviceId = device;
        
        // Adicionar ao grupo
        const clientInfo = { 
          ws, 
          deviceId, 
          ip: clientIp,
          lastSeen: new Date(),
          connectedAt: new Date()
        };
        
        switch(role) {
          case 'transmitter':
            systemData.clients.transmitters.set(clientId, clientInfo);
            console.log(`📡 Transmissor autenticado: ${deviceId}`);
            break;
          case 'receiver':
            systemData.clients.receivers.set(clientId, clientInfo);
            console.log(`🏠 Receptor autenticado: ${deviceId}`);
            break;
          case 'dashboard':
            systemData.clients.dashboards.set(clientId, clientInfo);
            console.log(`📊 Dashboard autenticado: ${deviceId}`);
            break;
        }
        
        // Confirmar autenticação
        ws.send(JSON.stringify({
          type: 'auth_success',
          message: 'Autenticado com sucesso',
          clientId,
          deviceId,
          role,
          timestamp: new Date().toISOString(),
          serverInfo: {
            version: '2.1.0',
            environment: NODE_ENV
          }
        }));
        
        return;
      }
      
      // Verificar autenticação
      if (!authenticated) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Não autenticado'
        }));
        return;
      }
      
      // Processar mensagens
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
          console.log(`❓ Tipo de mensagem não reconhecido: ${data.type}`);
      }
      
    } catch (error) {
      console.error(`❌ Erro ao processar mensagem:`, error);
      systemData.metrics.errors++;
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Erro ao processar mensagem',
        error: error.message
      }));
    }
  });
  
  ws.on('close', () => {
    console.log(`🔌 Conexão fechada: ${deviceId || clientId} (${clientType})`);
    clearInterval(heartbeatInterval);
    
    systemData.clients.transmitters.delete(clientId);
    systemData.clients.receivers.delete(clientId);
    systemData.clients.dashboards.delete(clientId);
  });
  
  ws.on('error', (error) => {
    console.error(`❌ Erro no WebSocket ${clientId}:`, error);
    systemData.metrics.errors++;
  });
  
  // Mensagem de boas-vindas
  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'welcome',
        message: 'Conectado ao servidor WebSocket',
        serverTime: new Date().toISOString(),
        requiresAuth: true
      }));
    }
  }, 500);
});

// ====== HANDLERS ======

function handleLoRaData(data, deviceId) {
  console.log(`📡 LoRa de ${deviceId}: ${data.liters}L (${data.percentage}%)`);
  
  systemData.caixaAgua = {
    distance: data.distance || 0,
    level: data.level || 0,
    percentage: data.percentage || 0,
    liters: data.liters || 0,
    sensorOK: data.sensor_ok || false,
    lastUpdate: new Date().toISOString(),
    deviceID: deviceId
  };
  
  if (data.rssi !== undefined) {
    systemData.loraStats = {
      rssi: data.rssi,
      snr: data.snr || 0,
      rxCount: data.rx_count || 0,
      lastDevice: deviceId,
      lastUpdate: new Date().toISOString()
    };
  }
  
  if (data.consumo_hora !== undefined) {
    systemData.consumo.hora = data.consumo_hora;
  }
  
  if (data.consumo_hoje !== undefined) {
    systemData.consumo.hoje = data.consumo_hoje;
  }
}

function handleResetConsumo(ws, deviceId) {
  console.log(`🔄 Reset de consumo por ${deviceId}`);
  
  systemData.consumo = {
    hora: 0,
    hoje: 0,
    diario: Array(24).fill(0),
    ultimoReset: new Date().toISOString()
  };
  
  ws.send(JSON.stringify({
    type: 'reset_confirmation',
    message: 'Consumo resetado',
    timestamp: new Date().toISOString()
  }));
  
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
  const groups = {
    'transmitter': systemData.clients.transmitters,
    'receiver': systemData.clients.receivers,
    'dashboard': systemData.clients.dashboards
  };
  
  const group = groups[clientType];
  if (group && group.has(clientId)) {
    const client = group.get(clientId);
    client.lastSeen = new Date();
    client.status = data;
  }
}

function broadcastToDashboards(data) {
  let sent = 0;
  systemData.clients.dashboards.forEach((client) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({
        ...data,
        broadcast: true,
        timestamp: new Date().toISOString()
      }));
      sent++;
    }
  });
  systemData.metrics.messagesSent += sent;
  if (sent > 0) console.log(`📤 Broadcast para ${sent} dashboards`);
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
  const timeout = 120000; // 2 minutos
  
  [systemData.clients.transmitters, systemData.clients.receivers, systemData.clients.dashboards]
    .forEach(group => {
      group.forEach((client, id) => {
        if (now - client.lastSeen > timeout) {
          console.log(`🧹 Removendo cliente inativo: ${client.deviceId}`);
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.close();
          }
          group.delete(id);
        }
      });
    });
}, 60000);

// ====== INICIAR SERVIDOR ======
server.listen(PORT, () => {
  console.log('═══════════════════════════════════════════');
  console.log('🚀 SERVIDOR WEBSOCKET INICIADO COM SUCESSO');
  console.log('═══════════════════════════════════════════');
  console.log(`📡 Porta: ${PORT}`);
  console.log(`🌍 Ambiente: ${NODE_ENV}`);
  console.log(`🔐 Tokens permitidos: ${ALLOWED_TOKENS.length}`);
  console.log(`⏰ Iniciado: ${systemData.startTime.toLocaleString('pt-BR')}`);
  console.log('📱 Aguardando conexões ESP32...');
  console.log('═══════════════════════════════════════════');
});

// ====== SHUTDOWN GRACEFUL ======
const shutdown = () => {
  console.log('\n🛑 Encerrando servidor...');
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.close();
    }
  });
  
  server.close(() => {
    console.log('✅ Servidor encerrado');
    process.exit(0);
  });
  
  setTimeout(() => process.exit(1), 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
