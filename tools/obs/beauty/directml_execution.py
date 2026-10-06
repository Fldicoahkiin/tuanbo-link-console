"""Serialize GPU submissions across the process's DirectML model sessions.

The pinned Windows runtime crashes when these two models execute concurrently.
CPU preprocessing and landmark/body work remain independently scheduled.
"""
import threading
import time
from contextlib import contextmanager
from collections import deque


class SubmissionQueue:
    """FIFO mutual exclusion; a waiting model cannot be overtaken by a new view."""
    def __init__(self):
        self._condition = threading.Condition()
        self._pending = deque()

    def __enter__(self):
        token = object()
        with self._condition:
            self._pending.append(token)
            self._condition.notify_all()
            try:
                self._condition.wait_for(lambda:self._pending[0] is token)
            except BaseException:
                self._pending.remove(token)
                self._condition.notify_all()
                raise
        return self

    def __exit__(self, *_):
        with self._condition:
            self._pending.popleft()
            self._condition.notify_all()

_submission_lock = threading.Lock()
_diagnostics = threading.local()


@contextmanager
def fifo_submissions():
    """Explicit worker experiment; enter before pools and exit after all join."""
    global _submission_lock
    previous = _submission_lock
    _submission_lock = SubmissionQueue()
    try:
        yield
    finally:
        _submission_lock = previous


@contextmanager
def capture_timings():
    """Collect only this thread's submissions during an explicit diagnostic."""
    if getattr(_diagnostics,'samples',None) is not None:
        raise RuntimeError('Nested GPU diagnostic capture is not supported')
    samples = []
    _diagnostics.samples = samples
    try:
        yield samples
    finally:
        del _diagnostics.samples


def run(session, outputs, inputs, *, timing=None):
    samples = getattr(_diagnostics,'samples',None)
    if timing is None and samples is not None:
        timing = {}
    queued = time.perf_counter() if timing is not None else 0
    with _submission_lock:
        started = time.perf_counter() if timing is not None else 0
        try:
            return session.run(outputs, inputs)
        except UnicodeDecodeError as error:
            # Preserve localized Windows diagnostics lost by ORT's UTF-8 binding.
            raise RuntimeError(f'DirectML execution failed: {error.object.decode("mbcs", errors="replace")}') from error
        finally:
            if timing is not None:
                timing.update(waitMs=(started-queued)*1000, executionMs=(time.perf_counter()-started)*1000)
                if samples is not None:
                    samples.append(dict(timing))
