"""#23 Phase 1：跨端播放会话（设备注册 / 上报 / 只读快照）。"""
import time

from app.services.session_bus import MAX_DEVICES, OFFLINE_AFTER, TRANSFER_TIMEOUT, SessionBus


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


# ---------- Phase 2：命令通道与移交握手 ----------


def _two_devices(bus):
    bus.hello("m", "dev-mac1", "Mac")
    bus.hello("m", "dev-iph1", "iPhone", "android")
    bus.report("m", "dev-mac1", {"playing": True, "position": 30, "index": 0, "queue": _queue("A", "B")})
    return bus


def test_command_is_forwarded_to_active_device():
    bus = _two_devices(SessionBus())
    out = bus.command("m", "dev-iph1", "pause")
    assert out["accepted"] is True and out["targetDeviceId"] == "dev-mac1"
    assert out["command"]["type"] == "pause" and out["command"]["fromDeviceId"] == "dev-iph1"


def test_command_rejects_self_active_unknown_and_offline():
    bus = _two_devices(SessionBus())
    assert bus.command("m", "dev-mac1", "play")["reason"] == "self-active"
    assert bus.command("m", "dev-iph1", "explode")["reason"] == "bad-command"
    bus._devices["m"]["dev-mac1"].last_seen = time.time() - (OFFLINE_AFTER + 1)
    assert bus.command("m", "dev-iph1", "next")["reason"] == "target-offline"
    assert bus.command("m-other", "dev-iph1", "next")["reason"] == "no-session"


def test_command_rejects_stale_revision():
    bus = _two_devices(SessionBus())
    rev = bus.snapshot("m")["session"]["revision"]
    assert bus.command("m", "dev-iph1", "pause", revision=rev - 1)["reason"] == "stale-revision"
    assert bus.command("m", "dev-iph1", "pause", revision=rev)["accepted"] is True


def test_transfer_handshake_reports_live_position_then_claims():
    bus = _two_devices(SessionBus())
    started = bus.start_transfer("m", "dev-mac1", "dev-iph1")
    assert started["ok"] is True
    assert bus.snapshot("m")["transfer"]["toDeviceId"] == "dev-iph1"
    assert bus.snapshot("m")["transfer"]["live"] is False

    live = bus.live_position("m", "dev-mac1", 42.75)
    assert live["ok"] is True and live["transfer"]["live"] is True
    assert bus.snapshot("m")["transfer"]["position"] == 42.8   # 现报的精确进度

    claimed = bus.claim("m", "dev-iph1")
    assert claimed["ok"] is True and claimed["fromDeviceId"] == "dev-mac1"
    session = bus.snapshot("m")["session"]
    assert session["activeDeviceId"] == "dev-iph1"
    assert session["position"] == 42.8 and session["playing"] is True
    assert bus.snapshot("m")["transfer"] is None              # 握手结束
    # 发送端仍在播 → 不再是 active
    devices = {d["id"]: d for d in bus.devices("m")}
    assert devices["dev-mac1"]["active"] is False and devices["dev-mac1"]["playing"] is True


def test_transfer_rejects_offline_or_unknown_targets():
    bus = _two_devices(SessionBus())
    assert bus.start_transfer("m", "dev-mac1", "dev-nope")["reason"] == "target-offline"
    assert bus.start_transfer("m-x", "dev-mac1", "dev-iph1")["reason"] == "no-session"
    bus._devices["m"]["dev-mac1"].last_seen = time.time() - (OFFLINE_AFTER + 1)
    assert bus.start_transfer("m", "dev-mac1", "dev-iph1")["reason"] == "source-offline"


def test_transfer_expires_without_claim():
    bus = _two_devices(SessionBus())
    bus.start_transfer("m", "dev-mac1", "dev-iph1")
    bus._transfers["m"].started_at = time.time() - (TRANSFER_TIMEOUT + 1)
    assert bus.snapshot("m")["transfer"] is None              # 超时清掉：发送端继续播，等于没发生
    assert bus.claim("m", "dev-iph1")["reason"] == "no-pending-transfer"


def test_live_position_requires_pending_transfer_for_that_sender():
    bus = _two_devices(SessionBus())
    assert bus.live_position("m", "dev-mac1", 10)["reason"] == "no-pending-transfer"
    bus.start_transfer("m", "dev-mac1", "dev-iph1")
    assert bus.live_position("m", "dev-iph1", 10)["reason"] == "no-pending-transfer"
    assert bus.live_position("m", "dev-mac1", 10)["ok"] is True
