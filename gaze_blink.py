# gaze_blink.py

import sys
import base64
import json
import cv2
import numpy as np
import time

# ─────────────────────────────────────────────────────────────────────────────
# Mediapipe Face Mesh만 직접 임포트 (mediapipe.tasks와 tensorflow 의존을 피함)
# ─────────────────────────────────────────────────────────────────────────────
from mediapipe.python.solutions.face_mesh import FaceMesh

# FaceMesh 초기화
mp_face_mesh = FaceMesh(
    static_image_mode=False,
    max_num_faces=1,
    refine_landmarks=True,
    min_detection_confidence=0.5,
    min_tracking_confidence=0.5
)

# ─────────────────────────────────────────────────────────────────────────────
# EAR (Eye Aspect Ratio) 계산 함수
# ─────────────────────────────────────────────────────────────────────────────
def compute_ear(landmarks, eye_indices, image_width, image_height):
    """
    landmarks: Mediapipe에서 반환한 얼굴 랜드마크 list (landmark.x, landmark.y 정규화 좌표)
    eye_indices: 6개의 눈 랜드마크 인덱스 (예: [33, 160, 158, 133, 153, 144])
    image_width, image_height: 원본 이미지 크기 (픽셀)
    """
    pts = []
    for idx in eye_indices:
        lm = landmarks[idx]
        x, y = int(lm.x * image_width), int(lm.y * image_height)
        pts.append((x, y))

    # EAR = (|p2-p6| + |p3-p5|) / (2 * |p1-p4|)
    p1, p2, p3, p4, p5, p6 = pts
    A = np.linalg.norm(np.array(p2) - np.array(p6))
    B = np.linalg.norm(np.array(p3) - np.array(p5))
    C = np.linalg.norm(np.array(p1) - np.array(p4))
    if C == 0:
        return 0.0
    ear = (A + B) / (2.0 * C)
    return ear

# EAR 임계값 (눈 감김 상태 판단)
EAR_THRESHOLD = 0.25

# Mediapipe Face Mesh 468 랜드마크 중 눈 주변 인덱스
LEFT_EYE_IDX  = [33, 160, 158, 133, 153, 144]
RIGHT_EYE_IDX = [362, 385, 387, 263, 373, 380]

# ─────────────────────────────────────────────────────────────────────────────
# 전역 상태 변수
# ─────────────────────────────────────────────────────────────────────────────
prev_ear_left  = None
prev_ear_right = None
eye_closed     = False   # 현재 눈이 감긴 상태인지
total_blinks   = 0       # 누적된 깜빡임 횟수
consecutive_face_frames = 0  # 얼굴이 검출된 연속 프레임 수

fps = 10.0     # 기본 FPS 값 (필요 시 외부에서 덮어씀)
prev_time = time.time()

# ─────────────────────────────────────────────────────────────────────────────
# get_metrics: 한 프레임당 Blink Rate(분당 깜빡임), Gaze Duration(초),
# face_detected(bool), studying(bool) 반환
# ─────────────────────────────────────────────────────────────────────────────
def get_metrics(frame_bgr: np.ndarray, fps_value: float):
    global prev_ear_left, prev_ear_right, eye_closed, total_blinks
    global consecutive_face_frames, prev_time, fps

    fps = fps_value

    h, w = frame_bgr.shape[:2]
    frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)

    # Face Mesh로 얼굴 검출 및 랜드마크
    results = mp_face_mesh.process(frame_rgb)
    face_detected = False
    blink_increment = 0

    if results.multi_face_landmarks:
        face_detected = True
        consecutive_face_frames += 1

        landmarks = results.multi_face_landmarks[0].landmark

        # 양쪽 눈 EAR 계산
        ear_left  = compute_ear(landmarks, LEFT_EYE_IDX, w, h)
        ear_right = compute_ear(landmarks, RIGHT_EYE_IDX, w, h)
        ear_avg   = (ear_left + ear_right) / 2.0

        # Blink 감지: EAR이 임계값 아래→위로 변화 시 1회 증가
        if ear_avg < EAR_THRESHOLD:
            if not eye_closed:
                eye_closed = True
        else:
            if eye_closed:
                total_blinks += 1
                blink_increment = 1
                eye_closed = False

        prev_ear_left  = ear_left
        prev_ear_right = ear_right
    else:
        face_detected = False
        consecutive_face_frames = 0

    # Gaze duration: 얼굴 검출된 연속 프레임 / fps (초 단위)
    gaze_duration = consecutive_face_frames / fps

    # Blink rate(BPM): total_blinks / (경과 시간 분)
    current_time = time.time()
    elapsed_min = (current_time - prev_time) / 60.0
    if elapsed_min < 1e-3:
        blink_rate = 0.0
    else:
        blink_rate = total_blinks / elapsed_min

    # 단순한 Studying 여부: 얼굴 검출 & blink_rate < 60
    studying = face_detected and (blink_rate < 60.0)

    return {
        'blink': int(blink_rate),
        'gaze': round(gaze_duration, 3),
        'face_detected': face_detected,
        'studying': studying
    }

# ─────────────────────────────────────────────────────────────────────────────
# process_frame: numpy 배열(BGR)을 받아 JSON 직렬화할 딕셔너리 반환
# ─────────────────────────────────────────────────────────────────────────────
def process_frame(image_np):
    # 필요 시 실제 FPS 계산 로직 추가 가능
    # current_time = time.time()
    # fps = 1.0 / (current_time - prev_time) if (current_time - prev_time) > 1e-3 else fps
    # prev_time = current_time

    metrics = get_metrics(image_np, fps)
    return {
        'gaze_duration': metrics['gaze'],
        'blink_count':   metrics['blink'],
        'face_detected': metrics['face_detected'],
        'studying':      metrics['studying']
    }

# ─────────────────────────────────────────────────────────────────────────────
# main: stdin으로 base64 인코딩된 이미지를 한 줄씩 읽고 처리 → JSON 출력
# ─────────────────────────────────────────────────────────────────────────────
def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            # base64 → 바이트 → numpy 배열 → 디코딩
            img_bytes = base64.b64decode(line)
            nparr = np.frombuffer(img_bytes, np.uint8)
            img_np = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

            if img_np is not None:
                result = process_frame(img_np)
                print(json.dumps(result))
                sys.stdout.flush()
            else:
                print(json.dumps({'error': 'invalid image'}))
                sys.stdout.flush()

        except Exception as e:
            print(json.dumps({'error': str(e)}))
            sys.stdout.flush()

if __name__ == '__main__':
    main()
