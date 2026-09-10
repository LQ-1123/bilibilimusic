"""#23 跨端播放会话（Spotify Connect 式）——服务端权威快照。

设计要点（详见 docs/issue-ledger.md §2）：

- 搬的是**会话状态**，不是音频：各设备自己向后端取流（`/api/stream/{bvid}?cid=`），
  服务端只维护「谁在放、放到哪、队列是什么」这一份快照，供其他设备只读展示与续播。
- 进程内单例，写法对齐 `SyncState`/`ExportState`；按 mid 隔离，跨账号不可见。
- Phase 1（本文件当前能力）：设备注册（hello）+ 上报（report）+ 只读快照/设备列表。
  Phase 2 再加命令通道与移交握手。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

OFFLINE_AFTER = 30.0      # 秒：超过无上报即视为离线（前端据此置灰）
DEVICE_TTL = 600.0        # 秒：离线这么久的设备从列表里清掉
REPORT_MIN_GAP = 1.0      # 秒：同一设备的最小上报间隔（防刷）
TRANSFER_TIMEOUT = 12.0   # 秒：移交握手的兜底时限（接收端自己的 canplay 超时是 5s）
MAX_DEVICES = 12
MAX_QUEUE = 200


@dataclass
class Device:
    id: str
    mid: str
    name: str = ""
    kind: str = "browser"      # browser | tauri | android
    last_seen: float = 0.0
    playing: bool = False
    preempted_at: float = 0.0  # 被别的设备抢走 active 的时刻（前端据此提示一次）

    def out(self, now: float, active_id: str | None) -> dict:
        return {
            "id": self.id,
            "name": self.name or self.kind,
            "kind": self.kind,
            "online": (now - self.last_seen) <= OFFLINE_AFTER if self.last_seen else False,
            "idleFor": round(now - self.last_seen, 1) if self.last_seen else None,
            "active": self.id == active_id,
            "playing": bool(self.playing),
            "preemptedAt": self.preempted_at or None,
        }


@dataclass
class PendingTransfer:
    """一次进行中的移交：发送端现报精确进度，接收端 canplay 后 claimed 才生效。"""

    from_id: str
    to_id: str
    started_at: float = 0.0
    position: float = 0.0     # 发送端现报的精确进度（不是缓存心跳）
    live: bool = False        # 是否已收到现报
    revision: int = 0

    def out(self, now: float) -> dict:
        return {
            "fromDeviceId": self.from_id,
            "toDeviceId": self.to_id,
            "position": round(self.position, 1),
            "live": self.live,
            "ageSec": round(now - self.started_at, 1),
        }


@dataclass
class PlaybackSession:
    mid: str
    active_device_id: str | None = None
    queue: list[dict] = field(default_factory=list)   # [{songId,bvid,cid,title,artist,coverUrl}]
    index: int = 0
    position: float = 0.0
    reported_at: float = 0.0
    playing: bool = False
    repeat: str = "off"
    shuffle: bool = False
    revision: int = 0

    def position_now(self, now: float) -> float:
        """播放中按上报时刻外推——控制器端据此显示实时进度（±1s）。"""
        if not self.playing or not self.reported_at:
            return round(self.position, 1)
        return round(self.position + max(0.0, now - self.reported_at), 1)

    def song(self) -> dict | None:
        if 0 <= self.index < len(self.queue):
            return self.queue[self.index]
        return None

    def out(self, now: float, device_name: str = "", with_queue: bool = True) -> dict:
        out = {
            "mid": self.mid,
            "activeDeviceId": self.active_device_id,
            "activeDeviceName": device_name,
            "queue": self.queue if with_queue else [],
            "queueSize": len(self.queue),
            "index": self.index,
            "song": self.song(),
            "position": self.position_now(now),
            "playing": self.playing,
            "repeat": self.repeat,
            "shuffle": self.shuffle,
            "revision": self.revision,
            "updatedAgo": round(now - self.reported_at, 1) if self.reported_at else None,
        }
        return out


class SessionBus:
    """进程内会话表：`{mid: {deviceId: Device}}` + `{mid: PlaybackSession}`。"""

    def __init__(self) -> None:
        self._devices: dict[str, dict[str, Device]] = {}
        self._sessions: dict[str, PlaybackSession] = {}
        self._last_report: dict[tuple[str, str], float] = {}
        self._transfers: dict[str, PendingTransfer] = {}

    # ---- 设备 ----

    def hello(self, mid: str, device_id: str, name: str = "", kind: str = "browser") -> dict:
        now = time.time()
        devices = self._devices.setdefault(mid, {})
        dev = devices.get(device_id)
        if dev is None:
            # 列表上限：先清离线太久的老设备，仍满则丢掉最久未见的
            self._sweep(mid, now)
            devices = self._devices.setdefault(mid, {})
            if len(devices) >= MAX_DEVICES:
                oldest = min(devices.values(), key=lambda d: d.last_seen)
                devices.pop(oldest.id, None)
            dev = Device(id=device_id, mid=mid, last_seen=now)
            devices[device_id] = dev
        dev.name = (name or dev.name or kind)[:40]
        dev.kind = (kind or dev.kind or "browser")[:16]
        dev.last_seen = now
        return self.snapshot(mid)

    def snapshot(self, mid: str) -> dict:
        now = time.time()
        self._sweep(mid, now)
        session = self._sessions.get(mid)
        devices = self._devices.get(mid, {})
        active_id = session.active_device_id if session else None
        active_name = devices[active_id].name if active_id in devices else ""
        transfer = self._transfers.get(mid)
        return {
            "session": session.out(now, active_name) if session else None,
            "transfer": transfer.out(now) if transfer else None,
            "devices": [d.out(now, active_id) for d in sorted(devices.values(), key=lambda d: d.last_seen, reverse=True)],
        }

    def devices(self, mid: str) -> list[dict]:
        return self.snapshot(mid)["devices"]

    def summary(self, mid: str) -> dict:
        """SSE 用的轻量快照：会话摘要（**不含队列**，否则每 5 秒推几十 KB）+ 设备列表。"""
        now = time.time()
        self._sweep(mid, now)
        session = self._sessions.get(mid)
        devices = self._devices.get(mid, {})
        active_id = session.active_device_id if session else None
        active_name = devices[active_id].name if active_id in devices else ""
        transfer = self._transfers.get(mid)
        return {
            "session": session.out(now, active_name, with_queue=False) if session else None,
            "transfer": transfer.out(now) if transfer else None,
            "devices": [d.out(now, active_id) for d in
                        sorted(devices.values(), key=lambda d: d.last_seen, reverse=True)],
        }

    # ---- 会话上报 ----

    def report(self, mid: str, device_id: str, payload: dict, name: str = "", kind: str = "browser") -> dict:
        """设备上报自己的播放状态；返回 {accepted, session, preemptedDeviceId}。

        规则（Phase 1）：
        - 第一次出声的设备成为 active；
        - 另一台正在播（且在线）时被后来者接管（后播者赢），被抢的那台记 preemptedAt 供 UI 提示一次；
        - 同一设备 1 秒内重复上报只刷新 last_seen，不改 revision（省流量、防抖）。
        """
        now = time.time()
        devices = self._devices.setdefault(mid, {})
        dev = devices.get(device_id)
        if dev is None:
            self.hello(mid, device_id, name, kind)
            devices = self._devices.setdefault(mid, {})
            dev = devices[device_id]
        dev.last_seen = now
        if name:
            dev.name = name[:40]
        playing = bool(payload.get("playing"))
        dev.playing = playing

        session = self._sessions.get(mid)
        if session is None:
            session = PlaybackSession(mid=mid)
            self._sessions[mid] = session

        def _sig() -> tuple:
            q = session.queue
            return (len(q), q[0]["bvid"] if q else "", q[-1]["bvid"] if q else "", session.index)

        prev_active = session.active_device_id
        queue_before = _sig()
        preempted = None
        if playing or prev_active is None:
            if prev_active and prev_active != device_id:
                prev = devices.get(prev_active)
                if prev is not None and (now - prev.last_seen) <= OFFLINE_AFTER and prev.playing:
                    preempted = prev_active
                    prev.preempted_at = now
            session.active_device_id = device_id

        # 只让 active 设备改写队列/进度；其他设备的上报仅刷新在线状态
        if session.active_device_id == device_id:
            key = (mid, device_id)
            last = self._last_report.get(key, 0.0)
            fresh = (now - last) >= REPORT_MIN_GAP
            last_position = float(payload.get("position") or 0.0)
            # 进度明显回退（换歌/拖拽）时不受防抖限制
            jumped = abs(last_position - session.position) > 1.5 or int(payload.get("index") or 0) != session.index
            if fresh or jumped or session.revision == 0:
                self._last_report[key] = now
                queue = payload.get("queue")
                if isinstance(queue, list):
                    session.queue = [
                        {
                            "songId": int(item.get("songId") or 0),
                            "bvid": str(item.get("bvid") or "")[:20],
                            "cid": int(item.get("cid") or 0),
                            "title": str(item.get("title") or "")[:200],
                            "artist": str(item.get("artist") or "")[:120],
                            "coverUrl": str(item.get("coverUrl") or "")[:400],
                            "duration": max(0, int(item.get("duration") or 0)),
                        }
                        for item in queue[:MAX_QUEUE]
                        if item.get("bvid")
                    ]
                session.index = max(0, int(payload.get("index") or 0))
                session.position = max(0.0, last_position)
                session.reported_at = now
                session.playing = playing
                session.repeat = str(payload.get("repeat") or "off")[:8]
                session.shuffle = bool(payload.get("shuffle"))
                session.revision += 1

        return {
            "accepted": session.active_device_id == device_id,
            "preemptedDeviceId": preempted,
            "queueChanged": _sig() != queue_before,
            "session": session.out(now, dev.name),
        }

    # ---- 内部 ----

    def _sweep(self, mid: str, now: float) -> None:
        devices = self._devices.get(mid)
        if not devices:
            return
        for did in [d.id for d in devices.values() if d.last_seen and (now - d.last_seen) > DEVICE_TTL]:
            devices.pop(did, None)
            self._last_report.pop((mid, did), None)
        session = self._sessions.get(mid)
        if session and session.active_device_id and session.active_device_id not in devices:
            session.active_device_id = None
            session.playing = False
        transfer = self._transfers.get(mid)
        if transfer and (now - transfer.started_at) > TRANSFER_TIMEOUT:
            self._transfers.pop(mid, None)   # 握手超时：发送端继续播，等于什么都没发生

    # ---- Phase 2：命令通道与移交握手 ----

    COMMAND_TYPES = {"play", "pause", "toggle", "next", "prev", "seek"}

    def command(self, mid: str, device_id: str, ctype: str, payload: dict | None = None,
                revision: int | None = None) -> dict:
        """控制器 → active 设备的命令（经 SSE 转发；服务端不碰播放，只做转发与校验）。"""
        now = time.time()
        self._sweep(mid, now)
        if ctype not in self.COMMAND_TYPES:
            return {"accepted": False, "reason": "bad-command"}
        session = self._sessions.get(mid)
        if session is None or session.active_device_id is None:
            return {"accepted": False, "reason": "no-session"}
        if revision is not None and revision < session.revision:
            return {"accepted": False, "reason": "stale-revision", "revision": session.revision,
                    "session": session.out(now)}
        target = session.active_device_id
        if target == device_id:
            return {"accepted": False, "reason": "self-active"}   # 本机就是 active：直接本地执行
        dev = self._devices.get(mid, {}).get(target)
        if dev is None or (now - dev.last_seen) > OFFLINE_AFTER:
            return {"accepted": False, "reason": "target-offline", "targetDeviceId": target}
        return {
            "accepted": True,
            "targetDeviceId": target,
            "command": {"type": ctype, "payload": payload or {}, "fromDeviceId": device_id,
                        "revision": session.revision},
        }

    def start_transfer(self, mid: str, from_id: str, to_id: str) -> dict:
        """发起移交：先广播 transferRequest 让发送端现报进度，接收端再预加载。"""
        now = time.time()
        self._sweep(mid, now)
        session = self._sessions.get(mid)
        if session is None:
            return {"ok": False, "reason": "no-session"}
        devices = self._devices.get(mid, {})
        to = devices.get(to_id)
        if to is None or (now - to.last_seen) > OFFLINE_AFTER:
            return {"ok": False, "reason": "target-offline"}
        from_id = from_id or session.active_device_id or ""
        if from_id and from_id not in devices:
            from_id = session.active_device_id or ""
        src = devices.get(from_id) if from_id else None
        if src is None or (now - src.last_seen) > OFFLINE_AFTER:
            return {"ok": False, "reason": "source-offline"}
        pending = PendingTransfer(from_id=from_id, to_id=to_id, started_at=now,
                                  position=session.position_now(now), revision=session.revision)
        self._transfers[mid] = pending
        return {
            "ok": True,
            "transfer": pending.out(now),
            "session": session.out(now, src.name),
        }

    def live_position(self, mid: str, device_id: str, position: float) -> dict:
        """发送端现报精确进度（规则①：不用缓存心跳，现场读 audio.currentTime）。"""
        now = time.time()
        pending = self._transfers.get(mid)
        if pending is None or pending.from_id != device_id:
            return {"ok": False, "reason": "no-pending-transfer"}
        pending.position = max(0.0, float(position or 0.0))
        pending.live = True
        return {"ok": True, "transfer": pending.out(now)}

    def claim(self, mid: str, device_id: str, position: float | None = None) -> dict:
        """接收端 canplay 就绪 → 正式接管（规则②：到这一步发送端才淡出）。"""
        now = time.time()
        pending = self._transfers.get(mid)
        if pending is None or pending.to_id != device_id:
            return {"ok": False, "reason": "no-pending-transfer"}
        session = self._sessions.get(mid)
        if session is None:
            return {"ok": False, "reason": "no-session"}
        session.active_device_id = device_id
        session.position = max(0.0, float(position if position is not None else pending.position))
        session.reported_at = now
        session.playing = True
        session.revision += 1
        self._transfers.pop(mid, None)
        dev = self._devices.get(mid, {}).get(device_id)
        return {"ok": True, "session": session.out(now, dev.name if dev else ""),
                "fromDeviceId": pending.from_id}


bus = SessionBus()  # 进程内单例（与 SyncState/ExportState 同一套路）
