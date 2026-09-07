#!/usr/bin/env bash
# ModelForge start script
set -e

echo "🚀 Starting ModelForge..."

# Check if backend dependencies are installed
python3 -c "import fastapi" 2>/dev/null || {
  echo "Installing dependencies..."
  pip install --quiet --break-system-packages -r requirements.txt
}

# Create storage directory
mkdir -p backend/pkl_storage

echo "📦 Starting FastAPI server on http://0.0.0.0:4500"
python3 -m uvicorn backend.main:app --host 0.0.0.0 --port 4500 --reload
