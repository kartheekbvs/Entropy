"""Environment-driven configuration (12-factor style).

Every knob is overridable through ``MODELFORGE_*`` environment variables so the
same artifact runs identically on a laptop, in Docker and in CI. A single
:class:`Settings` instance is created once at import time and shared via
``create_app`` state — tests build isolated instances with private directories.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

_TRUE = {"1", "true", "yes", "on"}


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in _TRUE


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ[name])
    except (KeyError, ValueError):
        return default


@dataclass(frozen=True)
class Settings:
    """Immutable runtime configuration.

    Attributes:
        base_dir:            repository root (two levels above this module).
        storage_dir:         where uploaded ``.pkl`` artifacts are written.
        state_dir:           where the catalog snapshot is persisted.
        static_dir:          frontend ``/static`` assets directory.
        frontend_dir:        frontend pages (HTML) directory.
        demo_models_dir:     bundled demo models (first-boot seeding).
        host / port:         bind address used by ``start.sh`` / ``main.run``.
        env:                 ``development`` or ``production``.
        max_upload_mb:       hard cap for uploaded artifacts (413 above).
        max_cached_models:   LRU capacity of loaded predictors.
        rate_limit_per_min:  per-key requests/minute (0 disables).
        log_level:           root log level name.
        cors_origins:        allowed CORS origins (``*`` in dev only).
        seed_demo:           load the demo spam classifier on first boot.
        history_limit:       prediction log retention count.
    """

    base_dir: Path = field(default_factory=lambda: Path(__file__).resolve().parent.parent)
    storage_dir: Path = Path("backend/pkl_storage")
    state_dir: Path = Path("state")
    static_dir: Path = Path("frontend/static")
    frontend_dir: Path = Path("frontend")
    demo_models_dir: Path = Path("demo_models")
    host: str = "0.0.0.0"
    port: int = 4500
    env: str = "development"
    max_upload_mb: int = 200
    max_cached_models: int = 8
    rate_limit_per_min: int = 120
    log_level: str = "INFO"
    cors_origins: list[str] = field(default_factory=lambda: ["*"])
    seed_demo: bool = True
    history_limit: int = 5000

    def resolve(self) -> "Settings":
        """Return a copy with all directory paths anchored to ``base_dir``."""
        base = self.base_dir
        changes = {
            "storage_dir": base / self.storage_dir,
            "state_dir": base / self.state_dir,
            "static_dir": base / self.frontend_dir / "static",
            "frontend_dir": base / self.frontend_dir,
            "demo_models_dir": base / self.demo_models_dir,
        }
        return Settings(**{**self.__dict__, **changes})

    @property
    def is_production(self) -> bool:
        return self.env == "production"

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    def ensure_dirs(self) -> None:
        """Create every writable directory upfront (fail fast, atomic boots)."""
        for d in (self.storage_dir, self.state_dir):
            d.mkdir(parents=True, exist_ok=True)


def settings_from_env() -> Settings:
    """Build :class:`Settings` from ``MODELFORGE_*`` environment variables."""
    cors_raw = os.environ.get("MODELFORGE_CORS_ORIGINS", "")
    cors = [o.strip() for o in cors_raw.split(",") if o.strip()] if cors_raw else ["*"]
    env = os.environ.get("MODELFORGE_ENV", "development").lower()
    if env == "production" and cors == ["*"]:
        cors = []  # never allow wildcard CORS in production by default

    s = Settings(
        host=os.environ.get("MODELFORGE_HOST", "0.0.0.0"),
        port=_env_int("MODELFORGE_PORT", 4500),
        env=env,
        max_upload_mb=_env_int("MODELFORGE_MAX_UPLOAD_MB", 200),
        max_cached_models=_env_int("MODELFORGE_MAX_CACHED_MODELS", 8),
        rate_limit_per_min=_env_int("MODELFORGE_RATE_LIMIT_PER_MIN", 120),
        log_level=os.environ.get("MODELFORGE_LOG_LEVEL", "INFO").upper(),
        cors_origins=cors,
        seed_demo=_env_bool("MODELFORGE_SEED_DEMO", True),
        history_limit=_env_int("MODELFORGE_HISTORY_LIMIT", 5000),
    ).resolve()
    s.ensure_dirs()
    return s
