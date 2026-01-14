// server.js
const WebSocket = require('ws');
const express = require('express');
const http = require('http');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const ALLOWED_TOKENS = process.env.ALLOWED_TOKENS.split(',');

wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    const data = JSON.parse(msg);
    if (data.type === 'auth') {
      if (!ALLOWED_TOKENS.includes(data.token)) {
        ws.send(JSON.stringify({ type: 'auth_error' }));
        ws.close();
        return;
      }
      ws.send(JSON.stringify({ type: 'auth_success' }));
    }
    if (data.type === 'lora_data') {
      console.log("📡 Dados recebidos:", data);
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Servidor WebSocket rodando na porta ${PORT}`);
});
