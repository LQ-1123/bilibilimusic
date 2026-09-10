"""#23 Phase 1 接口层：上报会发 sessionChanged 事件（含回放队列相关字段）。"""
import asyncio
import types

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
