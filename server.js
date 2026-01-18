import express from "express";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// ====== VARIÁVEIS GLOBAIS ======
let historico = [];
let lastReceptorRequest = Date.now();
let lastLoRaPacket = null;

// ====== CONFIGURAÇÕES DE TIMEOUT ======
const RECEPTOR_TIMEOUT_MS = 60000; // 60s sem HTTP = receptor offline
const LORA_TIMEOUT_MS = 30000; // 30s sem dados LoRa = aguardando transmissão

// ====== STATUS ATUAL ======
let systemStatus = {
  receptor: {
    connected: true,
    lastSeen: Date.now(),
    wifiSignal: -50,
    description: "Receptor conectado"
  },
  lora: {
    connected: true,
    lastPacket: null,
    waitingData: false,
    rssi: null,
    snr: null,
    quality: 50,
    description: "Transmissão LoRa ativa"
  }
};

// ====== FUNÇÃO PRINCIPAL DE VERIFICAÇÃO ======
function checkSystemStatus() {
  const now = Date.now();
  const timeSinceReceptor = now - lastReceptorRequest;
  const timeSinceLoRa = lastLoRaPacket ? now - lastLoRaPacket : Infinity;

  console.log(`\n🔍 VERIFICAÇÃO STATUS (${new Date().toLocaleTimeString()}):`);
  console.log(`   Receptor: há ${Math.floor(timeSinceReceptor/1000)}s`);
  console.log(`   LoRa: há ${lastLoRaPacket ? Math.floor(timeSinceLoRa/1000) : 'NUNCA'}s`);

  // ====== REGRA 1: RECEPTOR CONECTADO/DESCONECTADO ======
  if (timeSinceReceptor > RECEPTOR_TIMEOUT_MS) {
    // RECEPTOR DESCONECTADO
    if (systemStatus.receptor.connected) {
      systemStatus.receptor.connected = false;
      systemStatus.receptor.description = `Receptor offline - Sem comunicação há ${Math.floor(timeSinceReceptor/1000)}s`;
      
      console.log(`\n⚠️ ⚠️ ⚠️  RECEPTOR ESP32 DESCONECTADO!`);
      console.log(`   Sem requisições HTTP há ${Math.floor(timeSinceReceptor/1000)} segundos`);
      console.log(`   Causa: ESP32 perdeu WiFi, desligou ou sem energia\n`);
      
      historico = [];
      console.log("   📭 Histórico limpo");
    }
  } else {
    // RECEPTOR CONECTADO
    if (!systemStatus.receptor.connected) {
      systemStatus.receptor.connected = true;
      systemStatus.receptor.description = "Receptor conectado ao WiFi";
      
      console.log(`\n✅ RECEPTOR ESP32 RECONECTOU!`);
      console.log(`   Recebendo requisições HTTP normalmente\n`);
    }
  }

  // ====== REGRA 2: STATUS LoRa ======
  if (systemStatus.receptor.connected) {
    if (timeSinceLoRa > LORA_TIMEOUT_MS) {
      // AGUARDANDO LoRa
      if (!systemStatus.lora.waitingData) {
        systemStatus.lora.connected = false;
        systemStatus.lora.waitingData = true;
        systemStatus.lora.description = "Aguardando transmissão LoRa";
        
        console.log(`\n📡 STATUS LoRa: AGUARDANDO TRANSMISSÃO`);
        console.log(`   Receptor online (envia HTTP)`);
        console.log(`   Mas sem dados LoRa há ${Math.floor(timeSinceLoRa/1000)}s`);
        console.log(`   Causa: Transmissor off, fora de alcance ou problema LoRa\n`);
      }
    } else {
      // LoRa ATIVO
      if (systemStatus.lora.waitingData || !systemStatus.lora.connected) {
        systemStatus.lora.connected = true;
        systemStatus.lora.waitingData = false;
        systemStatus.lora.description = "Transmissão LoRa ativa";
        
        console.log(`\n✅ STATUS LoRa: TRANSMISSÃO RESTAURADA`);
        console.log(`   Recebendo dados LoRa normalmente\n`);
      }
    }
  } else {
    // Se receptor offline, LoRa também está offline
    systemStatus.lora.connected = false;
    systemStatus.lora.waitingData = true;
    systemStatus.lora.description = "Receptor offline";
  }
}

// ====== MIDDLEWARE ======
app.use((req, res, next) => {
  if (req.path === "/api/lora" && req.method === "POST") {
    lastReceptorRequest = Date.now();
    systemStatus.receptor.lastSeen = lastReceptorRequest;
    
    if (req.body && req.body.wifi_rssi !== undefined) {
      systemStatus.receptor.wifiSignal = req.body.wifi_rssi;
    }
    
    if (!systemStatus.receptor.connected) {
      systemStatus.receptor.connected = true;
      systemStatus.receptor.description = "Receptor reconectado";
      console.log(`🔌 Receptor reconectou via POST`);
    }
  }
  
  if (req.path === "/api/lora" && req.method === "GET") {
    setTimeout(() => checkSystemStatus(), 100);
  }
  
  next();
});

// ====== MIDDLEWARE DE AUTENTICAÇÃO ======
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization;
  const allowedTokens = process.env.ALLOWED_TOKENS?.split(',') || [];
  
  if (!token || !allowedTokens.includes(token)) {
    return res.status(401).json({ 
      error: "Token inválido",
      message: "Use um token válido no header 'Authorization'"
    });
  }
  
  next();
};

// ====== ROTA POST: DADOS DO RECEPTOR ======
app.post("/api/lora", authMiddleware, (req, res) => {
  console.log("📥 Dados recebidos do receptor ESP32");
  
  const { 
    device, 
    distance, 
    level, 
    percentage, 
    liters, 
    sensor_ok,
    wifi_rssi,
    lora_rssi,
    lora_snr,
    no_data,
    message
  } = req.body;

  const isHeartbeat = req.headers['x-heartbeat'] === 'true';
  const isNoDataPacket = req.headers['x-no-data'] === 'true' || no_data === true;
  
  if (isHeartbeat || isNoDataPacket) {
    console.log("📭 Receptor online, aguardando LoRa");
    
    if (lora_rssi !== undefined) {
      systemStatus.lora.rssi = lora_rssi;
      systemStatus.lora.snr = lora_snr;
      systemStatus.lora.quality = calculateSignalQuality(lora_rssi, lora_snr);
    }
    
    const waitingRecord = {
      device: device || "RECEPTOR_CASA",
      distance: -1,
      level: -1,
      percentage: -1,
      liters: -1,
      sensor_ok: false,
      timestamp: new Date().toISOString(),
      status: "waiting_lora",
      message: message || "Receptor online, aguardando transmissão LoRa",
      lora_connected: false,
      receptor_connected: true,
      wifi_signal: wifi_rssi || null,
      lora_signal: {
        rssi: lora_rssi || null,
        snr: lora_snr || null,
        quality: systemStatus.lora.quality
      }
    };
    
    historico.push(waitingRecord);
    if (historico.length > 100) historico.shift();
    
    return res.json({ 
      status: "ok", 
      message: "Status registrado",
      receptor_connected: true
    });
  }

  // ====== PACOTE NORMAL COM DADOS LoRa ======
  console.log("📦 Dados LoRa recebidos - Sistema NORMAL");
  
  lastLoRaPacket = Date.now();
  systemStatus.lora.lastPacket = lastLoRaPacket;
  
  if (lora_rssi !== undefined) {
    systemStatus.lora.rssi = lora_rssi;
    systemStatus.lora.snr = lora_snr;
    systemStatus.lora.quality = calculateSignalQuality(lora_rssi, lora_snr);
  }

  const registro = {
    device: device || "ESP32_TX",
    distance: parseFloat(distance) || 0,
    level: parseInt(level) || 0,
    percentage: parseInt(percentage) || 0,
    liters: parseInt(liters) || 0,
    sensor_ok: sensor_ok !== false,
    timestamp: new Date().toISOString(),
    status: "normal",
    lora_connected: true,
    receptor_connected: true,
    wifi_signal: wifi_rssi || null,
    lora_signal: {
      rssi: lora_rssi || null,
      snr: lora_snr || null,
      quality: systemStatus.lora.quality
    }
  };

  historico.push(registro);
  if (historico.length > 100) historico.shift();
  
  systemStatus.lora.connected = true;
  systemStatus.lora.waitingData = false;
  systemStatus.lora.description = "Transmissão LoRa ativa";

  res.json({ 
    status: "ok", 
    message: "Dados recebidos com sucesso!",
    receptor_connected: true,
    lora_connected: true
  });
});

// ====== ROTA GET: DADOS PARA DASHBOARD ======
app.get("/api/lora", (req, res) => {
  checkSystemStatus();
  
  console.log(`\n📊 Dashboard solicitou dados`);
  console.log(`   Receptor: ${systemStatus.receptor.connected ? 'CONECTADO' : 'DESCONECTADO'}`);
  console.log(`   LoRa: ${systemStatus.lora.connected ? 'ATIVO' : 'INATIVO'}`);
  console.log(`   Aguardando LoRa: ${systemStatus.lora.waitingData ? 'SIM' : 'NÃO'}`);
  
  let ultimo;
  let displayMode = "normal";
  
  // 1. RECEPTOR DESCONECTADO
  if (!systemStatus.receptor.connected) {
    console.log("   → MODO: RECEPTOR DESCONECTADO");
    displayMode = "receptor_disconnected";
    
    ultimo = {
      device: "RECEPTOR_CASA",
      distance: -1,
      level: -1,
      percentage: -1,
      liters: -1,
      sensor_ok: false,
      timestamp: new Date().toISOString(),
      status: "receptor_disconnected",
      message: `RECEPTOR ESP32 DESCONECTADO - Sem comunicação há ${Math.floor((Date.now() - lastReceptorRequest)/1000)}s`,
      lora_connected: false,
      display_mode: displayMode,
      receptor_connected: false,
      wifi_signal: systemStatus.receptor.wifiSignal,
      lora_signal: {
        rssi: systemStatus.lora.rssi,
        snr: systemStatus.lora.snr,
        quality: systemStatus.lora.quality
      }
    };
    
  } 
  // 2. RECEPTOR CONECTADO mas AGUARDANDO LoRa
  else if (systemStatus.receptor.connected && systemStatus.lora.waitingData) {
    console.log("   → MODO: AGUARDANDO LoRa");
    displayMode = "waiting_lora";
    
    ultimo = {
      device: "RECEPTOR_CASA",
      distance: -1,
      level: -1,
      percentage: -1,
      liters: -1,
      sensor_ok: false,
      timestamp: new Date().toISOString(),
      status: "waiting_lora",
      message: "Receptor online, aguardando transmissão LoRa",
      lora_connected: false,
      display_mode: displayMode,
      receptor_connected: true,
      wifi_signal: systemStatus.receptor.wifiSignal,
      lora_signal: {
        rssi: systemStatus.lora.rssi,
        snr: systemStatus.lora.snr,
        quality: systemStatus.lora.quality
      }
    };
    
  }
  // 3. TUDO NORMAL
  else if (systemStatus.receptor.connected && systemStatus.lora.connected) {
    console.log("   → MODO: NORMAL");
    displayMode = "normal";
    
    const recentNormalData = historico.filter(item => item.status === "normal");
    
    if (recentNormalData.length > 0) {
      ultimo = recentNormalData[recentNormalData.length - 1];
      ultimo.display_mode = displayMode;
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
        display_mode: displayMode,
        receptor_connected: true,
        wifi_signal: systemStatus.receptor.wifiSignal,
        lora_signal: {
          rssi: systemStatus.lora.rssi,
          snr: systemStatus.lora.snr,
          quality: systemStatus.lora.quality
        }
      };
    }
  }
  // 4. FALLBACK
  else {
    console.log("   → MODO: INDETERMINADO");
    displayMode = "unknown";
    
    ultimo = {
      device: "SISTEMA",
      distance: -1,
      level: -1,
      percentage: -1,
      liters: -1,
      sensor_ok: false,
      timestamp: new Date().toISOString(),
      status: "unknown",
      message: "Verificando status do sistema...",
      lora_connected: systemStatus.lora.connected,
      display_mode: displayMode,
      receptor_connected: systemStatus.receptor.connected,
      wifi_signal: systemStatus.receptor.wifiSignal,
      lora_signal: {
        rssi: systemStatus.lora.rssi,
        snr: systemStatus.lora.snr,
        quality: systemStatus.lora.quality
      }
    };
  }

  let historicoParaDashboard = systemStatus.receptor.connected ? 
    historico.slice(-20).map(item => ({
      ...item,
      timestamp: item.timestamp || new Date().toISOString()
    })) : [];

  const responseData = {
    ...ultimo,
    receptor_status: {
      connected: systemStatus.receptor.connected,
      last_seen: new Date(lastReceptorRequest).toISOString(),
      seconds_since_last_seen: Math.floor((Date.now() - lastReceptorRequest) / 1000),
      wifi_signal: systemStatus.receptor.wifiSignal,
      description: systemStatus.receptor.description
    },
    lora_connection_status: {
      connected: systemStatus.lora.connected,
      waiting_data: systemStatus.lora.waitingData,
      last_packet: systemStatus.lora.lastPacket ? 
        new Date(systemStatus.lora.lastPacket).toISOString() : null,
      seconds_since_last_packet: systemStatus.lora.lastPacket ? 
        Math.floor((Date.now() - systemStatus.lora.lastPacket) / 1000) : null,
      signal_quality: systemStatus.lora.quality,
      rssi: systemStatus.lora.rssi,
      snr: systemStatus.lora.snr,
      description: systemStatus.lora.description
    },
    historico: historicoParaDashboard,
    system_info: {
      total_readings: historico.length,
      server_time: new Date().toISOString(),
      server_uptime: process.uptime(),
      display_mode: displayMode
    }
  };

  res.json(responseData);
});

// ====== FUNÇÃO AUXILIAR ======
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

// ====== ROTAS ADICIONAIS ======
app.get("/api/test", (req, res) => {
  res.json({
    device: "TX_CAIXA_01",
    distance: 45.5,
    level: 65,
    percentage: 59,
    liters: 2950,
    sensor_ok: true,
    timestamp: new Date().toISOString(),
    message: "API funcionando!",
    receptor_connected: true,
    lora_connected: true
  });
});

app.get("/health", (req, res) => {
  checkSystemStatus();
  
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    receptor: {
      connected: systemStatus.receptor.connected,
      last_seen: new Date(lastReceptorRequest).toISOString(),
      seconds_ago: Math.floor((Date.now() - lastReceptorRequest) / 1000)
    },
    lora: {
      connected: systemStatus.lora.connected,
      waiting: systemStatus.lora.waitingData,
      last_packet: systemStatus.lora.lastPacket ? 
        new Date(systemStatus.lora.lastPacket).toISOString() : null
    }
  });
});

// ====== SERVER STATIC FILES ======
app.use(express.static("public"));
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

// ====== INICIAR SERVIDOR ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 SERVIDOR INICIADO - SISTEMA CORRIGIDO`);
  console.log(`========================================`);
  console.log(`✅ Porta: ${PORT}`);
  console.log(`📡 LÓGICA CORRETA:`);
  console.log(`   • Receptor desconectado = Sem HTTP há 60s`);
  console.log(`   • Aguardando LoRa = Receptor online + sem LoRa há 30s`);
  console.log(`   • Heartbeat a cada 20s do receptor`);
  console.log(`\n⏰ Início: ${new Date().toLocaleString()}`);
  
  setInterval(() => {
    checkSystemStatus();
  }, 10000);
});
