import os
import json
import shutil
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from app.main import TEMPLATES, UPLOAD_DIR

router = APIRouter()


@router.get("/api/models")
async def list_models(request: Request):
    items = _list_models()
    return TEMPLATES.TemplateResponse("_models.html", {"request": request, "models": items})


@router.get("/api/models/json")
async def list_models_json(request: Request):
    return {"models": _list_models()}


def _list_models():
    items = []
    if not os.path.isdir(UPLOAD_DIR):
        return items
    for d in sorted(os.listdir(UPLOAD_DIR)):
        meta_path = os.path.join(UPLOAD_DIR, d, "meta.json")
        if os.path.exists(meta_path):
            with open(meta_path) as f:
                items.append(json.load(f))
    return items
