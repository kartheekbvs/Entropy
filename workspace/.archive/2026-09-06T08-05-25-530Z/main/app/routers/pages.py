from fastapi import APIRouter, Request
from app.main import TEMPLATES

router = APIRouter()


@router.get("/")
async def home(request: Request):
    return TEMPLATES.TemplateResponse("index.html", {"request": request})


@router.get("/upload")
async def upload_page(request: Request):
    return TEMPLATES.TemplateResponse("upload.html", {"request": request})


@router.get("/models")
async def models_page(request: Request):
    return TEMPLATES.TemplateResponse("models.html", {"request": request})
