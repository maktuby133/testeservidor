require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

// Configurações
const PORT = process.env.PORT || 3000;
const WEBSOCKET_PORT = process.env.WEBSOCKET_PORT || 8080;
const NODE_ENV = process.env.NODE_ENV || 'development';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'esp32_token_secreto_2024';

// Inicializar Express
const app = express();
app.use(express.json());
app.use(express.static('public'));

// Middleware de logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Clientes conectados
const clients = new Map(); // deviceId -> WebSocket
let esp32Client = null;

// Métricas do sistema
const metrics = {
  connections: 0,
  messagesReceived: 0,
  messagesSent: 0,
  errors: 0,
  lastConnection: null
};

// ====== ROTAS HTTP ======

// Página principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Painel de configuração
app.get('/config', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'config_panel.html'));
});

// Status do sistema
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    metrics: {
      ...metrics,
      connectedClients: clients.size,
      esp32Connected: esp32Client ? 'connected' : 'disconnected'
    },
    environment: NODE_ENV,
    uptime: process.uptime()
  });
});

// Listar dispositivos conectados
app.get('/devices', (req, res) => {
  const deviceList = Array.from(clients.keys()).map(deviceId => ({
    deviceId,
    connected: true,
    lastSeen: metrics.lastConnection
  }));
  
  res.json({
    success: true,
    count: deviceList.length,
    devices: deviceList,
    esp32: esp32Client ? {
      connected: true,
      readyState: esp32Client.readyState
    } : { connected: false }
  });
});

// Enviar comando para ESP32
app.post('/send-command', express.json(), (req, res) => {
  const { command, deviceId = 'esp32' } = req.body;
  
  if (!command) {
    return res.status(400).json({ 
      success: false, 
      message: 'Comando não especificado' 
    });
  }
  
  let targetClient = null;
  
  if (deviceId === 'esp32') {
    targetClient = esp32Client;
  } else {
    targetClient = clients.get(deviceId);
  }
  
  if (!targetClient || targetClient.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ 
      success: false, 
      message: `Dispositivo ${deviceId} não conectado` 
    });
  }
  
  try {
    targetClient.send(command);
    metrics.messagesSent++;
    
    console.log(`📤 Comando enviado para ${deviceId}: ${command}`);
    
    res.json({ 
      success: true, 
      message: `Comando enviado para ${deviceId}`,
      command: command,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Erro ao enviar comando:', error);
    metrics.errors++;
    res.status(500).json({ 
      success: false, 
      message: 'Erro ao enviar comando',
      error: error.message 
    });
  }
});

// Teste do sensor (nova rota)
app.post('/test-sensor', express.json(), (req, res) => {
  const { test_type, duration = 10 } = req.body;
  
  if (!esp32Client || esp32Client.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ 
      success: false, 
      message: 'ESP32 não conectado',
      environment: NODE_ENV
    });
  }
  
  try {
    let command = '';
    switch(test_type) {
      case 'calibration':
        command = 'start_calibration';
        break;
      case 'stability':
        command = 'test_stability';
        break;
      case 'accuracy':
        command = 'test_accuracy';
        break;
      default:
        return res.status(400).json({
          success: false,
          message: 'Tipo de teste inválido'
        });
    }
    
    esp32Client.send(command);
    metrics.messagesSent++;
    
    console.log(`🔬 Teste de sensor iniciado: ${test_type} por ${duration}s`);
    
    res.json({ 
      success: true, 
      message: `Teste ${test_type} iniciado`,
      duration: duration,
      timestamp: new Date().toISOString(),
      environment: NODE_ENV
    });
  } catch (error) {
    console.error('❌ Erro ao iniciar teste:', error);
    metrics.errors++;
    res.status(500).json({ 
      success: false, 
      message: 'Erro ao iniciar teste',
      error: error.message,
      environment: NODE_ENV
    });
  }
});

// Ajuste de sensibilidade (nova rota)
app.post('/adjust-sensitivity', express.json(), (req, res) => {
  const { sensitivity } = req.body;
  
  if (!esp32Client || esp32Client.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ 
      success: false, 
      message: 'ESP32 não conectado',
      environment: NODE_ENV
    });
  }
  
  if (sensitivity < 5 || sensitivity > 50) {
    return res.status(400).json({
      success: false,
      message: 'Sensibilidade deve estar entre 5 e 50 litros'
    });
  }
  
  try {
    const command = `set_sensitivity:${sensitivity}`;
    esp32Client.send(command);
    metrics.messagesSent++;
    
    console.log(`🎯 Sensibilidade ajustada para: ${sensitivity}L`);
    
    res.json({ 
      success: true, 
      message: `Sensibilidade ajustada para ${sensitivity}L`,
      sensitivity: sensitivity,
      timestamp: new Date().toISOString(),
      environment: NODE_ENV
    });
  } catch (error) {
    console.error('❌ Erro ao ajustar sensibilidade:', error);
    metrics.errors++;
    res.status(500).json({ 
      success: false, 
      message: 'Erro ao ajustar sensibilidade',
      error: error.message,
      environment: NODE_ENV
    });
  }
});

// Últimos dados recebidos
app.get('/last-data', (req, res) => {
  const dataDir = path.join(__dirname, 'data');
  const files = fs.readdirSync(dataDir)
    .filter(file => file.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, 10);
  
  const lastData = files.map(file => {
    const content = fs.readFileSync(path.join(dataDir, file), 'utf8');
    return JSON.parse(content);
  });
  
  res.json({
    success: true,
    count: lastData.length,
    data: lastData
  });
});

// ====== WEBSOCKET SERVER ======

const wss = new WebSocket.Server({ port: WEBSOCKET_PORT });

wss.on('connection', (ws, req) => {
  const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  let deviceId = 'unknown';
  let authenticated = false;
  
  console.log(`🟢 Nova conexão WebSocket: ${clientId}`);
  metrics.connections++;
  metrics.lastConnection = new Date().toISOString();
  
  ws.on('message', (message) => {
    try {
      const data = message.toString();
      console.log(`📨 Mensagem recebida de ${clientId}:`, data.substring(0, 100));
      metrics.messagesReceived++;
      
      // Tentar parsear como JSON
      try {
        const jsonData = JSON.parse(data);
        
        // Autenticação
        if (jsonData.type === 'auth') {
          if (jsonData.token === AUTH_TOKEN) {
            authenticated = true;
            deviceId = jsonData.device || clientId;
            
            if (jsonData.device_type === 'LORA_RECEIVER' || jsonData.device === 'RECEPTOR_01') {
              esp32Client = ws;
              console.log(`✅ ESP32 Receptor autenticado: ${deviceId}`);
            } else {
              clients.set(deviceId, ws);
              console.log(`✅ Cliente autenticado: ${deviceId}`);
            }
            
            ws.send(JSON.stringify({
              type: 'auth_response',
              success: true,
              message: 'Autenticação bem-sucedida'
            }));
          } else {
            console.log(`❌ Token inválido de: ${clientId}`);
            ws.send(JSON.stringify({
              type: 'auth_response',
              success: false,
              message: 'Token de autenticação inválido'
            }));
            ws.close();
          }
          return;
        }
        
        // Se não está autenticado, rejeitar
        if (!authenticated) {
          console.log(`❌ Mensagem não autenticada de: ${clientId}`);
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Autenticação necessária'
          }));
          return;
        }
        
        // Processar dados do sensor
        if (jsonData.type === 'sensor_data' || jsonData.type === 'sensor_update') {
          console.log(`📊 Dados do sensor recebidos de ${deviceId}:`, {
            distance: jsonData.distance,
            liters: jsonData.liters,
            percentage: jsonData.percentage
          });
          
          // Salvar dados
          saveSensorData(jsonData);
          
          // Broadcast para outros clientes (exceto o remetente)
          wss.clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'sensor_update',
                device: deviceId,
                data: jsonData,
                timestamp: new Date().toISOString()
              }));
            }
          });
        }
        
        // Status do receptor
        if (jsonData.type === 'receiver_status') {
          console.log(`📡 Status do receptor ${deviceId}:`, {
            packets: jsonData.lora_packets_received,
            errors: jsonData.lora_packets_error
          });
        }
        
      } catch (jsonError) {
        // Se não for JSON, tratar como mensagem simples
        console.log(`📝 Mensagem simples de ${deviceId}: ${data}`);
        
        if (data === 'ping') {
          ws.send('pong');
        } else if (data.startsWith('set_sensitivity:')) {
          const sensitivity = data.split(':')[1];
          console.log(`🎯 Configuração de sensibilidade: ${sensitivity}L`);
        }
      }
      
    } catch (error) {
      console.error('❌ Erro ao processar mensagem:', error);
      metrics.errors++;
    }
  });
  
  ws.on('close', () => {
    console.log(`🔴 Conexão fechada: ${clientId}`);
    
    // Remover da lista de clientes
    if (deviceId !== 'unknown') {
      clients.delete(deviceId);
    }
    
    // Limpar ESP32 se for ele
    if (ws === esp32Client) {
      esp32Client = null;
      console.log('📡 ESP32 desconectado');
    }
    
    metrics.connections = Math.max(0, metrics.connections - 1);
  });
  
  ws.on('error', (error) => {
    console.error(`❌ Erro no WebSocket ${clientId}:`, error);
    metrics.errors++;
  });
  
  // Enviar mensagem de boas-vindas
  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Conectado ao servidor Caixa d\'Água Inteligente',
    server_time: new Date().toISOString(),
    requires_auth: true
  }));
});

// ====== FUNÇÕES AUXILIARES ======

function saveSensorData(data) {
  try {
    const dataDir = path.join(__dirname, 'data');
    
    // Criar diretório se não existir
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    // Adicionar timestamp
    const sensorData = {
      ...data,
      received_at: new Date().toISOString(),
      server_timestamp: Date.now()
    };
    
    // Salvar em arquivo
    const filename = `sensor_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.json`;
    const filepath = path.join(dataDir, filename);
    
    fs.writeFileSync(filepath, JSON.stringify(sensorData, null, 2));
    
    console.log(`💾 Dados salvos em: ${filename}`);
    
  } catch (error) {
    console.error('❌ Erro ao salvar dados:', error);
  }
}

// ====== INICIALIZAÇÃO ======

// Criar diretório de dados
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Iniciar servidor HTTP
app.listen(PORT, () => {
  console.log(`
🚀 SERVIDOR INICIADO!
=======================================
🌐 HTTP Server:  http://localhost:${PORT}
🔗 WebSocket:    ws://localhost:${WEBSOCKET_PORT}
🔐 Auth Token:   ${AUTH_TOKEN.substring(0, 10)}...
📁 Data Dir:     ${dataDir}
=======================================
📌 Rotas disponíveis:
   GET  /          → Painel principal
   GET  /config    → Painel de configuração
   GET  /health    → Status do sistema
   GET  /devices   → Dispositivos conectados
   GET  /last-data → Últimos dados
   POST /send-command → Enviar comando
   POST /test-sensor → Testar sensor
   POST /adjust-sensitivity → Ajustar sensibilidade
=======================================
  `);
});

// Monitorar conexões
setInterval(() => {
  console.log(`📊 Status: ${clients.size} cliente(s), ESP32: ${esp32Client ? 'Conectado' : 'Desconectado'}`);
}, 30000);
