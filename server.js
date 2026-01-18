import express from "express";
import path from "path";
import { fileURLToPath } from 'url';
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();
app.use(express.json());

// Para usar __dirname em ES6 modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== CONFIGURAÇÃO DA CAIXA ======
let caixaConfig = {
  // Configurações serão recebidas do transmissor
  altura: 0,
  volumeTotal: 0,
  distanciaCheia: 0,
  distanciaVazia: 0,
  updatedAt: new Date().toISOString()
};

// ====== VARIÁVEIS GLOBAIS ======
let historico = [];
let lastReceptorRequest = Date.now();
let lastLoRaPacket = null;
let lastGoodLoRaSignal = { rssi: null, snr: null, quality: 0 };

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
    quality: 0, // ZERADO quando perder conexão
    description: "Transmissão LoRa ativa"
  },
  sensor: {
    hasError: false,
    lastErrorTime: null,
    errorDescription: ""
  }
};

// ====== CARREGAR CONFIGURAÇÃO SALVA ======
function carregarConfiguracao() {
  try {
    if (fs.existsSync('config-caixa.json')) {
      const data = fs.readFileSync('config-caixa.json', 'utf8');
      const savedConfig = JSON.parse(data);
      
      if (savedConfig.volumeTotal && savedConfig.altura) {
        caixaConfig = {
          ...caixaConfig,
          ...savedConfig,
          updatedAt: new Date().toISOString()
        };
        console.log("📋 Configuração da caixa carregada do arquivo");
      }
    }
  } catch (error) {
    console.log("⚠️ Não foi possível carregar configuração salva:", error.message);
  }
}

// ====== SALVAR CONFIGURAÇÃO ======
function salvarConfiguracao() {
  try {
    fs.writeFileSync('config-caixa.json', JSON.stringify(caixaConfig, null, 2));
    console.log("💾 Configuração da caixa salva no arquivo");
  } catch (error) {
    console.error("❌ Erro ao salvar configuração:", error.message);
  }
}

// ====== FUNÇÃO PRINCIPAL DE VERIFICAÇÃO ======
function checkSystemStatus() {
  const now = Date.now();
  const timeSinceReceptor = now - lastReceptorRequest;
  const timeSinceLoRa = lastLoRaPacket ? now - lastLoRaPacket : Infinity;

  // ====== REGRA 1: RECEPTOR CONECTADO/DESCONECTADO ======
  if (timeSinceReceptor > RECEPTOR_TIMEOUT_MS) {
    if (systemStatus.receptor.connected) {
      systemStatus.receptor.connected = false;
      systemStatus.receptor.description = `Receptor offline - Sem comunicação há ${Math.floor(timeSinceReceptor/1000)}s`;
      historico = [];
    }
  } else {
    if (!systemStatus.receptor.connected) {
      systemStatus.receptor.connected = true;
      systemStatus.receptor.description = "Receptor conectado ao WiFi";
    }
  }

  // ====== REGRA 2: STATUS LoRa ======
  if (systemStatus.receptor.connected) {
    if (timeSinceLoRa > LORA_TIMEOUT_MS) {
      // AGUARDANDO LoRa - ZERAR SINAL
      systemStatus.lora.connected = false;
      systemStatus.lora.waitingData = true;
      systemStatus.lora.description = "Aguardando transmissão LoRa";
      systemStatus.lora.quality = 0; // ZERAR QUALIDADE DO SINAL
      systemStatus.lora.rssi = null;
      systemStatus.lora.snr = null;
    } else {
      // LoRa ATIVO - RESTAURAR ÚLTIMO SINAL BOM
      systemStatus.lora.connected = true;
      systemStatus.lora.waitingData = false;
      systemStatus.lora.description = "Transmissão LoRa ativa";
      // Restaurar último sinal bom
      systemStatus.lora.quality = lastGoodLoRaSignal.quality;
      systemStatus.lora.rssi = lastGoodLoRaSignal.rssi;
      systemStatus.lora.snr = lastGoodLoRaSignal.snr;
    }
  } else {
    systemStatus.lora.connected = false;
    systemStatus.lora.waitingData = true;
    systemStatus.lora.quality = 0;
    systemStatus.lora.rssi = null;
    systemStatus.lora.snr = null;
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
    message,
    // NOVOS CAMPOS DE CONFIGURAÇÃO DO TRANSMISSOR
    config_altura,
    config_volume_total,
    config_distancia_cheia,
    config_distancia_vazia
  } = req.body;

  const isHeartbeat = req.headers['x-heartbeat'] === 'true';
  const isNoDataPacket = req.headers['x-no-data'] === 'true' || no_data === true;
  
  // ====== DETECTAR ERRO NO SENSOR ======
  const isSensorError = sensor_ok === false || 
                       (distance === -1 && level === -1 && percentage === -1 && liters === -1);
  
  if (isSensorError) {
    console.log("❌ ERRO NO SENSOR ULTRASSÔNICO DETECTADO!");
    systemStatus.sensor.hasError = true;
    systemStatus.sensor.lastErrorTime = new Date().toISOString();
    systemStatus.sensor.errorDescription = "Sensor ultrassônico com falha";
  } else if (systemStatus.sensor.hasError) {
    systemStatus.sensor.hasError = false;
    systemStatus.sensor.errorDescription = "";
  }
  
  // ====== ATUALIZAR CONFIGURAÇÃO DA CAIXA SE ENVIADA PELO TRANSMISSOR ======
  if (config_altura && config_volume_total && config_distancia_cheia && config_distancia_vazia) {
    const novaConfig = {
      altura: parseFloat(config_altura),
      volumeTotal: parseFloat(config_volume_total),
      distanciaCheia: parseFloat(config_distancia_cheia),
      distanciaVazia: parseFloat(config_distancia_vazia),
      updatedAt: new Date().toISOString()
    };
    
    // Verificar se configuração mudou
    if (JSON.stringify(caixaConfig) !== JSON.stringify(novaConfig)) {
      caixaConfig = novaConfig;
      salvarConfiguracao();
      console.log("⚙️ Configuração da caixa atualizada pelo transmissor:");
      console.log(`   📏 Altura: ${caixaConfig.altura} cm`);
      console.log(`   💧 Volume: ${caixaConfig.volumeTotal} L`);
      console.log(`   🎯 Cheio: ${caixaConfig.distanciaCheia} cm`);
      console.log(`   🎯 Vazio: ${caixaConfig.distanciaVazia} cm`);
    }
  }
  
  if (isHeartbeat || isNoDataPacket) {
    console.log("📭 Receptor online, aguardando LoRa");
    
    // Não atualizar sinal LoRa em heartbeats sem dados
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
        rssi: null,
        snr: null,
        quality: 0 // ZERADO
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
  
  // Atualizar e salvar qualidade do sinal (apenas quando tem dados LoRa)
  if (lora_rssi !== undefined) {
    const quality = calculateSignalQuality(lora_rssi, lora_snr);
    systemStatus.lora.rssi = lora_rssi;
    systemStatus.lora.snr = lora_snr;
    systemStatus.lora.quality = quality;
    
    // Salvar como último sinal bom
    lastGoodLoRaSignal = {
      rssi: lora_rssi,
      snr: lora_snr,
      quality: quality
    };
  }

  const registro = {
    device: device || "ESP32_TX",
    distance: parseFloat(distance) || 0,
    level: parseInt(level) || 0,
    percentage: parseInt(percentage) || 0,
    liters: parseInt(liters) || 0,
    sensor_ok: sensor_ok !== false,
    timestamp: new Date().toISOString(),
    status: isSensorError ? "sensor_error" : "normal",
    lora_connected: true,
    receptor_connected: true,
    wifi_signal: wifi_rssi || null,
    lora_signal: {
      rssi: systemStatus.lora.rssi,
      snr: systemStatus.lora.snr,
      quality: systemStatus.lora.quality
    },
    sensor_error: isSensorError,
    sensor_error_message: isSensorError ? "Erro no sensor ultrassônico" : null
  };

  // Se for erro no sensor, forçar valores negativos
  if (isSensorError) {
    registro.distance = -1;
    registro.level = -1;
    registro.percentage = -1;
    registro.liters = -1;
    registro.sensor_ok = false;
    registro.message = "ERRO NO SENSOR ULTRASSÔNICO";
  }

  historico.push(registro);
  if (historico.length > 100) historico.shift();
  
  systemStatus.lora.connected = true;
  systemStatus.lora.waitingData = false;
  systemStatus.lora.description = "Transmissão LoRa ativa";

  res.json({ 
    status: "ok", 
    message: isSensorError ? "Erro no sensor detectado" : "Dados recebidos com sucesso!",
    receptor_connected: true,
    lora_connected: true,
    sensor_error: isSensorError,
    caixa_config: caixaConfig
  });
});

// ====== ROTA GET: DADOS PARA DASHBOARD ======
app.get("/api/lora", (req, res) => {
  checkSystemStatus();
  
  let ultimo;
  let displayMode = "normal";
  
  // ====== DECISÃO DE STATUS ======
  if (!systemStatus.receptor.connected) {
    displayMode = "receptor_disconnected";
    ultimo = criarRespostaStatus("receptor_disconnected");
  } 
  else if (systemStatus.receptor.connected && systemStatus.lora.waitingData) {
    displayMode = "waiting_lora";
    ultimo = criarRespostaStatus("waiting_lora");
  }
  else if (systemStatus.receptor.connected && systemStatus.lora.connected && systemStatus.sensor.hasError) {
    displayMode = "sensor_error";
    ultimo = criarRespostaStatus("sensor_error");
  }
  else if (systemStatus.receptor.connected && systemStatus.lora.connected) {
    displayMode = "normal";
    const recentNormalData = historico.filter(item => item.status === "normal");
    
    if (recentNormalData.length > 0) {
      ultimo = recentNormalData[recentNormalData.length - 1];
      ultimo.display_mode = displayMode;
      ultimo.receptor_connected = true;
    } else {
      ultimo = criarRespostaStatus("normal");
    }
  }
  else {
    displayMode = "unknown";
    ultimo = criarRespostaStatus("unknown");
  }

  // Preparar histórico
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
      signal_quality: systemStatus.lora.quality, // VAI ZERAR QUANDO PERDER LORA
      rssi: systemStatus.lora.rssi,
      snr: systemStatus.lora.snr,
      description: systemStatus.lora.description
    },
    sensor_status: {
      has_error: systemStatus.sensor.hasError,
      last_error_time: systemStatus.sensor.lastErrorTime,
      error_description: systemStatus.sensor.errorDescription
    },
    caixa_config: caixaConfig,
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

// ====== FUNÇÃO AUXILIAR: CRIAR RESPOSTA DE STATUS ======
function criarRespostaStatus(status) {
  const baseResponse = {
    device: status === "receptor_disconnected" ? "RECEPTOR_CASA" : 
            status === "waiting_lora" ? "RECEPTOR_CASA" : "ESP32_TX",
    distance: -1,
    level: -1,
    percentage: -1,
    liters: -1,
    sensor_ok: false,
    timestamp: new Date().toISOString(),
    status: status,
    lora_connected: status === "normal" || status === "sensor_error",
    display_mode: status,
    receptor_connected: status !== "receptor_disconnected",
    wifi_signal: systemStatus.receptor.wifiSignal,
    lora_signal: {
      rssi: systemStatus.lora.rssi,
      snr: systemStatus.lora.snr,
      quality: systemStatus.lora.quality // ZERADO quando waiting_lora
    },
    config_applied: {
      volume_total: caixaConfig.volumeTotal,
      altura_caixa: caixaConfig.altura
    }
  };

  switch(status) {
    case "receptor_disconnected":
      baseResponse.message = `RECEPTOR ESP32 DESCONECTADO - Sem comunicação há ${Math.floor((Date.now() - lastReceptorRequest)/1000)}s`;
      break;
    case "waiting_lora":
      baseResponse.message = "Receptor online, aguardando transmissão LoRa";
      break;
    case "sensor_error":
      baseResponse.message = "ERRO NO SENSOR ULTRASSÔNICO - Verifique conexões";
      baseResponse.sensor_error = true;
      baseResponse.sensor_error_message = "Sensor ultrassônico com falha";
      break;
    case "normal":
      baseResponse.distance = 0;
      baseResponse.level = 0;
      baseResponse.percentage = 0;
      baseResponse.liters = 0;
      baseResponse.sensor_ok = true;
      baseResponse.message = "Sistema pronto - Aguardando primeira leitura";
      break;
    default:
      baseResponse.message = "Verificando status do sistema...";
  }

  return baseResponse;
}

// ====== FUNÇÃO AUXILIAR: CALCULAR QUALIDADE DO SINAL ======
function calculateSignalQuality(rssi, snr) {
  if (rssi === null || rssi === undefined) return 0;
  
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
  const percentage = 59;
  const liters = caixaConfig.volumeTotal > 0 ? 
    Math.round((percentage / 100) * caixaConfig.volumeTotal) : 2950;
  const level = caixaConfig.altura > 0 ? 
    Math.round((percentage / 100) * caixaConfig.altura) : 65;
  
  res.json({
    device: "TX_CAIXA_01",
    distance: 45.5,
    level: level,
    percentage: percentage,
    liters: liters,
    sensor_ok: true,
    timestamp: new Date().toISOString(),
    message: "API funcionando!",
    receptor_connected: true,
    lora_connected: true,
    caixa_config: caixaConfig
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
      quality: systemStatus.lora.quality, // ZERADO quando desconectado
      last_packet: systemStatus.lora.lastPacket ? 
        new Date(systemStatus.lora.lastPacket).toISOString() : null
    },
    sensor: {
      has_error: systemStatus.sensor.hasError
    },
    caixa: {
      config_loaded: caixaConfig.volumeTotal > 0,
      volume_total: caixaConfig.volumeTotal,
      last_updated: caixaConfig.updatedAt
    }
  });
});

// ====== ROTA PARA ESTATÍSTICAS ======
app.get("/api/stats", (req, res) => {
  const normalReadings = historico.filter(item => item.status === "normal").length;
  const errorReadings = historico.filter(item => item.status === "sensor_error").length;
  const waitingReadings = historico.filter(item => item.status === "waiting_lora").length;
  
  res.json({
    total_readings: historico.length,
    by_status: {
      normal: normalReadings,
      sensor_error: errorReadings,
      waiting_lora: waitingReadings
    },
    time_range: historico.length > 0 ? {
      first: historico[0]?.timestamp,
      last: historico[historico.length - 1]?.timestamp
    } : null,
    caixa_config: caixaConfig,
    lora_signal: {
      current_quality: systemStatus.lora.quality,
      last_good_quality: lastGoodLoRaSignal.quality
    }
  });
});

// ====== ROTA PARA FORÇAR KEEP-ALIVE ======
app.get("/keep-alive", (req, res) => {
  console.log("💓 Keep-alive ping recebido");
  res.json({
    status: "alive",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    message: "Servidor ativo e respondendo"
  });
});

// ====== SERVER STATIC FILES ======
app.use(express.static("public"));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ====== MIDDLEWARE DE ERRO 404 ======
app.use((req, res) => {
  res.status(404).json({
    error: "Rota não encontrada",
    available_routes: [
      "GET /api/lora - Dados do dashboard",
      "POST /api/lora - Enviar dados do receptor",
      "GET /health - Status do servidor",
      "GET /keep-alive - Manter servidor ativo",
      "GET /api/test - Dados de teste",
      "GET /api/stats - Estatísticas"
    ]
  });
});

// ====== INICIAR SERVIDOR ======
const PORT = process.env.PORT || 3000;

// Carregar configuração ao iniciar
carregarConfiguracao();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 SERVIDOR INICIADO - SISTEMA SIMPLIFICADO`);
  console.log(`============================================`);
  console.log(`✅ Porta: ${PORT}`);
  console.log(`📡 STATUS DETECTADOS:`);
  console.log(`   • Receptor desconectado = Sem HTTP há 60s`);
  console.log(`   • Aguardando LoRa = Receptor online + sem LoRa há 30s (SINAL ZERADO)`);
  console.log(`   • Erro no sensor = Valores -1`);
  console.log(`   • Normal = Tudo funcionando`);
  
  if (caixaConfig.volumeTotal > 0) {
    console.log(`\n📋 CONFIGURAÇÃO DA CAIXA (do transmissor):`);
    console.log(`   • Altura: ${caixaConfig.altura} cm`);
    console.log(`   • Volume: ${caixaConfig.volumeTotal} L`);
    console.log(`   • Cheio: ${caixaConfig.distanciaCheia} cm`);
    console.log(`   • Vazio: ${caixaConfig.distanciaVazia} cm`);
  } else {
    console.log(`\n📋 AGUARDANDO CONFIGURAÇÃO DO TRANSMISSOR...`);
  }
  
  console.log(`\n⏰ Início: ${new Date().toLocaleString()}`);
  
  // Verificar status periodicamente
  setInterval(() => {
    checkSystemStatus();
  }, 10000);
  
  console.log(`\n💡 Dica: Use /keep-alive para manter servidor ativo no Render`);
});
