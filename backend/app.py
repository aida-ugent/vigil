"""Vigil backend v2 — entry point."""

import sys
from pathlib import Path

# Ensure backend/ is on the Python path for flat imports
sys.path.insert(0, str(Path(__file__).resolve().parent))

from routes import create_app  # noqa: E402

app = create_app()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="127.0.0.1", port=8787, reload=True)
