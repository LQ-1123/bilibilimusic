"""外发 URL 安全约束。

所有服务端对外发起的请求都必须经过这里校验：
- 仅允许 http/https；
- 拒绝 localhost、环回、私有、链路本地、保留、组播等地址（含 DNS 解析结果复核，防止域名指向内网）；
- B 站相关请求额外要求域名后缀在白名单内（分享短链、API、封面与音频流 CDN）。
"""

import ipaddress
import socket
from functools import lru_cache
from urllib.parse import urlsplit

ALLOWED_SCHEMES = ("http", "https")

# B 站生态域名后缀白名单（registrable domain）
BILIBILI_SUFFIXES = (
    "b23.tv",          # 分享短链
    "bilibili.com",    # 主站 / API
    "hdslb.com",       # 封面等静态资源 CDN
    "bilivideo.com",   # 音视频流 CDN
    "bilivideo.cn",    # 音视频流 CDN
    "akamaized.net",   # upos-hz-mirrorakam.akamaized.net 等海外流 CDN
)


class UnsafeUrlError(ValueError):
    """URL 未通过安全校验（协议 / 内网地址 / 白名单）。"""


def _check_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> None:
    # IPv4-mapped IPv6（如 ::ffff:10.0.0.1）按映射的 IPv4 判断
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        _check_ip(mapped)
        return
    if (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    ):
        raise UnsafeUrlError(f"拒绝访问内网/保留地址：{ip}")


@lru_cache(maxsize=512)
def _resolve_ips(host: str) -> tuple[str, ...]:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise UnsafeUrlError(f"域名解析失败：{host}") from exc
    return tuple(str(info[4][0]) for info in infos)


def validate_url(url: str, *, suffix_allowlist: tuple[str, ...] = ()) -> str:
    """校验 URL 安全性；通过时原样返回，不通过抛 UnsafeUrlError。"""
    parts = urlsplit((url or "").strip())
    if parts.scheme not in ALLOWED_SCHEMES:
        raise UnsafeUrlError(f"仅允许 http/https 协议：{url!r}")

    host = parts.hostname
    if not host:
        raise UnsafeUrlError(f"URL 缺少主机名：{url!r}")

    host_l = host.lower()
    if host_l == "localhost" or host_l.endswith((".localhost", ".local")):
        raise UnsafeUrlError(f"拒绝访问本机地址：{host}")

    if suffix_allowlist and not any(
        host_l == s or host_l.endswith("." + s) for s in suffix_allowlist
    ):
        raise UnsafeUrlError(f"域名不在白名单内：{host}")

    try:
        ips: tuple[str, ...] = (str(ipaddress.ip_address(host)),)
    except ValueError:
        ips = _resolve_ips(host)  # 域名：解析后逐个 IP 复核，防内网指向

    for raw in ips:
        _check_ip(ipaddress.ip_address(raw))
    return url


def validate_bilibili_url(url: str) -> str:
    """B 站生态请求专用：在通用校验之上叠加域名白名单。"""
    return validate_url(url, suffix_allowlist=BILIBILI_SUFFIXES)
