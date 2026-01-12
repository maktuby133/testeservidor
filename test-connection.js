
const WebSocket = require('ws');

console.log('🔍 Testando conexão com o servidor...');

// Testar HTTP Server
const http = require('http');
const httpOptions = {
  hostname: 'localhost',
  port: 3000,
  path: '/health',
  method: 'GET',
  timeout: 5000
};

const httpTest = new Promise((resolve, reject) => {
  const req = http.request(httpOptions, (res) => {
    let data = '';
    
    res.on('data', (chunk) => {
      data += chunk;
    });
    
    res.on('end', () => {
      try {
        const jsonData = JSON.parse(data);
        if (jsonData.status === 'healthy') {
          console.log('✅ HTTP Server está funcionando');
          resolve();
        } else {
          reject(new Error('HTTP Server não está saudável'));
        }
      } catch (error) {
        reject(new Error('Resposta HTTP inválida'));
      }
    });
  });
  
  req.on('error', (error) => {
    reject(new Error(`HTTP Error: ${error.message}`));
  });
  
  req.on('timeout', () => {
    req.destroy();
    reject(new Error('HTTP Timeout'));
  });
  
  req.end();
});

// Testar WebSocket Server
const wsTest = new Promise((resolve, reject) => {
  const ws = new WebSocket('ws://localhost:8080');
  let timeout;
  
  ws.on('open', () => {
    console.log('✅ WebSocket Server está funcionando');
    clearTimeout(timeout);
    ws.close();
    resolve();
  });
  
  ws.on('error', (error) => {
    clearTimeout(timeout);
    reject(new Error(`WebSocket Error: ${error.message}`));
  });
  
  timeout = setTimeout(() => {
    ws.close();
    reject(new Error('WebSocket Timeout'));
  }, 5000);
});

// Executar todos os testes
Promise.all([httpTest, wsTest])
  .then(() => {
    console.log('\n🎉 Todos os testes passaram! O sistema está funcionando corretamente.');
    console.log('\n📊 Serviços disponíveis:');
    console.log('   🌐 HTTP Server:  http://localhost:3000');
    console.log('   🔗 WebSocket:    ws://localhost:8080');
    console.log('   ⚙️  Painel:       http://localhost:3000/config');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Teste falhou:', error.message);
    console.log('\n🔧 Solução de problemas:');
    console.log('   1. Verifique se o servidor está rodando: node server.js');
    console.log('   2. Verifique as portas 3000 e 8080');
    console.log('   3. Verifique o arquivo .env');
    process.exit(1);
  });
