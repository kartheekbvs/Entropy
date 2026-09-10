# ModelForge — ML Model Hosting Platform

Transform your trained ML models into production-ready APIs in seconds.
Upload a model → get an API key → make predictions anywhere.

## Features

- **Scroll-driven landing page** — Video-like sections that animate as you scroll
- **Model upload** — Upload any Python pickle (.pkl) ML model
- **API key management** — Multiple purpose-specific API keys per model
- **Live predictions** — Query your model via REST API with any input
- **Dashboard** — Track usage, manage keys, view prediction logs
- **Demo model** — Pre-trained spam classifier included out of the box

## Tech Stack

- **Backend**: FastAPI (Python 3.13+)
- **Frontend**: Vanilla HTML/CSS/JS with GSAP scroll animations
- **ML**: scikit-learn, joblib, numpy, pandas

## Installation

```bash
pip install --break-system-packages -r requirements.txt
```

## Run

```bash
./start.sh
# or
python3 -m uvicorn backend.main:app --host 0.0.0.0 --port 4500 --reload
```

## URLs

| Page         | URL                          |
|--------------|------------------------------|
| Landing Page | http://localhost:4500/       |
| Dashboard    | http://localhost:4500/dashboard.html |
| Upload       | http://localhost:4500/upload.html   |
| API Keys     | http://localhost:4500/apikeys.html  |
| API Docs     | http://localhost:4500/docs          |

## API Endpoints

```
POST /api/upload              — Upload a .pkl model file
POST /api/keys                — Generate API key for a model
GET  /api/keys                — List API keys for a model
DELETE /api/keys/{key_id}     — Revoke an API key
POST /api/predict/{model_id}  — Make prediction using an API key
GET  /api/models              — List all uploaded models
GET  /api/dashboard           — Dashboard stats (key count, model count, etc.)
GET  /api/logs/{model_id}     — Prediction logs for a model
```

## Test

```bash
# Quick server health check
curl http://localhost:4500/

# Predict using demo spam model
curl -X POST http://localhost:4500/api/predict/demo-spam-classifier \
  -H "X-API-Key: demo-api-key-12345" \
  -H "Content-Type: application/json" \
  -d '{"data": ["WIN A FREE IPHONE NOW CLICK HERE"]}'
```
