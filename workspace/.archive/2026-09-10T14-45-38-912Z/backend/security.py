"""API key minting and validation.

Keys use the ``mf_<32 hex>`` shape — generated with ``secrets`` (CSPRNG), so
brute-forcing the 128-bit secret is computationally infeasible. Lookup is an
O(1) dict hit into the key index; the index maps the *hash* of the secret, so
the hot authentication path never compares plaintext strings.
"""

from __future__ import annotations

import hashlib
import re
import secrets

from backend.errors import AuthenticationError, AuthorizationError
from backend.store import ApiKey, Storage

KEY_PREFIX = "mf_"
KEY_PATTERN = re.compile(r"^mf_[0-9a-f]{32}$")
_ALLOWED_KEY_PURPOSES = {"predict", "batch", "analytics"}


def mint_key() -> tuple[str, str]:
    """Generate a new secret. Returns ``(secret, sha256_hex)``."""
    secret = KEY_PREFIX + secrets.token_hex(16)
    return secret, hash_secret(secret)


def hash_secret(secret: str) -> str:
    """SHA-256 of a secret (index key — not a password hash; see README)."""
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def build_key(model_id: str, purpose: str, label: str, created_at: str) -> ApiKey:
    """Create a fully-formed :class:`ApiKey` record ready to register."""
    if purpose not in _ALLOWED_KEY_PURPOSES:
        raise ValueError(f"purpose must be one of {sorted(_ALLOWED_KEY_PURPOSES)}")
    secret, key_hash = mint_key()
    key_id = secrets.token_hex(6)
    return ApiKey(
        id=key_id,
        key=secret,
        key_hash=key_hash,
        model_id=model_id,
        purpose=purpose,
        label=label,
        created_at=created_at,
    )


def validate_key(store: Storage, secret: str | None, model_id: str | None = None) -> ApiKey:
    """Authenticate a request and (optionally) authorize it for one model.

    Raises:
        AuthenticationError: header missing or unknown secret.
        AuthorizationError:  key revoked, or scoped to a different model.
    """
    if not secret:
        raise AuthenticationError("X-API-Key header is required")
    if not KEY_PATTERN.match(secret):
        raise AuthenticationError("Invalid API key format")
    key = store.find_key_by_secret(secret)
    if not key:
        raise AuthenticationError("Invalid API key")
    if not key.is_active:
        raise AuthorizationError("API key is revoked")
    if model_id is not None and key.model_id != model_id:
        raise AuthorizationError("API key not valid for this model")
    return key
