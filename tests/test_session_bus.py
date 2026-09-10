"""#23 Phase 1：跨端播放会话（设备注册 / 上报 / 只读快照）。"""
import time

from app.services.session_bus import MAX_DEVICES, OFFLINE_AFTER, SessionBus


def _queue(*titles):
    return [
        {"bvid": f"BV1xx411c7m{i}", "cid": 100 + i, "title": t, "songId": i}
        for i, t in enumerate(titles)
    ]


def test_hello_registers_device_without_session():
    bus = SessionBus()
    snap = bus.hello("mid-1", "dev-a", "Mac", "browser")
    assert snap["session"] is None
    assert [d["name"] for d in snap["devices"]] == ["Mac"]
    assert snap["devices"][0]["online"] is True
    assert snap["devices"][0]["active"] is False


def test_first_playing_device_becomes_active_and_publishes_queue():
    bus = SessionBus()
    bus.hello("mid-1", "dev-a", "Mac")
    out = bus.report("mid-1", "dev-a", {
        "playing": True, "position": 12.5, "index": 1, "queue": _queue("A", "B"),
    })
    assert out["accepted"] is True and out["queueChanged"] is True
    session = out["session"]
    assert session["activeDeviceId"] == "dev-a"
    assert session["song"]["title"] == "B"
    assert session["position"] == 12.5 and session["playing"] is True


def test_second_playing_device_preempts_and_first_is_flagged():
    bus = SessionBus()
    bus.hello("mid-1", "dev-a", "Mac")
    bus.report("mid-1", "dev-a", {"playing": True, "position": 30, "index": 0, "queue": _queue("A")})
    out = bus.report("mid-1", "dev-b", {"playing": True, "position": 0, "index": 0, "queue": _queue("C")},
                     name="iPhone", kind="android")
    assert out["preemptedDeviceId"] == "dev-a"
    devices = {d["id"]: d for d in bus.devices("mid-1")}
    assert devices["dev-b"]["active"] is True and devices["dev-b"]["playing"] is True
    assert devices["dev-a"]["active"] is False
    assert devices["dev-a"]["preemptedAt"] is not None


def test_non_active_device_report_does_not_overwrite_session():
    bus = SessionBus()
    bus.hello("mid-1", "dev-a", "Mac")
    bus.report("mid-1", "dev-a", {"playing": True, "position": 40, "index": 1, "queue": _queue("A", "B")})
    # dev-b 只是开页面（没播）上报了空状态：不能把队列/进度清掉
    out = bus.report("mid-1", "dev-b", {"playing": False, "position": 0, "index": 0, "queue": []})
    assert out["accepted"] is False
    session = out["session"]
    assert session["activeDeviceId"] == "dev-a"
    assert session["song"]["title"] == "B" and session["position"] == 40
    assert {d["id"]: d["online"] for d in bus.devices("mid-1")} == {"dev-a": True, "dev-b": True}


def test_position_extrapolates_while_playing():
    bus = SessionBus()
    bus.hello("mid-1", "dev-a")
    out = bus.report("mid-1", "dev-a", {"playing": True, "position": 10, "index": 0, "queue": _queue("A")})
    session = bus.snapshot("mid-1")["session"]
    assert session["position"] >= out["session"]["position"]
    # 暂停后不再外推
    bus.report("mid-1", "dev-a", {"playing": False, "position": 20, "index": 0, "queue": _queue("A")})
    paused = bus.snapshot("mid-1")["session"]
    time.sleep(0.05)
    assert bus.snapshot("mid-1")["session"]["position"] == paused["position"]


def test_report_debounce_keeps_revision_but_records_jump():
    bus = SessionBus()
    bus.hello("mid-1", "dev-a")
    bus.report("mid-1", "dev-a", {"playing": True, "position": 5, "index": 0, "queue": _queue("A", "B")})
    rev = bus.snapshot("mid-1")["session"]["revision"]
    bus.report("mid-1", "dev-a", {"playing": True, "position": 5.4, "index": 0, "queue": _queue("A", "B")})
    assert bus.snapshot("mid-1")["session"]["revision"] == rev  # 1 秒内的小抖动不刷版本
    bus.report("mid-1", "dev-a", {"playing": True, "position": 0, "index": 1, "queue": _queue("A", "B")})
    assert bus.snapshot("mid-1")["session"]["revision"] == rev + 1  # 换歌/拖拽不受防抖


def test_stale_device_is_offline_and_swept():
    bus = SessionBus()
    bus.hello("mid-1", "dev-a", "Mac")
    bus.report("mid-1", "dev-a", {"playing": True, "position": 1, "index": 0, "queue": _queue("A")})
    bus._devices["mid-1"]["dev-a"].last_seen = time.time() - (OFFLINE_AFTER + 5)
    assert bus.devices("mid-1")[0]["online"] is False
    bus._devices["mid-1"]["dev-a"].last_seen = time.time() - 9999
    assert bus.devices("mid-1") == []
    # 设备被清掉后 active 也要复位，避免前台显示幽灵会话在播
    assert bus.snapshot("mid-1")["session"]["playing"] is False


def test_device_table_is_capped():
    bus = SessionBus()
    for i in range(MAX_DEVICES + 3):
        bus.hello("mid-1", f"dev-{i}", f"D{i}")
    assert len(bus.devices("mid-1")) == MAX_DEVICES


def test_accounts_are_isolated():
    bus = SessionBus()
    bus.hello("mid-1", "dev-a", "Mac")
    bus.report("mid-1", "dev-a", {"playing": True, "position": 3, "index": 0, "queue": _queue("A")})
    assert bus.snapshot("mid-2")["session"] is None
    assert bus.devices("mid-2") == []
