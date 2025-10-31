const WebSocket = require('ws');
const express = require('express');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Armazenar conexões
const clients = new Map();

// Servir página web
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
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
      console.log(`📨 ${clientId}:`, message.type);
      
      // Retransmitir para outros clientes (se necessário)
      clients.forEach((client, id) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            ...message,
            clientId: clientId,
            timestamp: new Date().toISOString()
          }));
        }
      });
      
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

// API para comandos HTTP
app.post('/command/:clientId/:command', (req, res) => {
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
    connected: ws.readyState === WebSocket.OPEN
  }));
  res.json({ clients: clientList, total: clientList.length });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📊 Aguardando conexões da caixa d'água...`);
});
