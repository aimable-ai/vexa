"""
SSRF-safe webhook URL validation.

Validates that webhook URLs do not target internal networks, localhost,
cloud metadata endpoints, or internal hostnames.
Reference: OWASP SSRF Prevention Cheat Sheet
"""

import ipaddress
import os
import socket
from urllib.parse import urlparse


# Self-hosted opt-out for private/internal webhook targets (e.g. an Aimable
# instance reachable only via host.docker.internal on the same host).
_ALLOW_PRIVATE_WEBHOOKS = os.getenv("ALLOW_PRIVATE_WEBHOOKS", "").lower() in ("1", "true", "yes")


# Blocked IP ranges per OWASP (localhost, private, link-local, multicast)
_BLOCKED_IPV4_NETWORKS = [
    ipaddress.ip_network("0.0.0.0/8"),       # Current network
    ipaddress.ip_network("10.0.0.0/8"),      # Private
    ipaddress.ip_network("127.0.0.0/8"),     # Loopback
    ipaddress.ip_network("169.254.0.0/16"),  # Link-local (includes cloud metadata 169.254.169.254)
    ipaddress.ip_network("172.16.0.0/12"),   # Private
    ipaddress.ip_network("192.168.0.0/16"),  # Private
    ipaddress.ip_network("224.0.0.0/4"),     # Multicast
]

_BLOCKED_IPV6_NETWORKS = [
    ipaddress.ip_network("::1/128"),         # Loopback
    ipaddress.ip_network("fc00::/7"),        # Unique local
    ipaddress.ip_network("fe80::/10"),       # Link-local
    ipaddress.ip_network("ff00::/8"),        # Multicast
]

# Internal hostnames (Docker services from docker-compose + cloud metadata)
_BLOCKED_HOSTNAMES = frozenset([
    "localhost",
    "metadata.google.internal",
    "metadata.amazonaws.com",
    "metadata",
    # Vexa Docker services
    "api-gateway",
    "admin-api",
    "meeting-api",
    "runtime-api",
    "transcription-collector",
    "redis",
    "postgres",
    "mcp",
])


def _is_blocked_ip(ip_str: str) -> bool:
    """Check if IP is in a blocked range."""
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True  # Invalid IP, block
    if ip.version == 4:
        for net in _BLOCKED_IPV4_NETWORKS:
            if ip in net:
                return True
    else:
        for net in _BLOCKED_IPV6_NETWORKS:
            if ip in net:
                return True
    return False


def _is_blocked_hostname(hostname: str) -> bool:
    """Check if hostname is in the blocked list (case-insensitive)."""
    return hostname.lower() in _BLOCKED_HOSTNAMES


def _resolve_host(hostname: str) -> list[str]:
    """Resolve hostname to IP addresses. Returns empty list on failure."""
    try:
        results = socket.getaddrinfo(hostname, None)
        ips = []
        for (_, _, _, _, sockaddr) in results:
            addr = sockaddr[0]
            if addr and addr not in ips:
                ips.append(addr)
        return ips
    except (socket.gaierror, socket.error, OSError):
        return []


def validate_webhook_url(url: str) -> str:
    """
    Validate that a webhook URL is safe (not SSRF-vulnerable).

    - Only allows http:// and https://
    - Blocks private IPs, localhost, link-local, cloud metadata
    - Blocks internal hostnames (Docker services, cloud metadata)
    - Performs DNS resolution and validates all resolved IPs

    Returns the URL string if valid.
    Raises ValueError with a user-friendly message if blocked.
    """
    parsed = urlparse(url)

    # Scheme check
    if parsed.scheme not in ("http", "https"):
        raise ValueError(
            "Webhook URL must use http or https scheme"
        )

    hostname = parsed.hostname
    if not hostname:
        raise ValueError("Webhook URL must have a valid hostname")

    # Self-hosted opt-out: when the host app (e.g. Aimable) lives on the same
    # machine, its webhook endpoint is only reachable via a private/internal
    # address (host.docker.internal, 127.0.0.1, LAN IP). Mirrors runtime-api's
    # ALLOW_PRIVATE_CALLBACKS. Off by default — only the scheme/hostname checks
    # above still apply when enabled.
    if _ALLOW_PRIVATE_WEBHOOKS:
        return url

    # Hostname blocklist (before DNS to catch internal names)
    if _is_blocked_hostname(hostname):
        raise ValueError(
            "Webhook URL cannot target internal or private networks"
        )

    # If hostname is an IP, check directly
    try:
        ip = ipaddress.ip_address(hostname)
        if _is_blocked_ip(hostname):
            raise ValueError(
                "Webhook URL cannot target internal or private networks"
            )
        return url
    except ValueError:
        pass  # Not a valid IP, will resolve via DNS

    # Resolve hostname and validate all IPs (prevents DNS rebinding)
    ips = _resolve_host(hostname)
    if not ips:
        raise ValueError("Webhook URL hostname could not be resolved")

    for ip_str in ips:
        if _is_blocked_ip(ip_str):
            raise ValueError(
                "Webhook URL cannot target internal or private networks"
            )

    return url
