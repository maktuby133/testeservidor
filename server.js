import express from "express";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

let historico = [];

app.post("/api/lora", (req, res) => {
  const { device, percentage, liters, sensor_ok, timestamp } = req.body;
  const registro = {
    device: device || "ESP32",
    percentage: percentage || 0,
    liters: liters || 0,
    sensor_ok: sensor_ok ?? true,
    timestamp: timestamp || new Date().toISOString()
  };
  historico.push(registro);
  if (historico.length > 50) historico.shift();
  res.json({ status: "ok", recebido: registro });
});

app.get("/api/lora", (req, res) => {
  const ultimo = historico[historico.length - 1] || {
    device: "ESP32",
    percentage: 0,
    liters: 0,
    sensor_ok: true,
    timestamp: null
  };
  res.json({
    ...ultimo,
    historico: historico.slice(-7)
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});
