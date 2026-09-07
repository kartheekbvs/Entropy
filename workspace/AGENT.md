# AGENT.md — project memory

Persistent notes for the autonomous coding agent (written by you and
by the agent across previous runs). Keep it short and operational.

## Project: ModelForge — ML Model Hosting Platform

**Location**: `/home/z/my-project/workspace/`
**Port**: 4500

### What it is
A full ML model hosting platform: upload .pkl models → get API keys → make predictions via REST API. 
Features a scroll-driven "video-like" landing page with GSAP scroll animations, a dashboard, upload UI, and API key management UI.

### Key files
- `backend/main.py` — FastAPI app (all routes, upload, predict, keys, dashboard)
- `backend/storage.py` — In-memory store (models, API keys, prediction logs)
- `backend/predictor.py` — .pkl model loading and prediction engine
- `frontend/index.html` — Scroll-driven landing page
- `frontend/dashboard.html` — Live dashboard with model list, logs, inline predict console
- `frontend/upload.html` — Drag-and-drop model upload page
- `frontend/apikeys.html` — API key management page
- `frontend/static/styles.css` — All CSS (dark theme, GSAP animations, responsive)
- `frontend/static/main.js` — All JS (GSAP scroll triggers, API client, demo console)
- `train_demo_model.py` — Trains a spam classifier → `demo_models/spam_classifier.pkl`

### How to run
```bash
python3 -m uvicorn backend.main:app --host 0.0.0.0 --port 4500 --reload
```
Or: `./start.sh`

### Important quirks (lessons learned)
- Python 3.13 enforces dataclass field ordering strictly: non-default fields MUST come before fields with defaults.
  Always put `uploaded_at: str` (no default) before `feature_count: Optional[int] = None` (default).
- Static files mounted at `/static/` must resolve to `frontend/static/` directory (not just `frontend/`).
- Use `--break-system-packages` for pip installs on this system (PEP 668 restriction).
- FastAPI file uploads via `multipart/form-data` — use `UploadFile` + `Form()` params.
- The predictor handles string lists (text data) separately from numeric arrays to avoid TF-IDF vectorizer errors.
- Background processes started with `&` get a log at `.agent-shell/bg-*.log`.
- Shell commands with `print()` or complex expressions in `-c` are blocked — write scripts to `.py` files.

### URLs
| Page | URL |
|------|-----|
| Landing | http://localhost:4500/ |
| Dashboard | http://localhost:4500/dashboard.html |
| Upload | http://localhost:4500/upload.html |
| API Keys | http://localhost:4500/apikeys.html |
| API Docs | http://localhost:4500/docs |
