"""Observe owner pipe EOF without holding Python's buffered-stdin lock."""
import os
import threading


class OwnerWatch:
    def __init__(self, descriptor, stopped):
        self.error = None
        self.stopped = stopped
        self.thread = threading.Thread(target=self._read, args=(descriptor,), daemon=True, name='beauty-owner')
        self.thread.start()

    def _read(self, descriptor):
        try:
            # Ownership is represented by the pipe lifetime. Discard unexpected
            # bytes in bounded chunks; no buffered read or unbounded accumulation.
            while os.read(descriptor, 4096):
                continue
        except OSError as error:
            self.error = error
        finally:
            self.stopped.set()

    def check(self):
        if self.error is not None:
            raise RuntimeError(f'Owner pipe read failed: {self.error}') from self.error
