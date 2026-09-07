from fastapi import APIRouter, File, UploadFile, HTTPException, Form
from typing import List
import os, json, shutil, uuid
from datetime import datetime

router = APIRouter()

# Directories relative to main/ (cwd when uvicorn runs from main/)
UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "..", "uploads")
UPLOAD_DIR = os.path.abspath(UPLOAD_DIR)
META_FILE = os.path.join(UPLOAD_DIR, "models.json")

os.makedirs(UPLOAD_DIR, exist_ok=True)

ALLOWED_SOURCE = {"huggingface", "kaggle", "local"}
ALLOWED_EXT = {".bin", ".pt", ".pth", ".safetensors", ".onnx", ".h5", ".pkl", ".ckpt", ".zip", ".tar", ".gz"}


def _load_meta() -> List[dict]:
    if not os.path.exists(META_FILE):
        return []
    with open(META_FILE, "r") as f:
        return json.load(f)


def _save_meta(data):
    with open(META_FILE, "w") as f:
        json.dump(data, f, indent=2)


def list_models() -> List[dict]:
    """Public helper used by the page route in main.py."""
    return _load_meta()


@router.get("/models")
async def api_list_models():
    """Return all stored model metadata as JSON."""
    return {"models": _load_meta(), "count": len(_load_meta())}


@router.post("/models/upload")
async def upload_model(
    file: UploadFile = File(...),
    name: str = Form(...),
    source: str = Form("huggingface"),
    description: str = Form(""),
):
    """Upload a model file. Source can be huggingface, kaggle, or local."""
    source = source.lower().strip()
    if source not in ALLOWED_SOURCE:
        raise HTTPException(status_code=400, detail=f"source must be one of {ALLOWED_SOURCE}")

    ext = os.path.splitext(file.filename)[1].lower()
    if ext and ext not in ALLOWED_EXT:
        raise HTTPException(status_code=400, detail=f"extension '{ext}' not allowed. Allowed: {sorted(ALLOWED_EXT)}")

    model_id = str(uuid.uuid4())
    safe_name = name.strip().replace(" ", "_")
    stored_name = f"{model_id}_{safe_name}{ext}"
    file_path = os.path.join(UPLOAD_DIR, stored_name)

    with open(file_path, "wb") as out:
        shutil.copyfileobj(file.file, out)

    size_mb = round(os.path.getsize(file_path) / (1024 * 1024), 2)

    record = {
        "id": model_id,
        "name": name.strip(),
        "source": source,
        "description": description.strip(),
        "filename": stored_name,
        "size_mb": size_mb,
        "uploaded_at": datetime.utcnow().isoformat() + "Z",
    }

    models = _load_meta()
    models.append(record)
    _save_meta(models)

    return {"message": "Model uploaded", "model": record}


@router.delete("/models/{model_id}")
async def delete_model(model_id: str):
    models = _load_meta()
    target = next((m for m in models if m["id"] == model_id), None)
    if not target:
        raise HTTPException(status_code=404, detail="Model not found")

    file_path = os.path.join(UPLOAD_DIR, target["filename"])
    if os.path.exists(file_path):
        os.remove(file_path)

    models = [m for m in models if m["id"] != model_id]
    _save_meta(models)
    return {"message": "Model deleted", "id": model_id}


@router.get("/models/{model_id}")
async def get_model(model_id: str):
    models = _load_meta()
    target = next((m for m in models if m["id"] == model_id), None)
    if not target:
        raise HTTPException(status_code=404, detail="Model not found")
    return target
