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

// Controle de conexão do receptor - AGORA COM TEMPORIZADOR ATIVO
let receptorStatus = {
  connected: true,
  lastConnection: Date.now(),
  lastPacketTime: null,
  lastHttpRequest: Date.now(), // Para medir tempo desde última requisição HTTP
  connectionTimeout: 45000, // 45 segundos para considerar desconectado
  httpTimeout: 15000, // 15 segundos para considerar "aguardando LoRa"
  reconnectionCount: 0,
  wifiSignal: -50,
  lastWifiSignalUpdate: Date.now(),
  lastDashboardCheck: Date.now() // Quando o dashboard pediu dados pela última vez
};

// Variável global para o dashboard saber se deve mostrar "receptor desconectado"
let receptorDisconnectedForDashboard = false;

// Função para verificar status do receptor - EXECUTADA A CADA REQUEST E INTERVALO
function checkReceptorConnection(forceCheck = false) {
  const now = Date.now();
  const timeSinceLastHttp = now - receptorStatus.lastHttpRequest;
  
  // Se forçado ou se passou 5 segundos desde a última verificação
  if (forceCheck || now - receptorStatus.lastDashboardCheck > 5000) {
    receptorStatus.lastDashboardCheck = now;
    
    console.log(`\n🔍 VERIFICAÇÃO AUTOMÁTICA STATUS (${new Date().toLocaleTimeString()}):`);
    console.log(`   📡 Última req. HTTP há: ${Math.floor(timeSinceLastHttp/1000)} segundos`);
    
    // REGRA PRINCIPAL: Se não recebeu HTTP há mais de X segundos, receptor OFFLINE
    if (timeSinceLastHttp > receptorStatus.connectionTimeout) {
      if (receptorStatus.connected) {
        console.log(`\n⚠️ ⚠️ ⚠️  ALERTA: RECEPTOR ESP32 PERDEU CONEXÃO!`);
        console.log(`   Sem requisições HTTP há ${Math.floor(timeSinceLastHttp/1000)} segundos`);
        console.log(`   Último contato: ${new Date(receptorStatus.lastHttpRequest).toLocaleTimeString()}`);
        console.log(`   Causa provável: ESP32 perdeu WiFi, desligou ou sem energia\n`);
        
        receptorStatus.connected = false;
        receptorDisconnectedForDashboard = true;
        
        // Limpar histórico
        historico = [];
        console.log("   📭 Histórico LIMPO - Receptor offline");
        
        // Também marcar LoRa como desconectado
        lastLoRaStatus.connected = false;
        lastLoRaStatus.waitingData = true;
        lastLoRaStatus.noDataMode = true;
        lastLoRaStatus.lastStatusUpdate = new Date().toISOString();
      }
    } 
    // REGRA 2: Receptor está online mas sem dados LoRa há um tempo
    else if (timeSinceLastHttp < receptorStatus.connectionTimeout) {
      // Receptor está enviando HTTP (está online)
      if (!receptorStatus.connected) {
        receptorStatus.connected = true;
        receptorStatus.reconnectionCount++;
        receptorDisconnectedForDashboard = false;
        
        console.log(`\n✅ RECEPTOR ESP32 RECONECTOU!`);
        console.log(`   Reconexão #${receptorStatus.reconnectionCount}`);
        console.log(`   Recebida requisição HTTP após ${Math.floor(timeSinceLastHttp/1000)} segundos\n`);
      }
      
      // Verificar se está aguardando LoRa (tem HTTP mas não tem pacotes LoRa)
      const timeSinceLoRaPacket = receptorStatus.lastPacketTime ? now - receptorStatus.lastPacketTime : Infinity;
      
      if (timeSinceLoRaPacket > receptorStatus.httpTimeout) {
        if (!lastLoRaStatus.waitingData) {
          console.log(`\n📡 STATUS LoRa: AGUARDANDO TRANSMISSÃO`);
          console.log(`   Receptor online (envia HTTP a cada ${Math.floor(timeSinceLastHttp/1000)}s)`);
          console.log(`   Mas sem dados LoRa há ${Math.floor(timeSinceLoRaPacket/1000)} segundos`);
          console.log(`   Causa: Transmissor off, fora de alcance ou problemas LoRa\n`);
          
          lastLoRaStatus.connected = false;
          lastLoRaStatus.waitingData = true;
          lastLoRaStatus.noDataMode = true;
          lastLoRaStatus.lastStatusUpdate = new Date().toISOString();
        }
      } else if (lastLoRaStatus.waitingData) {
        console.log(`\n✅ STATUS LoRa: TRANSMISSÃO RESTAURADA`);
        console.log(`   Recebendo dados LoRa normalmente\n`);
        
        lastLoRaStatus.connected = true;
        lastLoRaStatus.waitingData = false;
        lastLoRaStatus.noDataMode = false;
      }
    }
  }
}

// Middleware para TODAS as requisições - atualiza o timestamp
app.use((req, res, next) => {
  // Se for uma requisição do ESP32 receptor, atualizar timestamp
  if (req.path === "/api/lora" && req.method === "POST") {
    receptorStatus.lastHttpRequest = Date.now();
    
    // Verificar se estava marcado como desconectado
    if (!receptorStatus.connected || receptorDisconnectedForDashboard) {
      receptorStatus.connected = true;
      receptorDisconnectedForDashboard = false;
      receptorStatus.reconnectionCount++;
      
      console.log(`\n🔌 RECEPTOR RECONECTOU VIA POST!`);
      console.log(`   Reconexão #${receptorStatus.reconnectionCount}`);
    }
  }
  
  // Se for requisição do dashboard, também verificar status
  if (req.path === "/api/lora" && req.method === "GET") {
    receptorStatus.lastDashboardCheck = Date.now();
    // Forçar verificação quando dashboard pede dados
    setTimeout(() => checkReceptorConnection(true), 100);
  }
  
  next();
});

// Middleware de autenticação
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization;
  const allowedTokens = process.env.ALLOWED_TOKENS?.split(',') || [];
  
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
  console.log("📥 Dados recebidos do ESP32 Receptor");
  
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

  // Receptor está definitivamente CONECTADO (acabou de enviar HTTP)
  receptorStatus.connected = true;
  receptorDisconnectedForDashboard = false;
  
  // Atualizar qualidade do WiFi
  if (wifi_rssi !== undefined) {
    receptorStatus.wifiSignal = wifi_rssi;
    receptorStatus.lastWifiSignalUpdate = Date.now();
  }

  // Verificar tipo de pacote
  const isStatusPacket = req.headers['x-packet-type'] === 'status' || receptor_status !== undefined;
  const isNoDataPacket = req.headers['x-no-data'] === 'true' || no_data === true || no_data_mode === true;
  
  if (isNoDataPacket) {
    console.log("📭 Receptor online, mas AGUARDANDO TRANSMISSÃO LoRa");
    
    // Atualizar sinal LoRa
    if (lora_rssi !== undefined) {
      lastLoRaStatus.rssi = lora_rssi;
      lastLoRaStatus.snr = lora_snr;
      lastLoRaStatus.signalQuality = calculateSignalQuality(lora_rssi, lora_snr);
    }
    
    // Receptor CONECTADO, apenas aguardando LoRa
    lastLoRaStatus.connected = false;
    lastLoRaStatus.waitingData = true;
    lastLoRaStatus.noDataMode = true;
    lastLoRaStatus.lastStatusUpdate = new Date().toISOString();
    
    // Criar registro
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
      status: "waiting_lora",
      message: message || "Receptor online, aguardando transmissão LoRa",
      lora_connected: false,
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
      receptor_connected: true,
      lora_connected: false
    });
  }
  
  if (isStatusPacket) {
    console.log("📡 Status LoRa recebido");
    
    if (lora_rssi !== undefined) {
      lastLoRaStatus.rssi = lora_rssi;
      lastLoRaStatus.snr = lora_snr;
      lastLoRaStatus.signalQuality = calculateSignalQuality(lora_rssi, lora_snr);
    }
    
    return res.json({ 
      status: "ok", 
      receptor_connected: true
    });
  }

  // PACOTE NORMAL DE DADOS LoRa
  console.log("📦 Dados LoRa recebidos - Sistema NORMAL");
  
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
    timestamp: new Date().toISOString(),
    crc: crc || "N/A",
    received_at: new Date().toISOString(),
    status: "normal",
    lora_connected: true,
    receptor_connected: true,
    wifi_signal: wifi_rssi || null,
    lora_signal: {
      rssi: lora_rssi || null,
      snr: lora_snr || null,
      quality: lastLoRaStatus.signalQuality
    }
  };

  historico.push(registro);
  if (historico.length > 100) historico.shift();
  
  // Atualizar status LoRa
  lastLoRaStatus.connected = true;
  lastLoRaStatus.waitingData = false;
  lastLoRaStatus.noDataMode = false;

  res.json({ 
    status: "ok", 
    message: "Dados recebidos!",
    receptor_connected: true,
    lora_connected: true
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

// Fornece dados para o dashboard - AGORA COM VERIFICAÇÃO AUTOMÁTICA
app.get("/api/lora", (req, res) => {
  // Forçar verificação de status ANTES de responder
  checkReceptorConnection(true);
  
  let ultimo;
  let displayMode = "normal";
  let statusMessage = "Sistema funcionando normalmente";
  
  console.log(`\n📊 Dashboard solicitou dados (${new Date().toLocaleTimeString()})`);
  console.log(`   Receptor HTTP ativo: ${receptorStatus.connected ? 'SIM' : 'NÃO'}`);
  console.log(`   Dashboard vê como: ${receptorDisconnectedForDashboard ? 'DESCONECTADO' : 'CONECTADO'}`);
  console.log(`   LoRa: ${lastLoRaStatus.connected ? 'ATIVO' : 'INATIVO'}`);
  
  // DECISÃO BASEADA NO STATUS ATUAL:
  
  // 1. RECEPTOR DESCONECTADO (dashboard detectou falta de HTTP)
  if (receptorDisconnectedForDashboard || !receptorStatus.connected) {
    console.log("   → MODO DASHBOARD: RECEPTOR DESCONECTADO");
    displayMode = "receptor_disconnected";
    statusMessage = "RECEPTOR ESP32 DESCONECTADO - Sem comunicação há 45+ segundos";
    
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
      display_mode: displayMode,
      receptor_connected: false, // false = receptor offline
      wifi_signal: receptorStatus.wifiSignal,
      lora_signal: {
        rssi: lastLoRaStatus.rssi,
        snr: lastLoRaStatus.snr,
        quality: lastLoRaStatus.signalQuality
      }
    };
    
  } 
  // 2. RECEPTOR CONECTADO mas AGUARDANDO LoRa
  else if (lastLoRaStatus.waitingData) {
    console.log("   → MODO DASHBOARD: AGUARDANDO LoRa");
    displayMode = "waiting_lora";
    statusMessage = "Receptor online, aguardando transmissão LoRa";
    
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
      display_mode: displayMode,
      receptor_connected: true, // true = receptor online
      wifi_signal: receptorStatus.wifiSignal,
      lora_signal: {
        rssi: lastLoRaStatus.rssi,
        snr: lastLoRaStatus.snr,
        quality: lastLoRaStatus.signalQuality
      }
    };
    
  }
  // 3. TUDO NORMAL
  else if (lastLoRaStatus.connected) {
    console.log("   → MODO DASHBOARD: NORMAL");
    
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
        message: "Sistema pronto",
        lora_connected: true,
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
    console.log("   → MODO DASHBOARD: INDETERMINADO");
    
    ultimo = {
      device: "SISTEMA",
      distance: -1,
      level: -1,
      percentage: -1,
      liters: -1,
      sensor_ok: false,
      timestamp: new Date().toISOString(),
      status: "unknown",
      message: "Verificando status...",
      lora_connected: lastLoRaStatus.connected,
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

  // Preparar histórico (vazio se receptor desconectado)
  let historicoParaDashboard = receptorDisconnectedForDashboard ? [] : 
    historico.slice(-20).map(item => ({
      ...item,
      timestamp: item.timestamp || item.received_at
    }));

  const responseData = {
    ...ultimo,
    receptor_status: {
      connected: !receptorDisconnectedForDashboard, // Dashboard deve ver isso
      last_http_request: new Date(receptorStatus.lastHttpRequest).toISOString(),
      time_since_last_http: Date.now() - receptorStatus.lastHttpRequest,
      seconds_since_last_http: Math.floor((Date.now() - receptorStatus.lastHttpRequest) / 1000),
      reconnection_count: receptorStatus.reconnectionCount,
      wifi_signal: receptorStatus.wifiSignal,
      status_description: receptorDisconnectedForDashboard ? 
        `Receptor offline - Sem comunicação há ${Math.floor((Date.now() - receptorStatus.lastHttpRequest) / 1000)} segundos` : 
        "Receptor online e comunicando"
    },
    lora_connection_status: {
      connected: lastLoRaStatus.connected,
      waiting_data: lastLoRaStatus.waitingData,
      signal_quality: lastLoRaStatus.signalQuality,
      rssi: lastLoRaStatus.rssi,
      snr: lastLoRaStatus.snr,
      status_description: lastLoRaStatus.connected ? 
        "Transmissão LoRa ativa" : 
        (lastLoRaStatus.waitingData ? 
          "Aguardando transmissão LoRa" : 
          "Status LoRa desconhecido")
    },
    historico: historicoParaDashboard,
    system_info: {
      total_readings: historico.length,
      server_time: new Date().toISOString(),
      server_uptime: process.uptime(),
      display_mode: displayMode,
      check_timestamp: new Date().toISOString()
    }
  };

  res.json(responseData);
});

// Health check - também verifica status
app.get("/health", (req, res) => {
  checkReceptorConnection(true);
  
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    receptor: {
      connected: !receptorDisconnectedForDashboard,
      last_http: new Date(receptorStatus.lastHttpRequest).toISOString(),
      seconds_since_last_http: Math.floor((Date.now() - receptorStatus.lastHttpRequest) / 1000),
      dashboard_sees_as: receptorDisconnectedForDashboard ? "disconnected" : "connected"
    },
    lora: {
      connected: lastLoRaStatus.connected,
      waiting: lastLoRaStatus.waitingData
    }
  });
});

// Endpoint para forçar status (para testes)
app.get("/api/status/force/:status", (req, res) => {
  const status = req.params.status;
  
  switch(status) {
    case "connected":
      receptorStatus.connected = true;
      receptorDisconnectedForDashboard = false;
      receptorStatus.lastHttpRequest = Date.now();
      break;
    case "disconnected":
      receptorStatus.connected = false;
      receptorDisconnectedForDashboard = true;
      receptorStatus.lastHttpRequest = Date.now() - 60000; // 1 minuto atrás
      break;
    case "waiting_lora":
      lastLoRaStatus.connected = false;
      lastLoRaStatus.waitingData = true;
      break;
    case "normal":
      receptorStatus.connected = true;
      receptorDisconnectedForDashboard = false;
      lastLoRaStatus.connected = true;
      lastLoRaStatus.waitingData = false;
      receptorStatus.lastHttpRequest = Date.now();
      break;
  }
  
  res.json({
    forced: status,
    receptor_disconnected_for_dashboard: receptorDisconnectedForDashboard,
    last_http_request: new Date(receptorStatus.lastHttpRequest).toISOString()
  });
});

// Endpoint para simular requisição do receptor (para testes)
app.post("/api/simulate/receptor", (req, res) => {
  receptorStatus.lastHttpRequest = Date.now();
  receptorStatus.connected = true;
  receptorDisconnectedForDashboard = false;
  
  console.log(`✅ Simulação: Receptor enviou requisição HTTP`);
  
  res.json({
    simulated: true,
    message: "Receptor marcado como online",
    timestamp: new Date().toISOString()
  });
});

// Servir arquivos estáticos
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 SERVIDOR INICIADO - DETECÇÃO AUTOMÁTICA DE RECEPTOR`);
  console.log(`=======================================================`);
  console.log(`✅ Porta: ${PORT}`);
  console.log(`📡 Sistema de detecção ATIVADO:`);
  console.log(`   • Receptor desconectado = Sem HTTP há 45 segundos`);
  console.log(`   • Dashboard verifica automaticamente a cada 5s`);
  console.log(`   • Reconexão detectada automaticamente`);
  console.log(`\n🔧 Endpoints para teste:`);
  console.log(`   GET /api/status/force/disconnected  - Simular receptor offline`);
  console.log(`   GET /api/status/force/connected     - Simular receptor online`);
  console.log(`   POST /api/simulate/receptor         - Simular requisição ESP32`);
  console.log(`\n⏰ Início: ${new Date().toLocaleString()}`);
  console.log(`📡 Monitoramento ativo...\n`);
  
  // Iniciar verificação periódica
  setInterval(() => {
    checkReceptorConnection(false);
  }, 5000); // Verificar a cada 5 segundos
});
