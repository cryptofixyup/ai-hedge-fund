from pathlib import Path

import pytest
from fastapi import HTTPException

from app.backend.security import is_authorized_client, is_loopback_client
from app.backend.routes.storage import resolve_output_file
from app.backend.models.schemas import ApiKeySummaryResponse


def test_loopback_addresses_are_recognized():
    assert is_loopback_client("127.0.0.1")
    assert is_loopback_client("::1")
    assert not is_loopback_client("192.0.2.10")
    assert not is_loopback_client("localhost")
    assert not is_loopback_client(None)


def test_remote_clients_require_configured_bearer_token():
    assert not is_authorized_client("192.0.2.10", None, None)
    assert not is_authorized_client("192.0.2.10", "Bearer wrong", "correct-token")
    assert not is_authorized_client("192.0.2.10", "Basic correct-token", "correct-token")
    assert is_authorized_client("192.0.2.10", "Bearer correct-token", "correct-token")


def test_loopback_clients_do_not_require_remote_token():
    assert is_authorized_client("127.0.0.1", None, None)


def test_trusted_local_proxy_uses_forwarded_client_address():
    trusted = {"127.0.0.1"}
    assert not is_authorized_client(
        "127.0.0.1", None, None, "198.51.100.24", trusted
    )
    assert is_authorized_client(
        "127.0.0.1", "Bearer " + "x" * 32, "x" * 32,
        "198.51.100.24", trusted,
    )
    assert not is_authorized_client(
        "127.0.0.1", None, None, None, trusted
    )


@pytest.mark.parametrize(
    "filename",
    [
        "../secrets.json",
        "../../app.py",
        "/tmp/owned.json",
        "nested/file.json",
        r"nested\\file.json",
        ".hidden.json",
        "no-extension.txt",
        "bad name.json",
    ],
)
def test_storage_rejects_path_components_and_invalid_names(tmp_path: Path, filename: str):
    with pytest.raises(HTTPException) as exc:
        resolve_output_file(tmp_path, filename)
    assert exc.value.status_code == 400


def test_storage_accepts_simple_json_filename(tmp_path: Path):
    result = resolve_output_file(tmp_path, "portfolio-report_01.json")
    assert result == tmp_path.resolve() / "portfolio-report_01.json"


def test_api_key_summary_schema_never_exposes_secret_value():
    assert "key_value" not in ApiKeySummaryResponse.model_fields
