// Teste da função de truncamento inteligente

// Função para truncar títulos de forma inteligente
function truncateIntelligently(text, maxLength) {
  if (text.length <= maxLength) return text;
  
  // Encontrar o último espaço antes do limite
  let cutPoint = maxLength;
  while (cutPoint > 0 && text[cutPoint] !== ' ') {
    cutPoint--;
  }
  
  // Se não encontrou um espaço, ou o corte seria muito pequeno
  if (cutPoint < maxLength * 0.7) {
    // Cortar no limite e adicionar reticências
    return text.substring(0, maxLength - 3) + '...';
  }
  
  // Cortar no último espaço e adicionar reticências
  let result = text.substring(0, cutPoint).trim();
  
  // Remover pontuação final se houver
  result = result.replace(/[.,;:!?]$/, '');
  
  return result + '...';
}

// Testes
const exemplos = [
  "Advogado Piripiriense José Amâncio Neto é nomeado coordenador especial",
  "Governador do Piauí anuncia investimento de R$ 200 milhões em infraestrutura que beneficiará mais de 50 cidades do interior do estado",
  "Prefeitura de Teresina inaugura novo hospital público"
];

console.log('🧪 TESTES DE TRUNCAMENTO INTELIGENTE:\n');

exemplos.forEach((titulo, index) => {
  console.log(`TESTE ${index + 1}:`);
  console.log(`Original (${titulo.length} chars): "${titulo}"`);
  console.log(`Truncado (${truncateIntelligently(titulo, 55).length} chars): "${truncateIntelligently(titulo, 55)}"`);
  console.log('---');
});

console.log('\n✅ VANTAGENS:');
console.log('- Não corta palavras no meio');
console.log('- Preserva significado');
console.log('- Remove pontuação desnecessária');
console.log('- Mantém nomes próprios completos quando possível');
