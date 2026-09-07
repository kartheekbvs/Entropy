import os
import shutil
from datetime import datetime
from fastapi import APIRouter, UploadFile, File, Form, Request
from fastapi.responses import HTMLResponse, JSONResponse
from app.main import TEMPLATES, UPLOAD_DIR

router = APIRouter()


@router.post("/api/upload")
async def upload_model(
    request: Request,
    name: str = Form(...),
    description: str = Form(""),
    tags: str = Form(""),
    model_file: UploadFile = File(...),
):
    model_dir = os.path.join(UPLOAD_DIR, name.strip().replace(" ", "_"))
    os.makedirs(model_dir, exist_ok=True)
    dest = os.path.join(model_dir, model_file.filename)
    with open(dest, "wb") as buf:
        shutil.copyfileobj(model_file.file, buf)

    meta = {
        "name": name,
        "description": description,
        "tags": [t.strip() for t in tags.split(",") if t.strip()],
        "filename": model_file.filename,
        "size": os.path.getsize(dest),
        "uploaded": datetime.utcnow().isoformat(),
    }
    with open(os.path.join(model_dir, "meta.json"), "w") as f:
        import json
        json.dump(meta, f, indent=2)

    # HTMX: return the partial list fragment
    items = _list_models()
    return TEMPLATES.TemplateResponse("_models.html", {"request": request, "models": items})


def _list_models():
    items = []
    if not os.path.isdir(UPLOAD_DIR):
        return items
    for d in sorted(os.listdir(UPLOAD_DIR)):
        meta_path = os.path.join(UPLOAD_DIR, d, "meta.json")
        if os.path.exists(meta_path):
            import json
            with open(meta_path) as f:
                items.append(json.load(f))
    return items
