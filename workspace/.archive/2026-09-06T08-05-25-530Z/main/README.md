# ML Model Hub

FastAPI + HTMX + Jinja2 application to upload ML models (Hugging Face / Kaggle style) with an olive green theme.

## Structure
```
main/
  app/
    __init__.py
    main.py            # FastAPI app factory + mounts
    routers/
      __init__.py
      pages.py         # Jinja2 page routes (/, /upload, /models)
      upload.py        # POST /api/upload (stores file + meta.json)
      models.py        # GET /api/models (HTMX partial) + /api/models/json
  templates/
    base.html, index.html, upload.html, models.html, _models.html
  static/css/style.css   # olive green theme
  uploads/               # stored model files + meta.json (auto-created)
  requirements.txt
```

## Run
```bash
cd main
python -m pip install -r requirements.txt
uvicorn app.main:app --reload --port 4500
```
Open http://localhost:4500

## Notes
- Toggle dark mode with the 🌙 button in the top-right nav (persists to localStorage).
