import sys
import base64
import json
import cv2
import numpy as np
import time
from gaze_metrics import get_metrics  # 사용자 정의 함수
# 전역 변수 초기화
fps = 10  # 예시로 1초에 10프레임 들어온다고 가정 (클라이언트 전송 주기에 맞춤)
prev_time = time.time()
# 간단 예시: 받은 이미지 디코딩 후 눈 깜빡임, 시선 고정 시간 가짜 결과 리턴

def process_frame(image_np):
    global prev_time, fps

    # 실제 FPS 계산 (선택사항, 아니면 고정값으로 사용 가능)
    # current_time = time.time()
    # fps = 1 / (current_time - prev_time) if current_time != prev_time else fps
    # prev_time = current_time

    metrics = get_metrics(image_np, fps)
    # metrics = {'blink': blinks_per_minute, 'gaze': gaze_fixed_time, 'fps': fps}

    return {
        'gaze_duration': metrics['gaze'],  # 시선 고정 시간(초)
        'blink_count': metrics['blink'],    # 분당 깜빡임 횟수
        'face_detected':metrics['face_detected'],
        'studying':metrics['studying'],
    }

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            # base64 → numpy array (이미지 디코딩)
            img_bytes = base64.b64decode(line)
            nparr = np.frombuffer(img_bytes, np.uint8)
            img_np = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

            # 이미지가 정상적으로 디코딩 되었으면 처리
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
