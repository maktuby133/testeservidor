import express from "express";
import path from "path";
import dotenv from "dotenv";

// Carregar variáveis de ambiente
dotenv.config();

const app = express();
app.use(express.json());

// Memória temporária para histórico
let historico = [];
let lastLoRaStatus = {
  connected: true,
  lastPacketTime: null,
  lastStatusUpdate: null,
  noDataMode: false,
  waitingData: false
};

// Controle de conexão do receptor
let receptorStatus = {
  connected: true,
  lastConnection: Date.now(),
  lastPacketTime: null,
  connectionTimeout: 30000, // 30 segundos para considerar desconectado
  reconnectionCount: 0
};

// Função para verificar se receptor está conectado
function checkReceptorConnection() {
  const now = Date.now();
  const timeSinceLastPacket = receptorStatus.lastPacketTime ? 
    now - receptorStatus.lastPacketTime : Infinity;
  
  const shouldBeConnected = timeSinceLastPacket < receptorStatus.connectionTimeout;
  
  if (receptorStatus.connected !== shouldBeConnected) {
    receptorStatus.connected = shouldBeConnected;
    
    if (!receptorStatus.connected) {
      console.log(`⚠️  RECEPTOR DESCONECTADO! Sem pacotes há ${Math.floor(timeSinceLastPacket/1000)} segundos`);
      console.log(`   Último pacote: ${new Date(receptorStatus.lastPacketTime).toLocaleString()}`);
      
      // Limpar histórico quando receptor desconectar
      historico = [];
      console.log("   📭 Histórico LIMPO devido à desconexão do receptor");
      
      // Atualizar status LoRa
      lastLoRaStatus.connected = false;
      lastLoRaStatus.waitingData = true;
      lastLoRaStatus.noDataMode = true;
      lastLoRaStatus.lastStatusUpdate = new Date().toISOString();
    } else {
      receptorStatus.reconnectionCount++;
      console.log(`✅ RECEPTOR RECONECTADO! Reconexão #${receptorStatus.reconnectionCount}`);
    }
  }
}

// Executar verificação a cada 10 segundos
setInterval(checkReceptorConnection, 10000);

// Middleware de autenticação
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization;
  const allowedTokens = process.env.ALLOWED_TOKENS?.split(',') || [];
  
  console.log("🔐 Verificação de token:");
  console.log("   Token recebido:", token);
  console.log("   Tokens permitidos:", allowedTokens);
  
  if (!token || !allowedTokens.includes(token)) {
    console.log("❌ Token inválido ou não fornecido");
    return res.status(401).json({ 
      error: "Token inválido",
      message: "Use um token válido no header 'Authorization'",
      allowed_tokens: allowedTokens
    });
  }
  
  console.log("✅ Token válido");
  next();
};

// Recebe dados do ESP32 receptor
app.post("/api/lora", authMiddleware, (req, res) => {
  console.log("📥 Dados recebidos:", req.body);
  
  const { 
    device, 
    distance, 
    level, 
    percentage, 
    liters, 
    sensor_ok,
    timestamp,
    crc,
    receptor_time,
    receptor_status,
    last_packet_ms,
    no_data,
    no_data_mode,
    message
  } = req.body;

  // ATUALIZAR STATUS DO RECEPTOR (sempre que receber pacote)
  receptorStatus.lastConnection = Date.now();
  receptorStatus.lastPacketTime = Date.now();
  receptorStatus.connected = true;

  // Verificar se é um pacote de status de conexão
  const isStatusPacket = req.headers['x-packet-type'] === 'status' || receptor_status !== undefined;
  
  // Verificar se é um pacote de "sem dados" (aguardando dados)
  const isNoDataPacket = req.headers['x-no-data'] === 'true' || no_data === true || no_data_mode === true;
  
  if (isNoDataPacket) {
    console.log("📭 PACOTE SEM DADOS - Modo 'Aguardando Dados' ativado");
    
    lastLoRaStatus.connected = false;
    lastLoRaStatus.noDataMode = true;
    lastLoRaStatus.waitingData = true;
    lastLoRaStatus.lastStatusUpdate = new Date().toISOString();
    
    // Criar registro especial para "Aguardando Dados"
    const noDataRecord = {
      device: device || "RECEPTOR_CASA",
      distance: -1,
      level: -1,
      percentage: -1,
      liters: -1,
      sensor_ok: false,
      timestamp: new Date().toISOString(),
      crc: "NO_DATA",
      received_at: new Date().toISOString(),
      source_timestamp: timestamp || null,
      server_timestamp: new Date().toISOString(),
      status: "waiting_data",
      message: message || "Aguardando dados do transmissor LoRa",
      lora_connected: false,
      no_data_mode: true,
      receptor_connected: true // Receptor ainda está conectado
    };
    
    historico.push(noDataRecord);
    
    // Manter apenas últimos 100 registros
    if (historico.length > 100) historico.shift();
    
    return res.json({ 
      status: "ok", 
      message: "Status 'Aguardando Dados' registrado",
      record: noDataRecord,
      lora_connected: false,
      no_data_mode: true,
      receptor_connected: true
    });
  }
  
  if (isStatusPacket) {
    console.log("📡 Pacote de status LoRa recebido");
    
    lastLoRaStatus.connected = receptor_status === 'connected';
    lastLoRaStatus.noDataMode = no_data_mode === true;
    lastLoRaStatus.waitingData = receptor_status === 'disconnected';
    lastLoRaStatus.lastPacketTime = last_packet_ms || null;
    lastLoRaStatus.lastStatusUpdate = new Date().toISOString();
    
    if (!lastLoRaStatus.connected) {
      console.log(`⚠️  Alerta: Receptor reportou perda de conexão LoRa`);
      console.log(`   Tempo sem pacotes: ${last_packet_ms} ms`);
      console.log(`   Modo sem dados: ${lastLoRaStatus.noDataMode ? 'ATIVADO' : 'desativado'}`);
    } else {
      console.log(`✅ Receptor reportou conexão LoRa restaurada`);
      lastLoRaStatus.waitingData = false;
      lastLoRaStatus.noDataMode = false;
    }
    
    return res.json({ 
      status: "ok", 
      message: "Status LoRa atualizado",
      lora_connected: lastLoRaStatus.connected,
      waiting_data: lastLoRaStatus.waitingData,
      receptor_connected: true
    });
  }

  // Se for pacote de dados normal
  const dataTimestamp = receptor_time ? new Date().toISOString() : new Date().toISOString();
  const deviceTimestamp = timestamp ? new Date(parseInt(timestamp)).toISOString() : dataTimestamp;
  
  const finalTimestamp = deviceTimestamp || dataTimestamp;

  const registro = {
    device: device || "ESP32",
    distance: parseFloat(distance) || 0,
    level: parseInt(level) || 0,
    percentage: parseInt(percentage) || 0,
    liters: parseInt(liters) || 0,
    sensor_ok: sensor_ok !== false,
    timestamp: finalTimestamp,
    crc: crc || "N/A",
    received_at: new Date().toISOString(),
    source_timestamp: timestamp || null,
    server_timestamp: new Date().toISOString(),
    status: "normal",
    lora_connected: true,
    no_data_mode: false,
    receptor_connected: true
  };

  console.log("📊 Registro salvo:", registro);
  console.log("⏰ Receptor CONECTADO - Último contato:", new Date().toLocaleTimeString());
  
  historico.push(registro);
  
  // Manter apenas últimos 100 registros
  if (historico.length > 100) historico.shift();
  
  // Atualizar status LoRa
  lastLoRaStatus.connected = true;
  lastLoRaStatus.waitingData = false;
  lastLoRaStatus.noDataMode = false;
  lastLoRaStatus.lastPacketTime = Date.now();

  res.json({ 
    status: "ok", 
    message: "Dados recebidos com sucesso!",
    recebido: registro,
    historico_count: historico.length,
    receptor_connected: true,
    timestamp_correction: {
      used: finalTimestamp,
      original: timestamp,
      server: registro.server_timestamp
    }
  });
});

// Fornece dados para o dashboard
app.get("/api/lora", (req, res) => {
  // Verificar status do receptor
  checkReceptorConnection();
  
  let ultimo;
  let receptorDisconnectedMode = false;
  
  if (!receptorStatus.connected) {
    // MODO RECEPTOR DESCONECTADO
    receptorDisconnectedMode = true;
    console.log("📡 Dashboard acessado - RECEPTOR DESCONECTADO");
    
    ultimo = {
      device: "RECEPTOR_CASA",
      distance: -1,
      level: -1,
      percentage: -1,
      liters: -1,
      sensor_ok: false,
      timestamp: new Date().toISOString(),
      status: "receptor_disconnected",
      message: "RECEPTOR DESCONECTADO - Aguardando reconexão",
      lora_connected: false,
      no_data_mode: true,
      display_mode: "receptor_disconnected",
      receptor_connected: false
    };
    
  } else {
    // Receptor está conectado
    const recentNormalData = historico.filter(item => 
      item.status === "normal" && 
      new Date(item.timestamp) > new Date(Date.now() - 30000)
    );
    
    if (recentNormalData.length > 0) {
      ultimo = recentNormalData[recentNormalData.length - 1];
    } else if (lastLoRaStatus.waitingData || lastLoRaStatus.noDataMode) {
      ultimo = {
        device: "RECEPTOR_CASA",
        distance: -1,
        level: -1,
        percentage: -1,
        liters: -1,
        sensor_ok: false,
        timestamp: new Date().toISOString(),
        status: "waiting_data",
        message: "Aguardando dados do transmissor LoRa",
        lora_connected: false,
        no_data_mode: true,
        display_mode: "waiting",
        receptor_connected: true
      };
    } else if (historico.length > 0) {
      ultimo = historico[historico.length - 1];
    } else {
      ultimo = {
        device: "ESP32",
        distance: 0,
        level: 0,
        percentage: 0,
        liters: 0,
        sensor_ok: true,
        timestamp: new Date().toISOString(),
        lora_connected: true,
        no_data_mode: false,
        display_mode: "normal",
        receptor_connected: true
      };
    }
  }

  // Preparar histórico baseado no status
  let historicoParaDashboard;
  if (receptorDisconnectedMode) {
    // Quando receptor desconectado, enviar histórico vazio
    historicoParaDashboard = [];
  } else {
    // Quando conectado, enviar histórico normal
    historicoParaDashboard = historico.slice(-20).map(item => ({
      ...item,
      timestamp: item.timestamp || item.server_timestamp || item.received_at
    }));
  }

  const responseData = {
    ...ultimo,
    receptor_status: {
      connected: receptorStatus.connected,
      last_connection: new Date(receptorStatus.lastConnection).toISOString(),
      last_packet_time: receptorStatus.lastPacketTime ? 
        new Date(receptorStatus.lastPacketTime).toISOString() : null,
      time_since_last_packet: receptorStatus.lastPacketTime ? 
        Date.now() - receptorStatus.lastPacketTime : null,
      reconnection_count: receptorStatus.reconnectionCount
    },
    lora_connection_status: {
      connected: lastLoRaStatus.connected,
      waiting_data: lastLoRaStatus.waitingData,
      no_data_mode: lastLoRaStatus.noDataMode,
      last_status_update: lastLoRaStatus.lastStatusUpdate,
      last_packet_time: lastLoRaStatus.lastPacketTime,
      current_time: Date.now(),
      time_since_last_packet: lastLoRaStatus.lastPacketTime ? 
        Date.now() - lastLoRaStatus.lastPacketTime : null
    },
    historico: historicoParaDashboard,
    system_info: {
      total_readings: historico.length,
      normal_readings: historico.filter(item => item.status === "normal").length,
      waiting_readings: historico.filter(item => item.status === "waiting_data").length,
      receptor_disconnected_readings: historico.filter(item => item.status === "receptor_disconnected").length,
      uptime: process.uptime(),
      server_time: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      receptor_disconnected_mode: receptorDisconnectedMode
    }
  };

  res.json(responseData);
});

// Endpoint para dados de teste (sem autenticação)
app.get("/api/test", (req, res) => {
  const now = new Date();
  
  const testData = {
    device: "TX_CAIXA_01",
    distance: 45.5,
    level: 65,
    percentage: 59,
    liters: 2950,
    sensor_ok: true,
    timestamp: now.toISOString(),
    crc: "0x1234",
    message: "Dados de teste - API funcionando!",
    server_time: now.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    lora_connected: true,
    no_data_mode: false,
    display_mode: "normal",
    receptor_connected: true
  };
  
  res.json(testData);
});

// Endpoint para verificar status do sistema
app.get("/api/system/status", (req, res) => {
  checkReceptorConnection();
  
  res.json({
    receptor: receptorStatus,
    lora: lastLoRaStatus,
    historico: {
      total: historico.length,
      normal: historico.filter(item => item.status === "normal").length,
      waiting: historico.filter(item => item.status === "waiting_data").length,
      disconnected: historico.filter(item => item.status === "receptor_disconnected").length
    },
    server: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString(),
      node_version: process.version
    }
  });
});

// Endpoint para verificar tokens (debug)
app.get("/api/debug/tokens", (req, res) => {
  const allowedTokens = process.env.ALLOWED_TOKENS?.split(',') || [];
  res.json({
    allowed_tokens: allowedTokens,
    count: allowedTokens.length,
    note: "Use um desses tokens no header 'Authorization'"
  });
});

// Endpoint para verificar status LoRa
app.get("/api/lora/status", (req, res) => {
  checkReceptorConnection();
  
  res.json({
    receptor: receptorStatus,
    lora_connection: lastLoRaStatus,
    historico_count: historico.length,
    last_normal_reading: historico.filter(item => item.status === "normal").slice(-1)[0] || null,
    last_waiting_reading: historico.filter(item => item.status === "waiting_data").slice(-1)[0] || null,
    current_time: new Date().toISOString(),
    server_uptime: process.uptime()
  });
});

// Health check para Render
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    receptor_connected: receptorStatus.connected,
    receptor_last_seen: receptorStatus.lastPacketTime ? 
      new Date(receptorStatus.lastPacketTime).toISOString() : null
  });
});

// Servir arquivos estáticos
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
  console.log(`📊 Endpoints disponíveis:`);
  console.log(`   POST /api/lora          - Receber dados do ESP32 (com auth)`);
  console.log(`   GET  /api/lora          - Obter dados para dashboard`);
  console.log(`   GET  /api/test          - Dados de teste`);
  console.log(`   GET  /api/debug/tokens  - Ver tokens permitidos`);
  console.log(`   GET  /api/lora/status   - Status da conexão LoRa`);
  console.log(`   GET  /api/system/status - Status completo do sistema`);
  console.log(`   GET  /health            - Health check para Render`);
  console.log(`   GET  /                  - Dashboard HTML`);
  console.log(`🔐 Tokens permitidos: ${process.env.ALLOWED_TOKENS}`);
  console.log(`⏰ Servidor iniciado em: ${new Date().toISOString()}`);
  console.log(`📡 Monitoramento receptor: ATIVADO (timeout: ${receptorStatus.connectionTimeout/1000}s)`);
});
