const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: false // Melhor para ESP32
});

// Armazenar conexões
const clients = new Map();
let esp32Client = null; // Cliente ESP32 específico

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
  res.json({ 
    status: 'OK', 
    service: 'Caixa dÁgua WebSocket',
    connectedClients: clients.size,
    esp32Connected: !!esp32Client,
    webClients: clients.size - (esp32Client ? 1 : 0),
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// WebSocket connection
wss.on('connection', function connection(ws, req) {
  const clientId = generateClientId(req);
  console.log(`✅ Nova conexão: ${clientId} - IP: ${getClientIP(req)}`);
  
  clients.set(clientId, ws);
  ws.clientId = clientId;
  
  // Detectar se é o ESP32 (baseado no user-agent ou padrão de mensagens)
  if (isESP32Connection(req)) {
    esp32Client = ws;
    console.log(`🎯 ESP32 identificado: ${clientId}`);
  }
  
  // Enviar confirmação
  ws.send(JSON.stringify({
    type: 'connected',
    message: 'Conectado ao servidor',
    clientId: clientId,
    isESP32: esp32Client === ws
  }));
  
  // Mensagens do ESP32 ou Web
  ws.on('message', function message(data) {
    try {
      // Tentar parsear como JSON (mensagens do ESP32)
      try {
        const message = JSON.parse(data.toString());
        handleWebSocketMessage(ws, message);
      } catch (jsonError) {
        // Se não for JSON, tratar como comando de texto (do frontend)
        handleTextCommand(ws, data.toString());
      }
    } catch (error) {
      console.error('❌ Erro ao processar mensagem:', error);
    }
  });
  
  ws.on('close', function close() {
    console.log(`❌ Conexão fechada: ${clientId}`);
    if (esp32Client === ws) {
      console.log('🎯 ESP32 desconectado');
      esp32Client = null;
    }
    clients.delete(clientId);
  });
  
  ws.on('error', function error(err) {
    console.error(`❌ Erro ${clientId}:`, err);
    if (esp32Client === ws) {
      esp32Client = null;
    }
    clients.delete(clientId);
  });
});

// Gerar ID único para cliente
function generateClientId(req) {
  const isESP32 = isESP32Connection(req);
  const prefix = isESP32 ? 'ESP32' : 'WEB';
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Detectar se é conexão do ESP32
function isESP32Connection(req) {
  const userAgent = req.headers['user-agent'] || '';
  return userAgent.includes('ESP32') || 
         req.url.includes('esp32') || 
         userAgent.includes('Arduino');
}

// Obter IP do cliente
function getClientIP(req) {
  return req.headers['x-forwarded-for'] || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress ||
         (req.connection.socket ? req.connection.socket.remoteAddress : null);
}

// Processar mensagens JSON (do ESP32)
function handleWebSocketMessage(ws, message) {
  console.log(`📨 ${ws.clientId} - ${message.type}:`, message);
  
  // Adicionar timestamp e origem
  const enhancedMessage = {
    ...message,
    clientId: ws.clientId,
    timestamp: new Date().toISOString(),
    origin: esp32Client === ws ? 'esp32' : 'web'
  };
  
  // Retransmitir para TODOS os clientes web (exceto o próprio ESP32)
  clients.forEach((client, id) => {
    if (client.readyState === WebSocket.OPEN && client !== ws) {
      try {
        client.send(JSON.stringify(enhancedMessage));
      } catch (error) {
        console.error(`❌ Erro ao enviar para ${id}:`, error);
      }
    }
  });
  
  // Log específico para dados importantes
  if (message.type === 'all_data') {
    console.log(`💧 Dados Caixa: ${message.liters}L (${message.percentage}%) - Consumo H: ${message.consumo_hora}L D: ${message.consumo_hoje}L`);
  } else if (message.type === 'status') {
    console.log(`📊 Status: WiFi ${message.wifi_connected ? '✅' : '❌'} | Sensor ${message.sensor_ok ? '✅' : '❌'} | Mem: ${message.free_memory}`);
  }
}

// Processar comandos de texto (do frontend)
function handleTextCommand(ws, command) {
  console.log(`📤 Comando de ${ws.clientId}: ${command}`);
  
  // Se o comando vem do frontend e temos ESP32 conectado, repassar
  if (esp32Client && esp32Client.readyState === WebSocket.OPEN && ws !== esp32Client) {
    console.log(`🔄 Repassando comando para ESP32: ${command}`);
    esp32Client.send(command);
    
    // Confirmar para o frontend
    ws.send(JSON.stringify({
      type: 'command_ack',
      command: command,
      status: 'sent_to_esp32',
      timestamp: new Date().toISOString()
    }));
  } else if (!esp32Client && command !== 'get_data') {
    // Avisar frontend que ESP32 não está conectado
    ws.send(JSON.stringify({
      type: 'error',
      message: 'ESP32 não conectado',
      command: command,
      timestamp: new Date().toISOString()
    }));
    console.log('⚠️ Comando ignorado - ESP32 não conectado');
  }
}

// ====== API PARA COMANDOS E CONFIGURAÇÕES ======

// Enviar comando para ESP32
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

// Configurações do sistema
app.post('/config', express.json(), (req, res) => {
  const { altura, volume, fator, distancia } = req.body;
  
  if (!esp32Client || esp32Client.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ 
      success: false, 
      message: 'ESP32 não conectado' 
    });
  }
  
  const configCommand = `config:altura=${altura}&volume=${volume}&fator=${fator}&distancia=${distancia}`;
  
  try {
    esp32Client.send(configCommand);
    console.log(`⚙️ Configuração enviada: ${configCommand}`);
    res.json({ 
      success: true, 
      message: 'Configuração enviada para ESP32',
      config: { altura, volume, fator, distancia },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Erro ao enviar configuração:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erro ao enviar configuração',
      error: error.message 
    });
  }
});

// Listar clientes conectados
app.get('/clients', (req, res) => {
  const clientList = Array.from(clients.entries()).map(([id, ws]) => ({
    id,
    connected: ws.readyState === WebSocket.OPEN,
    type: id.startsWith('ESP32') ? 'ESP32' : 'WEB',
    isActiveESP32: ws === esp32Client
  }));
  
  res.json({ 
    clients: clientList, 
    total: clientList.length,
    esp32Connected: !!esp32Client,
    activeESP32: esp32Client ? esp32Client.clientId : null
  });
});

// Status do sistema
app.get('/status', (req, res) => {
  res.json({
    status: 'operational',
    serverTime: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    connections: {
      total: clients.size,
      esp32: esp32Client ? 1 : 0,
      web: clients.size - (esp32Client ? 1 : 0)
    },
    environment: {
      node: process.version,
      platform: process.platform,
      port: process.env.PORT || 3000
    }
  });
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
    console.log('🔄 Comando de reset de consumo enviado');
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

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🔄 Recebido SIGTERM, encerrando servidor...');
  server.close(() => {
    console.log('✅ Servidor encerrado');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🔄 Recebido SIGINT, encerrando servidor...');
  server.close(() => {
    console.log('✅ Servidor encerrado');
    process.exit(0);
  });
});
