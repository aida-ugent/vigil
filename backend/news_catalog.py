"""Build a Media Cloud snapshot offline; serve it without upstream API calls."""
from __future__ import annotations

import asyncio
import csv
import io
import hashlib
import json
import os
import re
import tempfile
import time
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

router = APIRouter()
# Official, versioned Media Cloud geographic collection export.
DATASET_URL = "https://zenodo.org/records/18189311"
CATALOG_SCOPE = "geographic-publishers-v1"
PUBLISHER_TYPES = {"digital_native", "print_native", "audio_broadcast", "video_broadcast"}
DATASET_FILES = {
    "media_sources.csv": "4b9744c84e2293637d3c1b10b3f62338931c72e2a7b8b2dac70bab00b79fb5e9",
    "geographic_collection_to_media_source.csv": "e2595931d5956db03784ad1622918e31bd6e383a581b40e02dab1abf112634d4",
    "geographic_collections.csv": "9fed39178c12f8843e9cd9f5ed47a8d0aca75231520461b2e351101c5de0bd32",
}
MAX_BYTES = 8_000_000
MAX_PAGE_BYTES = 8_000_000


def snapshot_path() -> Path:
    return Path(os.getenv("MEDIACLOUD_CACHE_PATH", str(Path(__file__).parent / ".cache" / "news-sources.json")))


def normalize_domain(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        host = value.strip().rstrip(".").encode("idna").decode("ascii").lower()
    except UnicodeError:
        return None
    if host.startswith("www."):
        host = host[4:]
    if len(host) > 253 or "." not in host:
        return None
    if not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in host.split(".")):
        return None
    return host


def parse_csv(text: str, required: set[str]) -> list[dict]:
    reader = csv.DictReader(io.StringIO(text))
    if not required.issubset(reader.fieldnames or []):
        raise ValueError("Invalid Media Cloud export columns")
    rows = list(reader)
    if not rows or len(rows) > 200_000:
        raise ValueError("Invalid Media Cloud export size")
    return rows


def curated_snapshot(exports: dict[str, str]) -> dict:
    collections = parse_csv(exports["geographic_collections.csv"], {"id", "name"})
    memberships = parse_csv(exports["geographic_collection_to_media_source.csv"], {"collection_id", "source_id"})
    sources = parse_csv(exports["media_sources.csv"], {"id", "name", "label", "media_type", "url_search_string"})
    collection_ids = {row["id"] for row in collections}
    if any(row["collection_id"] not in collection_ids for row in memberships):
        raise ValueError("Unknown geographic collection in export")
    members = {row["source_id"] for row in memberships}
    if not members.issubset({row["id"] for row in sources}):
        raise ValueError("Missing collection members in source export")
    domains = set()
    invalid = 0
    for row in sources:
        if row["id"] not in members:
            continue
        label = row["label"].strip()
        # Curated records such as BBC lack a media_type. Accept a publication
        # name, but not a bare URL/domain placeholder in an unclassified record.
        named_publication = bool(label) and normalize_domain(label) is None and "://" not in label
        if row["media_type"] not in PUBLISHER_TYPES and not (not row["media_type"] and named_publication):
            continue
        # Never broaden a child source's URL restriction to its parent domain.
        if row["url_search_string"]:
            continue
        host = normalize_domain(row["name"])
        if host is None:
            invalid += 1
            continue
        domains.add(host)
    if len(domains) < 100 or invalid > len(sources) * 0.05:
        raise ValueError("Incomplete curated Media Cloud snapshot")
    ordered = sorted(domains)
    digest = hashlib.sha256("\n".join(ordered).encode()).hexdigest()
    return {"source": "mediacloud", "scope": CATALOG_SCOPE,
            "dataset": DATASET_URL, "publishedAt": "2026-01-08",
            "domains": ordered, "fetchedAt": int(time.time() * 1000),
            "version": f"mediacloud-curated:{digest}"}


async def collect_sources(client: httpx.AsyncClient) -> dict:
    exports = {}
    for name, expected in DATASET_FILES.items():
        # No Media Cloud credentials are sent to the public export host.
        async with client.stream("GET", f"{DATASET_URL}/files/{name}?download=1") as response:
            response.raise_for_status()
            body = bytearray()
            async for chunk in response.aiter_bytes():
                if len(body) + len(chunk) > MAX_PAGE_BYTES:
                    raise ValueError("Media Cloud export too large")
                body.extend(chunk)
        if hashlib.sha256(body).hexdigest() != expected:
            raise ValueError("Media Cloud export checksum mismatch")
        exports[name] = body.decode("utf-8-sig")
        print(f"Downloaded curated export: {name}", flush=True)
    return curated_snapshot(exports)


def read_snapshot(path: Path) -> dict:
    if path.stat().st_size > MAX_BYTES:
        raise ValueError("Snapshot too large")
    data = json.loads(path.read_text())
    if (not isinstance(data, dict) or data.get("source") != "mediacloud"
            or data.get("scope") != CATALOG_SCOPE
            or not re.fullmatch(r"mediacloud-curated:[a-f0-9]{64}", data.get("version", ""))
            or not isinstance(data.get("domains"), list) or len(data["domains"]) < 100
            or not isinstance(data.get("fetchedAt"), (int, float))):
        raise ValueError("Invalid Media Cloud snapshot")
    if any(normalize_domain(domain) != domain for domain in data["domains"]):
        raise ValueError("Invalid snapshot domain")
    return {key: data[key] for key in ("source", "scope", "dataset", "publishedAt", "domains", "fetchedAt", "version")}


@router.get("/news/sources")
def news_sources():
    try:
        snapshot = read_snapshot(snapshot_path())
    except (OSError, ValueError, TypeError, KeyError):
        raise HTTPException(503, "Media Cloud snapshot unavailable. Run the backend news_catalog.py command.") from None
    return JSONResponse(snapshot, headers={"Cache-Control": "no-store"})


async def update_snapshot() -> None:
    async with httpx.AsyncClient(
        headers={"Accept": "text/csv"},
        timeout=60, follow_redirects=False, trust_env=False,
    ) as client:
        snapshot = await collect_sources(client)
    path = snapshot_path()
    if path.exists():
        previous = json.loads(path.read_text())
        # The intentional migration from the uncurated directory is much smaller.
        # Retain shrink protection for subsequent curated-to-curated updates.
        if previous.get("scope") == CATALOG_SCOPE and len(snapshot["domains"]) < len(previous["domains"]) / 2:
            raise ValueError("Unexpected directory shrink; keeping previous snapshot")
    encoded = json.dumps(snapshot)
    if len(encoded.encode()) > MAX_BYTES:
        raise ValueError("Snapshot too large")
    path.parent.mkdir(parents=True, exist_ok=True)
    # Atomic replacement ensures requests never see a partially written catalog.
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as output:
        temporary = Path(output.name)
        output.write(encoded)
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Cached {len(snapshot['domains'])} Media Cloud domains.")


if __name__ == "__main__":
    from config import get_settings

    get_settings()  # Load the backend's local .env, as the server does.
    try:
        asyncio.run(update_snapshot())
    except ValueError as exc:
        raise SystemExit(f"Media Cloud refresh failed: {exc}. The previous snapshot was retained.") from None
    except (OSError, httpx.HTTPError):
        # Upstream exception strings can contain request information; keep logs generic.
        raise SystemExit("Media Cloud refresh failed. Check the connection and cache path; the previous snapshot was retained.") from None
