"""HTML page routes (server-rendered shells, behavior lives in /static)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from backend.dependencies import get_settings
from backend.config import Settings

router = APIRouter(tags=["pages"])

_PAGES = {
    "/": "index.html",
    "/upload.html": "upload.html",
    "/dashboard.html": "dashboard.html",
    "/apikeys.html": "apikeys.html",
}


def _register(page_path: str, file_name: str) -> None:
    @router.get(page_path, include_in_schema=False, name=f"page_{file_name}")
    async def _page(settings: Settings = Depends(get_settings)) -> FileResponse:
        path = settings.frontend_dir / file_name
        if not path.is_file():
            raise HTTPException(status_code=404, detail="Page not found")
        return FileResponse(path, headers={"Cache-Control": "no-cache"})


for _route, _file in _PAGES.items():
    _register(_route, _file)
