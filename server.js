import express from "express";
import path from "path";

const app = express();
app.use(express.json());

// Memória temporária para histórico
let historico = [];

// Middleware de autenticação (opcional)
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization;
  const allowedTokens = process.env.ALLOWED_TOKENS?.split(',') || [];
  
  if (!token || !allowedTokens.includes(token)) {
    return res.status(401).json({ error: "Token inválido" });
  }
  next();
};

// Recebe dados do ESP32 receptor
app.post("/api/lora", authMiddleware, (req, res) => {
  console.log("📥 Dados recebidos:", req.body);
  
  // Extrair todos os campos do ESP32
  const { 
    device, 
    distance, 
    level, 
    percentage, 
    liters, 
    sensor_ok,
    timestamp 
  } = req.body;

  const registro = {
    device: device || "ESP32",
    distance: parseFloat(distance) || 0,
    level: parseInt(level) || 0,
    percentage: parseInt(percentage) || 0,
    liters: parseInt(liters) || 0,
    sensor_ok: sensor_ok !== false,
    timestamp: timestamp || new Date().toISOString()
  };

  console.log("📊 Registro salvo:", registro);
  
  historico.push(registro);
  if (historico.length > 100) historico.shift();

  res.json({ 
    status: "ok", 
    message: "Dados recebidos com sucesso",
    recebido: registro 
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
    historico: historico.slice(-20) // Últimas 20 leituras
  });
});

// Endpoint para dados de teste
app.get("/api/test", (req, res) => {
  const testData = {
    device: "TX_CAIXA_01",
    distance: 45.7,
    level: 64,
    percentage: 58,
    liters: 2900,
    sensor_ok: true,
    timestamp: new Date().toISOString()
  };
  
  res.json(testData);
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
  console.log(`   POST /api/lora    - Receber dados do ESP32`);
  console.log(`   GET  /api/lora    - Obter dados para dashboard`);
  console.log(`   GET  /api/test    - Dados de teste`);
});
