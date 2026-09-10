"""#23 Phase 1 接口层：上报会发 sessionChanged 事件（含回放队列相关字段）。"""
import asyncio
import types

import pytest

from app import events
from app.api.routes import (
    DeviceHello,
    SessionReport,
    devices_hello,
    get_playback_session,
    list_devices,
    report_playback_session,
)
from app.services.session_bus import SessionBus
from app.services import session_bus as bus_module


def _req(mid="mid-api"):
    return types.SimpleNamespace(state=types.SimpleNamespace(mid=mid))


def test_hello_then_report_then_snapshot(monkeypatch):
    monkeypatch.setattr(bus_module, "bus", SessionBus())
    from app.api import routes

    monkeypatch.setattr(routes, "session_bus", bus_module.bus)
    hello = devices_hello(DeviceHello(deviceId="dev-aaa", name="Mac", kind="browser"), _req())
    assert hello["session"] is None and hello["devices"][0]["id"] == "dev-aaa"

    body = SessionReport(
        deviceId="dev-aaa", name="Mac", playing=True, position=7.5, index=0,
        queue=[{"songId": 8, "bvid": "BV1yN4y1H7XX", "cid": 1405147297, "title": "爱的初体验"}],
    )
    out = report_playback_session(body, _req())
    assert out["accepted"] is True and out["session"]["song"]["title"] == "爱的初体验"

    snap = get_playback_session(_req())
    assert snap["session"]["position"] == 7.5 and snap["session"]["playing"] is True
    assert [d["id"] for d in list_devices(_req())["devices"]] == ["dev-aaa"]


def test_report_publishes_session_changed_event(monkeypatch):
    monkeypatch.setattr(bus_module, "bus", SessionBus())
    from app.api import routes

    monkeypatch.setattr(routes, "session_bus", bus_module.bus)
    queue = events.subscribe("mid-ev")
    try:
        report_playback_session(
            SessionReport(deviceId="dev-aaa", playing=True, position=1, index=0,
                          queue=[{"bvid": "BV1yN4y1H7XX", "cid": 1, "title": "A"}]),
            _req("mid-ev"),
        )
        name, data = asyncio.run(asyncio.wait_for(queue.get(), timeout=1))
        assert name == "sessionChanged"
        # 事件里不带整条队列（几十 KB），只带摘要 + 队列是否变化
        assert data["session"]["queue"] == [] and data["session"]["queueSize"] == 1
        assert data["queueChanged"] is True
        assert data["devices"][0]["active"] is True
    finally:
        events.unsubscribe(queue)


def test_report_from_second_device_flags_preempted(monkeypatch):
    monkeypatch.setattr(bus_module, "bus", SessionBus())
    from app.api import routes

    monkeypatch.setattr(routes, "session_bus", bus_module.bus)
    report_playback_session(SessionReport(deviceId="dev-aaa", name="Mac", playing=True, position=10,
                                          queue=[{"bvid": "BV1yN4y1H7XX", "cid": 1, "title": "A"}]),
                            _req("mid-p"))
    out = report_playback_session(SessionReport(deviceId="dev-bbb", name="iPhone", kind="android",
                                                playing=True, position=0,
                                                queue=[{"bvid": "BV1xx411c7mD", "cid": 2, "title": "B"}]),
                                  _req("mid-p"))
    assert out["preemptedDeviceId"] == "dev-aaa"
    assert out["session"]["activeDeviceName"] == "iPhone"


# ---------- Phase 2：命令通道与移交握手 ----------


def _two_devices(monkeypatch):
    monkeypatch.setattr(bus_module, "bus", SessionBus())
    from app.api import routes

    monkeypatch.setattr(routes, "session_bus", bus_module.bus)
    devices_hello(DeviceHello(deviceId="dev-mac1", name="Mac"), _req("mid-t"))
    devices_hello(DeviceHello(deviceId="dev-iph1", name="iPhone", kind="android"), _req("mid-t"))
    report_playback_session(
        SessionReport(deviceId="dev-mac1", name="Mac", playing=True, position=30, index=0,
                      queue=[{"bvid": "BV1yN4y1H7XX", "cid": 1, "title": "A"},
                             {"bvid": "BV1xx411c7mD", "cid": 2, "title": "B"}]),
        _req("mid-t"),
    )
    return bus_module.bus


def test_command_endpoint_publishes_to_target(monkeypatch):
    from app.api.routes import SessionCommand, session_command

    _two_devices(monkeypatch)
    q = events.subscribe("mid-t")
    try:
        out = session_command(SessionCommand(deviceId="dev-iph1", type="pause"), _req("mid-t"))
        assert out["accepted"] is True and out["targetDeviceId"] == "dev-mac1"
        name, data = asyncio.run(asyncio.wait_for(q.get(), timeout=1))
        assert name == "sessionCommand"
        assert data["targetDeviceId"] == "dev-mac1" and data["type"] == "pause"
    finally:
        events.unsubscribe(q)


def test_command_endpoint_conflicts_on_stale_revision(monkeypatch):
    from fastapi import HTTPException

    from app.api.routes import SessionCommand, session_command

    bus = _two_devices(monkeypatch)
    rev = bus.snapshot("mid-t")["session"]["revision"]
    with pytest.raises(HTTPException) as err:
        session_command(SessionCommand(deviceId="dev-iph1", type="next", revision=rev - 1), _req("mid-t"))
    assert err.value.status_code == 409


def test_transfer_endpoints_full_handshake(monkeypatch):
    from app.api.routes import (
        TransferClaimed,
        TransferPosition,
        TransferStart,
        session_claimed,
        session_position,
        session_transfer,
    )

    bus = _two_devices(monkeypatch)
    q = events.subscribe("mid-t")
    try:
        started = session_transfer(TransferStart(fromDeviceId="dev-mac1", toDeviceId="dev-iph1"), _req("mid-t"))
        assert started["ok"] is True
        names = []
        for _ in range(2):   # transferRequest（发送端现报）+ transferIn（接收端预加载）
            name, data = asyncio.run(asyncio.wait_for(q.get(), timeout=1))
            names.append((name, data))
        assert names[0][0] == "transferRequest" and names[0][1]["toDeviceId"] == "dev-iph1"
        assert names[1][0] == "transferIn"
        assert len(names[1][1]["queue"]) == 2       # 接收端拿到完整队列

        session_position(TransferPosition(deviceId="dev-mac1", position=42.75), _req("mid-t"))
        name, data = asyncio.run(asyncio.wait_for(q.get(), timeout=1))
        assert name == "transferPosition" and data["position"] == 42.8

        claimed = session_claimed(TransferClaimed(deviceId="dev-iph1"), _req("mid-t"))
        assert claimed["ok"] is True and claimed["session"]["activeDeviceId"] == "dev-iph1"
        name, data = asyncio.run(asyncio.wait_for(q.get(), timeout=1))
        assert name == "sessionChanged" and data["claimedBy"] == "dev-iph1"
        assert bus.snapshot("mid-t")["transfer"] is None
    finally:
        events.unsubscribe(q)


def test_transfer_endpoint_rejects_offline_target(monkeypatch):
    from fastapi import HTTPException

    from app.api.routes import TransferStart, session_transfer

    _two_devices(monkeypatch)
    with pytest.raises(HTTPException) as err:
        session_transfer(TransferStart(fromDeviceId="dev-mac1", toDeviceId="dev-nope00"), _req("mid-t"))
    assert err.value.status_code == 409


def test_report_carries_volume_to_snapshot(monkeypatch):
    """#27：音量随上报入会话，另一台设备才能在抽屉里看到并改写。"""
    monkeypatch.setattr(bus_module, "bus", SessionBus())
    from app.api import routes

    monkeypatch.setattr(routes, "session_bus", bus_module.bus)
    report_playback_session(SessionReport(
        deviceId="dev-aaa", name="Mac", playing=True, position=3, index=0,
        queue=[{"bvid": "BV1yN4y1H7XX", "cid": 1, "title": "A"}], volume=35,
    ), _req("mid-vol"))
    assert get_playback_session(_req("mid-vol"))["session"]["volume"] == 35
