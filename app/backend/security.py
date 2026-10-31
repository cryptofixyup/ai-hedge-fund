"""Network-boundary helpers for the local-first API."""

import ipaddress
import secrets


def is_loopback_client(host: str | None) -> bool:
    """Return True only for a literal loopback IP address."""
    if not host:
        return False
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def is_authorized_client(
    client_host: str | None,
    authorization_header: str | None,
    configured_token: str | None,
) -> bool:
    """Allow loopback clients; require a constant-time Bearer token remotely.

    Forwarded-IP headers are intentionally ignored. A reverse proxy must inject
    the backend token itself; the token must never be embedded in browser code.
    """
    if is_loopback_client(client_host):
        return True
    if not configured_token:
        return False
    scheme, separator, supplied_token = (authorization_header or "").partition(" ")
    return (
        separator == " "
        and scheme.lower() == "bearer"
        and bool(supplied_token)
        and secrets.compare_digest(supplied_token, configured_token)
    )
