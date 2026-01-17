
#!/usr/bin/env node

/**
 * BOT PARA MANTER SERVIDOR ATIVO NO RENDER
 * Este script faz ping periódico no servidor para evitar que ele seja desligado
 * por inatividade no plano gratuito do Render.
 */

import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

// Configurações
const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
const PING_INTERVAL = 14 * 60 * 1000; // 14 minutos (Render desliga após 15min inatividade)
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutos para verificar saúde
const RETRY_DELAY = 30000; // 30 segundos se falhar

// URLs para pingar
const ENDPOINTS = [
  "/health",
  "/api/lora",
  "/api/test",
  "/"
];

// Histórico de status
let statusHistory = [];
let totalPings = 0;
let successfulPings = 0;
let failedPings = 0;

// Função para fazer ping em um endpoint
async function pingEndpoint(endpoint) {
  const url = `${SERVER_URL}${endpoint}`;
  const startTime = Date.now();
  
  try {
    const response = await fetch(url, {
      timeout: 10000, // 10 segundos timeout
      headers: {
        'User-Agent': 'Render-KeepAlive-Bot/1.0'
      }
    });
    
    const endTime = Date.now();
    const responseTime = endTime - startTime;
    
    const logEntry = {
      timestamp: new Date().toISOString(),
      endpoint,
      status: response.status,
      responseTime,
      success: response.ok
    };
    
    if (response.ok) {
      successfulPings++;
      console.log(`✅ ${endpoint} - ${response.status} (${responseTime}ms)`);
    } else {
      failedPings++;
      console.log(`⚠️  ${endpoint} - ${response.status} (${responseTime}ms)`);
    }
    
    statusHistory.push(logEntry);
    
    // Manter apenas últimos 100 registros
    if (statusHistory.length > 100) {
      statusHistory.shift();
    }
    
    return logEntry;
    
  } catch (error) {
    const endTime = Date.now();
    const responseTime = endTime - startTime;
    
    const logEntry = {
      timestamp: new Date().toISOString(),
      endpoint,
      status: 'ERROR',
      responseTime,
      success: false,
      error: error.message
    };
    
    failedPings++;
    console.log(`❌ ${endpoint} - ERRO: ${error.message} (${responseTime}ms)`);
    
    statusHistory.push(logEntry);
    
    if (statusHistory.length > 100) {
      statusHistory.shift();
    }
    
    return logEntry;
  }
}

// Função para pingar todos os endpoints
async function pingAllEndpoints() {
  totalPings++;
  console.log(`\n🔄 Ping #${totalPings} - ${new Date().toLocaleString()}`);
  console.log(`📡 Server: ${SERVER_URL}`);
  
  const results = [];
  
  for (const endpoint of ENDPOINTS) {
    const result = await pingEndpoint(endpoint);
    results.push(result);
    
    // Pequena pausa entre requisições
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  return results;
}

// Função para verificar saúde do servidor
async function healthCheck() {
  console.log(`\n🏥 Health Check - ${new Date().toLocaleString()}`);
  
  try {
    const response = await fetch(`${SERVER_URL}/health`, { timeout: 15000 });
    
    if (response.ok) {
      const data = await response.json();
      console.log(`✅ Health: ${data.status}`);
      console.log(`⏰ Uptime: ${Math.floor(data.uptime)} segundos`);
      console.log(`📡 Receptor: ${data.receptor_connected ? 'CONECTADO' : 'DESCONECTADO'}`);
      
      if (data.receptor_last_seen) {
        const lastSeen = new Date(data.receptor_last_seen);
        const diffMinutes = Math.floor((Date.now() - lastSeen.getTime()) / 60000);
        console.log(`👀 Receptor visto há: ${diffMinutes} minutos`);
      }
      
      return true;
    } else {
      console.log(`⚠️  Health Check falhou: ${response.status}`);
      return false;
    }
    
  } catch (error) {
    console.log(`❌ Health Check erro: ${error.message}`);
    return false;
  }
}

// Função para mostrar estatísticas
function showStats() {
  console.log(`\n📊 ESTATÍSTICAS DO BOT`);
  console.log(`=======================`);
  console.log(`Total de pings: ${totalPings}`);
  console.log(`Pings bem-sucedidos: ${successfulPings}`);
  console.log(`Pings falhos: ${failedPings}`);
  console.log(`Taxa de sucesso: ${totalPings > 0 ? ((successfulPings / totalPings) * 100).toFixed(2) : 0}%`);
  console.log(`Tempo de execução: ${Math.floor(process.uptime())} segundos`);
  console.log(`Próximo ping em: ${Math.floor(PING_INTERVAL / 60000)} minutos`);
  
  if (statusHistory.length > 0) {
    const lastPing = statusHistory[statusHistory.length - 1];
    console.log(`Último ping: ${new Date(lastPing.timestamp).toLocaleTimeString()}`);
  }
}

// Função principal
async function main() {
  console.log(`
🤖 BOT DE KEEP-ALIVE PARA RENDER
================================
Servidor: ${SERVER_URL}
Intervalo de ping: ${PING_INTERVAL / 60000} minutos
Intervalo health check: ${HEALTH_CHECK_INTERVAL / 60000} minutos

O bot irá manter o servidor ativo pingando periodicamente.
Render desliga aplicações gratuitas após 15 minutos de inatividade.

Iniciando em: ${new Date().toLocaleString()}
  `);
  
  // Ping imediato ao iniciar
  await pingAllEndpoints();
  
  // Configurar intervalos
  setInterval(pingAllEndpoints, PING_INTERVAL);
  setInterval(healthCheck, HEALTH_CHECK_INTERVAL);
  setInterval(showStats, 10 * 60 * 1000); // Mostrar stats a cada 10 min
  
  // Health check a cada 5 minutos
  setInterval(healthCheck, 5 * 60 * 1000);
  
  // Manter processo rodando
  setInterval(() => {
    // Apenas para manter ativo
  }, 60000);
  
  console.log(`\n✅ Bot iniciado com sucesso!`);
  console.log(`📡 Monitorando servidor: ${SERVER_URL}`);
}

// Tratamento de sinais para shutdown elegante
process.on('SIGINT', () => {
  console.log('\n\n🛑 Recebido SIGINT. Desligando bot...');
  showStats();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\n🛑 Recebido SIGTERM. Desligando bot...');
  showStats();
  process.exit(0);
});

// Iniciar bot
main().catch(error => {
  console.error(`❌ Erro ao iniciar bot: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});
