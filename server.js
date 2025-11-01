const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: false,
  clientTracking: true
});

// Armazenar conexões
const clients = new Map();
let esp32Client = null;

// Middleware para CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

app.use(express.json());
app.use(express.static('public'));

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
    uptime: Math.floor(process.uptime()),
    memory: {
      used: Math.round(memoryUsage.heapUsed / 1024 / 1024) + ' MB',
      total: Math.round(memoryUsage.heapTotal / 1024 / 1024) + ' MB'
    },
    connections: {
      total: clients.size,
      esp32: esp32Client ? 1 : 0,
      web: Array.from(clients.values()).filter(client => client !== esp32Client).length
    }
  });
});

// WebSocket connection
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
  
  // CORREÇÃO CRÍTICA: Detectar se é o ESP32
  if (isESP32) {
    // Se já tem um ESP32 conectado, fechar a conexão anterior
    if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
      console.log(`🔄 Substituindo ESP32 anterior: ${esp32Client.clientId}`);
      esp32Client.close(1000, 'Novo ESP32 conectado');
    }
    esp32Client = ws;
    console.log(`🎯 ESP32 registrado: ${clientId}`);
    
    // Notificar todos os clientes web que o ESP32 conectou
    broadcastToWebClients({
      type: 'esp32_connected',
      message: 'ESP32 conectado',
      clientId: clientId,
      timestamp: new Date().toISOString()
    });
  }
  
  // Enviar confirmação de conexão
  const welcomeMessage = {
    type: 'connected',
    message: 'Conectado ao servidor WebSocket',
    clientId: clientId,
    isESP32: isESP32,
    timestamp: new Date().toISOString()
  };
  
  sendToClient(ws, welcomeMessage);
  
  // Mensagens do cliente
  ws.on('message', function message(data) {
    try {
      const messageString = data.toString();
      
      // CORREÇÃO: Tentar detectar se é ESP32 pela mensagem
      if (!ws.isESP32 && isESP32Message(messageString)) {
        console.log(`🎯 Detectado ESP32 pela mensagem: ${clientId}`);
        ws.isESP32 = true;
        
        if (esp32Client && esp32Client !== ws) {
          esp32Client.close(1000, 'Novo ESP32 detectado');
        }
        esp32Client = ws;
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
    }
  });
  
  ws.on('close', function close(code, reason) {
    console.log(`❌ Conexão fechada: ${clientId} - Código: ${code} - Motivo: ${reason || 'Nenhum'}`);
    
    if (esp32Client === ws) {
      console.log('🎯 ESP32 desconectado');
      esp32Client = null;
      
      // Notificar todos os clientes web que o ESP32 desconectou
      broadcastToWebClients({
        type: 'esp32_disconnected',
        message: 'ESP32 desconectado',
        timestamp: new Date().toISOString()
      });
    }
    
    clients.delete(clientId);
    logConnectionStats();
  });
  
  ws.on('error', function error(err) {
    console.error(`❌ Erro WebSocket ${clientId}:`, err.message);
  });
  
  // Log estatísticas de conexão
  logConnectionStats();
});

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
  
  // Adicionar metadados à mensagem
  const enhancedMessage = {
    ...message,
    clientId: ws.clientId,
    origin: ws.isESP32 ? 'esp32' : 'web',
    timestamp: new Date().toISOString(),
    serverTime: Date.now()
  };
  
  console.log(`📨 ${clientInfo} - ${message.type}`);
  
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
      const { clientId, origin, timestamp, serverTime, ...cleanMessage } = enhancedMessage;
      sendToClient(esp32Client, cleanMessage);
    } else if (!esp32Client) {
      // CORREÇÃO: Se não há ESP32, responder ao frontend
      sendToClient(ws, {
        type: 'error',
        message: 'ESP32 não conectado',
        timestamp: new Date().toISOString()
      });
    }
  }
}

// Processar comandos de texto (do frontend)
function handleTextCommand(ws, command) {
  console.log(`📤 Comando de ${ws.clientId}: ${command}`);
  
  // CORREÇÃO: Comandos que não precisam do ESP32
  if (command === 'get_status' || command === 'health') {
    const statusMessage = {
      type: 'server_status',
      clients: clients.size,
      esp32Connected: !!esp32Client,
      timestamp: new Date().toISOString()
    };
    return sendToClient(ws, statusMessage);
  }
  
  // Se o comando precisa do ESP32
  if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
    console.log(`🔄 Repassando comando para ESP32: ${command}`);
    esp32Client.send(command);
    
    // Confirmar para o frontend
    sendToClient(ws, {
      type: 'command_ack',
      command: command,
      status: 'sent_to_esp32',
      timestamp: new Date().toISOString()
    });
  } else {
    // CORREÇÃO MELHORADA: Avisar frontend que ESP32 não está conectado
    sendToClient(ws, {
      type: 'error',
      message: 'ESP32 não conectado',
      command: command,
      timestamp: new Date().toISOString()
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
    } catch (error) {
      console.error(`❌ Erro ao enviar para ${client.clientId}:`, error.message);
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
      } catch (error) {
        console.error(`❌ Erro ao transmitir para ${id}:`, error.message);
      }
    }
  });
  
  if (sentCount > 0) {
    console.log(`📡 Mensagem ${message.type} transmitida para ${sentCount} cliente(s) web`);
  }
}

// Log estatísticas de conexão
function logConnectionStats() {
  const webClients = Array.from(clients.values()).filter(client => !client.isESP32).length;
  console.log(`📊 Estatísticas: Total: ${clients.size} | ESP32: ${esp32Client ? 1 : 0} | Web: ${webClients}`);
}

// ====== API REST ======

// Status do sistema
app.get('/status', (req, res) => {
  const webClients = Array.from(clients.values()).filter(client => !client.isESP32);
  
  res.json({
    status: 'operational',
    serverTime: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    memory: process.memoryUsage(),
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
    esp32Connected: !!esp32Client
  });
});

// Enviar comando para ESP32 via HTTP
app.post('/command/:command', express.json(), (req, res) => {
  const { command } = req.params;
  
  if (!esp32Client || esp32Client.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ 
      success: false, 
      message: 'ESP32 não conectado',
      command: command 
    });
  }
  
  try {
    esp32Client.send(command);
    console.log(`📤 Comando HTTP enviado: ${command}`);
    
    res.json({ 
      success: true, 
      message: `Comando enviado para ESP32`,
      command: command,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Erro ao enviar comando:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erro ao enviar comando',
      error: error.message 
    });
  }
});

// Reset de consumo via API
app.post('/consumo/reset', (req, res) => {
  if (!esp32Client || esp32Client.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ 
      success: false, 
      message: 'ESP32 não conectado' 
    });
  }
  
  try {
    esp32Client.send('reset_consumo');
    console.log('🔄 Comando de reset de consumo enviado via API');
    
    res.json({ 
      success: true, 
      message: 'Reset de consumo enviado para ESP32',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Erro ao enviar reset:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erro ao enviar comando de reset',
      error: error.message 
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
    env: process.env.NODE_ENV || 'development'
  });
});

// Middleware de erro
app.use((error, req, res, next) => {
  console.error('❌ Erro no servidor:', error);
  res.status(500).json({ 
    success: false, 
    message: 'Erro interno do servidor',
    error: process.env.NODE_ENV === 'production' ? 'Internal error' : error.message
  });
});

// Rota 404
app.use('*', (req, res) => {
  res.status(404).json({ 
    success: false, 
    message: 'Rota não encontrada',
    path: req.originalUrl 
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🌐 Acesse: http://localhost:${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/health`);
  console.log(`📋 Status: http://localhost:${PORT}/status`);
  console.log(`🎯 Aguardando conexões ESP32 e Web...`);
});

// Heartbeat para manter conexões ativas
setInterval(() => {
  if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
    try {
      esp32Client.ping();
    } catch (error) {
      console.error('❌ Erro no heartbeat do ESP32:', error.message);
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
    console.log(`🧹 Limpeza: ${cleanedCount} cliente(s) removido(s)`);
  }
}, 60000);

// Graceful shutdown
function gracefulShutdown(signal) {
  console.log(`\n🔄 Recebido ${signal}, encerrando servidor...`);
  
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
