import asyncio
import csv
import hashlib
import io
import json
import sys
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from news_catalog import (
    CATALOG_SCOPE, DATASET_URL, collect_sources, curated_snapshot,
    read_snapshot, router, update_snapshot,
)


def csv_text(fields, rows):
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=fields)
    writer.writeheader()
    writer.writerows(rows)
    return out.getvalue()


def exports(count=120, extras=()):
    sources = [{"id": str(i), "name": f"news-{i}.com", "media_type": "print_native",
                "url_search_string": ""} for i in range(count)] + list(extras)
    return {
        "geographic_collections.csv": "id,name\n1,Example - National\n",
        "geographic_collection_to_media_source.csv": csv_text(
            ["collection_id", "source_id"],
            [{"collection_id": "1", "source_id": s["id"]} for s in sources if s["id"] != "unlisted"],
        ),
        "media_sources.csv": csv_text(["id", "name", "label", "media_type", "url_search_string"], sources),
    }


def test_curated_membership_and_publisher_classification_are_required():
    extra = [
        {"id": "google", "name": "google.com", "media_type": "", "url_search_string": ""},
        {"id": "other", "name": "other.com", "media_type": "other", "url_search_string": ""},
        {"id": "unlisted", "name": "unlisted.com", "media_type": "digital_native", "url_search_string": ""},
        {"id": "child", "name": "shared.com", "media_type": "print_native", "url_search_string": "shared.com/news/*"},
        {"id": "bad", "name": "https://invalid.com/path", "media_type": "print_native", "url_search_string": ""},
    ]
    extra.append({"id": "named", "name": "named-news.com", "label": "Named News",
                  "media_type": "", "url_search_string": ""})
    extra[0]["label"] = "www.google.com"
    snapshot = curated_snapshot(exports(extras=extra))
    assert len(snapshot["domains"]) == 121
    assert "named-news.com" in snapshot["domains"]
    assert "google.com" not in snapshot["domains"]
    assert snapshot["scope"] == CATALOG_SCOPE
    assert snapshot["dataset"] == DATASET_URL
    assert snapshot["version"].startswith("mediacloud-curated:")


def test_all_four_publisher_types_and_domain_normalization():
    extra = [
        {"id": str(1000+i), "name": f"WWW.Publisher-{i}.COM", "media_type": kind, "url_search_string": ""}
        for i, kind in enumerate(["digital_native", "print_native", "audio_broadcast", "video_broadcast"])
    ]
    snapshot = curated_snapshot(exports(extras=extra))
    assert all(f"publisher-{i}.com" in snapshot["domains"] for i in range(4))


@pytest.mark.parametrize("problem", ["columns", "collection", "member", "too-small"])
def test_invalid_curated_exports_are_rejected(problem):
    data = exports(10 if problem == "too-small" else 120)
    if problem == "columns":
        data["media_sources.csv"] = "oops\ninvalid\n"
    if problem == "collection":
        data["geographic_collection_to_media_source.csv"] += "missing,1\n"
    if problem == "member":
        data["geographic_collection_to_media_source.csv"] += "1,missing\n"
    with pytest.raises(ValueError):
        curated_snapshot(data)


def test_download_checksums_and_no_credentials(monkeypatch):
    data = exports()
    hashes = {name: hashlib.sha256(body.encode()).hexdigest() for name, body in data.items()}
    monkeypatch.setattr("news_catalog.DATASET_FILES", hashes)
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, text=data[request.url.path.split("/")[-1]])

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await collect_sources(client)

    assert len(asyncio.run(run())["domains"]) == 120
    assert len(requests) == 3
    assert all(r.url.host == "zenodo.org" and "authorization" not in r.headers for r in requests)
    data["media_sources.csv"] += "corrupted"
    with pytest.raises(ValueError, match="checksum"):
        asyncio.run(run())


def test_endpoint_rejects_broad_cache_and_serves_curated_without_network(tmp_path, monkeypatch):
    path = tmp_path / "sources.json"
    monkeypatch.setenv("MEDIACLOUD_CACHE_PATH", str(path))
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    assert client.get("/news/sources").status_code == 503
    snapshot = curated_snapshot(exports())
    path.write_text(json.dumps({**snapshot, "scope": "all-sources"}))
    assert client.get("/news/sources").status_code == 503
    path.write_text(json.dumps(snapshot))
    with patch("news_catalog.httpx.AsyncClient", side_effect=AssertionError("No network")):
        response = client.get("/news/sources")
    assert response.status_code == 200
    assert response.json() == snapshot


def test_failed_builder_preserves_existing_snapshot(tmp_path, monkeypatch):
    path = tmp_path / "sources.json"
    path.write_text("previous snapshot")
    monkeypatch.setenv("MEDIACLOUD_CACHE_PATH", str(path))
    with patch("news_catalog.collect_sources", side_effect=ValueError("Incomplete export")):
        with pytest.raises(ValueError):
            asyncio.run(update_snapshot())
    assert path.read_text() == "previous snapshot"


def test_intentional_migration_allows_shrink_but_later_updates_do_not(tmp_path, monkeypatch):
    path = tmp_path / "sources.json"
    monkeypatch.setenv("MEDIACLOUD_CACHE_PATH", str(path))
    path.write_text(json.dumps({"domains": ["old.com"] * 10000}))
    snapshot = curated_snapshot(exports(300))
    with patch("news_catalog.collect_sources", return_value=snapshot):
        asyncio.run(update_snapshot())
    assert read_snapshot(path) == snapshot
    smaller = curated_snapshot(exports(120))
    with patch("news_catalog.collect_sources", return_value=smaller):
        with pytest.raises(ValueError, match="shrink"):
            asyncio.run(update_snapshot())
    assert read_snapshot(path) == snapshot
