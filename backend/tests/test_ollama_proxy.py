import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from ollama_proxy import router


def test_extension_origin_is_not_forwarded(monkeypatch):
    monkeypatch.setenv('OLLAMA_BASE_URL', 'http://127.0.0.1:11434')
    monkeypatch.setenv('OLLAMA_MODEL', 'llama3.3:70b')
    app = FastAPI()
    app.include_router(router)
    upstream = AsyncMock()
    upstream.post.return_value = httpx.Response(200, json={'choices': [{'message': {'content': '{"ok":true}'}}]})
    with patch('ollama_proxy.httpx.AsyncClient') as factory:
        factory.return_value.__aenter__.return_value = upstream
        result = TestClient(app).post('/v1/chat/completions', headers={'Origin': 'chrome-extension://test', 'Authorization': 'Bearer private'}, json={
            'model': 'llama3.3:70b', 'messages': [{'role': 'user', 'content': 'test'}], 'response_format': {'type': 'json_object'},
        })
    assert result.status_code == 200
    args, kwargs = upstream.post.call_args
    assert args[0] == 'http://127.0.0.1:11434/v1/chat/completions'
    assert kwargs['headers'] == {'Content-Type': 'application/json'}
    assert kwargs['json']['response_format'] == {'type': 'json_object'}


def test_unconfigured_or_wrong_model_rejected(monkeypatch):
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    body = {'model': 'wrong', 'messages': [{'role': 'user', 'content': 'test'}]}
    monkeypatch.delenv('OLLAMA_BASE_URL', raising=False)
    assert client.post('/v1/chat/completions', json=body).status_code == 503
    monkeypatch.setenv('OLLAMA_BASE_URL', 'http://127.0.0.1:11434')
    monkeypatch.setenv('OLLAMA_MODEL', 'llama3.3:70b')
    assert client.post('/v1/chat/completions', json=body).status_code == 400
