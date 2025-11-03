const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');
const axios = require('axios');

// 🎯 CARREGAR VARIÁVEIS DE AMBIENTE
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: false,
  clientTracking: true
});

// 🎯 CONFIGURAÇÃO
const HEALTH_CHECK_URL = process.env.HEALTH_CHECK_URL || `https://testeservidor-6opr.onrender.com/health`;
const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL) || 14 * 60 * 1000;
const ESP32_TOKEN = process.env.ESP32_TOKEN || 'esp32_token_secreto_2024';
const MAX_REQUESTS_PER_MINUTE = parseInt(process.env.MAX_REQUESTS_PER_MINUTE) || 60;
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Armazenar conexões
const clients = new Map();
let esp32Client = null;

// Métricas
const metrics = {
  messagesReceived: 0,
  messagesSent: 0,
  errors: 0,
  esp32Reconnects: 0,
  webClientsConnected: 0,
  esp32Disconnections: 0
};

// Rate limiting
const rateLimit = new Map();

// Middleware para CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

app.use(express.json());
app.use(express.static('public'));

// 🎯 MIDDLEWARE DE RATE LIMITING
app.use((req, res, next) => {
  const clientIP = getClientIP(req);
  
  if (!checkRateLimit(clientIP)) {
    return res.status(429).json({
      success: false,
      message: 'Muitas requisições. Tente novamente em 1 minuto.'
    });
  }
  
  next();
});

// ====== ROTAS ======

// Rota principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'Caixa dÁgua WebSocket',
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    uptime: Math.floor(process.uptime()),
    connections: {
      total: clients.size,
      esp32: esp32Client ? 1 : 0,
      web: Array.from(clients.values()).filter(client => client !== esp32Client).length
    }
  });
});

// 🎯 ROTA CORRIGIDA: Reset de consumo
app.post('/command/reset_consumo', express.json(), (req, res) => {
  console.log('🔄 API: Recebido comando reset_consumo');
  
  if (!esp32Client || esp32Client.readyState !== WebSocket.OPEN) {
    console.log('❌ ESP32 não conectado');
    return res.status(404).json({ 
      success: false, 
      message: 'ESP32 não conectado',
      environment: NODE_ENV
    });
  }
  
  try {
    // 🎯 ENVIAR COMANDO DIRETAMENTE PARA ESP32
    esp32Client.send('reset_consumo');
    metrics.messagesSent++;
    console.log('✅ Comando reset_consumo enviado para ESP32');
    
    res.json({ 
      success: true, 
      message: 'Reset de consumo enviado para ESP32',
      timestamp: new Date().toISOString(),
      environment: NODE_ENV
    });
  } catch (error) {
    console.error('❌ Erro ao enviar reset:', error);
    metrics.errors++;
    res.status(500).json({ 
      success: false, 
      message: 'Erro ao enviar comando de reset',
      error: error.message,
      environment: NODE_ENV
    });
  }
});

// 🎯 ROTA ALTERNATIVA (para compatibilidade)
app.post('/consumo/reset', express.json(), (req, res) => {
  console.log('🔄 API: Recebido comando /consumo/reset');
  
  if (!esp32Client || esp32Client.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ 
      success: false, 
      message: 'ESP32 não conectado',
      environment: NODE_ENV
    });
  }
  
  try {
    esp32Client.send('reset_consumo');
    metrics.messagesSent++;
    console.log('✅ Comando reset_consumo enviado para ESP32 via /consumo/reset');
    
    res.json({ 
      success: true, 
      message: 'Reset de consumo enviado para ESP32',
      timestamp: new Date().toISOString(),
      environment: NODE_ENV
    });
  } catch (error) {
    console.error('❌ Erro ao enviar reset:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erro ao enviar comando de reset',
      error: error.message,
      environment: NODE_ENV
    });
  }
});

// Status do sistema
app.get('/status', (req, res) => {
  const webClients = Array.from(clients.values()).filter(client => !client.isESP32);
  
  res.json({
    status: 'operational',
    serverTime: new Date().toISOString(),
    environment: NODE_ENV,
    uptime: Math.floor(process.uptime()),
    connections: {
      total: clients.size,
      esp32: esp32Client ? {
        connected: true,
        clientId: esp32Client.clientId,
        ip: esp32Client.clientIP,
        connectedAt: esp32Client.connectedAt
      } : { connected: false },
      web: webClients.length
    }
  });
});

// ====== WEBSOCKET ======

wss.on('connection', function connection(ws, req) {
  const clientId = generateClientId(req);
  const clientIP = getClientIP(req);
  const isESP32 = isESP32Connection(req, clientIP);
  
  console.log(`✅ Nova conexão: ${clientId} - IP: ${clientIP} - Tipo: ${isESP32 ? 'ESP32' : 'WEB'}`);
  
  clients.set(clientId, ws);
  ws.clientId = clientId;
  ws.clientIP = clientIP;
  ws.isESP32 = isESP32;
  ws.connectedAt = new Date();
  
  // Detectar ESP32
  if (isESP32) {
    if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
      console.log(`🔄 Substituindo ESP32 anterior: ${esp32Client.clientId}`);
      esp32Client.close(1000, 'Novo ESP32 conectado');
      metrics.esp32Reconnects++;
    }
    
    esp32Client = ws;
    console.log(`🎯 ESP32 registrado: ${clientId}`);
    
    // Notificar clientes web
    broadcastToWebClients({
      type: 'esp32_connected',
      message: 'ESP32 conectado',
      clientId: clientId,
      timestamp: new Date().toISOString()
    });
  } else {
    metrics.webClientsConnected++;
  }
  
  // Mensagem de boas-vindas
  sendToClient(ws, {
    type: 'connected',
    message: 'Conectado ao servidor WebSocket',
    clientId: clientId,
    isESP32: isESP32,
    timestamp: new Date().toISOString()
  });
  
  // Mensagens do cliente
  ws.on('message', function message(data) {
    try {
      const messageString = data.toString();
      metrics.messagesReceived++;
      
      // Tentar parsear como JSON primeiro
      try {
        const parsedMessage = JSON.parse(messageString);
        handleWebSocketMessage(ws, parsedMessage);
      } catch (jsonError) {
        // Se não for JSON, tratar como comando de texto
        handleTextCommand(ws, messageString);
      }
    } catch (error) {
      console.error(`❌ Erro ao processar mensagem de ${clientId}:`, error);
      metrics.errors++;
    }
  });
  
  ws.on('close', function close(code, reason) {
    console.log(`❌ Conexão fechada: ${clientId} - Código: ${code} - Motivo: ${reason || 'Nenhum'}`);
    
    if (esp32Client === ws) {
      console.log('🎯 ESP32 desconectado');
      esp32Client = null;
      metrics.esp32Disconnections++;
      
      // Notificar clientes web
      broadcastToWebClients({
        type: 'esp32_disconnected',
        message: 'ESP32 desconectado',
        clientId: clientId,
        reason: 'connection_closed',
        code: code,
        timestamp: new Date().toISOString()
      });
    } else {
      metrics.webClientsConnected = Math.max(0, metrics.webClientsConnected - 1);
    }
    
    clients.delete(clientId);
  });
  
  ws.on('error', function error(err) {
    console.error(`❌ Erro WebSocket ${clientId}:`, err.message);
    metrics.errors++;
  });
});

// ====== FUNÇÕES PRINCIPAIS ======

function handleWebSocketMessage(ws, message) {
  const clientInfo = `${ws.clientId} (${ws.clientIP})`;
  
  console.log(`📨 ${clientInfo} - ${message.type}`);
  
  // Adicionar metadados
  const enhancedMessage = {
    ...message,
    clientId: ws.clientId,
    origin: ws.isESP32 ? 'esp32' : 'web',
    timestamp: new Date().toISOString()
  };
  
  // Se a mensagem é do ESP32, retransmitir para todos os clientes web
  if (ws.isESP32) {
    broadcastToWebClients(enhancedMessage);
  } else {
    // Se é do frontend e temos ESP32, repassar para o ESP32
    if (esp32Client && esp32Client.readyState === WebSocket.OPEN && esp32Client !== ws) {
      // Remover metadados antes de enviar para ESP32
      const { clientId, origin, timestamp, ...cleanMessage } = enhancedMessage;
      sendToClient(esp32Client, cleanMessage);
      metrics.messagesSent++;
    } else if (!esp32Client) {
      // Se não há ESP32, responder ao frontend
      sendToClient(ws, {
        type: 'error',
        message: 'ESP32 não conectado',
        timestamp: new Date().toISOString()
      });
    }
  }
}

// 🎯 FUNÇÃO CRÍTICA CORRIGIDA: Processar comandos de texto
function handleTextCommand(ws, command) {
  console.log(`📤 Comando de ${ws.clientId}: ${command}`);
  
  // Comandos que não precisam do ESP32
  if (command === 'get_status' || command === 'health') {
    const statusMessage = {
      type: 'server_status',
      clients: clients.size,
      esp32Connected: !!esp32Client,
      timestamp: new Date().toISOString()
    };
    return sendToClient(ws, statusMessage);
  }
  
  // 🎯 CORREÇÃO: Se o comando precisa do ESP32
  if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
    console.log(`🔄 REPASSANDO COMANDO PARA ESP32: ${command}`);
    
    try {
      esp32Client.send(command);
      metrics.messagesSent++;
      console.log(`✅ Comando ${command} ENVIADO para ESP32`);
      
    } catch (error) {
      console.error(`❌ ERRO ao enviar comando para ESP32:`, error.message);
      sendToClient(ws, {
        type: 'error',
        message: 'Erro ao enviar comando para ESP32',
        command: command,
        timestamp: new Date().toISOString()
      });
    }
    
  } else {
    console.log(`❌ ESP32 NÃO CONECTADO - Comando ${command} ignorado`);
    sendToClient(ws, {
      type: 'error',
      message: 'ESP32 não conectado',
      command: command,
      timestamp: new Date().toISOString()
    });
  }
}

// ====== FUNÇÕES AUXILIARES ======

function sendToClient(client, message) {
  if (client.readyState === WebSocket.OPEN) {
    try {
      client.send(JSON.stringify(message));
      metrics.messagesSent++;
    } catch (error) {
      console.error(`❌ Erro ao enviar para ${client.clientId}:`, error.message);
      metrics.errors++;
    }
  }
}

function broadcastToWebClients(message) {
  let sentCount = 0;
  
  clients.forEach((client, id) => {
    if (client.readyState === WebSocket.OPEN && !client.isESP32) {
      try {
        client.send(JSON.stringify(message));
        sentCount++;
        metrics.messagesSent++;
      } catch (error) {
        console.error(`❌ Erro ao transmitir para ${id}:`, error.message);
        metrics.errors++;
      }
    }
  });
  
  if (sentCount > 0) {
    console.log(`📡 Mensagem ${message.type} transmitida para ${sentCount} cliente(s) web`);
  }
}

function checkRateLimit(clientIP) {
  const now = Date.now();
  const windowStart = now - 60000; // 1 minuto
  
  if (!rateLimit.has(clientIP)) {
    rateLimit.set(clientIP, []);
  }
  
  const requests = rateLimit.get(clientIP).filter(time => time > windowStart);
  rateLimit.set(clientIP, requests);
  
  if (requests.length >= MAX_REQUESTS_PER_MINUTE) {
    console.log(`🚫 Rate limit excedido para IP: ${clientIP}`);
    return false;
  }
  
  requests.push(now);
  rateLimit.set(clientIP, requests);
  return true;
}

function isESP32Connection(req, clientIP) {
  const userAgent = req.headers['user-agent'] || '';
  
  const isESP = userAgent.includes('ESP32') || 
                userAgent.includes('Arduino') ||
                userAgent.includes('WiFiClient') ||
                userAgent === '' ||
                req.headers['origin'] === '' ||
                clientIP.includes('192.168.') ||
                clientIP.includes('10.0.');
  
  return isESP;
}

function generateClientId(req) {
  const isESP32 = isESP32Connection(req, getClientIP(req));
  const prefix = isESP32 ? 'ESP32' : 'WEB';
  const timestamp = Date.now();
  const random = Math.random().toString(36).substr(2, 9);
  return `${prefix}_${timestamp}_${random}`;
}

function getClientIP(req) {
  return req.headers['x-forwarded-for'] || 
         req.connection.remoteAddress || 
         'unknown';
}

// ====== INICIALIZAÇÃO ======

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🌐 Ambiente: ${NODE_ENV}`);
  console.log(`📊 Health: http://localhost:${PORT}/health`);
  console.log(`🎯 Aguardando conexões ESP32 e Web...`);
});

// Health check automático
async function healthCheck() {
    try {
        const response = await axios.get(HEALTH_CHECK_URL);
        console.log(`✅ Health check: ${response.status} - ${new Date().toLocaleTimeString('pt-BR')}`);
    } catch (error) {
        console.log(`❌ Erro no health check: ${error.message}`);
    }
}

setInterval(healthCheck, HEALTH_CHECK_INTERVAL);
healthCheck();

// Limpeza de conexões mortas
setInterval(() => {
  let cleanedCount = 0;
  
  clients.forEach((client, id) => {
    if (client.readyState !== WebSocket.OPEN) {
      clients.delete(id);
      cleanedCount++;
      
      if (client === esp32Client) {
        esp32Client = null;
        console.log('🧹 ESP32 removido (conexão fechada)');
      }
    }
  });
  
  if (cleanedCount > 0) {
    console.log(`🧹 Limpeza: ${cleanedCount} cliente(s) removido(s)`);
  }
}, 60000);

console.log('✅ Servidor WebSocket inicializado com sucesso!');
