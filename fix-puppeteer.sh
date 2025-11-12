#!/bin/bash

# Script para arreglar Puppeteer en Mac
# Ejecuta: chmod +x fix-puppeteer.sh && ./fix-puppeteer.sh

echo "🔧 Arreglando Puppeteer para Mac..."

# Ir al directorio backend
cd "$(dirname "$0")"

# Limpiar instalación anterior
echo "📦 Limpiando instalación anterior..."
rm -rf node_modules/puppeteer
rm -rf node_modules/.cache/puppeteer

# Reinstalar Puppeteer
echo "📥 Reinstalando Puppeteer..."
npm install puppeteer --force

# Verificar instalación
echo "✅ Verificando instalación..."
node -e "
const puppeteer = require('puppeteer');
try {
  const path = puppeteer.executablePath();
  console.log('✅ Chromium encontrado en:', path);
  
  // Verificar que el archivo existe
  const fs = require('fs');
  if (fs.existsSync(path)) {
    console.log('✅ Archivo Chromium existe');
  } else {
    console.log('❌ Archivo Chromium NO existe');
  }
} catch (e) {
  console.log('❌ Error:', e.message);
}
"

echo ""
echo "✨ Proceso completado!"
echo ""
echo "Si aún tienes problemas, prueba:"
echo "1. Dar permisos a Terminal en Preferencias del Sistema > Seguridad y Privacidad > Accesibilidad"
echo "2. Ejecutar: xattr -cr node_modules/puppeteer/.local-chromium"
echo "3. Reiniciar el servidor backend"

