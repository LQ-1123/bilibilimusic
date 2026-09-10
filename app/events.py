"""进程内曲库变更事件总线（SSE 推送用）。

导入入库、对账删除等在请求/后台任务里发布；/api/events 订阅端按账号
mid 过滤后推给浏览器，前端据此自动刷新曲库视图，免去「收藏后要手动
刷新页面」。单进程部署，无需跨进程消息件；多账号互不串扰靠 mid 过滤。
"""

import asyncio

_subs: set[tuple[str | None, asyncio.Queue]] = set()


def subscribe(mid: str | None) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    _subs.add((mid, q))
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    for item in list(_subs):
        if item[1] is q:
            _subs.discard(item)


def publish(mid: str | None, name: str, data: dict | None = None) -> None:
    """发布事件；data 可选（#23 会话快照等结构化负载）。

    队列项统一为 (name, data)：订阅端按事件名分发，忽略 data 的旧监听器行为不变。
    """
    for sub_mid, q in list(_subs):
        if sub_mid == mid:
            q.put_nowait((name, data))
