"""Landmark IDs from MediaPipe's official face_mesh_connections.py topology.

https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/python/solutions/face_mesh_connections.py
Complete face mesh including irises. Coordinates remain normalized.
"""
POINT_IDS = tuple(range(478))
POINT_KEYS = tuple(f"p{point}{axis}" for point in POINT_IDS for axis in "xy")
