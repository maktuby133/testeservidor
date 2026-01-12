
const http = require('http');

console.log('🏥 Verificando saúde do servidor...');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/health',
  method: 'GET',
  timeout: 10000,
  headers: {
    'User-Agent': 'Health-Check/1.0'
  }
};

const req = http.request(options, (res) => {
  let data = '';
  
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    try {
      const result = JSON.parse(data);
      
      if (res.statusCode === 200 && result.status === 'healthy') {
        console.log('✅ Servidor está saudável!');
        console.log('\n📊 Estatísticas:');
        console.log(`   👥 Clientes conectados: ${result.metrics.connectedClients}`);
        console.log(`   📨 Mensagens recebidas: ${result.metrics.messagesReceived}`);
        console.log(`   📤 Mensagens enviadas: ${result.metrics.messagesSent}`);
        console.log(`   ⚠️  Erros: ${result.metrics.errors}`);
        console.log(`   📡 ESP32: ${result.metrics.esp32Connected}`);
        console.log(`   ⏱️  Uptime: ${Math.floor(result.uptime)} segundos`);
        console.log(`   🌍 Ambiente: ${result.environment}`);
        
        // Verificar se ESP32 está conectado
        if (result.metrics.esp32Connected !== 'connected') {
          console.warn('⚠️  ESP32 não está conectado');
        }
        
        // Verificar memória
        const used = process.memoryUsage();
        console.log('\n💾 Uso de memória:');
        console.log(`   RSS: ${Math.round(used.rss / 1024 / 1024)} MB`);
        console.log(`   Heap: ${Math.round(used.heapUsed / 1024 / 1024)} MB / ${Math.round(used.heapTotal / 1024 / 1024)} MB`);
        
        process.exit(0);
      } else {
        console.error('❌ Servidor não está saudável:', result);
        process.exit(1);
      }
    } catch (error) {
      console.error('❌ Resposta inválida do servidor:', error.message);
      process.exit(1);
    }
  });
});

req.on('error', (error) => {
  console.error('❌ Não foi possível conectar ao servidor:', error.message);
  console.log('\n🔧 Verifique:');
  console.log('   1. O servidor está rodando?');
  console.log('   2. Porta 3000 está livre?');
  console.log('   3. Firewall permite a conexão?');
  process.exit(1);
});

req.on('timeout', () => {
  console.error('❌ Timeout ao conectar ao servidor');
  req.destroy();
  process.exit(1);
});

req.end();
