import os
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATES = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)


def create_app() -> FastAPI:
    app = FastAPI(title="ML Model Uploader", description="Upload ML models like Hugging Face / Kaggle")
    app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")

    from .routers import upload, models, pages
    app.include_router(pages.router)
    app.include_router(upload.router)
    app.include_router(models.router)
    return app


app = create_app()


@app.get("/health")
def health():
    return {"status": "ok"}
