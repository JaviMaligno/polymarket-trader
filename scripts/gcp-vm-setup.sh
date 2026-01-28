#!/bin/bash
# ==============================================
# GCP e2-micro VM Setup Script
# Run this on a fresh Debian/Ubuntu VM
# ==============================================

set -e

echo "=== Polymarket Trader - GCP VM Setup ==="

# Update system
echo "[1/6] Updating system packages..."
sudo apt-get update
sudo apt-get upgrade -y

# Install Docker
echo "[2/6] Installing Docker..."
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
rm get-docker.sh

# Install Docker Compose
echo "[3/6] Installing Docker Compose..."
sudo apt-get install -y docker-compose-plugin

# Install Git
echo "[4/6] Installing Git..."
sudo apt-get install -y git

# Clone repository
echo "[5/6] Cloning repository..."
if [ ! -d "polymarket-trader" ]; then
    git clone https://github.com/JaviMaligno/polymarket-trader.git
fi
cd polymarket-trader

# Create .env file
echo "[6/6] Setting up environment..."
if [ ! -f ".env" ]; then
    echo "Creating .env file..."
    cat > .env << 'EOF'
# Database connection (Timescale Cloud)
DATABASE_URL=postgresql://user:password@host:port/database?sslmode=require

# Add your actual DATABASE_URL above
EOF
    echo ""
    echo "!!! IMPORTANT !!!"
    echo "Edit .env file with your DATABASE_URL:"
    echo "  nano .env"
    echo ""
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "1. Edit .env with your DATABASE_URL:"
echo "   nano .env"
echo ""
echo "2. Log out and back in (for docker group):"
echo "   exit"
echo ""
echo "3. Start services:"
echo "   cd polymarket-trader"
echo "   docker compose -f docker-compose.gcp.yml up -d"
echo ""
echo "4. Check status:"
echo "   docker compose -f docker-compose.gcp.yml ps"
echo "   docker compose -f docker-compose.gcp.yml logs -f"
echo ""
