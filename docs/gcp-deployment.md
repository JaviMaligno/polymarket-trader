# Despliegue en Google Cloud Platform (Free Tier)

Esta guía explica cómo desplegar Polymarket Trader en una VM e2-micro de GCP, que es **permanentemente gratuita**.

## Recursos del Free Tier

Google Cloud ofrece **gratis permanente** (no trial):
- 1 VM e2-micro (0.25 vCPU, 1GB RAM)
- 30GB de disco estándar
- Disponible en: `us-west1`, `us-central1`, `us-east1`

## Paso 1: Crear cuenta en GCP

1. Ve a [Google Cloud Console](https://console.cloud.google.com)
2. Crea una cuenta (te pedirán tarjeta pero no cobran si no excedes free tier)
3. Crea un nuevo proyecto: `polymarket-trader`

## Paso 2: Crear la VM e2-micro

### Opción A: Desde la consola web

1. Ve a **Compute Engine > VM instances**
2. Click **Create Instance**
3. Configura:
   - **Name**: `polymarket-vm`
   - **Region**: `us-east1` (o us-west1, us-central1)
   - **Zone**: cualquiera disponible
   - **Machine type**: `e2-micro` (0.25 vCPU, 1GB RAM)
   - **Boot disk**:
     - OS: `Debian 12` o `Ubuntu 22.04 LTS`
     - Size: `30 GB` (máximo gratis)
   - **Firewall**: Marcar "Allow HTTP traffic"
4. Click **Create**

### Opción B: Desde gcloud CLI

```bash
# Instalar gcloud CLI si no lo tienes
# https://cloud.google.com/sdk/docs/install

# Autenticarse
gcloud auth login

# Crear la VM
gcloud compute instances create polymarket-vm \
  --machine-type=e2-micro \
  --zone=us-east1-b \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=30GB \
  --tags=http-server
```

## Paso 3: Conectar a la VM

```bash
# Desde gcloud CLI
gcloud compute ssh polymarket-vm --zone=us-east1-b

# O desde la consola web: click "SSH" en la lista de VMs
```

## Paso 4: Setup automático

Una vez conectado a la VM:

```bash
# Descargar y ejecutar script de setup
curl -fsSL https://raw.githubusercontent.com/JaviMaligno/polymarket-trader/main/scripts/gcp-vm-setup.sh | bash
```

O manualmente:

```bash
# Actualizar sistema
sudo apt-get update && sudo apt-get upgrade -y

# Instalar Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER

# Instalar Docker Compose
sudo apt-get install -y docker-compose-plugin git

# Clonar repo
git clone https://github.com/JaviMaligno/polymarket-trader.git
cd polymarket-trader

# IMPORTANTE: Logout y login para aplicar grupo docker
exit
```

## Paso 5: Configurar variables de entorno

```bash
# Reconectar a la VM
gcloud compute ssh polymarket-vm --zone=us-east1-b

cd polymarket-trader

# Crear archivo .env
nano .env
```

Contenido del `.env`:
```
DATABASE_URL=postgresql://user:password@host:port/database?sslmode=require
```

## Paso 6: Iniciar servicios

```bash
# Construir y arrancar
docker compose -f docker-compose.gcp.yml up -d --build

# Ver logs
docker compose -f docker-compose.gcp.yml logs -f

# Ver estado
docker compose -f docker-compose.gcp.yml ps
```

## Paso 7: Configurar firewall (si necesitas acceso externo)

```bash
# Permitir acceso al health check del data-collector
gcloud compute firewall-rules create allow-data-collector \
  --allow=tcp:10000 \
  --target-tags=http-server

# Permitir acceso al optimizer
gcloud compute firewall-rules create allow-optimizer \
  --allow=tcp:8000 \
  --target-tags=http-server
```

## Comandos útiles

```bash
# Ver logs en tiempo real
docker compose -f docker-compose.gcp.yml logs -f

# Reiniciar servicios
docker compose -f docker-compose.gcp.yml restart

# Parar servicios
docker compose -f docker-compose.gcp.yml down

# Actualizar a última versión
git pull
docker compose -f docker-compose.gcp.yml up -d --build

# Ver uso de recursos
docker stats
```

## Monitorización

### Health checks
- Data Collector: `http://<VM_IP>:10000/health`
- Optimizer: `http://<VM_IP>:8000/health`

### Ver IP externa de la VM
```bash
gcloud compute instances describe polymarket-vm \
  --zone=us-east1-b \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)'
```

## Troubleshooting

### Out of memory
La VM tiene solo 1GB. Si hay problemas:
```bash
# Ver memoria disponible
free -h

# Ver qué consume más
docker stats --no-stream

# Reiniciar para liberar memoria
docker compose -f docker-compose.gcp.yml restart
```

### Servicios no arrancan
```bash
# Ver logs de error
docker compose -f docker-compose.gcp.yml logs --tail=100

# Verificar que .env existe y tiene DATABASE_URL
cat .env
```

### La VM se para
Las VMs e2-micro no se paran automáticamente. Si se para:
1. Verifica en la consola de GCP
2. Puede ser mantenimiento programado (raro)
3. Reinicia desde la consola

## Costos

| Recurso | Free Tier | Tu uso | Costo |
|---------|-----------|--------|-------|
| VM e2-micro | 1 instancia | 1 | $0 |
| Disco | 30GB standard | 30GB | $0 |
| Red egress | 1GB/mes | ~500MB | $0 |

**Total: $0/mes** (mientras no excedas los límites)

## Arquitectura Híbrida

El sistema usa una arquitectura híbrida GCP + Render:

| Servicio | Ubicación | Razón |
|----------|-----------|-------|
| Data Collector | GCP | Necesita estar siempre activo |
| Dashboard API | GCP | Necesita estar siempre activo |
| TimescaleDB | GCP / Timescale Cloud | Persistencia de datos |
| Optimizer | Render | Tolera idle time (solo se usa ocasionalmente) |
| Frontend | Render | Static site, CDN gratuito |

### URLs de Producción

- **Frontend**: https://polymarket-dashboard-frontend.onrender.com
- **API**: http://34.74.36.101:3001
- **Optimizer**: https://polymarket-optimizer-server.onrender.com
