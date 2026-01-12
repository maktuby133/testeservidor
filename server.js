require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ====== CONFIGURAÇÕES ======
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'esp32_token_secreto_2024';

// ====== CLIENTES CONECTADOS ======
let webClients = new Set();
let esp32Client = null; // Cliente direto ESP32 (modo antigo)
let loraReceiverClient = null; // Cliente receptor LoRa
let lastSensorData = null;
let lastConsumoData = null;
let lastConsumoSemanal = null;

// ====== ESTATÍSTICAS DO SISTEMA ======
const metrics = {
  webClientsTotal: 0,
  esp32Connects: 0,
  loraReceiverConnects: 0,
  messagesReceived: 0,
  messagesSent: 0,
  loraPacketsReceived: 0,
  errors: 0,
  lastLoraRx: null,
  lastWebClientConnect: null,
  systemStartTime: Date.now()
};

// ====== MIDDLEWARE ======
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ====== ROTAS HTTP ======
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  const uptime = Math.floor((Date.now() - metrics.systemStartTime) / 1000);
  
  res.json({
    status: 'online',
    environment: NODE_ENV,
    uptime: uptime,
    connections: {
      web_clients: webClients.size,
      esp32_direct: esp32Client ? 'connected' : 'disconnected',
      lora_receiver: loraReceiverClient ? 'connected' : 'disconnected'
    },
    metrics: {
      ...metrics,
      uptime_formatted: formatUptime(uptime)
    },
    last_data: {
      sensor: lastSensorData ? 'available' : 'none',
      consumo: lastConsumoData ? 'available' : 'none',
      last_lora_rx: metrics.lastLoraRx
    },
    timestamp: new Date().toISOString()
  });
});

app.get('/api/data', (req, res) => {
  res.json({
    sensor_data: lastSensorData || {},
    consumo_data: lastConsumoData || {},
    consumo_semanal: lastConsumoSemanal || {},
    timestamp: new Date().toISOString()
  });
});

app.get('/api/metrics', (req, res) => {
  const uptime = Math.floor((Date.now() - metrics.systemStartTime) / 1000);
  
  res.json({
    ...metrics,
    uptime: uptime,
    uptime_formatted: formatUptime(uptime),
    connections: {
      web_clients: webClients.size,
      esp32_direct: esp32Client !== null,
      lora_receiver: loraReceiverClient !== null
    },
    timestamp: new Date().toISOString()
  });
});

// Reset de consumo via HTTP
app.post('/reset-consumo', (req, res) => {
  console.log('🔄 Reset de consumo solicitado via HTTP');
  
  // Enviar comando para ESP32 direto ou via receptor LoRa
  if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
    esp32Client.send('reset_consumo');
    res.json({ 
      success: true, 
      message: 'Reset enviado para ESP32 direto',
      method: 'direct'
    });
  } else if (loraReceiverClient && loraReceiverClient.readyState === WebSocket.OPEN) {
    // Enviar comando para o receptor encaminhar via LoRa
    const command = JSON.stringify({
      type: 'command',
      target: 'CAIXA_AGUA',
      command: 'reset_consumo',
      timestamp: Date.now()
    });
    loraReceiverClient.send(command);
    res.json({ 
      success: true, 
      message: 'Reset enviado via receptor LoRa',
      method: 'lora'
    });
  } else {
    res.status(404).json({ 
      success: false, 
      message: 'Nenhum dispositivo conectado'
    });
  }
});

// ====== WEBSOCKET ======
wss.on('connection', (ws, req) => {
  const clientIP = req.socket.remoteAddress;
  console.log(`\n🔗 Nova conexão WebSocket de ${clientIP}`);
  
  let clientType = 'unknown';
  let isAuthenticated = false;
  let deviceInfo = {};

  // Timeout para autenticação
  const authTimeout = setTimeout(() => {
    if (!isAuthenticated) {
      console.log('⏰ Timeout de autenticação - fechando conexão');
      ws.send(JSON.stringify({ 
        type: 'error', 
        message: 'Autenticação necessária' 
      }));
      ws.close();
    }
  }, 30000); // 30 segundos para autenticar

  ws.on('message', (message) => {
    try {
      metrics.messagesReceived++;
      const data = JSON.parse(message);
      
      // ====== AUTENTICAÇÃO ======
      if (data.type === 'auth') {
        console.log('🔐 Tentativa de autenticação:', data);
        
        // Verificar token
        if (data.token === AUTH_TOKEN) {
          isAuthenticated = true;
          clearTimeout(authTimeout);
          
          deviceInfo = {
            device: data.device,
            deviceType: data.device_type || data.device,
            version: data.version || 'unknown'
          };
          
          // Identificar tipo de cliente
          if (data.device_type === 'LORA_RECEIVER' || data.device === 'RECEPTOR_01') {
            clientType = 'lora_receiver';
            loraReceiverClient = ws;
            metrics.loraReceiverConnects++;
            console.log('✅ Receptor LoRa autenticado:', data.device);
            
            ws.send(JSON.stringify({ 
              type: 'auth_success', 
              message: 'Receptor LoRa conectado',
              role: 'lora_receiver'
            }));
            
            // Notificar clientes web
            broadcastToWeb({
              type: 'lora_receiver_connected',
              device: data.device,
              timestamp: new Date().toISOString()
            });
            
          } else if (data.device === 'ESP32' || data.device === 'CAIXA_AGUA') {
            clientType = 'esp32_direct';
            esp32Client = ws;
            metrics.esp32Connects++;
            console.log('✅ ESP32 direto autenticado');
            
            ws.send(JSON.stringify({ 
              type: 'auth_success', 
              message: 'ESP32 conectado',
              role: 'esp32_direct'
            }));
            
            broadcastToWeb({
              type: 'esp32_connected',
              timestamp: new Date().toISOString()
            });
            
          } else {
            clientType = 'web';
            webClients.add(ws);
            metrics.webClientsTotal++;
            metrics.lastWebClientConnect = new Date().toISOString();
            console.log(`✅ Cliente web autenticado (${webClients.size} total)`);
            
            ws.send(JSON.stringify({ 
              type: 'auth_success', 
              message: 'Cliente web conectado',
              role: 'web_client'
            }));
            
            // Enviar dados atuais
            if (lastSensorData) {
              ws.send(JSON.stringify(lastSensorData));
            }
            if (lastConsumoData) {
              ws.send(JSON.stringify(lastConsumoData));
            }
            if (lastConsumoSemanal) {
              ws.send(JSON.stringify(lastConsumoSemanal));
            }
          }
          
        } else {
          console.log('❌ Token inválido:', data.token);
          ws.send(JSON.stringify({ 
            type: 'auth_failed', 
            message: 'Token inválido' 
          }));
          ws.close();
        }
        return;
      }
      
      // Exigir autenticação para outros comandos
      if (!isAuthenticated) {
        console.log('⚠️ Mensagem não autenticada ignorada');
        return;
      }
      
      // ====== PROCESSAR DADOS DO RECEPTOR LORA ======
      if (clientType === 'lora_receiver' && data.type === 'sensor_data') {
        console.log('\n📡 ========================================');
        console.log('DADOS RECEBIDOS VIA LoRa');
        console.log('========================================');
        console.log('📦 Pacote completo:', JSON.stringify(data, null, 2));
        
        metrics.loraPacketsReceived++;
        metrics.lastLoraRx = new Date().toISOString();
        
        // Armazenar dados
        lastSensorData = {
          type: 'all_data',
          ...data,
          source: 'lora',
          server_timestamp: new Date().toISOString()
        };
        
        // Broadcast para clientes web
        broadcastToWeb(lastSensorData);
        
        console.log('✅ Dados processados e enviados aos clientes web');
        console.log('========================================\n');
      }
      
      // ====== PROCESSAR DADOS DIRETOS DO ESP32 ======
      else if (clientType === 'esp32_direct') {
        console.log('📡 Dados diretos do ESP32:', data.type);
        
        if (data.type === 'all_data') {
          lastSensorData = { ...data, source: 'direct' };
          broadcastToWeb(lastSensorData);
        } else if (data.type === 'consumo_data') {
          lastConsumoData = data;
          broadcastToWeb(lastConsumoData);
        } else if (data.type === 'consumo_semanal_data') {
          lastConsumoSemanal = data;
          broadcastToWeb(lastConsumoSemanal);
        }
      }
      
      // ====== STATUS DO RECEPTOR ======
      else if (data.type === 'receiver_status') {
        console.log('📊 Status do receptor LoRa:', {
          device: data.device,
          lora_packets: data.lora_packets_received,
          uptime: data.uptime,
          rssi: data.last_rssi
        });
        
        broadcastToWeb({
          type: 'lora_receiver_status',
          ...data,
          server_timestamp: new Date().toISOString()
        });
      }
      
      // ====== COMANDOS DOS CLIENTES WEB ======
      else if (clientType === 'web') {
        console.log('📨 Comando do cliente web:', data);
        
        // Encaminhar comandos
        if (data === 'get_data' || data === 'get_status') {
          if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
            esp32Client.send(data);
          }
          if (loraReceiverClient && loraReceiverClient.readyState === WebSocket.OPEN) {
            loraReceiverClient.send(JSON.stringify({
              type: 'command',
              command: data
            }));
          }
        } else if (data === 'reset_consumo') {
          if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
            esp32Client.send('reset_consumo');
          } else if (loraReceiverClient && loraReceiverClient.readyState === WebSocket.OPEN) {
            loraReceiverClient.send(JSON.stringify({
              type: 'command',
              target: 'CAIXA_AGUA',
              command: 'reset_consumo'
            }));
          }
        }
      }
      
    } catch (error) {
      console.error('❌ Erro ao processar mensagem:', error);
      metrics.errors++;
    }
  });

  ws.on('close', () => {
    console.log(`❌ Conexão WebSocket fechada (${clientType})`);
    
    if (clientType === 'esp32_direct') {
      esp32Client = null;
      broadcastToWeb({
        type: 'esp32_disconnected',
        timestamp: new Date().toISOString()
      });
    } else if (clientType === 'lora_receiver') {
      loraReceiverClient = null;
      broadcastToWeb({
        type: 'lora_receiver_disconnected',
        timestamp: new Date().toISOString()
      });
    } else if (clientType === 'web') {
      webClients.delete(ws);
      console.log(`Cliente web removido (${webClients.size} restantes)`);
    }
    
    clearTimeout(authTimeout);
  });

  ws.on('error', (error) => {
    console.error('❌ Erro WebSocket:', error.message);
    metrics.errors++;
  });
});

// ====== FUNÇÕES AUXILIARES ======
function broadcastToWeb(data) {
  const message = JSON.stringify(data);
  let sentCount = 0;
  
  webClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
      sentCount++;
      metrics.messagesSent++;
    }
  });
  
  if (sentCount > 0) {
    console.log(`📤 Broadcast para ${sentCount} cliente(s) web`);
  }
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  return `${days}d ${hours}h ${minutes}m ${secs}s`;
}

// ====== HEALTH CHECK PERIÓDICO ======
setInterval(() => {
  const uptime = Math.floor((Date.now() - metrics.systemStartTime) / 1000);
  
  console.log('\n💚 ========================================');
  console.log('HEALTH CHECK - Servidor');
  console.log('========================================');
  console.log(`⏱️  Uptime: ${formatUptime(uptime)}`);
  console.log(`🌐 Ambiente: ${NODE_ENV}`);
  console.log(`📱 Clientes web: ${webClients.size}`);
  console.log(`📡 ESP32 direto: ${esp32Client ? '✅ CONECTADO' : '❌ DESCONECTADO'}`);
  console.log(`📡 Receptor LoRa: ${loraReceiverClient ? '✅ CONECTADO' : '❌ DESCONECTADO'}`);
  console.log(`📊 Pacotes LoRa recebidos: ${metrics.loraPacketsReceived}`);
  console.log(`📊 Mensagens recebidas: ${metrics.messagesReceived}`);
  console.log(`📊 Mensagens enviadas: ${metrics.messagesSent}`);
  console.log(`❌ Erros: ${metrics.errors}`);
  if (metrics.lastLoraRx) {
    console.log(`📡 Último pacote LoRa: ${metrics.lastLoraRx}`);
  }
  console.log('========================================\n');
}, 60000); // A cada 60 segundos

// ====== INICIAR SERVIDOR ======
server.listen(PORT, () => {
  console.log('\n🚀 ========================================');
  console.log('   SERVIDOR CAIXA D\'ÁGUA COM LoRa');
  console.log('========================================');
  console.log(`🌐 Ambiente: ${NODE_ENV}`);
  console.log(`🔗 Servidor rodando na porta ${PORT}`);
  console.log(`🏠 Interface web: http://localhost:${PORT}`);
  console.log(`💚 Health check: http://localhost:${PORT}/health`);
  console.log(`📊 Métricas: http://localhost:${PORT}/api/metrics`);
  console.log(`📡 Suporta: ESP32 direto + Receptor LoRa`);
  console.log(`🔐 Token: ${AUTH_TOKEN}`);
  console.log('========================================\n');
  console.log('✅ Aguardando conexões...\n');
});

// ====== TRATAMENTO DE ERROS ======
process.on('uncaughtException', (error) => {
  console.error('❌ Erro não capturado:', error);
  metrics.errors++;
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promise rejeitada não tratada:', reason);
  metrics.errors++;
});

// ====== GRACEFUL SHUTDOWN ======
process.on('SIGTERM', () => {
  console.log('\n⚠️  Recebido SIGTERM, encerrando graciosamente...');
  
  // Fechar todas as conexões WebSocket
  webClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'server_shutdown',
        message: 'Servidor encerrando'
      }));
      client.close();
    }
  });
  
  if (esp32Client) esp32Client.close();
  if (loraReceiverClient) loraReceiverClient.close();
  
  server.close(() => {
    console.log('✅ Servidor encerrado com sucesso');
    process.exit(0);
  });
});
