"""Explicit CPU delegate budgets for the pinned MediaPipe runtime."""
import mediapipe as mp


class ThreadedBaseOptions(mp.tasks.BaseOptions):
    def __init__(self, model, threads):
        if threads not in (1, 2, 4, 8):
            raise ValueError('Unsupported CPU thread count')
        super().__init__(model_asset_buffer=model)
        self.threads = threads

    def to_pb2(self):
        result = super().to_pb2()
        result.acceleration.xnnpack.num_threads = self.threads
        return result
