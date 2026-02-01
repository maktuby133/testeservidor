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

// ====== FUNÇÃO PARA CALCULAR CONSUMO DE ÁGUA ======
function calcularConsumo(currentIndex) {
  const now = new Date(historico[currentIndex].timestamp);
  
  // Filtrar apenas registros com status normal e com liters válidos
  const validReadings = historico.filter(item => 
    item.status === "normal" && 
    item.liters !== null && 
    item.liters !== undefined && 
    item.liters >= 0
  );
  
  if (validReadings.length === 0) {
    return { uso1h: null, usoSemana: null, usoMes: null };
  }
  
  const currentReading = validReadings.find(item => item.timestamp === historico[currentIndex].timestamp);
  if (!currentReading) {
    return { uso1h: null, usoSemana: null, usoMes: null };
  }
  
  // Calcular uso em 1 hora (litros consumidos)
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const readingsLastHour = validReadings.filter(item => {
    const itemDate = new Date(item.timestamp);
    return itemDate >= oneHourAgo && itemDate <= now;
  });
  
  let uso1h = null;
  if (readingsLastHour.length >= 2) {
    const firstInHour = readingsLastHour[0];
    const lastInHour = readingsLastHour[readingsLastHour.length - 1];
    const consumo = firstInHour.liters - lastInHour.liters;
    uso1h = consumo > 0 ? Math.round(consumo) : 0;
  }
  
  // Calcular uso na última semana
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const readingsLastWeek = validReadings.filter(item => {
    const itemDate = new Date(item.timestamp);
    return itemDate >= oneWeekAgo && itemDate <= now;
  });
  
  let usoSemana = null;
  if (readingsLastWeek.length >= 2) {
    const firstInWeek = readingsLastWeek[0];
    const lastInWeek = readingsLastWeek[readingsLastWeek.length - 1];
    const consumo = firstInWeek.liters - lastInWeek.liters;
    usoSemana = consumo > 0 ? Math.round(consumo) : 0;
  }
  
  // Calcular uso no último mês
  const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const readingsLastMonth = validReadings.filter(item => {
    const itemDate = new Date(item.timestamp);
    return itemDate >= oneMonthAgo && itemDate <= now;
  });
  
  let usoMes = null;
  if (readingsLastMonth.length >= 2) {
    const firstInMonth = readingsLastMonth[0];
    const lastInMonth = readingsLastMonth[readingsLastMonth.length - 1];
    const consumo = firstInMonth.liters - lastInMonth.liters;
    usoMes = consumo > 0 ? Math.round(consumo) : 0;
  }
  
  return { uso1h, usoSemana, usoMes };
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
    // ✅ CORREÇÃO: Verificar se há dados válidos recentes no histórico
    const hasRecentValidData = historico.length > 0 && 
      historico[historico.length - 1].status === "normal" &&
      (Date.now() - new Date(historico[historico.length - 1].timestamp).getTime()) < 60000; // menos de 60s
    
    if (timeSinceLoRa > LORA_TIMEOUT_MS && !hasRecentValidData) {
      // AGUARDANDO LoRa - ZERAR SINAL (apenas se não houver dados válidos recentes)
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
    
    // ✅ CORREÇÃO: NÃO adicionar ao histórico se houver dados válidos recentes
    const hasRecentData = historico.length > 0 && 
      historico[historico.length - 1].status === "normal" &&
      (Date.now() - new Date(historico[historico.length - 1].timestamp).getTime()) < 60000;
    
    // Só adiciona registro de waiting_lora se NÃO houver dados recentes
    if (!hasRecentData) {
      const waitingRecord = {
        device: device || "RECEPTOR_CASA",
        distance: -1,
        level: -1,
        percentage: -1,
        liters: -1,
        sensor_ok: false,
        timestamp: new Date().toISOString(),
        status: "waiting_lora",
        lora_signal: {
          rssi: null,
          snr: null,
          quality: 0
        }
      };
      
      // Só adiciona se o último registro também não for waiting_lora
      if (historico.length === 0 || historico[historico.length - 1].status !== "waiting_lora") {
        historico.push(waitingRecord);
        if (historico.length > 500) historico.shift();
      }
    }
    
    return res.json({ 
      success: true, 
      message: hasRecentData ? "Dados recentes disponíveis" : "Aguardando dados LoRa",
      status: hasRecentData ? "normal" : "waiting_lora"
    });
  }

  // ====== ATUALIZAR ÚLTIMO PACOTE LoRa ======
  lastLoRaPacket = Date.now();
  systemStatus.lora.lastPacket = lastLoRaPacket;
  
  // ====== PROCESSAR SINAL LoRa ======
  const loraQuality = calculateSignalQuality(lora_rssi, lora_snr);
  
  // GUARDAR ÚLTIMO SINAL BOM
  if (loraQuality > 0) {
    lastGoodLoRaSignal = {
      rssi: lora_rssi,
      snr: lora_snr,
      quality: loraQuality
    };
  }
  
  systemStatus.lora.rssi = lora_rssi;
  systemStatus.lora.snr = lora_snr;
  systemStatus.lora.quality = loraQuality;
  
  // ====== CRIAR REGISTRO NO HISTÓRICO ======
  const novoRegistro = {
    device: device || "ESP32_TX",
    distance: parseFloat(distance) || 0,
    level: parseFloat(level) || 0,
    percentage: parseInt(percentage) || 0,
    liters: parseInt(liters) || 0,
    sensor_ok: sensor_ok,
    timestamp: new Date().toISOString(),
    status: isSensorError ? "sensor_error" : "normal",
    lora_signal: {
      rssi: lora_rssi,
      snr: lora_snr,
      quality: loraQuality
    }
  };
  
  historico.push(novoRegistro);
  if (historico.length > 500) historico.shift();
  
  console.log(`✅ Dados processados - Status: ${novoRegistro.status} | Nível: ${percentage}% | Volume: ${liters}L | Sinal: ${loraQuality}%`);
  
  res.json({ 
    success: true, 
    message: "Dados recebidos com sucesso",
    status: novoRegistro.status,
    lora_quality: loraQuality
  });
});

// ====== ROTA GET: DASHBOARD ======
app.get("/api/lora", (req, res) => {
  checkSystemStatus();
  
  let displayMode = "normal";
  let responseData = null;
  
  // ====== LÓGICA DE DECISÃO DO MODO DE EXIBIÇÃO ======
  
  // ✅ Verificar se há dados válidos recentes (menos de 2 minutos)
  const hasRecentValidData = historico.length > 0 && 
    historico[historico.length - 1].status === "normal" &&
    (Date.now() - new Date(historico[historico.length - 1].timestamp).getTime()) < 120000; // 2 minutos
  
  if (!systemStatus.receptor.connected) {
    displayMode = "receptor_disconnected";
    responseData = criarRespostaStatus("receptor_disconnected");
  } else if (systemStatus.sensor.hasError && historico.length > 0) {
    displayMode = "sensor_error";
    const lastReading = historico[historico.length - 1];
    responseData = {
      ...lastReading,
      display_mode: "sensor_error",
      receptor_connected: true,
      lora_connected: systemStatus.lora.connected,
      wifi_signal: systemStatus.receptor.wifiSignal,
      sensor_error: true,
      sensor_error_message: systemStatus.sensor.errorDescription,
      config_applied: {
        volume_total: caixaConfig.volumeTotal,
        altura_caixa: caixaConfig.altura
      }
    };
  } else if ((!systemStatus.lora.connected || systemStatus.lora.waitingData) && !hasRecentValidData) {
    // ✅ Só mostra waiting_lora se NÃO houver dados válidos recentes
    displayMode = "waiting_lora";
    responseData = criarRespostaStatus("waiting_lora");
  } else if (historico.length > 0) {
    displayMode = "normal";
    const lastReading = historico[historico.length - 1];
    responseData = {
      ...lastReading,
      display_mode: "normal",
      receptor_connected: true,
      lora_connected: true, // ✅ Marca como conectado se há dados válidos
      wifi_signal: systemStatus.receptor.wifiSignal,
      config_applied: {
        volume_total: caixaConfig.volumeTotal,
        altura_caixa: caixaConfig.altura
      }
    };
  } else {
    displayMode = "normal";
    responseData = criarRespostaStatus("normal");
  }

  // ====== PREPARAR HISTÓRICO COM CÁLCULO DE CONSUMO ======
  // ✅ Filtrar registros waiting_lora redundantes (quando há dados válidos próximos)
  const historicoFiltrado = historico.filter((item, index, array) => {
    // Manter todos os registros normais e de erro
    if (item.status === "normal" || item.status === "sensor_error" || item.status === "receptor_disconnected") {
      return true;
    }
    
    // Para registros waiting_lora, verificar se há dados normais recentes
    if (item.status === "waiting_lora") {
      // Procurar por registros normais nos próximos 5 minutos
      const itemTime = new Date(item.timestamp).getTime();
      const hasNormalAfter = array.some((other, otherIndex) => {
        if (otherIndex <= index) return false; // Só olhar registros posteriores
        const otherTime = new Date(other.timestamp).getTime();
        const timeDiff = otherTime - itemTime;
        return other.status === "normal" && timeDiff < 300000; // 5 minutos
      });
      
      // Se há registro normal logo depois, não mostrar o waiting_lora
      return !hasNormalAfter;
    }
    
    return true;
  });
  
  const historicoParaDashboard = historicoFiltrado.slice(-100).map((item, index, array) => {
    const consumo = calcularConsumo(historico.indexOf(item));
    return {
      ...item,
      uso_1h: consumo.uso1h,
      uso_semana: consumo.usoSemana,
      uso_mes: consumo.usoMes
    };
  }).reverse();

  // ====== ADICIONAR INFORMAÇÕES EXTRAS ======
  responseData = {
    ...responseData,
    receptor_status: {
      connected: systemStatus.receptor.connected,
      last_seen: new Date(systemStatus.receptor.lastSeen).toISOString(),
      wifi_rssi: systemStatus.receptor.wifiSignal,
      description: systemStatus.receptor.description
    },
    lora_status: {
      connected: systemStatus.lora.connected,
      waiting_data: systemStatus.lora.waitingData,
      last_packet: systemStatus.lora.lastPacket ? 
        new Date(systemStatus.lora.lastPacket).toISOString() : null,
      rssi: systemStatus.lora.rssi,
      snr: systemStatus.lora.snr,
      quality: systemStatus.lora.quality,
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

// ====== FUNÇÃO PARA CALCULAR QUALIDADE DO SINAL ====== 
// VERSÃO CORRIGIDA COM RANGE ESTENDIDO
int calculateSignalQuality(int16_t rssi, float snr) {
  // NUNCA retornar 0 se houver RSSI válido (comunicação estabelecida)
  if (rssi == 0) return 0;
  
  int quality = 0;
  
  // RANGE ESTENDIDO - Aceita sinais muito fracos até -130 dBm
  if (rssi >= -40) quality = 100;
  else if (rssi >= -50) quality = 95;
  else if (rssi >= -60) quality = 85;
  else if (rssi >= -70) quality = 75;
  else if (rssi >= -80) quality = 65;
  else if (rssi >= -90) quality = 50;
  else if (rssi >= -100) quality = 35;
  else if (rssi >= -110) quality = 20;
  else if (rssi >= -115) quality = 12;  // NOVO - sinal muito fraco
  else if (rssi >= -120) quality = 8;   // NOVO - sinal extremamente fraco
  else if (rssi >= -125) quality = 5;   // NOVO - limite de sensibilidade
  else if (rssi >= -130) quality = 3;   // NOVO - mínimo detectável
  else quality = 1;  // NUNCA ZERO se houver comunicação
  
  // Ajuste baseado no SNR
  if (snr > 10) quality = min(100, quality + 15);
  else if (snr > 5) quality = min(100, quality + 10);
  else if (snr > 0) quality = min(100, quality + 5);
  else if (snr >= -5) quality = max(1, quality - 5);
  else if (snr >= -10) quality = max(1, quality - 10);
  else quality = max(1, quality - 15);
  
  // GARANTIR que nunca seja 0 quando há RSSI
  return max(1, quality);
}

// ====== VERSÃO ALTERNATIVA COM LÓGICA MAIS SIMPLES ======
int calculateSignalQualitySimple(int16_t rssi) {
  if (rssi == 0) return 0;
  
  // Mapear -130 dBm a -40 dBm para 1% a 100%
  // RSSI melhor = -40 dBm = 100%
  // RSSI pior = -130 dBm = 1%
  
  int quality = map(rssi, -130, -40, 1, 100);
  
  // Garantir limites
  quality = constrain(quality, 1, 100);
  
  return quality;
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
  console.log(`\n🚀 SERVIDOR INICIADO - SISTEMA COM CÁLCULO DE CONSUMO`);
  console.log(`============================================`);
  console.log(`✅ Porta: ${PORT}`);
  console.log(`📡 STATUS DETECTADOS:`);
  console.log(`   • Receptor desconectado = Sem HTTP há 60s`);
  console.log(`   • Aguardando LoRa = Receptor online + sem LoRa há 30s (SINAL ZERADO)`);
  console.log(`   • Erro no sensor = Valores -1`);
  console.log(`   • Normal = Tudo funcionando`);
  console.log(`\n💧 FUNCIONALIDADES:`);
  console.log(`   • Cálculo de consumo por 1 hora`);
  console.log(`   • Cálculo de consumo por semana`);
  console.log(`   • Cálculo de consumo por mês`);
  
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
