from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from routers import model_routes

app = FastAPI(
    title="ML Model Hub",
    description="Upload and manage ML models from HuggingFace and Kaggle",
    version="1.0.0",
)

# Mount static files (CSS/JS) — directory is relative to this file
app.mount("/static", StaticFiles(directory="static"), name="static")

# Jinja2 templates live in main/templates
templates = Jinja2Templates(directory="templates")

# Include the model router under /api
app.include_router(model_routes.router, prefix="/api", tags=["models"])


@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    """Landing page."""
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/upload", response_class=HTMLResponse)
async def upload_page(request: Request):
    """Upload page with drag-and-drop form for HuggingFace / Kaggle models."""
    return templates.TemplateResponse("upload.html", {"request": request})


@app.get("/models", response_class=HTMLResponse)
async def models_page(request: Request):
    """List all uploaded models."""
    models = model_routes.list_models()
    return templates.TemplateResponse("models.html", {"request": request, "models": models})


@app.get("/health")
async def health():
    return {"status": "ok", "service": "ML Model Hub"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
