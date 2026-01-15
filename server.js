// server.js - Servidor Express + REST API
const express = require('express');
const http = require('http');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// 🚨 Apenas o token do projeto da caixa d’água
const ALLOWED_TOKEN = "esp32_token_secreto_2024";

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

// ✅ Rota para receber dados LoRa via POST
app.post('/api/lora', (req, res) => {
  const token = req.headers['authorization'];
  const deviceId = req.headers['x-device-id'];

  if (token !== ALLOWED_TOKEN) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  const data = req.body;
  console.log("📡 Dados LoRa recebidos:", data);

  // Aqui você pode salvar em banco de dados ou repassar para dashboard
  res.json({ status: 'ok', device: deviceId });
});

// Iniciar servidor
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🌍 Ambiente: ${NODE_ENV}`);
});
