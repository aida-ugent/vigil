#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# npm 9's npx exports obsolete settings to npm 11. Remove only these inherited
# settings inside the child shell; changing the user's global npm config is unnecessary.
npx --yes --package=node@24 --package=npm@11 --call '
  unset npm_config_metrics_registry npm_config_globalignorefile
  npm ci && npm run build
'

python3 - <<'PY'
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

output = Path("../vigil-extension.zip")
temporary = output.with_suffix(".zip.tmp")
try:
    with ZipFile(temporary, "w", ZIP_DEFLATED) as archive:
        for path in sorted(Path("dist").rglob("*")):
            if path.is_file():
                archive.write(path, Path("vigil-extension") / path.relative_to("dist"))
    temporary.replace(output)
finally:
    temporary.unlink(missing_ok=True)
print(f"Created {output.resolve()}")
PY
