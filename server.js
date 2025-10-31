const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Armazenar conexões
const clients = new Map();

// Servir arquivos estáticos (HTML, CSS, JS)
app.use(express.static('public'));

// Rota principal - serve o HTML ORIGINAL
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'Caixa dÁgua WebSocket',
    connectedClients: clients.size,
    timestamp: new Date().toISOString()
  });
});

// WebSocket connection
wss.on('connection', function connection(ws) {
  const clientId = `CAIXA_${Date.now()}`;
  console.log(`✅ Nova conexão: ${clientId}`);
  
  clients.set(clientId, ws);
  ws.clientId = clientId;
  
  // Enviar confirmação
  ws.send(JSON.stringify({
    type: 'connected',
    message: 'Conectado ao servidor',
    clientId: clientId
  }));
  
  // Mensagens do ESP32
  ws.on('message', function message(data) {
    try {
      const message = JSON.parse(data.toString());
      handleWebSocketMessage(ws, message);
    } catch (error) {
      console.error('❌ Erro ao processar mensagem:', error);
    }
  });
  
  ws.on('close', function close() {
    console.log(`❌ Conexão fechada: ${clientId}`);
    clients.delete(clientId);
  });
  
  ws.on('error', function error(err) {
    console.error(`❌ Erro ${clientId}:`, err);
    clients.delete(clientId);
  });
});

function handleWebSocketMessage(ws, message) {
  console.log(`📨 ${ws.clientId}:`, message.type);
  
  // Retransmitir para TODOS os clientes (incluindo páginas web)
  clients.forEach((client, id) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        ...message,
        clientId: ws.clientId,
        timestamp: new Date().toISOString()
      }));
    }
  });
}

// API para comandos HTTP
app.post('/command/:clientId/:command', express.json(), (req, res) => {
  const { clientId, command } = req.params;
  const ws = clients.get(clientId);
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(command);
    res.json({ success: true, message: `Comando enviado para ${clientId}` });
  } else {
    res.status(404).json({ success: false, message: 'Cliente não encontrado' });
  }
});

// Listar clientes conectados
app.get('/clients', (req, res) => {
  const clientList = Array.from(clients.entries()).map(([id, ws]) => ({
    id,
    connected: ws.readyState === WebSocket.OPEN,
    type: id.startsWith('CAIXA_') ? 'ESP32' : 'WEB'
  }));
  res.json({ clients: clientList, total: clientList.length });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🌐 Acesse: http://localhost:${PORT}`);
  console.log(`📊 Aguardando conexões da caixa d'água...`);
});
