"""Network-boundary helpers for the local-first API."""

import ipaddress
import secrets


def _is_ip_address_loopback(host: str | None) -> bool:
    if not host:
        return False
    try:
        return ipaddress.ip_address(host.strip()).is_loopback
    except ValueError:
        return False


def is_loopback_client(host: str | None) -> bool:
    """Return True only for a literal loopback IP address."""
    return _is_ip_address_loopback(host)


def is_private_vercel_service(vercel_env: str | None, private_service_flag: str | None) -> bool:
    """Recognize only an explicitly marked Vercel Preview/Production API service."""
    return (
        (vercel_env or "").strip().lower() in {"preview", "production"}
        and (private_service_flag or "").strip().lower() == "true"
    )


def is_authorized_client(
    client_host: str | None,
    authorization_header: str | None,
    configured_token: str | None,
    forwarded_for: str | None = None,
    trusted_proxy_hosts: set[str] | None = None,
) -> bool:
    """Allow direct loopback clients; require a Bearer token remotely.

    If the socket peer is an explicitly trusted proxy, determine the original
    client from its X-Forwarded-For header. The proxy must overwrite that header,
    and the backend must not be directly reachable from untrusted networks.
    """
    trusted_proxies = trusted_proxy_hosts or set()
    effective_client = client_host

    if client_host in trusted_proxies:
        if not forwarded_for:
            return False
        effective_client = forwarded_for.split(",", 1)[0].strip()

    if _is_ip_address_loopback(effective_client):
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
