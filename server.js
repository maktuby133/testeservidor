require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_TOKENS = (process.env.ALLOWED_TOKENS || '').split(',');

// Métricas simples
const metrics = {
  connections: 0,
  messagesSent: 0,
  messagesReceived: 0,
  errors: 0
};

// Clientes conectados
let clients = {
  transmitter: null,
  receiver: null,
  dashboards: []
};

// ====== WEBSOCKET ======
wss.on('connection', (ws) => {
  const clientId = Math.random().toString(36).substring(2, 10);
  console.log(`🔗 Nova conexão: ${clientId}`);

  let authenticated = false;
  let role = null;

  ws.on('message', (message) => {
    metrics.messagesReceived++;
    try {
      const data = JSON.parse(message);

      // Primeira mensagem deve ser 'auth'
      if (!authenticated) {
        if (data.type === 'auth' && ALLOWED_TOKENS.includes(data.token)) {
          authenticated = true;
          role = data.role;

          if (role === 'transmitter') clients.transmitter = ws;
          else if (role === 'receiver') clients.receiver = ws;
          else if (role === 'dashboard') clients.dashboards.push(ws);

          console.log(`✅ Cliente autenticado: ${data.device} (${role})`);
          ws.send(JSON.stringify({ type: 'auth_success', role }));
        } else {
          console.log(`❌ Autenticação falhou para cliente ${clientId}`);
          ws.send(JSON.stringify({ type: 'auth_failed' }));
          ws.close();
        }
        return;
      }

      // Mensagens após autenticação
      if (data.type === 'lora_data') {
        console.log(`📡 Dados LoRa recebidos de ${data.device}: ${data.liters}L (${data.percentage}%)`);
        // Broadcast para dashboards
        clients.dashboards.forEach(d => {
          if (d.readyState === WebSocket.OPEN) {
            d.send(JSON.stringify(data));
          }
        });
      }

    } catch (err) {
      console.error('❌ Erro ao processar mensagem:', err);
      metrics.errors++;
    }
  });

  ws.on('close', () => {
    console.log(`🔌 Conexão fechada: ${clientId}`);
    if (clients.transmitter === ws) clients.transmitter = null;
    if (clients.receiver === ws) clients.receiver = null;
    clients.dashboards = clients.dashboards.filter(d => d !== ws);
  });
});

// ====== ROTAS REST ======
app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Servidor ativo',
    metrics,
    environment: NODE_ENV
  });
});

app.post('/test-sensor', (req, res) => {
  const { test_type, duration = 10 } = req.body;
  if (!clients.receiver || clients.receiver.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ success: false, message: 'Receptor não conectado' });
  }

  let command = '';
  switch(test_type) {
    case 'calibration': command = 'start_calibration'; break;
    case 'stability':   command = 'test_stability'; break;
    case 'accuracy':    command = 'test_accuracy'; break;
    default:
      return res.status(400).json({ success: false, message: 'Tipo de teste inválido' });
  }

  clients.receiver.send(command);
  metrics.messagesSent++;
  console.log(`🔬 Teste de sensor iniciado: ${test_type} por ${duration}s`);

  res.json({ success: true, message: `Teste ${test_type} iniciado`, duration });
});

app.post('/adjust-sensitivity', (req, res) => {
  const { sensitivity } = req.body;
  if (!clients.receiver || clients.receiver.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ success: false, message: 'Receptor não conectado' });
  }
  if (sensitivity < 5 || sensitivity > 50) {
    return res.status(400).json({ success: false, message: 'Sensibilidade deve estar entre 5 e 50 litros' });
  }

  const command = `set_sensitivity:${sensitivity}`;
  clients.receiver.send(command);
  metrics.messagesSent++;
  console.log(`🎯 Sensibilidade ajustada para: ${sensitivity}L`);

  res.json({ success: true, message: `Sensibilidade ajustada para ${sensitivity}L`, sensitivity });
});

// ====== START ======
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT} (${NODE_ENV})`);
});
