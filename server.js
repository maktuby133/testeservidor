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
  distanciaCheia: 20.0,
  distanciaVazia: 60.0,
  volumeTotal: 5000.0,
  updatedAt: new Date().toISOString()
};

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
  },
  sensor: {
    hasError: false,
    lastErrorTime: null,
    errorDescription: ""
  },
  caixa: {
    config: caixaConfig,
    needsRecalibration: false
  }
};

// ====== CARREGAR CONFIGURAÇÃO SALVA ======
function carregarConfiguracao() {
  try {
    if (fs.existsSync('config-caixa.json')) {
      const data = fs.readFileSync('config-caixa.json', 'utf8');
      const savedConfig = JSON.parse(data);
      
      // Atualizar apenas se a configuração for válida
      if (savedConfig.volumeTotal && savedConfig.distanciaCheia) {
        caixaConfig = {
          ...caixaConfig,
          ...savedConfig,
          updatedAt: new Date().toISOString()
        };
        
        systemStatus.caixa.config = caixaConfig;
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
  
  // ====== DETECTAR ERRO NO SENSOR ======
  const isSensorError = sensor_ok === false || 
                       (distance === -1 && percentage === -1 && liters === -1);
  
  if (isSensorError) {
    console.log("❌❌❌ ERRO NO SENSOR ULTRASSÔNICO DETECTADO! ❌❌❌");
    console.log(`   Dispositivo: ${device}`);
    console.log(`   Distância: ${distance} cm`);
    console.log(`   Porcentagem: ${percentage}%`);
    console.log(`   Litros: ${liters} L`);
    console.log("   🔧 Causa: Sensor desconectado ou com falha\n");
    
    systemStatus.sensor.hasError = true;
    systemStatus.sensor.lastErrorTime = new Date().toISOString();
    systemStatus.sensor.errorDescription = "Sensor ultrassônico com falha";
  } else if (systemStatus.sensor.hasError) {
    // Se estava com erro e agora recebeu dados bons, limpar erro
    systemStatus.sensor.hasError = false;
    systemStatus.sensor.errorDescription = "";
    console.log("✅ Sensor voltou ao normal");
  }
  
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
    percentage: parseInt(percentage) || 0,
    liters: parseInt(liters) || 0,
    sensor_ok: sensor_ok !== false,
    timestamp: new Date().toISOString(),
    status: isSensorError ? "sensor_error" : "normal",
    lora_connected: true,
    receptor_connected: true,
    wifi_signal: wifi_rssi || null,
    lora_signal: {
      rssi: lora_rssi || null,
      snr: lora_snr || null,
      quality: systemStatus.lora.quality
    },
    sensor_error: isSensorError,
    sensor_error_message: isSensorError ? "Erro no sensor ultrassônico" : null,
    config_applied: {
      volume_total: caixaConfig.volumeTotal,
      distancia_cheia: caixaConfig.distanciaCheia,
      distancia_vazia: caixaConfig.distanciaVazia
    }
  };

  // Se for erro no sensor, forçar valores negativos
  if (isSensorError) {
    registro.distance = -1;
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
    config_applied: registro.config_applied
  });
});

// ====== ROTA POST: CONFIGURAÇÃO DA CAIXA ======
app.post("/api/config", authMiddleware, (req, res) => {
  console.log("⚙️ Configuração da caixa recebida");
  
  const { 
    distanciaCheia,
    distanciaVazia,
    volumeTotal
  } = req.body;
  
  // Validar dados
  if (!distanciaCheia || !distanciaVazia || !volumeTotal) {
    return res.status(400).json({
      error: "Dados incompletos",
      message: "Distância cheia, vazia e volume total são obrigatórios"
    });
  }
  
  if (distanciaVazia <= distanciaCheia) {
    return res.status(400).json({
      error: "Configuração inválida",
      message: "Distância vazia deve ser MAIOR que distância cheia"
    });
  }
  
  // Atualizar configuração
  caixaConfig = {
    distanciaCheia: parseFloat(distanciaCheia),
    distanciaVazia: parseFloat(distanciaVazia),
    volumeTotal: parseFloat(volumeTotal),
    updatedAt: new Date().toISOString()
  };
  
  systemStatus.caixa.config = caixaConfig;
  
  // Salvar no arquivo
  salvarConfiguracao();
  
  // Recalcular histórico com nova configuração
  historico = historico.map(item => {
    if (item.percentage >= 0 && item.liters >= 0) {
      // Recalcular litros baseado no novo volume total
      const novaLitros = Math.round((item.percentage / 100) * caixaConfig.volumeTotal);
      
      return {
        ...item,
        liters: novaLitros,
        config_applied: {
          volume_total: caixaConfig.volumeTotal,
          distancia_cheia: caixaConfig.distanciaCheia,
          distancia_vazia: caixaConfig.distanciaVazia
        }
      };
    }
    return item;
  });
  
  console.log("✅ Configuração da caixa atualizada:");
  console.log(`   💧 Volume total: ${caixaConfig.volumeTotal} L`);
  console.log(`   🎯 Cheio: ${caixaConfig.distanciaCheia} cm | Vazio: ${caixaConfig.distanciaVazia} cm`);
  
  res.json({
    status: "ok",
    message: "Configuração da caixa atualizada com sucesso",
    config: caixaConfig,
    historico_recalculado: historico.filter(item => item.status === "normal").length
  });
});

// ====== ROTA GET: CONFIGURAÇÃO ATUAL ======
app.get("/api/config", (req, res) => {
  res.json({
    status: "ok",
    config: caixaConfig,
    systemStatus: {
      receptor: systemStatus.receptor,
      lora: systemStatus.lora,
      sensor: systemStatus.sensor,
      caixa: systemStatus.caixa
    },
    historico_count: historico.length,
    server_time: new Date().toISOString()
  });
});

// ====== ROTA GET: DADOS PARA DASHBOARD ======
app.get("/api/lora", (req, res) => {
  checkSystemStatus();
  
  console.log(`\n📊 Dashboard solicitou dados`);
  console.log(`   Receptor: ${systemStatus.receptor.connected ? 'CONECTADO' : 'DESCONECTADO'}`);
  console.log(`   LoRa: ${systemStatus.lora.connected ? 'ATIVO' : 'INATIVO'}`);
  console.log(`   Aguardando LoRa: ${systemStatus.lora.waitingData ? 'SIM' : 'NÃO'}`);
  console.log(`   Erro Sensor: ${systemStatus.sensor.hasError ? 'SIM' : 'NÃO'}`);
  console.log(`   Config Caixa: ${caixaConfig.volumeTotal}L (Cheia:${caixaConfig.distanciaCheia}cm, Vazia:${caixaConfig.distanciaVazia}cm)`);
  
  let ultimo;
  let displayMode = "normal";
  
  // ====== DECISÃO DE STATUS ======
  
  // 1. RECEPTOR DESCONECTADO
  if (!systemStatus.receptor.connected) {
    console.log("   → MODO: RECEPTOR DESCONECTADO");
    displayMode = "receptor_disconnected";
    
    ultimo = {
      device: "RECEPTOR_CASA",
      distance: -1,
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
      },
      config_applied: {
        volume_total: caixaConfig.volumeTotal,
        distancia_cheia: caixaConfig.distanciaCheia,
        distancia_vazia: caixaConfig.distanciaVazia
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
      },
      config_applied: {
        volume_total: caixaConfig.volumeTotal,
        distancia_cheia: caixaConfig.distanciaCheia,
        distancia_vazia: caixaConfig.distanciaVazia
      }
    };
    
  }
  // 3. ERRO NO SENSOR (RECEPTOR CONECTADO + LoRa ATIVO mas sensor com erro)
  else if (systemStatus.receptor.connected && systemStatus.lora.connected && systemStatus.sensor.hasError) {
    console.log("   → MODO: ERRO NO SENSOR");
    displayMode = "sensor_error";
    
    ultimo = {
      device: "ESP32_TX",
      distance: -1,
      percentage: -1,
      liters: -1,
      sensor_ok: false,
      timestamp: new Date().toISOString(),
      status: "sensor_error",
      message: "ERRO NO SENSOR ULTRASSÔNICO - Verifique conexões",
      lora_connected: true,
      display_mode: displayMode,
      receptor_connected: true,
      wifi_signal: systemStatus.receptor.wifiSignal,
      lora_signal: {
        rssi: systemStatus.lora.rssi,
        snr: systemStatus.lora.snr,
        quality: systemStatus.lora.quality
      },
      sensor_error: true,
      sensor_error_message: "Sensor ultrassônico com falha",
      config_applied: {
        volume_total: caixaConfig.volumeTotal,
        distancia_cheia: caixaConfig.distanciaCheia,
        distancia_vazia: caixaConfig.distanciaVazia
      }
    };
    
  }
  // 4. TUDO NORMAL
  else if (systemStatus.receptor.connected && systemStatus.lora.connected) {
    console.log("   → MODO: NORMAL");
    displayMode = "normal";
    
    const recentNormalData = historico.filter(item => item.status === "normal");
    
    if (recentNormalData.length > 0) {
      ultimo = recentNormalData[recentNormalData.length - 1];
      ultimo.display_mode = displayMode;
      ultimo.receptor_connected = true;
      
      // Garantir que tem a configuração aplicada
      if (!ultimo.config_applied) {
        ultimo.config_applied = {
          volume_total: caixaConfig.volumeTotal,
          distancia_cheia: caixaConfig.distanciaCheia,
          distancia_vazia: caixaConfig.distanciaVazia
        };
      }
    } else {
      ultimo = {
        device: "ESP32_TX",
        distance: 0,
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
        },
        config_applied: {
          volume_total: caixaConfig.volumeTotal,
          distancia_cheia: caixaConfig.distanciaCheia,
          distancia_vazia: caixaConfig.distanciaVazia
        }
      };
    }
  }
  // 5. FALLBACK
  else {
    console.log("   → MODO: INDETERMINADO");
    displayMode = "unknown";
    
    ultimo = {
      device: "SISTEMA",
      distance: -1,
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
      },
      config_applied: {
        volume_total: caixaConfig.volumeTotal,
        distancia_cheia: caixaConfig.distanciaCheia,
        distancia_vazia: caixaConfig.distanciaVazia
      }
    };
  }

  // Preparar histórico
  let historicoParaDashboard = systemStatus.receptor.connected ? 
    historico.slice(-20).map(item => ({
      ...item,
      timestamp: item.timestamp || new Date().toISOString(),
      config_applied: item.config_applied || {
        volume_total: caixaConfig.volumeTotal,
        distancia_cheia: caixaConfig.distanciaCheia,
        distancia_vazia: caixaConfig.distanciaVazia
      }
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
  const percentage = 59;
  const liters = Math.round((percentage / 100) * caixaConfig.volumeTotal);
  
  res.json({
    device: "TX_CAIXA_01",
    distance: 45.5,
    percentage: percentage,
    liters: liters,
    sensor_ok: true,
    timestamp: new Date().toISOString(),
    message: "API funcionando!",
    receptor_connected: true,
    lora_connected: true,
    config_applied: {
      volume_total: caixaConfig.volumeTotal,
      distancia_cheia: caixaConfig.distanciaCheia,
      distancia_vazia: caixaConfig.distanciaVazia
    }
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
    },
    sensor: {
      has_error: systemStatus.sensor.hasError
    },
    caixa: {
      config_loaded: true,
      volume_total: caixaConfig.volumeTotal,
      distancia_cheia: caixaConfig.distanciaCheia,
      distancia_vazia: caixaConfig.distanciaVazia,
      last_updated: caixaConfig.updatedAt
    }
  });
});

// ====== ROTA PARA RESETAR CONFIGURAÇÃO ======
app.post("/api/reset-config", authMiddleware, (req, res) => {
  caixaConfig = {
    distanciaCheia: 20.0,
    distanciaVazia: 60.0,
    volumeTotal: 5000.0,
    updatedAt: new Date().toISOString()
  };
  
  salvarConfiguracao();
  
  console.log("🔄 Configuração da caixa resetada para valores padrão");
  
  res.json({
    status: "ok",
    message: "Configuração resetada para valores padrão",
    config: caixaConfig
  });
});

// ====== SERVER STATIC FILES ======
app.use(express.static("public"));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
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
    caixa_config: caixaConfig
  });
});

// ====== MIDDLEWARE DE ERRO 404 ======
app.use((req, res) => {
  res.status(404).json({
    error: "Rota não encontrada",
    available_routes: [
      "GET /api/lora - Dados do dashboard",
      "POST /api/lora - Enviar dados do receptor",
      "GET /api/config - Obter configuração",
      "POST /api/config - Atualizar configuração",
      "GET /api/stats - Estatísticas",
      "GET /health - Status do servidor",
      "GET /api/test - Dados de teste"
    ]
  });
});

// ====== INICIAR SERVIDOR ======
const PORT = process.env.PORT || 3000;

// Carregar configuração ao iniciar
carregarConfiguracao();

app.listen(PORT, () => {
  console.log(`\n🚀 SERVIDOR INICIADO - SISTEMA SIMPLIFICADO`);
  console.log(`==========================================`);
  console.log(`✅ Porta: ${PORT}`);
  console.log(`📡 STATUS DETECTADOS:`);
  console.log(`   • Receptor desconectado = Sem HTTP há 60s`);
  console.log(`   • Aguardando LoRa = Receptor online + sem LoRa há 30s`);
  console.log(`   • Erro no sensor = Valores -1 + sensor_ok=false`);
  console.log(`   • Normal = Tudo funcionando`);
  console.log(`\n📋 CONFIGURAÇÃO DA CAIXA:`);
  console.log(`   • Volume total: ${caixaConfig.volumeTotal} L`);
  console.log(`   • Distância cheia: ${caixaConfig.distanciaCheia} cm (100%)`);
  console.log(`   • Distância vazia: ${caixaConfig.distanciaVazia} cm (0%)`);
  console.log(`\n⏰ Início: ${new Date().toLocaleString()}`);
  
  // Verificar status periodicamente
  setInterval(() => {
    checkSystemStatus();
  }, 10000);
});
