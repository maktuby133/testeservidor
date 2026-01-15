// server.js - Servidor WebSocket + Frontend
const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// ✅ WebSocket agora com rota dedicada /ws
const wss = new WebSocket.Server({ server, path: "/ws" });

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_TOKENS = process.env.ALLOWED_TOKENS
  ? process.env.ALLOWED_TOKENS.split(',')
  : ['esp32_token_secreto_2024'];

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rota raiz
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Rota de saúde
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', environment: NODE_ENV });
});

// Rota de API para dados do sistema (exemplo)
app.get('/api/system', (req, res) => {
  res.json({ success: true, message: "API funcionando" });
});

// WebSocket
wss.on('connection', (ws) => {
  console.log("✅ Cliente WebSocket conectado");
  let authenticated = false;

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);

      // Autenticação
      if (data.type === 'auth') {
        if (!ALLOWED_TOKENS.includes(data.token)) {
          ws.send(JSON.stringify({ type: 'auth_error', message: 'Token inválido' }));
          ws.close();
          return;
        }
        authenticated = true;
        ws.send(JSON.stringify({ type: 'auth_success', device: data.device }));
        console.log("🔑 Autenticado:", data.device);
      }

      // Dados LoRa
      if (authenticated && data.type === 'lora_data') {
        console.log("📡 Dados LoRa recebidos:", data);
        // Broadcast para todos dashboards conectados
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'update', ...data }));
          }
        });
      }
    } catch (err) {
      console.error("❌ Erro ao processar mensagem:", err);
    }
  });

  ws.on('close', () => {
    console.log("❌ Cliente WebSocket desconectado");
  });
});

// Iniciar servidor
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🌍 Ambiente: ${NODE_ENV}`);
});
