"""Pinned MediaPipe 0.10.21 landmark graph for an independently located ROI.

Graph contract: google-ai-edge/mediapipe v0.10.21, tasks/cc/vision/
face_landmarker/face_landmarks_detector_graph.cc. No secondary face search.
"""
from io import BytesIO
from zipfile import ZipFile
import math

import mediapipe as mp
from mediapipe.framework import calculator_pb2
from mediapipe.framework.formats import rect_pb2
from mediapipe.python import packet_creator, packet_getter
from mediapipe.python._framework_bindings import task_runner
from mediapipe.tasks.cc.vision.face_landmarker.proto import face_landmarks_detector_graph_options_pb2

ROI_SCALE = 1.2


class FaceLandmarkRegion:
    def __init__(self, model):
        with ZipFile(BytesIO(model)) as archive:
            landmark_model = archive.read('face_landmarks_detector.tflite')
        options = face_landmarks_detector_graph_options_pb2.FaceLandmarksDetectorGraphOptions(
            base_options=mp.tasks.BaseOptions(model_asset_buffer=landmark_model).to_pb2(),
            min_detection_confidence=.5)
        inputs = ['IMAGE:image', 'NORM_RECT:rect']
        outputs = ['NORM_LANDMARKS:landmarks', 'PRESENCE:presence', 'PRESENCE_SCORE:score', 'FACE_RECT_NEXT_FRAME:next_rect']
        config = calculator_pb2.CalculatorGraphConfig(input_stream=inputs, output_stream=outputs)
        node = config.node.add(calculator='mediapipe.tasks.vision.face_landmarker.SingleFaceLandmarksDetectorGraph',
                               input_stream=inputs, output_stream=outputs)
        node.options.Extensions[options.ext].CopyFrom(options)
        self.runner = task_runner.TaskRunner.create(config)

    def detect(self, image, box):
        x, y, width, height = (float(value) for value in box[:4])
        edge = max(width, height)*ROI_SCALE
        angle = math.atan2(float(box[7]-box[5]), float(box[6]-box[4]))
        rect = rect_pb2.NormalizedRect(x_center=(x+width/2)/image.width,
            y_center=(y+height/2)/image.height, width=edge/image.width, height=edge/image.height, rotation=angle)
        packets = self.runner.process({'image': packet_creator.create_image(image), 'rect': packet_creator.create_proto(rect)})
        if packets['landmarks'].is_empty():
            return None
        landmarks = packet_getter.get_proto(packets['landmarks']).landmark
        if len(landmarks) != 478:
            raise ValueError('Unexpected regional face landmark count')
        return landmarks

    def close(self):
        self.runner.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
