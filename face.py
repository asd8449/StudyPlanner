# @title 기본 제목 텍스트
import cv2
import os
import numpy as np
from deepface import DeepFace
from PIL import ImageFont, ImageDraw, Image
import mediapipe as mp

# ========== 한글 텍스트 출력 함수 ==========
def draw_text_korean(img, text, position, font_path='C:/Windows/Fonts/malgun.ttf',
                     font_size=24, color=(0, 255, 0)):
    img_pil = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(img_pil)
    font = ImageFont.truetype(font_path, font_size)
    draw.text(position, text, font=font, fill=color)
    return cv2.cvtColor(np.array(img_pil), cv2.COLOR_RGB2BGR)

# ========== 경로 설정 ==========
IMAGE_DIR = "images"
VECTOR_DIR = "vectors"
os.makedirs(IMAGE_DIR, exist_ok=True)
os.makedirs(VECTOR_DIR, exist_ok=True)

# ========== 사용자 이름 입력 ==========
name = input("이름을 입력하세요: ").strip()

# ========== Mediapipe 얼굴 감지기 ==========
mp_face = mp.solutions.face_detection
detector = mp_face.FaceDetection(model_selection=0, min_detection_confidence=0.6)

# ========== 웹캠 시작 ==========
cap = cv2.VideoCapture(0)
cv2.namedWindow("Face Register")

img_count = 1
print("\n[📸] 스페이스바를 눌러 등록 / ESC로 종료")

while True:
    ret, frame = cap.read()
    if not ret:
        break

    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    result = detector.process(rgb)

    detected = False
    crop_region = None

    if result.detections:
        for det in result.detections:
            bbox = det.location_data.relative_bounding_box
            h, w, _ = frame.shape
            x = int(bbox.xmin * w)
            y = int(bbox.ymin * h)
            bw = int(bbox.width * w)
            bh = int(bbox.height * h)
            x1, y1 = max(0, x), max(0, y)
            x2, y2 = min(w, x + bw), min(h, y + bh)
            crop_region = frame[y1:y2, x1:x2]

            # 박스 표시
            cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
            frame = draw_text_korean(frame, "🟢 얼굴 인식됨", (x1, y1 - 30))
            detected = True
    else:
        frame = draw_text_korean(frame, "❌ 얼굴이 감지되지 않았습니다", (30, 30), font_size=22, color=(0, 0, 255))

    frame = draw_text_korean(frame, f"스페이스바: 등록 / ESC: 종료", (30, 30),
                             font_size=22, color=(255, 255, 0))

    cv2.imshow("Face Register", frame)
    key = cv2.waitKey(30)

    if key == 32:  # 스페이스바
        if not detected or crop_region is None or crop_region.size == 0:
            print("❌ 얼굴 감지 안됨. 다시 시도하세요.")
            continue

        image_path = f"{IMAGE_DIR}/{name}_{img_count}.jpg"
        vector_path = f"{VECTOR_DIR}/{name}_{img_count}.npy"
        cv2.imwrite(image_path, frame)

        try:
            rgb_crop = cv2.cvtColor(crop_region, cv2.COLOR_BGR2RGB)
            result = DeepFace.represent(
                img_path=rgb_crop,
                model_name="ArcFace",
                detector_backend="skip",
                enforce_detection=False
            )
            embedding = np.array(result[0]["embedding"], dtype=np.float32)
            embedding /= np.linalg.norm(embedding)  # ✅ L2 정규화

            np.save(vector_path, embedding)
            print(f"✅ 등록 성공: {image_path} + {vector_path}")
            img_count += 1

        except Exception as e:
            print(f"❌ 벡터화 실패: {e}")

    elif key == 27:  # ESC
        print("🛑 등록 종료")
        break

cap.release()
cv2.destroyAllWindows()
print(f"\n🎉 총 {img_count - 1}개의 이미지 등록 완료")
