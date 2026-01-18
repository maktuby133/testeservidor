#!/usr/bin/env node

/**
 * BOT SIMPLES PARA MANTER SERVIDOR ATIVO NO RENDER
 * Faz ping a cada 14 minutos para evitar desligamento
 */

import fetch from 'node-fetch';

// Configurações
const SERVER_URL = process.env.SERVER_URL || "https://testeservidor-6opr.onrender.com";
const PING_INTERVAL = 14 * 60 * 1000; // 14 minutos
const PING_TIMEOUT = 10000; // 10 segundos

console.log(`
🤖 BOT SIMPLES DE KEEP-ALIVE
===========================
Servidor: ${SERVER_URL}
Intervalo: 14 minutos
Iniciado em: ${new Date().toLocaleString()}
`);

// Função para fazer ping
async function pingServer() {
  const urls = [
    `${SERVER_URL}/keep-alive`,
    `${SERVER_URL}/health`,
    `${SERVER_URL}/api/test`
  ];
  
  for (const url of urls) {
    try {
      const startTime = Date.now();
      const response = await fetch(url, { 
        timeout: PING_TIMEOUT,
        headers: { 'User-Agent': 'KeepAlive-Bot/1.0' }
      });
      const endTime = Date.now();
      const responseTime = endTime - startTime;
      
      if (response.ok) {
        console.log(`✅ ${url} - ${response.status} (${responseTime}ms)`);
      } else {
        console.log(`⚠️  ${url} - ${response.status} (${responseTime}ms)`);
      }
    } catch (error) {
      console.log(`❌ ${url} - ERRO: ${error.message}`);
    }
    
    // Pequena pausa entre requisições
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log(`🔄 Próximo ping em: ${new Date(Date.now() + PING_INTERVAL).toLocaleTimeString()}`);
}

// Ping imediato
pingServer();

// Configurar intervalo
const intervalId = setInterval(pingServer, PING_INTERVAL);

// Manter processo rodando
setInterval(() => {
  // Apenas para manter ativo
}, 60000);

// Tratamento de sinais
process.on('SIGINT', () => {
  console.log('\n🛑 Bot desligado');
  clearInterval(intervalId);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Bot desligado');
  clearInterval(intervalId);
  process.exit(0);
});
