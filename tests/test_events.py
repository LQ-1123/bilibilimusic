"""曲库变更事件总线：按账号 mid 过滤、订阅退订。

#23 起队列项统一是 (name, data)：data 为 None 时 SSE 仍只发事件名（旧监听器行为不变）。
"""

from app import events


async def test_publish_filters_by_mid():
    q101 = events.subscribe("101")
    q202 = events.subscribe("202")
    qguest = events.subscribe(None)
    try:
        events.publish("101", "libraryChanged")
        events.publish(None, "playlistsChanged")
        assert q101.qsize() == 1
        assert q101.get_nowait() == ("libraryChanged", None)
        assert q202.qsize() == 0  # 别的账号的事件不串扰
        assert qguest.qsize() == 1
        assert qguest.get_nowait() == ("playlistsChanged", None)
    finally:
        events.unsubscribe(q101)
        events.unsubscribe(q202)
        events.unsubscribe(qguest)
    assert not any(item[1] is q101 for item in events._subs)  # 退订即移除
    q = events.subscribe("101")
    try:
        events.publish("101", "libraryChanged")  # 重新订阅的队列正常收到
        assert q.qsize() == 1
    finally:
        events.unsubscribe(q)


async def test_publish_carries_optional_payload():
    q = events.subscribe("7")
    try:
        events.publish("7", "sessionChanged", {"session": {"position": 3}})
        name, data = q.get_nowait()
        assert name == "sessionChanged" and data["session"]["position"] == 3
    finally:
        events.unsubscribe(q)


async def test_subscribe_unsubscribe_is_clean():
    before = set(events._subs)
    q = events.subscribe("9")
    assert set(events._subs) - before == {("9", q)}
    events.unsubscribe(q)
    assert set(events._subs) == before
