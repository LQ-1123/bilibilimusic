"""换号时关闭旧账号任务，自动同步一次只能执行一次。"""

import asyncio

from app.services.exporter import ExportService
from app.services.sync import SyncService


async def test_quiet_sync_waits_for_single_existing_job(monkeypatch):
    started, release = asyncio.Event(), asyncio.Event()
    syncer = SyncService(None, None)

    async def reconcile(state):
        state.folders += 1
        started.set()
        await release.wait()

    monkeypatch.setattr(syncer, "_reconcile", reconcile)
    state = syncer.submit()
    quiet = asyncio.create_task(syncer.reconcile_quietly())
    await asyncio.wait_for(started.wait(), timeout=2)
    await asyncio.sleep(0)
    release.set()
    await quiet
    assert state.status == "done"
    assert state.folders == 1
    await syncer.shutdown()


async def test_shutdown_stops_sync_before_further_writes(monkeypatch):
    started = asyncio.Event()
    syncer = SyncService(None, None)

    async def reconcile(state):
        started.set()
        await asyncio.Event().wait()
        state.pushed += 1

    monkeypatch.setattr(syncer, "_reconcile", reconcile)
    state = syncer.submit()
    await asyncio.wait_for(started.wait(), timeout=2)
    await syncer.shutdown()
    assert state.status == "failed"
    assert state.pushed == 0


async def test_shutdown_cancels_queued_exports_too(monkeypatch):
    from types import SimpleNamespace

    started = asyncio.Event()
    exporter = ExportService(SimpleNamespace(store=SimpleNamespace(logged_in=True)))

    async def export(state):
        state.status = "syncing"
        started.set()
        await asyncio.Event().wait()
        state.done += 1

    monkeypatch.setattr(exporter, "_export", export)
    first, queued = exporter.submit(), exporter.submit()
    await asyncio.wait_for(started.wait(), timeout=2)
    await exporter.shutdown()
    assert first.status == "failed"
    assert queued.status == "failed"
    assert first.done == queued.done == 0
