require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'esp32_token_secreto_2024';

let esp32GatewayClient = null; // ESP32 receptor (gateway LoRa -> WebSocket)
let dashboardClients = new Set(); // navegadores/painéis conectados
const metrics = {
  messagesSent: 0,
  messagesReceived: 0,
  errors: 0,
  lastMessageAt: null
};

// Health route
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    env: NODE_ENV,
    gatewayConnected: !!esp32GatewayClient,
    dashboards: dashboardClients.size,
    metrics
  });
});

// WebSocket server
wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.replace('/?', ''));
  const role = params.get('role') || 'dashboard';
  const token = params.get('token') || '';

  if (role === 'gateway') {
    if (token !== AUTH_TOKEN) {
      ws.close(4001, 'Unauthorized');
      return;
    }
    esp32GatewayClient = ws;
    console.log('🔗 ESP32 Gateway conectado');

    ws.on('message', (message) => {
      metrics.messagesReceived++;
      metrics.lastMessageAt = new Date().toISOString();

      // Repassa dados do gateway para dashboards
      for (const client of dashboardClients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message.toString());
        }
      }
    });

    ws.on('close', () => {
      console.log('❌ ESP32 Gateway desconectado');
      esp32GatewayClient = null;
    });

    ws.on('error', (err) => {
      console.error('❌ Erro no gateway:', err);
      metrics.errors++;
    });

  } else {
    // Dashboard client
    dashboardClients.add(ws);
    console.log('🖥️ Dashboard conectado');

    ws.on('close', () => {
      dashboardClients.delete(ws);
      console.log('🖥️ Dashboard desconectado');
    });

    ws.on('error', (err) => {
      console.error('❌ Erro no dashboard:', err);
      metrics.errors++;
    });
  }
});

// Rota: iniciar testes no sensor (via LoRa -> transmissor)
app.post('/test-sensor', express.json(), (req, res) => {
  const { test_type, duration = 10 } = req.body;

  if (!esp32GatewayClient || esp32GatewayClient.readyState !== WebSocket.OPEN) {
    return res.status(404).json({
      success: false,
      message: 'ESP32 Gateway não conectado',
      environment: NODE_ENV
    });
  }

  try {
    let command = '';
    switch (test_type) {
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

    // Envia comando para o gateway, que repassa via LoRa ao transmissor
    const payload = JSON.stringify({
      type: 'command',
      command,
      duration
    });
    esp32GatewayClient.send(payload);
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

// Rota: ajustar sensibilidade (via LoRa -> transmissor)
app.post('/adjust-sensitivity', express.json(), (req, res) => {
  const { sensitivity } = req.body;

  if (!esp32GatewayClient || esp32GatewayClient.readyState !== WebSocket.OPEN) {
    return res.status(404).json({
      success: false,
      message: 'ESP32 Gateway não conectado',
      environment: NODE_ENV
    });
  }

  if (typeof sensitivity !== 'number' || sensitivity < 5 || sensitivity > 50) {
    return res.status(400).json({
      success: false,
      message: 'Sensibilidade deve estar entre 5 e 50 litros'
    });
  }

  try {
    const payload = JSON.stringify({
      type: 'command',
      command: `set_sensitivity:${sensitivity}`
    });
    esp32GatewayClient.send(payload);
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

server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT} | env=${NODE_ENV}`);
});

