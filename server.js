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

// 🎯 CONFIGURAÇÃO VIA VARIÁVEIS DE AMBIENTE
const HEALTH_CHECK_URL = process.env.HEALTH_CHECK_URL || `https://testeservidor-6opr.onrender.com/health`;
const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL) || 14 * 60 * 1000;
const ESP32_TOKEN = process.env.ESP32_TOKEN || 'esp32_token_secreto_2024';
const MAX_REQUESTS_PER_MINUTE = parseInt(process.env.MAX_REQUESTS_PER_MINUTE) || 60;
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// 🎯 NOVO: Sistema de notificação de desconexão
const DISCONNECTION_TIMEOUT = 20000; // 20 segundos
const clientHeartbeats = new Map();

// 🎯 LOG DE CONFIGURAÇÃO CARREGADA
console.log('🔧 Configuração do Servidor:');
console.log(`   Porta: ${PORT}`);
console.log(`   Ambiente: ${NODE_ENV}`);
console.log(`   Health Check: ${HEALTH_CHECK_URL}`);
console.log(`   Token ESP32: ${ESP32_TOKEN ? '✅ Configurado' : '❌ Não configurado'}`);
console.log(`   Rate Limit: ${MAX_REQUESTS_PER_MINUTE} req/minuto`);
console.log(`   Timeout Desconexão: ${DISCONNECTION_TIMEOUT/1000} segundos`);

// Armazenar conexões
const clients = new Map();
let esp32Client = null;

// 🎯 NOVO: Armazenamento de dados históricos
const historicalData = [];
const metrics = {
  messagesReceived: 0,
  messagesSent: 0,
  errors: 0,
  esp32Reconnects: 0,
  webClientsConnected: 0,
  esp32Disconnections: 0,
  esp32Timeouts: 0
};

// 🎯 NOVO: Rate limiting
const rateLimit = new Map();

// 🎯 NOVA FUNÇÃO: Sistema de heartbeat para ESP32
function setupESP32Heartbeat(clientId, ws) {
    console.log(`💓 Iniciando heartbeat para ESP32: ${clientId}`);
    
    clientHeartbeats.set(clientId, {
        lastHeartbeat: Date.now(),
        isConnected: true,
        heartbeatInterval: setInterval(() => {
            const clientData = clientHeartbeats.get(clientId);
            if (clientData && Date.now() - clientData.lastHeartbeat > DISCONNECTION_TIMEOUT) {
                console.log(`🚨 ESP32 ${clientId} considerado DESCONECTADO (timeout heartbeat)`);
                clientData.isConnected = false;
                metrics.esp32Timeouts++;
                
                // Notificar TODOS os clientes web sobre a desconexão
                broadcastToWebClients({
                    type: 'esp32_disconnected',
                    message: 'ESP32 desconectado - Sem comunicação',
                    clientId: clientId,
                    reason: 'heartbeat_timeout',
                    timestamp: new Date().toISOString(),
                    environment: NODE_ENV,
                    urgent: true
                });
                
                // Limpar intervalos
                clearInterval(clientData.heartbeatInterval);
                clientHeartbeats.delete(clientId);
            }
        }, 5000) // Verificar a cada 5 segundos
    });
}

// 🎯 NOVA FUNÇÃO: Atualizar heartbeat do ESP32
function updateESP32Heartbeat(clientId) {
    const heartbeatData = clientHeartbeats.get(clientId);
    if (heartbeatData) {
        heartbeatData.lastHeartbeat = Date.now();
        if (!heartbeatData.isConnected) {
            heartbeatData.isConnected = true;
            console.log(`💓 ESP32 ${clientId} reconectado (heartbeat atualizado)`);
        }
    }
}

// 🎯 NOVA FUNÇÃO: Notificar reconexão do ESP32
function notifyESP32Reconnection(clientId) {
    broadcastToWebClients({
        type: 'esp32_reconnected',
        message: 'ESP32 reconectado',
        clientId: clientId,
        timestamp: new Date().toISOString(),
        environment: NODE_ENV
    });
}

// Middleware para CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

app.use(express.json());
app.use(express.static('public'));

// 🎯 NOVO: Middleware de rate limiting
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

// Rota principal - serve o HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check melhorado
app.get('/health', (req, res) => {
  const memoryUsage = process.memoryUsage();
  
  res.json({ 
    status: 'OK', 
    service: 'Caixa dÁgua WebSocket',
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    uptime: Math.floor(process.uptime()),
    memory: {
      used: Math.round(memoryUsage.heapUsed / 1024 / 1024) + ' MB',
      total: Math.round(memoryUsage.heapTotal / 1024 / 1024) + ' MB'
    },
    connections: {
      total: clients.size,
      esp32: esp32Client ? 1 : 0,
      web: Array.from(clients.values()).filter(client => client !== esp32Client).length
    },
    metrics: {
      ...metrics,
      historicalDataPoints: historicalData.length
    },
    config: {
      health_check_interval: `${HEALTH_CHECK_INTERVAL / 60000} minutos`,
      rate_limit: `${MAX_REQUESTS_PER_MINUTE} req/minuto`,
      token_configured: !!ESP32_TOKEN,
      disconnection_timeout: `${DISCONNECTION_TIMEOUT/1000} segundos`
    },
    render_keepalive: 'ACTIVE'
  });
});

// 🎯 NOVA ROTA PARA PING SIMPLES (mais leve)
app.get('/ping', (req, res) => {
  res.json({ 
    status: 'pong', 
    timestamp: new Date().toISOString(),
    service: 'active',
    environment: NODE_ENV
  });
});

// 🎯 NOVA ROTA PARA MÉTRICAS
app.get('/metrics', (req, res) => {
  const uptimeMinutes = process.uptime() / 60;
  
  res.json({
    ...metrics,
    averageMessageRate: metrics.messagesReceived / uptimeMinutes,
    historicalDataPoints: historicalData.length,
    rateLimitSize: rateLimit.size,
    environment: NODE_ENV
  });
});

// 🎯 NOVA ROTA PARA DADOS HISTÓRICOS
app.get('/historical-data', (req, res) => {
  const { hours = 24 } = req.query;
  const cutoffTime = new Date(Date.now() - (hours * 60 * 60 * 1000));
  
  const filteredData = historicalData.filter(entry => 
    new Date(entry.timestamp) >= cutoffTime
  );
  
  res.json({
    success: true,
    data: filteredData,
    total: filteredData.length,
    timeRange: `${hours} horas`,
    environment: NODE_ENV
  });
});

// 🎯 NOVA ROTA PARA CONFIGURAÇÃO DO SISTEMA
app.get('/config', (req, res) => {
  res.json({
    success: true,
    config: {
      environment: NODE_ENV,
      port: PORT,
      health_check: {
        url: HEALTH_CHECK_URL,
        interval: `${HEALTH_CHECK_INTERVAL / 60000} minutos`
      },
      security: {
        token_configured: !!ESP32_TOKEN,
        rate_limit: MAX_REQUESTS_PER_MINUTE,
        disconnection_timeout: `${DISCONNECTION_TIMEOUT/1000} segundos`
      },
      server: {
        uptime: Math.floor(process.uptime()),
        node_version: process.version,
        platform: process.platform
      }
    }
  });
});

// WebSocket connection
wss.on('connection', function connection(ws, req) {
  const clientId = generateClientId(req);
  const clientIP = getClientIP(req);
  const isESP32 = isESP32Connection(req, clientIP);
  
  console.log(`✅ Nova conexão: ${clientId} - IP: ${clientIP} - Tipo: ${isESP32 ? 'ESP32' : 'WEB'} - Ambiente: ${NODE_ENV}`);
  
  clients.set(clientId, ws);
  ws.clientId = clientId;
  ws.clientIP = clientIP;
  ws.isESP32 = isESP32;
  ws.connectedAt = new Date();
  
  // 🎯 ATUALIZADO: Detectar se é o ESP32 com autenticação
  if (isESP32) {
    const authenticated = authenticateESP32(req);
    if (!authenticated) {
      console.log(`❌ Tentativa de conexão ESP32 não autenticada: ${clientId}`);
      ws.close(1008, 'Autenticação falhou');
      clients.delete(clientId);
      return;
    }
    
    // Se já tem um ESP32 conectado, fechar a conexão anterior
    if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
      console.log(`🔄 Substituindo ESP32 anterior: ${esp32Client.clientId}`);
      
      // Notificar sobre a substituição
      broadcastToWebClients({
        type: 'esp32_connection_change',
        message: 'Novo ESP32 conectado - Substituindo anterior',
        oldClientId: esp32Client.clientId,
        newClientId: clientId,
        timestamp: new Date().toISOString(),
        environment: NODE_ENV
      });
      
      esp32Client.close(1000, 'Novo ESP32 conectado');
      metrics.esp32Reconnects++;
      
      // Limpar heartbeat do anterior
      if (clientHeartbeats.has(esp32Client.clientId)) {
        clearInterval(clientHeartbeats.get(esp32Client.clientId).heartbeatInterval);
        clientHeartbeats.delete(esp32Client.clientId);
      }
    }
    
    esp32Client = ws;
    console.log(`🎯 ESP32 registrado: ${clientId}`);
    
    // 🎯 NOVO: Iniciar sistema de heartbeat para este ESP32
    setupESP32Heartbeat(clientId, ws);
    
    // Notificar todos os clientes web que o ESP32 conectou
    broadcastToWebClients({
      type: 'esp32_connected',
      message: 'ESP32 conectado',
      clientId: clientId,
      timestamp: new Date().toISOString(),
      environment: NODE_ENV
    });
  } else {
    metrics.webClientsConnected++;
  }
  
  // Enviar confirmação de conexão
  const welcomeMessage = {
    type: 'connected',
    message: 'Conectado ao servidor WebSocket',
    clientId: clientId,
    isESP32: isESP32,
    timestamp: new Date().toISOString(),
    environment: NODE_ENV
  };
  
  sendToClient(ws, welcomeMessage);
  
  // Mensagens do cliente
  ws.on('message', function message(data) {
    try {
      const messageString = data.toString();
      metrics.messagesReceived++;
      
      // 🎯 ATUALIZADO: Atualizar heartbeat do ESP32 quando receber mensagem
      if (ws.isESP32) {
        updateESP32Heartbeat(ws.clientId);
      }
      
      // 🎯 ATUALIZADO: Tentar detectar se é ESP32 pela mensagem com autenticação
      if (!ws.isESP32 && isESP32Message(messageString)) {
        console.log(`🎯 Detectado ESP32 pela mensagem: ${clientId}`);
        
        // Verificar autenticação na mensagem
        try {
          const parsedMsg = JSON.parse(messageString);
          if (parsedMsg.token !== ESP32_TOKEN) {
            console.log(`❌ ESP32 não autenticado pela mensagem: ${clientId}`);
            ws.close(1008, 'Token inválido');
            return;
          }
        } catch (e) {
          console.log(`❌ Mensagem ESP32 sem token válido: ${clientId}`);
          ws.close(1008, 'Autenticação necessária');
          return;
        }
        
        ws.isESP32 = true;
        
        if (esp32Client && esp32Client !== ws) {
          esp32Client.close(1000, 'Novo ESP32 detectado');
          metrics.esp32Reconnects++;
        }
        esp32Client = ws;
        
        // 🎯 NOVO: Iniciar heartbeat para ESP32 detectado
        setupESP32Heartbeat(clientId, ws);
      }
      
      // Tentar parsear como JSON primeiro (mensagens do ESP32)
      try {
        const parsedMessage = JSON.parse(messageString);
        handleWebSocketMessage(ws, parsedMessage);
      } catch (jsonError) {
        // Se não for JSON, tratar como comando de texto (do frontend)
        handleTextCommand(ws, messageString);
      }
    } catch (error) {
      console.error(`❌ Erro ao processar mensagem de ${clientId}:`, error);
      metrics.errors++;
    }
  });
  
  ws.on('close', function close(code, reason) {
    console.log(`❌ Conexão fechada: ${clientId} - Código: ${code} - Motivo: ${reason || 'Nenhum'} - Ambiente: ${NODE_ENV}`);
    
    if (esp32Client === ws) {
      console.log('🎯 ESP32 desconectado');
      esp32Client = null;
      metrics.esp32Disconnections++;
      
      // Limpar heartbeat
      if (clientHeartbeats.has(clientId)) {
        clearInterval(clientHeartbeats.get(clientId).heartbeatInterval);
        clientHeartbeats.delete(clientId);
      }
      
      // Notificar todos os clientes web que o ESP32 desconectou
      broadcastToWebClients({
        type: 'esp32_disconnected',
        message: 'ESP32 desconectado',
        clientId: clientId,
        reason: 'connection_closed',
        code: code,
        timestamp: new Date().toISOString(),
        environment: NODE_ENV
      });
    } else {
      metrics.webClientsConnected = Math.max(0, metrics.webClientsConnected - 1);
    }
    
    clients.delete(clientId);
    logConnectionStats();
  });
  
  ws.on('error', function error(err) {
    console.error(`❌ Erro WebSocket ${clientId}:`, err.message);
    metrics.errors++;
  });
  
  // Log estatísticas de conexão
  logConnectionStats();
});

// 🎯 NOVA FUNÇÃO: Autenticação ESP32
function authenticateESP32(req) {
  // Verificar token no header Authorization
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    return token === ESP32_TOKEN;
  }
  
  // Verificar token no query parameter
  const url = require('url');
  const parsedUrl = url.parse(req.url, true);
  const tokenParam = parsedUrl.query.token;
  if (tokenParam) {
    return tokenParam === ESP32_TOKEN;
  }
  
  // Para desenvolvimento, permitir sem token se não estiver em produção
  if (NODE_ENV !== 'production') {
    console.log('⚠️  Modo desenvolvimento: Autenticação ESP32 bypassada');
    return true;
  }
  
  return false;
}

// 🎯 NOVA FUNÇÃO: Rate limiting
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

// 🎯 NOVA FUNÇÃO: Salvar dados históricos
function saveSensorData(data) {
  const dataPoint = {
    timestamp: new Date().toISOString(),
    liters: data.liters,
    percentage: data.percentage,
    consumption: data.consumo_hoje,
    distance: data.distance,
    environment: NODE_ENV
  };
  
  historicalData.push(dataPoint);
  
  // Manter apenas últimas 48h (aproximadamente 2880 pontos se enviar a cada minuto)
  if (historicalData.length > 2880) {
    historicalData.shift();
  }
}

// CORREÇÃO CRÍTICA: Detectar se é conexão do ESP32
function isESP32Connection(req, clientIP) {
  const userAgent = req.headers['user-agent'] || '';
  
  // ESP32 geralmente não envia User-Agent ou envia string específica
  const isESP = userAgent.includes('ESP32') || 
                userAgent.includes('Arduino') ||
                userAgent.includes('WiFiClient') ||
                userAgent === '' || // ESP32 muitas vezes não envia User-Agent
                userAgent.includes('ESP8266') ||
                // Nova detecção: verificar por padrão de IP ou origem
                req.headers['origin'] === '' || // ESP32 não envia origin
                clientIP.includes('192.168.') || // IP local comum do ESP32
                clientIP.includes('10.0.') || // Outro IP local
                req.headers['sec-websocket-protocol'] === 'arduino';
  
  console.log(`🔍 Detecção ESP32 - UserAgent: "${userAgent}", Origin: "${req.headers['origin']}", IP: ${clientIP}, Resultado: ${isESP}`);
  return isESP;
}

// CORREÇÃO CRÍTICA: Detectar ESP32 pelo conteúdo da mensagem
function isESP32Message(message) {
  // Verificar se a mensagem contém padrões típicos do ESP32
  return message.includes('"type":"all_data"') ||
         message.includes('"type":"status"') ||
         message.includes('"distance":') ||
         message.includes('"liters":') ||
         message.includes('"percentage":') ||
         (message.startsWith('{') && message.includes('sensor_ok'));
}

// Gerar ID único para cliente
function generateClientId(req) {
  const isESP32 = isESP32Connection(req, getClientIP(req));
  const prefix = isESP32 ? 'ESP32' : 'WEB';
  const timestamp = Date.now();
  const random = Math.random().toString(36).substr(2, 9);
  return `${prefix}_${timestamp}_${random}`;
}

// Obter IP do cliente
function getClientIP(req) {
  return req.headers['x-forwarded-for'] || 
         req.headers['x-real-ip'] ||
         req.connection.remoteAddress || 
         req.socket.remoteAddress ||
         (req.connection.socket ? req.connection.socket.remoteAddress : 'unknown');
}

// Processar mensagens JSON (do ESP32)
function handleWebSocketMessage(ws, message) {
  const clientInfo = `${ws.clientId} (${ws.clientIP})`;
  
  // 🎯 ATUALIZADO: Salvar dados históricos para mensagens de sensor
  if (message.type === 'all_data' || message.type === 'status') {
    saveSensorData(message);
  }
  
  // Adicionar metadados à mensagem
  const enhancedMessage = {
    ...message,
    clientId: ws.clientId,
    origin: ws.isESP32 ? 'esp32' : 'web',
    timestamp: new Date().toISOString(),
    serverTime: Date.now(),
    environment: NODE_ENV
  };
  
  console.log(`📨 ${clientInfo} - ${message.type} - Ambiente: ${NODE_ENV}`);
  
  // Log específico para dados importantes
  if (message.type === 'all_data') {
    console.log(`💧 Dados: ${message.liters}L (${message.percentage}%) | Consumo H: ${message.consumo_hora}L D: ${message.consumo_hoje}L`);
  } else if (message.type === 'status') {
    console.log(`📊 Status: WiFi ${message.wifi_connected ? '✅' : '❌'} | Sensor ${message.sensor_ok ? '✅' : '❌'} | Mem: ${message.free_memory}`);
  }
  
  // CORREÇÃO: Se a mensagem é do ESP32, retransmitir para todos os clientes web
  if (ws.isESP32) {
    broadcastToWebClients(enhancedMessage);
  } else {
    // Se é do frontend e temos ESP32, repassar para o ESP32
    if (esp32Client && esp32Client.readyState === WebSocket.OPEN && esp32Client !== ws) {
      // Remover metadados antes de enviar para ESP32
      const { clientId, origin, timestamp, serverTime, environment, ...cleanMessage } = enhancedMessage;
      sendToClient(esp32Client, cleanMessage);
      metrics.messagesSent++;
    } else if (!esp32Client) {
      // CORREÇÃO: Se não há ESP32, responder ao frontend
      sendToClient(ws, {
        type: 'error',
        message: 'ESP32 não conectado',
        timestamp: new Date().toISOString(),
        environment: NODE_ENV
      });
    }
  }
}

// Processar comandos de texto (do frontend)
function handleTextCommand(ws, command) {
  console.log(`📤 Comando de ${ws.clientId}: ${command} - Ambiente: ${NODE_ENV}`);
  
  // CORREÇÃO: Comandos que não precisam do ESP32
  if (command === 'get_status' || command === 'health') {
    const statusMessage = {
      type: 'server_status',
      clients: clients.size,
      esp32Connected: !!esp32Client,
      timestamp: new Date().toISOString(),
      environment: NODE_ENV,
      metrics: metrics
    };
    return sendToClient(ws, statusMessage);
  }
  
  // Se o comando precisa do ESP32
  if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
    console.log(`🔄 Repassando comando para ESP32: ${command}`);
    esp32Client.send(command);
    metrics.messagesSent++;
    
    // Confirmar para o frontend
    sendToClient(ws, {
      type: 'command_ack',
      command: command,
      status: 'sent_to_esp32',
      timestamp: new Date().toISOString(),
      environment: NODE_ENV
    });
  } else {
    // CORREÇÃO MELHORADA: Avisar frontend que ESP32 não está conectado
    sendToClient(ws, {
      type: 'error',
      message: 'ESP32 não conectado',
      command: command,
      timestamp: new Date().toISOString(),
      environment: NODE_ENV
    });
    console.log('⚠️ Comando ignorado - ESP32 não conectado:', command);
  }
}

// ====== FUNÇÕES AUXILIARES ======

// Enviar mensagem para um cliente específico
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

// Transmitir para todos os clientes web (exceto ESP32)
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
    console.log(`📡 Mensagem ${message.type} transmitida para ${sentCount} cliente(s) web - Ambiente: ${NODE_ENV}`);
  }
}

// Log estatísticas de conexão
function logConnectionStats() {
  const webClients = Array.from(clients.values()).filter(client => !client.isESP32).length;
  console.log(`📊 Estatísticas: Total: ${clients.size} | ESP32: ${esp32Client ? 1 : 0} | Web: ${webClients} | Ambiente: ${NODE_ENV}`);
}

// ====== API REST ======

// Status do sistema
app.get('/status', (req, res) => {
  const webClients = Array.from(clients.values()).filter(client => !client.isESP32);
  
  res.json({
    status: 'operational',
    serverTime: new Date().toISOString(),
    environment: NODE_ENV,
    uptime: Math.floor(process.uptime()),
    memory: process.memoryUsage(),
    metrics: metrics,
    connections: {
      total: clients.size,
      esp32: esp32Client ? {
        connected: true,
        clientId: esp32Client.clientId,
        ip: esp32Client.clientIP,
        connectedAt: esp32Client.connectedAt
      } : { connected: false },
      web: webClients.map(client => ({
        clientId: client.clientId,
        ip: client.clientIP,
        connectedAt: client.connectedAt
      }))
    }
  });
});

// Listar clientes conectados
app.get('/clients', (req, res) => {
  const clientList = Array.from(clients.entries()).map(([id, ws]) => ({
    id,
    ip: ws.clientIP,
    type: ws.isESP32 ? 'ESP32' : 'WEB',
    connected: ws.readyState === WebSocket.OPEN,
    connectedAt: ws.connectedAt,
    isActiveESP32: ws === esp32Client
  }));
  
  res.json({ 
    clients: clientList, 
    total: clientList.length,
    esp32Connected: !!esp32Client,
    environment: NODE_ENV
  });
});

// Enviar comando para ESP32 via HTTP
app.post('/command/:command', express.json(), (req, res) => {
  const { command } = req.params;
  
  if (!esp32Client || esp32Client.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ 
      success: false, 
      message: 'ESP32 não conectado',
      command: command,
      environment: NODE_ENV
    });
  }
  
  try {
    esp32Client.send(command);
    metrics.messagesSent++;
    console.log(`📤 Comando HTTP enviado: ${command} - Ambiente: ${NODE_ENV}`);
    
    res.json({ 
      success: true, 
      message: `Comando enviado para ESP32`,
      command: command,
      timestamp: new Date().toISOString(),
      environment: NODE_ENV
    });
  } catch (error) {
    console.error('❌ Erro ao enviar comando:', error);
    metrics.errors++;
    res.status(500).json({ 
      success: false, 
      message: 'Erro ao enviar comando',
      error: error.message,
      environment: NODE_ENV
    });
  }
});

// Reset de consumo via API
app.post('/consumo/reset', (req, res) => {
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
    console.log('🔄 Comando de reset de consumo enviado via API');
    
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

// Informações do sistema
app.get('/system/info', (req, res) => {
  res.json({
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    environment: NODE_ENV,
    metrics: metrics
  });
});

// Middleware de erro
app.use((error, req, res, next) => {
  console.error('❌ Erro no servidor:', error);
  metrics.errors++;
  res.status(500).json({ 
    success: false, 
    message: 'Erro interno do servidor',
    error: NODE_ENV === 'production' ? 'Internal error' : error.message,
    environment: NODE_ENV
  });
});

// Rota 404
app.use('*', (req, res) => {
  res.status(404).json({ 
    success: false, 
    message: 'Rota não encontrada',
    path: req.originalUrl,
    environment: NODE_ENV
  });
});

// 🎯 FUNÇÃO DE HEALTH CHECK
async function healthCheck() {
    try {
        const response = await axios.get(HEALTH_CHECK_URL);
        console.log(`✅ Health check realizado: ${response.status} - ${new Date().toLocaleTimeString('pt-BR')} - Ambiente: ${NODE_ENV}`);
    } catch (error) {
        console.log(`❌ Erro no health check: ${error.message} - Ambiente: ${NODE_ENV}`);
        metrics.errors++;
    }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🌐 Ambiente: ${NODE_ENV}`);
  console.log(`📊 Health: http://localhost:${PORT}/health`);
  console.log(`📋 Status: http://localhost:${PORT}/status`);
  console.log(`🔧 Config: http://localhost:${PORT}/config`);
  console.log(`🎯 Aguardando conexões ESP32 e Web...`);
  console.log(`🔐 Token ESP32: ${ESP32_TOKEN}`);
  console.log(`💓 Sistema de heartbeat ativo: ${DISCONNECTION_TIMEOUT/1000}s timeout`);
  
  // 🎯 INICIAR HEALTH CHECK AUTOMÁTICO
  console.log(`🔄 Health Check configurado a cada ${HEALTH_CHECK_INTERVAL / 60000} minutos`);
  setInterval(healthCheck, HEALTH_CHECK_INTERVAL);
  healthCheck(); // Executar imediatamente
});

// Heartbeat para manter conexões ativas
setInterval(() => {
  if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
    try {
      esp32Client.ping();
    } catch (error) {
      console.error('❌ Erro no heartbeat do ESP32:', error.message);
      metrics.errors++;
    }
  }
}, 30000);

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
    console.log(`🧹 Limpeza: ${cleanedCount} cliente(s) removido(s) - Ambiente: ${NODE_ENV}`);
  }
}, 60000);

// 🎯 NOVO: Limpeza periódica do rate limit
setInterval(() => {
  const now = Date.now();
  const windowStart = now - 120000; // 2 minutos
  
  rateLimit.forEach((requests, ip) => {
    const filteredRequests = requests.filter(time => time > windowStart);
    if (filteredRequests.length === 0) {
      rateLimit.delete(ip);
    } else {
      rateLimit.set(ip, filteredRequests);
    }
  });
}, 60000); // A cada minuto

// Graceful shutdown
function gracefulShutdown(signal) {
  console.log(`\n🔄 Recebido ${signal}, encerrando servidor... - Ambiente: ${NODE_ENV}`);
  
  // Fechar todas as conexões WebSocket
  clients.forEach((client, id) => {
    client.close(1000, 'Servidor sendo encerrado');
  });
  
  server.close(() => {
    console.log('✅ Servidor encerrado com sucesso');
    process.exit(0);
  });
  
  // Force close após 10 segundos
  setTimeout(() => {
    console.log('❌ Forçando encerramento...');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Log inicial
console.log('✅ Servidor WebSocket inicializado com sucesso!');
console.log('🎯 Sistema de notificação de desconexão ATIVADO!');
