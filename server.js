import express from "express";
import path from "path";
import { fileURLToPath } from 'url';
import dotenv from "dotenv";
import fs from "fs";
import mqtt from 'mqtt';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static("public"));

// ==========================================
// CONFIGURAÇÃO MQTT - HIVE MQ
// ==========================================
const MQTT_BROKER = process.env.MQTT_BROKER || "006d70cbbb9d44c2a347d2a3903c8f9a.s1.eu.hivemq.cloud";
const MQTT_PORT = parseInt(process.env.MQTT_PORT) || 8883;
const MQTT_USER = process.env.MQTT_USER || "esp32-receptor";
const MQTT_PASS = process.env.MQTT_PASS || "061084Cc@";

const TOPIC_DADOS = "caixas/agua/dados";
const TOPIC_STATUS = "caixas/agua/status";
const TOPIC_COMANDOS = "caixas/agua/comandos";

// ==========================================
// VARIÁVEIS GLOBAIS
// ==========================================
let historico = [];
let ultimoDado = null;
let caixaConfig = {
  altura: 0,
  volumeTotal: 0,
  distanciaCheia: 0,
  distanciaVazia: 0,
  updatedAt: null
};

let systemStatus = {
  receptorOnline: false,
  ultimaMensagem: null,
  mqttConectado: false
};

// ==========================================
// KEEP-ALIVE AUTOMÁTICO (EVITA SERVIDOR DORMIR)
// ==========================================
let lastKeepAlive = Date.now();

function keepServerAlive() {
  const now = Date.now();
  const elapsed = now - lastKeepAlive;
  
  // Envia heartbeat MQTT a cada 2 minutos
  if (elapsed > 120000 && client.connected()) {
    const heartbeat = {
      server: "render-nodejs",
      status: "alive",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage().heapUsed / 1024 / 1024
    };
    
    client.publish(TOPIC_STATUS, JSON.stringify(heartbeat));
    console.log(`💓 Keep-alive enviado (uptime: ${Math.floor(heartbeat.uptime)}s)`);
    lastKeepAlive = now;
  }
}

// Executa keep-alive a cada 1 minuto
setInterval(keepServerAlive, 60000);

// ==========================================
// CONEXÃO MQTT COM HIVE MQ
// ==========================================
console.log(`🔌 Iniciando conexão MQTT...`);
console.log(`   Broker: ${MQTT_BROKER}:${MQTT_PORT}`);
console.log(`   User: ${MQTT_USER}`);

const client = mqtt.connect(`mqtts://${MQTT_BROKER}:${MQTT_PORT}`, {
  username: MQTT_USER,
  password: MQTT_PASS,
  rejectUnauthorized: true,
  clientId: `render-server-${Math.random().toString(16).substr(2, 8)}`,
  clean: true,
  connectTimeout: 4000,
  reconnectPeriod: 5000,
  keepalive: 60
});

client.on('connect', () => {
  console.log('✅ CONECTADO AO HIVE MQ!');
  systemStatus.mqttConectado = true;
  
  client.subscribe([TOPIC_DADOS, TOPIC_STATUS], (err) => {
    if (err) {
      console.error('❌ Erro ao se inscrever:', err);
    } else {
      console.log(`📡 Inscrito em: ${TOPIC_DADOS}`);
      console.log(`📡 Inscrito em: ${TOPIC_STATUS}`);
      console.log('⏳ Aguardando dados do ESP32...');
    }
  });
});

client.on('message', (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    systemStatus.ultimaMensagem = new Date().toISOString();
    systemStatus.receptorOnline = true;
    
    if (topic === TOPIC_DADOS) {
      console.log(`📥 Recebido: ${payload.percentage}% | ${payload.liters}L | RSSI:${payload.lora_rssi}`);
      
      if (payload.config_volume_total > 0) {
        caixaConfig = {
          altura: payload.config_altura,
          volumeTotal: payload.config_volume_total,
          distanciaCheia: payload.config_distancia_cheia,
          distanciaVazia: payload.config_distancia_vazia,
          updatedAt: new Date().toISOString()
        };
        fs.writeFileSync('config.json', JSON.stringify(caixaConfig));
      }
      
      const registro = {
        device: payload.device || "TX_CAIXA_01",
        distance: payload.distance,
        level: payload.level,
        percentage: payload.percentage,
        liters: payload.liters,
        sensor_ok: payload.sensor_ok,
        timestamp: new Date().toISOString(),
        status: payload.sensor_ok ? "normal" : "sensor_error",
        lora_signal: {
          rssi: payload.lora_rssi,
          snr: payload.lora_snr,
          quality: payload.signal_quality || 85
        }
      };
      
      historico.push(registro);
      ultimoDado = registro;
      
      if (historico.length > 500) {
        historico.shift();
      }
    }
    
    if (topic === TOPIC_STATUS) {
      if (payload.status === "online") {
        console.log("✅ Receptor reportou: ONLINE");
        systemStatus.receptorOnline = true;
      } else if (payload.status === "offline") {
        console.log("⚠️ Receptor desconectou");
        systemStatus.receptorOnline = false;
      }
    }
    
  } catch (e) {
    console.error('❌ Erro ao processar:', e.message);
  }
});

client.on('error', (err) => {
  console.error('❌ Erro MQTT:', err.message);
  systemStatus.mqttConectado = false;
});

client.on('disconnect', () => {
  console.log('⚠️ Desconectado do HiveMQ');
  systemStatus.mqttConectado = false;
});

// ==========================================
// API HTTP
// ==========================================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api/lora", (req, res) => {
  const agora = new Date();
  const ultima = systemStatus.ultimaMensagem ? new Date(systemStatus.ultimaMensagem) : null;
  const desatualizado = ultima ? (agora - ultima) > 120000 : true;
  
  let resposta;
  
  if (!systemStatus.receptorOnline || desatualizado || !ultimoDado) {
    resposta = {
      device: "TX_CAIXA_01",
      distance: -1,
      level: -1,
      percentage: -1,
      liters: -1,
      sensor_ok: false,
      status: "waiting_lora",
      timestamp: new Date().toISOString(),
      message: desatualizado ? "Aguardando dados..." : "Receptor offline",
      receptor_connected: systemStatus.receptorOnline,
      lora_connected: !desatualizado,
      caixa_config: caixaConfig,
      historico: historico.slice(-20).reverse(),
      system_info: {
        mqtt_connected: systemStatus.mqttConectado,
        server_uptime: process.uptime()
      }
    };
  } else {
    resposta = {
      ...ultimoDado,
      receptor_connected: true,
      lora_connected: true,
      caixa_config: caixaConfig,
      historico: historico.slice(-20).reverse(),
      system_info: {
        mqtt_connected: systemStatus.mqttConectado,
        server_uptime: process.uptime()
      }
    };
  }
  
  res.json(resposta);
});

// Rota de keep-alive (chamada pelo bot ou qualquer ping externo)
app.get("/keep-alive", (req, res) => {
  res.json({ 
    status: "alive", 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mqtt: systemStatus.mqttConectado
  });
});

// Rota de health check
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    mqtt_conectado: systemStatus.mqttConectado,
    receptor_online: systemStatus.receptorOnline,
    ultima_mensagem: systemStatus.ultimaMensagem,
    total_registros: historico.length,
    uptime: process.uptime()
  });
});

// Rota de teste
app.get("/api/test", (req, res) => {
  res.json({
    status: "OK",
    mqtt_conectado: systemStatus.mqttConectado,
    receptor_online: systemStatus.receptorOnline,
    ultima_mensagem: systemStatus.ultimaMensagem,
    total_registros: historico.length
  });
});

// Rota para enviar comandos ao ESP32
app.post("/api/comando", express.json(), (req, res) => {
  const { comando } = req.body;
  
  if (!client.connected()) {
    return res.status(503).json({ error: "MQTT desconectado" });
  }
  
  client.publish(TOPIC_COMANDOS, comando);
  console.log(`📤 Comando enviado: ${comando}`);
  
  res.json({ success: true, comando: comando });
});

// ==========================================
// CONFIGURAÇÃO MQTT VIA API (NOVO)
// ==========================================
app.post("/api/configure-mqtt", express.json(), (req, res) => {
  const { broker, port, user, pass } = req.body;
  
  if (!broker || !port || !user || !pass) {
    return res.status(400).json({ 
      error: "Todos os campos são obrigatórios (broker, port, user, pass)" 
    });
  }
  
  // Salvar em variáveis de ambiente (temporário - reinicia perde)
  process.env.MQTT_BROKER = broker;
  process.env.MQTT_PORT = port;
  process.env.MQTT_USER = user;
  process.env.MQTT_PASS = pass;
  
  console.log(`⚙️ Configuração MQTT atualizada:`);
  console.log(`   Broker: ${broker}:${port}`);
  console.log(`   User: ${user}`);
  console.log(`   ⚠️ Reinicie o servidor para aplicar`);
  
  res.json({ 
    success: true, 
    message: "Configuração salva. Reinicie o servidor para aplicar.",
    config: { broker, port, user }
  });
});

// ==========================================
// INICIA SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 SERVIDOR HTTP RODANDO NA PORTA ${PORT}`);
  console.log(`🌐 Dashboard: http://localhost:${PORT}`);
  console.log(`💓 Keep-alive automático: ATIVADO`);
  console.log(`\n⏳ Conectando ao HiveMQ...`);
});
