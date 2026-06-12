#!/bin/bash

# run_lighthouse.sh - Script para ejecutar auditorías de Lighthouse

# Colores para salida en consola
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Lighthouse Audit Runner ===${NC}"

# 1. Obtener la URL
URL=$1
if [ -z "$URL" ]; then
    echo -e "${YELLOW}No se especificó ninguna URL.${NC}"
    read -p "Introduce la URL a auditar (ej. http://localhost:5173 o https://example.com): " URL
    if [ -z "$URL" ]; then
        echo -e "${RED}Error: Debes proporcionar una URL.${NC}"
        exit 1
    fi
fi

# 2. Obtener el dispositivo (mobile o desktop)
DEVICE=$2
if [ -z "$DEVICE" ]; then
    echo -e "Selecciona el dispositivo para la auditoría:"
    echo "1) Mobile (Móvil - por defecto)"
    echo "2) Desktop (Escritorio)"
    read -p "Opción [1 o 2]: " OPTION
    if [ "$OPTION" == "2" ]; then
        DEVICE="desktop"
    else
        DEVICE="mobile"
    fi
fi

# Configurar banderas según el dispositivo
FLAGS=""
if [ "$DEVICE" == "desktop" ]; then
    FLAGS="--preset=desktop"
    echo -e "${GREEN}Configurando auditoría para Escritorio (Desktop)...${NC}"
else
    DEVICE="mobile"
    echo -e "${GREEN}Configurando auditoría para Móvil (Mobile)...${NC}"
fi

# 3. Crear directorio para guardar reportes
REPORT_DIR="lighthouse-reports"
mkdir -p "$REPORT_DIR"

# Formatear el nombre del archivo de salida
TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
# Limpiar la URL para el nombre de archivo (quitar http://, https:// y caracteres raros)
CLEAN_URL=$(echo "$URL" | sed -e 's/[^a-zA-Z0-9]/_/g' -e 's/http__//g' -e 's/https__//g')
OUTPUT_FILE="$REPORT_DIR/report-${CLEAN_URL}-${DEVICE}-${TIMESTAMP}"

echo -e "${BLUE}Auditando: ${URL}${NC}"
echo -e "${BLUE}Guardando reporte en: ${OUTPUT_FILE}.html${NC}"
echo -e "Ejecutando auditoría..."

# 4. Verificar si Lighthouse está instalado globalmente, de lo contrario usar npx
if command -v lighthouse &> /dev/null; then
    lighthouse "$URL" $FLAGS --output=html --output-path="${OUTPUT_FILE}.html" --view
else
    echo -e "${YELLOW}Lighthouse global no detectado. Ejecutando mediante npx...${NC}"
    npx -y lighthouse "$URL" $FLAGS --output=html --output-path="${OUTPUT_FILE}.html" --view
fi

# 5. Confirmación final
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Auditoría completada con éxito.${NC}"
    echo -e "Puedes abrir el reporte manualmente en: ${GREEN}file://$(pwd)/${OUTPUT_FILE}.html${NC}"
else
    echo -e "${RED}✗ Ocurrió un error al ejecutar Lighthouse.${NC}"
    exit 1
fi
