// server.js - Servidor WebSocket + Frontend
const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Variáveis de ambiente
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_TOKENS = process.env.ALLOWED_TOKENS
  ? process.env.ALLOWED_TOKENS.split(',')
  : ['esp32_token_secreto_2024'];

// Clientes conectados
let clients = {
  transmitters: new Map(),
  receivers: new Map(),
  dashboards: new Map()
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

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ✅ Rota raiz para abrir o painel
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Rota de saúde
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', environment: NODE_ENV });
});

// Rota para dados do sistema
app.get('/api/system', (req, res) => {
  res.json({ success: true, data: systemData });
});

// WebSocket Server
wss.on('connection', (ws) => {
  let authenticated = false;
  let clientType = 'unknown';
  let deviceId = '';

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // Autenticação
      if (data.type === 'auth') {
        if (!ALLOWED_TOKENS.includes(data.token)) {
          ws.send(JSON.stringify({ type: 'auth_error', message: 'Token inválido' }));
          ws.close();
          return;
        }
        authenticated = true;
        clientType = data.role || 'unknown';
        deviceId = data.device || 'unknown';

        if (clientType === 'receiver') {
          clients.receivers.set(deviceId, { ws, deviceId });
        } else if (clientType === 'transmitter') {
          clients.transmitters.set(deviceId, { ws, deviceId });
        } else if (clientType === 'dashboard') {
          clients.dashboards.set(deviceId, { ws, deviceId });
        }

        ws.send(JSON.stringify({ type: 'auth_success', deviceId }));
        return;
      }

      if (!authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Não autenticado' }));
        return;
      }

      // Processar mensagens
      if (data.type === 'lora_data') {
        systemData.lastTransmission = new Date().toISOString();
        systemData.caixaAgua = {
          distance: data.distance,
          level: data.level,
          percentage: data.percentage,
          liters: data.liters,
          sensorOK: data.sensor_ok,
          lastUpdate: new Date().toISOString()
        };
        systemData.loraStats = {
          rssi: data.rssi || 0,
          snr: data.snr || 0,
          rxCount: data.rx_count || 0,
          lastDevice: data.device || ''
        };

        // Broadcast para dashboards
        clients.dashboards.forEach((client) => {
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({ type: 'update', ...systemData.caixaAgua, ...systemData.loraStats }));
          }
        });
      }

      if (data.type === 'consumo_data') {
        systemData.consumo.diario = data.consumo_diario || Array(24).fill(0);
        systemData.consumo.hora = data.consumo_acumulado_ultima_hora || 0;
        systemData.consumo.hoje = data.consumo_acumulado_hoje || 0;

        clients.dashboards.forEach((client) => {
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({ type: 'consumo_data', ...systemData.consumo }));
          }
        });
      }
    } catch (err) {
      console.error('❌ Erro ao processar mensagem:', err);
    }
  });

  ws.on('close', () => {
    clients.transmitters.delete(deviceId);
    clients.receivers.delete(deviceId);
    clients.dashboards.delete(deviceId);
  });
});

// Iniciar servidor
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🌍 Ambiente: ${NODE_ENV}`);
});
