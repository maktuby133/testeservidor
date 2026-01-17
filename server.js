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
  waitingData: false,
  signalQuality: null,
  rssi: null,
  snr: null
};

// Controle de conexão do receptor
let receptorStatus = {
  connected: true,
  lastConnection: Date.now(),
  lastPacketTime: null,
  lastHttpRequest: Date.now(), // Para medir tempo desde última requisição HTTP
  connectionTimeout: 120000, // 120 segundos para considerar desconectado (2 minutos)
  httpTimeout: 30000, // 30 segundos para considerar "aguardando LoRa"
  reconnectionCount: 0,
  wifiSignal: -50,
  lastWifiSignalUpdate: Date.now()
};

// Função para verificar status do receptor CORRIGIDA
function checkReceptorConnection() {
  const now = Date.now();
  const timeSinceLastHttp = now - receptorStatus.lastHttpRequest;
  
  console.log(`🔍 Verificação status receptor:`);
  console.log(`   Última requisição HTTP há: ${Math.floor(timeSinceLastHttp/1000)} segundos`);
  console.log(`   Último pacote LoRa há: ${receptorStatus.lastPacketTime ? Math.floor((now - receptorStatus.lastPacketTime)/1000) : 'Nunca'} segundos`);
  console.log(`   Receptor marcado como: ${receptorStatus.connected ? 'CONECTADO' : 'DESCONECTADO'}`);
  
  // REGRA 1: Receptor está DESCONECTADO se não envia requisições HTTP há mais de 2 minutos
  // (Isso significa que ESP32 perdeu WiFi ou desligou)
  const shouldBeConnected = timeSinceLastHttp < receptorStatus.connectionTimeout;
  
  if (receptorStatus.connected !== shouldBeConnected) {
    receptorStatus.connected = shouldBeConnected;
    
    if (!receptorStatus.connected) {
      console.log(`\n⚠️  ⚠️  ⚠️  RECEPTOR ESP32 DESCONECTADO!`);
      console.log(`   Sem requisições HTTP há ${Math.floor(timeSinceLastHttp/1000)} segundos`);
      console.log(`   Provável causa: ESP32 perdeu WiFi, desligou ou sem energia`);
      console.log(`   Último contato: ${new Date(receptorStatus.lastHttpRequest).toLocaleTimeString()}\n`);
      
      // Limpar histórico quando receptor realmente desconectar
      historico = [];
      console.log("   📭 Histórico LIMPO devido à desconexão REAL do receptor");
      
      // Atualizar status LoRa também
      lastLoRaStatus.connected = false;
      lastLoRaStatus.waitingData = true;
      lastLoRaStatus.noDataMode = true;
      lastLoRaStatus.lastStatusUpdate = new Date().toISOString();
    } else {
      receptorStatus.reconnectionCount++;
      console.log(`\n✅ RECEPTOR ESP32 RECONECTADO!`);
      console.log(`   Reconexão #${receptorStatus.reconnectionCount}`);
      console.log(`   Recebida requisição HTTP após ${Math.floor(timeSinceLastHttp/1000)} segundos\n`);
    }
  }
  
  // REGRA 2: Aguardando LoRa se receptor envia HTTP mas não tem dados LoRa há mais de 30 segundos
  // (Isso é separado da conexão WiFi do receptor)
  const timeSinceLoRaPacket = receptorStatus.lastPacketTime ? now - receptorStatus.lastPacketTime : Infinity;
  const isWaitingLoRa = receptorStatus.connected && timeSinceLoRaPacket > receptorStatus.httpTimeout;
  
  if (isWaitingLoRa && !lastLoRaStatus.waitingData) {
    console.log(`\n📡 STATUS LoRa: AGUARDANDO TRANSMISSÃO`);
    console.log(`   Receptor conectado ao WiFi/servidor`);
    console.log(`   Mas sem dados LoRa há ${Math.floor(timeSinceLoRaPacket/1000)} segundos`);
    console.log(`   Causa: Transmissor off, fora de alcance ou problemas LoRa\n`);
    
    lastLoRaStatus.connected = false;
    lastLoRaStatus.waitingData = true;
    lastLoRaStatus.noDataMode = true;
    lastLoRaStatus.lastStatusUpdate = new Date().toISOString();
  } else if (!isWaitingLoRa && lastLoRaStatus.waitingData && receptorStatus.connected) {
    console.log(`\n✅ STATUS LoRa: TRANSMISSÃO RESTAURADA`);
    console.log(`   Recebendo dados LoRa normalmente\n`);
    
    lastLoRaStatus.connected = true;
    lastLoRaStatus.waitingData = false;
    lastLoRaStatus.noDataMode = false;
  }
}

// Executar verificação a cada 10 segundos
setInterval(checkReceptorConnection, 10000);

// Middleware de autenticação
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization;
  const allowedTokens = process.env.ALLOWED_TOKENS?.split(',') || [];
  
  // Atualizar tempo da última requisição HTTP (receptor está vivo!)
  receptorStatus.lastHttpRequest = Date.now();
  
  if (!token || !allowedTokens.includes(token)) {
    console.log("❌ Token inválido ou não fornecido");
    return res.status(401).json({ 
      error: "Token inválido",
      message: "Use um token válido no header 'Authorization'",
      allowed_tokens: allowedTokens
    });
  }
  
  next();
};

// Recebe dados do ESP32 receptor
app.post("/api/lora", authMiddleware, (req, res) => {
  console.log("📥 Dados recebidos:", JSON.stringify(req.body, null, 2));
  
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
    message,
    wifi_rssi,
    lora_rssi,
    lora_snr
  } = req.body;

  // ATUALIZAR STATUS DO RECEPTOR - ele está enviando HTTP, então está CONECTADO
  receptorStatus.lastConnection = Date.now();
  receptorStatus.lastHttpRequest = Date.now();
  receptorStatus.connected = true;
  
  // Atualizar qualidade do WiFi se disponível
  if (wifi_rssi !== undefined) {
    receptorStatus.wifiSignal = wifi_rssi;
    receptorStatus.lastWifiSignalUpdate = Date.now();
  }

  // Verificar tipo de pacote
  const isStatusPacket = req.headers['x-packet-type'] === 'status' || receptor_status !== undefined;
  const isNoDataPacket = req.headers['x-no-data'] === 'true' || no_data === true || no_data_mode === true;
  
  if (isNoDataPacket) {
    console.log("📭 PACOTE DE STATUS: AGUARDANDO TRANSMISSÃO LoRa");
    
    // Atualizar sinal LoRa se disponível
    if (lora_rssi !== undefined) {
      lastLoRaStatus.rssi = lora_rssi;
      lastLoRaStatus.snr = lora_snr;
      lastLoRaStatus.signalQuality = calculateSignalQuality(lora_rssi, lora_snr);
    }
    
    // IMPORTANTE: Receptor está CONECTADO, apenas aguardando LoRa
    lastLoRaStatus.connected = false;
    lastLoRaStatus.waitingData = true;
    lastLoRaStatus.noDataMode = true;
    lastLoRaStatus.lastStatusUpdate = new Date().toISOString();
    
    // Criar registro especial para "Aguardando LoRa"
    const waitingLoRaRecord = {
      device: device || "RECEPTOR_CASA",
      distance: -1,
      level: -1,
      percentage: -1,
      liters: -1,
      sensor_ok: false,
      timestamp: new Date().toISOString(),
      crc: "WAITING_LORA",
      received_at: new Date().toISOString(),
      source_timestamp: timestamp || null,
      server_timestamp: new Date().toISOString(),
      status: "waiting_lora", // Status correto
      message: message || "Aguardando transmissão LoRa - Receptor conectado",
      lora_connected: false,
      no_data_mode: true,
      receptor_connected: true, // IMPORTANTE: Receptor CONECTADO
      wifi_signal: wifi_rssi || null,
      lora_signal: {
        rssi: lora_rssi || null,
        snr: lora_snr || null,
        quality: lastLoRaStatus.signalQuality
      }
    };
    
    historico.push(waitingLoRaRecord);
    if (historico.length > 100) historico.shift();
    
    return res.json({ 
      status: "ok", 
      message: "Status 'Aguardando LoRa' registrado",
      record: waitingLoRaRecord,
      lora_connected: false,
      waiting_data: true,
      receptor_connected: true, // Receptor está conectado
      signal_quality: lastLoRaStatus.signalQuality,
      status_type: "waiting_lora"
    });
  }
  
  if (isStatusPacket) {
    console.log("📡 Pacote de status LoRa recebido");
    
    if (lora_rssi !== undefined) {
      lastLoRaStatus.rssi = lora_rssi;
      lastLoRaStatus.snr = lora_snr;
      lastLoRaStatus.signalQuality = calculateSignalQuality(lora_rssi, lora_snr);
    }
    
    lastLoRaStatus.connected = receptor_status === 'connected';
    lastLoRaStatus.waitingData = receptor_status === 'disconnected';
    lastLoRaStatus.noDataMode = no_data_mode === true;
    lastLoRaStatus.lastStatusUpdate = new Date().toISOString();
    
    return res.json({ 
      status: "ok", 
      message: "Status LoRa atualizado",
      lora_connected: lastLoRaStatus.connected,
      waiting_data: lastLoRaStatus.waitingData,
      receptor_connected: true, // Receptor está conectado
      signal_quality: lastLoRaStatus.signalQuality,
      lora_signal: {
        rssi: lastLoRaStatus.rssi,
        snr: lastLoRaStatus.snr,
        quality: lastLoRaStatus.signalQuality
      }
    });
  }

  // PACOTE NORMAL DE DADOS LoRa
  console.log("📦 PACOTE NORMAL LoRa RECEBIDO");
  
  const finalTimestamp = timestamp ? new Date(parseInt(timestamp)).toISOString() : new Date().toISOString();

  // Atualizar sinal LoRa
  if (lora_rssi !== undefined) {
    lastLoRaStatus.rssi = lora_rssi;
    lastLoRaStatus.snr = lora_snr;
    lastLoRaStatus.signalQuality = calculateSignalQuality(lora_rssi, lora_snr);
  }

  // Registrar tempo do último pacote LoRa
  receptorStatus.lastPacketTime = Date.now();
  
  const registro = {
    device: device || "ESP32_TX",
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
    receptor_connected: true, // Receptor conectado
    wifi_signal: wifi_rssi || null,
    lora_signal: {
      rssi: lora_rssi || null,
      snr: lora_snr || null,
      quality: lastLoRaStatus.signalQuality
    }
  };

  console.log("📊 Registro salvo:", registro);
  console.log("⏰ Receptor WiFi: CONECTADO");
  console.log("📡 LoRa: TRANSMITINDO DADOS");
  if (lora_rssi !== undefined) {
    console.log(`   📶 Sinal LoRa: RSSI=${lora_rssi} dBm, SNR=${lora_snr} dB, Qualidade=${lastLoRaStatus.signalQuality}%`);
  }
  
  historico.push(registro);
  if (historico.length > 100) historico.shift();
  
  // Atualizar status LoRa
  lastLoRaStatus.connected = true;
  lastLoRaStatus.waitingData = false;
  lastLoRaStatus.noDataMode = false;
  lastLoRaStatus.lastPacketTime = Date.now();

  res.json({ 
    status: "ok", 
    message: "Dados LoRa recebidos com sucesso!",
    recebido: registro,
    historico_count: historico.length,
    receptor_connected: true,
    lora_connected: true,
    signal_quality: lastLoRaStatus.signalQuality,
    lora_signal: {
      rssi: lastLoRaStatus.rssi,
      snr: lastLoRaStatus.snr,
      quality: lastLoRaStatus.signalQuality
    }
  });
});

// Função para calcular qualidade do sinal
function calculateSignalQuality(rssi, snr) {
  if (rssi === null || rssi === undefined) return 50;
  
  let quality = 0;
  
  if (rssi >= -40) quality = 100;
  else if (rssi >= -50) quality = 95;
  else if (rssi >= -60) quality = 85;
  else if (rssi >= -70) quality = 75;
  else if (rssi >= -80) quality = 65;
  else if (rssi >= -90) quality = 50;
  else if (rssi >= -100) quality = 30;
  else if (rssi >= -110) quality = 15;
  else quality = 5;
  
  if (snr !== null && snr !== undefined) {
    if (snr > 10) quality = Math.min(100, quality + 15);
    else if (snr > 5) quality = Math.min(100, quality + 10);
    else if (snr < -5) quality = Math.max(0, quality - 20);
    else if (snr < 0) quality = Math.max(0, quality - 10);
  }
  
  return Math.round(Math.max(0, Math.min(100, quality)));
}

// Fornece dados para o dashboard
app.get("/api/lora", (req, res) => {
  // Atualizar que recebemos uma requisição HTTP (dashboard acessando)
  receptorStatus.lastHttpRequest = Date.now();
  
  // Verificar status
  checkReceptorConnection();
  
  let ultimo;
  let displayMode = "normal";
  let statusMessage = "Sistema funcionando normalmente";
  
  console.log(`\n📊 Dashboard solicitando dados:`);
  console.log(`   Receptor conectado: ${receptorStatus.connected ? 'SIM' : 'NÃO'}`);
  console.log(`   LoRa conectado: ${lastLoRaStatus.connected ? 'SIM' : 'NÃO'}`);
  console.log(`   Aguardando LoRa: ${lastLoRaStatus.waitingData ? 'SIM' : 'NÃO'}`);
  
  // DECISÃO DE STATUS BASEADA NAS NOVAS REGRAS:
  
  // 1. RECEPTOR DESCONECTADO (perdeu WiFi/desligou)
  if (!receptorStatus.connected) {
    console.log("   → MODO: RECEPTOR DESCONECTADO");
    displayMode = "receptor_disconnected";
    statusMessage = "RECEPTOR ESP32 DESCONECTADO - Verifique WiFi/alimentação";
    
    ultimo = {
      device: "RECEPTOR_CASA",
      distance: -1,
      level: -1,
      percentage: -1,
      liters: -1,
      sensor_ok: false,
      timestamp: new Date().toISOString(),
      status: "receptor_disconnected",
      message: statusMessage,
      lora_connected: false,
      no_data_mode: true,
      display_mode: displayMode,
      receptor_connected: false, // IMPORTANTE: false aqui
      wifi_signal: receptorStatus.wifiSignal,
      lora_signal: {
        rssi: lastLoRaStatus.rssi,
        snr: lastLoRaStatus.snr,
        quality: lastLoRaStatus.signalQuality
      }
    };
    
  } 
  // 2. RECEPTOR CONECTADO mas AGUARDANDO LoRa
  else if (receptorStatus.connected && lastLoRaStatus.waitingData) {
    console.log("   → MODO: AGUARDANDO TRANSMISSÃO LoRa");
    displayMode = "waiting_lora";
    statusMessage = "Aguardando transmissão LoRa - Receptor conectado";
    
    ultimo = {
      device: "RECEPTOR_CASA",
      distance: -1,
      level: -1,
      percentage: -1,
      liters: -1,
      sensor_ok: false,
      timestamp: new Date().toISOString(),
      status: "waiting_lora",
      message: statusMessage,
      lora_connected: false,
      no_data_mode: true,
      display_mode: displayMode,
      receptor_connected: true, // IMPORTANTE: true aqui
      wifi_signal: receptorStatus.wifiSignal,
      lora_signal: {
        rssi: lastLoRaStatus.rssi,
        snr: lastLoRaStatus.snr,
        quality: lastLoRaStatus.signalQuality
      }
    };
    
  }
  // 3. TUDO NORMAL - Recebendo dados LoRa
  else if (receptorStatus.connected && lastLoRaStatus.connected) {
    console.log("   → MODO: NORMAL");
    
    // Buscar último dado normal
    const recentNormalData = historico.filter(item => item.status === "normal");
    
    if (recentNormalData.length > 0) {
      ultimo = recentNormalData[recentNormalData.length - 1];
      ultimo.display_mode = "normal";
      ultimo.receptor_connected = true;
    } else {
      ultimo = {
        device: "ESP32_TX",
        distance: 0,
        level: 0,
        percentage: 0,
        liters: 0,
        sensor_ok: true,
        timestamp: new Date().toISOString(),
        status: "normal",
        message: "Sistema pronto - Aguardando primeira leitura",
        lora_connected: true,
        no_data_mode: false,
        display_mode: "normal",
        receptor_connected: true,
        wifi_signal: receptorStatus.wifiSignal,
        lora_signal: {
          rssi: lastLoRaStatus.rssi,
          snr: lastLoRaStatus.snr,
          quality: lastLoRaStatus.signalQuality
        }
      };
    }
    
  }
  // 4. FALLBACK
  else {
    console.log("   → MODO: INDETERMINADO (usando fallback)");
    
    ultimo = {
      device: "SISTEMA",
      distance: -1,
      level: -1,
      percentage: -1,
      liters: -1,
      sensor_ok: false,
      timestamp: new Date().toISOString(),
      status: "unknown",
      message: "Status do sistema sendo verificado...",
      lora_connected: lastLoRaStatus.connected,
      no_data_mode: lastLoRaStatus.noDataMode,
      display_mode: "unknown",
      receptor_connected: receptorStatus.connected,
      wifi_signal: receptorStatus.wifiSignal,
      lora_signal: {
        rssi: lastLoRaStatus.rssi,
        snr: lastLoRaStatus.snr,
        quality: lastLoRaStatus.signalQuality
      }
    };
  }

  // Preparar histórico baseado no status
  let historicoParaDashboard = [];
  
  if (receptorStatus.connected) {
    // Se receptor conectado, mostrar histórico
    historicoParaDashboard = historico.slice(-20).map(item => ({
      ...item,
      timestamp: item.timestamp || item.server_timestamp || item.received_at
    }));
  }
  // Se receptor desconectado, histórico vazio (já foi limpo)

  const responseData = {
    ...ultimo,
    receptor_status: {
      connected: receptorStatus.connected,
      last_http_request: new Date(receptorStatus.lastHttpRequest).toISOString(),
      last_packet_time: receptorStatus.lastPacketTime ? 
        new Date(receptorStatus.lastPacketTime).toISOString() : null,
      time_since_last_http: Date.now() - receptorStatus.lastHttpRequest,
      reconnection_count: receptorStatus.reconnectionCount,
      wifi_signal: receptorStatus.wifiSignal,
      status_description: receptorStatus.connected ? 
        "Receptor ESP32 conectado ao WiFi e servidor" : 
        "Receptor ESP32 desconectado - Verifique alimentação/WiFi"
    },
    lora_connection_status: {
      connected: lastLoRaStatus.connected,
      waiting_data: lastLoRaStatus.waitingData,
      no_data_mode: lastLoRaStatus.noDataMode,
      last_status_update: lastLoRaStatus.lastStatusUpdate,
      last_packet_time: lastLoRaStatus.lastPacketTime,
      current_time: Date.now(),
      time_since_last_packet: lastLoRaStatus.lastPacketTime ? 
        Date.now() - lastLoRaStatus.lastPacketTime : null,
      signal_quality: lastLoRaStatus.signalQuality,
      rssi: lastLoRaStatus.rssi,
      snr: lastLoRaStatus.snr,
      status_description: lastLoRaStatus.connected ? 
        "Transmissão LoRa ativa" : 
        (lastLoRaStatus.waitingData ? 
          "Aguardando transmissão LoRa - Verifique transmissor" : 
          "Status LoRa desconhecido")
    },
    historico: historicoParaDashboard,
    system_info: {
      total_readings: historico.length,
      normal_readings: historico.filter(item => item.status === "normal").length,
      waiting_lora_readings: historico.filter(item => item.status === "waiting_lora").length,
      receptor_disconnected_readings: historico.filter(item => item.status === "receptor_disconnected").length,
      uptime: process.uptime(),
      server_time: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      display_mode: displayMode
    }
  };

  res.json(responseData);
});

// Endpoint para dados de teste
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
    receptor_connected: true,
    wifi_signal: -65,
    lora_signal: {
      rssi: -75,
      snr: 8.5,
      quality: 80
    }
  };
  
  res.json(testData);
});

// Endpoint para simular status
app.get("/api/simulate/:status", (req, res) => {
  const status = req.params.status;
  
  switch(status) {
    case "normal":
      receptorStatus.connected = true;
      lastLoRaStatus.connected = true;
      lastLoRaStatus.waitingData = false;
      break;
    case "waiting_lora":
      receptorStatus.connected = true;
      lastLoRaStatus.connected = false;
      lastLoRaStatus.waitingData = true;
      break;
    case "receptor_disconnected":
      receptorStatus.connected = false;
      lastLoRaStatus.connected = false;
      lastLoRaStatus.waitingData = true;
      break;
  }
  
  res.json({
    status: "simulated",
    receptor_connected: receptorStatus.connected,
    lora_connected: lastLoRaStatus.connected,
    waiting_lora: lastLoRaStatus.waitingData
  });
});

// Endpoint para verificar status do sistema
app.get("/api/system/status", (req, res) => {
  checkReceptorConnection();
  
  res.json({
    receptor: {
      ...receptorStatus,
      last_http_request: new Date(receptorStatus.lastHttpRequest).toISOString(),
      time_since_last_http: Date.now() - receptorStatus.lastHttpRequest,
      status_description: receptorStatus.connected ? 
        "Receptor conectado (enviando requisições HTTP)" : 
        "Receptor desconectado (sem requisições HTTP)"
    },
    lora: {
      ...lastLoRaStatus,
      status_description: lastLoRaStatus.connected ? 
        "LoRa transmitindo" : 
        (lastLoRaStatus.waitingData ? 
          "Aguardando transmissão LoRa" : 
          "Status LoRa desconhecido")
    },
    historico: {
      total: historico.length,
      normal: historico.filter(item => item.status === "normal").length,
      waiting_lora: historico.filter(item => item.status === "waiting_lora").length,
      receptor_disconnected: historico.filter(item => item.status === "receptor_disconnected").length
    }
  });
});

// Endpoint para verificar tokens
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
    receptor_status: receptorStatus.connected ? "connected" : "disconnected",
    receptor_description: receptorStatus.connected ? 
      "ESP32 receptor conectado ao WiFi e servidor" : 
      "ESP32 receptor desconectado (sem requisições HTTP há >2min)",
    lora_status: lastLoRaStatus.connected ? "connected" : "disconnected",
    lora_description: lastLoRaStatus.connected ? 
      "Recebendo dados LoRa normalmente" : 
      (lastLoRaStatus.waitingData ? 
        "Aguardando transmissão LoRa (receptor conectado)" : 
        "Status LoRa desconhecido"),
    signal_quality: lastLoRaStatus.signalQuality,
    current_time: new Date().toISOString()
  });
});

// Health check para Render
app.get("/health", (req, res) => {
  checkReceptorConnection();
  
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    receptor_connected: receptorStatus.connected,
    receptor_last_seen: new Date(receptorStatus.lastHttpRequest).toISOString(),
    time_since_receptor_last_seen: Date.now() - receptorStatus.lastHttpRequest,
    lora_connected: lastLoRaStatus.connected,
    lora_waiting: lastLoRaStatus.waitingData,
    lora_signal_quality: lastLoRaStatus.signalQuality,
    system_mode: !receptorStatus.connected ? "receptor_disconnected" : 
                (lastLoRaStatus.waitingData ? "waiting_lora" : "normal")
  });
});

// Servir arquivos estáticos
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 SERVIDOR INICIADO - SISTEMA DE STATUS CORRIGIDO`);
  console.log(`==================================================`);
  console.log(`✅ Servidor rodando na porta ${PORT}`);
  console.log(`📡 Sistema de status aprimorado:`);
  console.log(`   • Receptor desconectado = Sem HTTP há 2 minutos`);
  console.log(`   • Aguardando LoRa = Receptor conectado, sem dados LoRa há 30s`);
  console.log(`   • Normal = Receptor conectado + dados LoRa`);
  console.log(`\n📊 Endpoints:`);
  console.log(`   POST /api/lora            - Receber dados ESP32`);
  console.log(`   GET  /api/lora            - Dashboard`);
  console.log(`   GET  /api/test            - Dados de teste`);
  console.log(`   GET  /api/system/status   - Status completo`);
  console.log(`   GET  /api/lora/status     - Status LoRa`);
  console.log(`   GET  /health              - Health check`);
  console.log(`   GET  /                    - Dashboard HTML`);
  console.log(`\n🔐 Tokens permitidos: ${process.env.ALLOWED_TOKENS}`);
  console.log(`⏰ Início: ${new Date().toLocaleString()}`);
  console.log(`📡 Aguardando conexões...\n`);
});
