import cv2
import mediapipe as mp
import numpy as np
from scipy.spatial import distance
import time

# Mediapipe 얼굴 메시 초기화
mp_face_mesh = mp.solutions.face_mesh
face_mesh = mp_face_mesh.FaceMesh(min_detection_confidence=0.5, min_tracking_confidence=0.5)

# 눈의 랜드마크 인덱스 (Mediapipe FaceMesh 기준)
LEFT_EYE_LANDMARKS = [33, 133, 160, 158, 159, 144]
RIGHT_EYE_LANDMARKS = [362, 263, 385, 387, 386, 373]

# 깜빡임 감지 및 시선 고정을 위한 임계값
blink_threshold = 0.29   # EAR (Eye Aspect Ratio) 임계값 (필요에 따라 조정)
gaze_stable_threshold = 0.02    # 시선 변화 임계값

# 전역 변수 (누적 값)
global_blink_timestamps = []    # 깜빡임 이벤트의 시각을 저장 (초 단위)
global_gaze_fixed_count = 0     # 누적 시선 고정 프레임 수
gaze_ratio_last = None          # 이전 프레임의 gaze_ratio
blink_detected = False          # 현재 프레임에서 깜빡임 상태를 판별하기 위한 플래그

def eye_aspect_ratio(eye_landmarks, landmarks):
    """주어진 눈의 랜드마크를 이용해 EAR(Eye Aspect Ratio)를 계산"""
    p1 = np.array([landmarks[eye_landmarks[1]].x, landmarks[eye_landmarks[1]].y])
    p2 = np.array([landmarks[eye_landmarks[2]].x, landmarks[eye_landmarks[2]].y])
    p3 = np.array([landmarks[eye_landmarks[3]].x, landmarks[eye_landmarks[3]].y])
    p4 = np.array([landmarks[eye_landmarks[4]].x, landmarks[eye_landmarks[4]].y])
    p5 = np.array([landmarks[eye_landmarks[5]].x, landmarks[eye_landmarks[5]].y])
    p6 = np.array([landmarks[eye_landmarks[0]].x, landmarks[eye_landmarks[0]].y])
    ear = (distance.euclidean(p2, p4) + distance.euclidean(p3, p5)) / (2.0 * distance.euclidean(p1, p6))
    return ear

def get_metrics(frame, fps):
    """
    입력된 이미지(frame, BGR 형식)를 처리하여
    - 최근 60초 동안의 분당 눈 깜빡임 횟수와
    - 시선 고정 시간 (초)
    를 계산하여 반환합니다.
    """
    global global_blink_timestamps, global_gaze_fixed_count, gaze_ratio_last, blink_detected

    # BGR 이미지를 RGB로 변환 후 Mediapipe 처리
    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    results = face_mesh.process(rgb_frame)

    gaze_ratio = None

    if results.multi_face_landmarks:
        for face_landmarks in results.multi_face_landmarks:
            # 왼쪽/오른쪽 눈 EAR 계산
            left_ear = eye_aspect_ratio(LEFT_EYE_LANDMARKS, face_landmarks.landmark)
            right_ear = eye_aspect_ratio(RIGHT_EYE_LANDMARKS, face_landmarks.landmark)
            avg_ear = (left_ear + right_ear) / 2.0

            # 깜빡임 감지: EAR 값이 임계값보다 낮으면 깜빡임으로 간주
            # 단, 중복 감지를 방지하기 위해 이전 프레임에서 깜빡임 상태가 아니었을 때만 기록
            if avg_ear < blink_threshold and not blink_detected:
                blink_detected = True
                global_blink_timestamps.append(time.time())
            elif avg_ear >= blink_threshold:
                blink_detected = False

            # 시선 분석 (코 끝, 왼쪽 눈, 오른쪽 눈 기준)
            nose_tip = face_landmarks.landmark[1]  # 코 끝 (기준점)
            left_eye_center = face_landmarks.landmark[LEFT_EYE_LANDMARKS[0]]
            right_eye_center = face_landmarks.landmark[RIGHT_EYE_LANDMARKS[0]]
            eye_x_diff = right_eye_center.x - left_eye_center.x

            if eye_x_diff != 0:
                gaze_ratio = (nose_tip.x - left_eye_center.x) / eye_x_diff

                # 이전 프레임과의 gaze_ratio 차이가 작으면 시선이 고정된 것으로 판단
                if gaze_ratio_last is not None:
                    gaze_diff = abs(gaze_ratio - gaze_ratio_last)
                    # 변경: threshold를 0.05로 늘려 민감도를 낮춤
                    if gaze_diff < 0.05:
                        global_gaze_fixed_count += 1
                    else:
                        global_gaze_fixed_count = 0  # 큰 변화가 있으면 고정 카운트 초기화
                gaze_ratio_last = gaze_ratio

    # 분당 깜빡임 계산: 최근 60초 이내의 타임스탬프만 남김
    current_time = time.time()
    one_minute_ago = current_time - 60
    global_blink_timestamps = [ts for ts in global_blink_timestamps if ts >= one_minute_ago]
    blinks_per_minute = len(global_blink_timestamps)

    # fps(프레임 속도)를 이용해 시선 고정 시간(초)을 계산 (누적 프레임 수 / fps)
    gaze_fixed_time = round(global_gaze_fixed_count / fps, 1)

    return {
        'blink': blinks_per_minute,  # 최근 60초 기준 분당 깜빡임 횟수
        'gaze': gaze_fixed_time,
        'fps': fps,
        'face_detected': bool(results.multi_face_landmarks),  # 추가
        'studying': bool(results.multi_face_landmarks)        # 같은 의미로도 가능
    }
