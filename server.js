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
const ALLOWED_TOKENS = process.env.ALLOWED_TOKENS
  ? process.env.ALLOWED_TOKENS.split(',')
  : ['esp32_token_secreto_2024'];

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', environment: process.env.NODE_ENV || 'development' });
});

wss.on('connection', (ws) => {
  let authenticated = false;

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.type === 'auth') {
        if (!ALLOWED_TOKENS.includes(data.token)) {
          ws.send(JSON.stringify({ type: 'auth_error' }));
          ws.close();
          return;
        }
        authenticated = true;
        ws.send(JSON.stringify({ type: 'auth_success', device: data.device }));
      }

      if (authenticated && data.type === 'lora_data') {
        console.log("📡 Dados recebidos:", data);
        // Broadcast para dashboards
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
});

server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
