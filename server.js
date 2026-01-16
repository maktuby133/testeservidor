import express from "express";
import path from "path";
import dotenv from "dotenv";

// Carregar variáveis de ambiente
dotenv.config();

const app = express();
app.use(express.json());

// Memória temporária para histórico
let historico = [];

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
    crc 
  } = req.body;

  const registro = {
    device: device || "ESP32",
    distance: parseFloat(distance) || 0,
    level: parseInt(level) || 0,
    percentage: parseInt(percentage) || 0,
    liters: parseInt(liters) || 0,
    sensor_ok: sensor_ok !== false,
    timestamp: timestamp || new Date().toISOString(),
    crc: crc || "N/A",
    received_at: new Date().toISOString()
  };

  console.log("📊 Registro salvo:", registro);
  
  historico.push(registro);
  if (historico.length > 100) historico.shift();

  res.json({ 
    status: "ok", 
    message: "Dados recebidos com sucesso!",
    recebido: registro,
    historico_count: historico.length
  });
});

// Fornece dados para o dashboard
app.get("/api/lora", (req, res) => {
  const ultimo = historico.length > 0 ? historico[historico.length - 1] : {
    device: "ESP32",
    distance: 0,
    level: 0,
    percentage: 0,
    liters: 0,
    sensor_ok: true,
    timestamp: null
  };

  res.json({
    ...ultimo,
    historico: historico.slice(-20), // Últimas 20 leituras
    system_info: {
      total_readings: historico.length,
      uptime: process.uptime(),
      memory_usage: process.memoryUsage()
    }
  });
});

// Endpoint para dados de teste (sem autenticação)
app.get("/api/test", (req, res) => {
  const testData = {
    device: "TX_CAIXA_01",
    distance: 45.5,
    level: 65,
    percentage: 59,
    liters: 2950,
    sensor_ok: true,
    timestamp: new Date().toISOString(),
    crc: "0x1234",
    message: "Dados de teste - API funcionando!"
  };
  
  res.json(testData);
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

// Servir arquivos estáticos
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
  console.log(`📊 Endpoints disponíveis:`);
  console.log(`   POST /api/lora      - Receber dados do ESP32 (com auth)`);
  console.log(`   GET  /api/lora      - Obter dados para dashboard`);
  console.log(`   GET  /api/test      - Dados de teste`);
  console.log(`   GET  /api/debug/tokens - Ver tokens permitidos`);
  console.log(`   GET  /              - Dashboard HTML`);
  console.log(`🔐 Tokens permitidos: ${process.env.ALLOWED_TOKENS}`);
});
