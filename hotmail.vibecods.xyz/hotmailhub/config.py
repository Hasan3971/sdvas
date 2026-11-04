"""Runtime configuration, read from HUB_* environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from .util import to_int, truthy


@dataclass
class Config:
    host: str = "127.0.0.1"
    port: int = 8899
    data_dir: Path = Path("data")
    db_path: Path | None = None
    admin_password: str = ""
    trust_proxy: bool = False
    cookie_secure: str = "auto"  # auto | always | never
    session_ttl: int = 7 * 24 * 3600
    public_url: str = ""
    provider_timeout: int = 20
    max_connections: int = 12
    token_url: str = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
    backup_keep: int = 7
    max_body: int = 25 * 1024 * 1024
    background: bool = True

    @classmethod
    def from_env(cls) -> "Config":
        def env(name: str, default: str = "") -> str:
            return os.environ.get("HUB_" + name, default)

        config = cls(
            host=env("HOST", cls.host),
            port=to_int(env("PORT"), cls.port, 1, 65535),
            data_dir=Path(env("DATA_DIR", "data")),
            db_path=Path(env("DB_PATH")) if env("DB_PATH") else None,
            admin_password=env("ADMIN_PASSWORD"),
            trust_proxy=truthy(env("TRUST_PROXY")),
            cookie_secure=env("COOKIE_SECURE", "auto").lower(),
            session_ttl=to_int(env("SESSION_TTL"), cls.session_ttl, 300),
            public_url=env("PUBLIC_URL").rstrip("/"),
            provider_timeout=to_int(env("PROVIDER_TIMEOUT"), cls.provider_timeout, 3, 120),
            max_connections=to_int(env("MAX_CONNECTIONS"), cls.max_connections, 1, 64),
            token_url=env("TOKEN_URL", cls.token_url),
            backup_keep=to_int(env("BACKUP_KEEP"), cls.backup_keep, 0, 365),
        )
        return config.finalize()

    def finalize(self) -> "Config":
        self.data_dir = Path(self.data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        if self.db_path is None:
            self.db_path = self.data_dir / "hub.db"
        self.db_path = Path(self.db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        return self
