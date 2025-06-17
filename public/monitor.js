// monitor.js

// 전역 변수 선언
let displayStream = null;

// DOM 요소 가져오기
const video            = document.getElementById('video');
const screenShot       = document.getElementById('screenShot');
const resultDiv        = document.getElementById('result');
const graphCanvas      = document.getElementById('graph');
const graphCtx         = graphCanvas.getContext('2d');
const ocrOutput        = document.getElementById('ocrOutput');
const subjectOutput    = document.getElementById('subjectOutput');
const keywordsOutput   = document.getElementById('keywordsOutput');
const userCountOutput  = document.getElementById('userCountOutput');
const noiseLevelOutput = document.getElementById('noiseLevelOutput');

// JWT 토큰 (로그인 시 로컬스토리지에 저장했다고 가정)
const token = localStorage.getItem('token') || '';

// Socket.IO 클라이언트 연결 (인증 토큰 포함)
const socket = io({ auth: { token }, path: '/socket.io' });

// 순수 WebSocket 연결 (모니터링용)
const ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/monitor_ws');
let gazeHistory = [];

// ---- Socket.IO 이벤트 처리 ----
socket.on('connect', () => {
  console.log('Socket.IO connected');
  startVideo();
  startDisplayCapture();
  startStatusPolling();
});

socket.on('disconnect', () => {
  console.warn('Socket.IO disconnected');
});

socket.on('ocrResult', data => {
  if (ocrOutput) {
    console.log('OCR Result received:', data);
    ocrOutput.textContent     = `[${data.username} @ ${data.timestamp}] 추출된 텍스트: ${data.ocrText || '없음'}`;
  }
  if (subjectOutput) {
    subjectOutput.textContent = `분류: ${data.subject || '분류 중...'}`;
  }
  if (keywordsOutput) {
    keywordsOutput.textContent = Array.isArray(data.keywords) && data.keywords.length > 0
      ? `키워드: ${data.keywords.join(', ')}`
      : '키워드: 매칭된 키워드 없음';
  }
});

// ---- WebSocket 이벤트 처리 ----
ws.addEventListener('open', () => {
  console.log('Monitor WebSocket connected');
});

ws.addEventListener('message', event => {
  const data = JSON.parse(event.data);
  if (resultDiv) {
    resultDiv.textContent =
      `📌 시선 고정 시간: ${data.gaze_duration}s\n` +
      `👁️ 분당 눈 깜빡임 횟수: ${data.blink_count}\n` +
      `🙂 얼굴 인식: ${data.face_detected}\n` +
      `📚 학습 상태: ${data.studying}`;
  }
  if (typeof data.gaze_duration === 'number' && isFinite(data.gaze_duration)) {
    gazeHistory.push(data.gaze_duration);
    if (gazeHistory.length > 60) gazeHistory.shift();
    drawGraph();
  }
});

ws.addEventListener('error', err => console.error('Monitor WebSocket error:', err));
ws.addEventListener('close', () => console.warn('Monitor WebSocket closed'));

// ---- 강의실 현황 주기적 조회 ----
function startStatusPolling() {
  updateStatus();
  setInterval(updateStatus, 5000); // 5초마다 갱신
}

async function updateStatus() {
  if (!userCountOutput || !noiseLevelOutput) return;
  try {
    const res = await fetch('/api/status', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(res.statusText);
    const json = await res.json();
    userCountOutput.textContent  = `사용자 수: ${json.userCount}`;
    noiseLevelOutput.textContent = `소음 레벨: ${json.noiseLevel}`;
  } catch (e) {
    console.error('상태 조회 오류:', e);
  }
}

// ---- 비디오 및 화면 캡처 ----
async function startDisplayCapture() {
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch (err) {
    console.error('디스플레이 캡처 오류:', err);
  }
}

function startVideo() {
  navigator.mediaDevices.getUserMedia({ video: true })
    .then(stream => {
      video.srcObject = stream;
      captureFrames();
    })
    .catch(console.error);
}

function captureFrames() {
  const videoCanvas   = document.createElement('canvas');
  const displayCanvas = document.createElement('canvas');
  const videoCtx      = videoCanvas.getContext('2d');
  const displayCtx    = displayCanvas.getContext('2d');

  videoCanvas.width   = 400;
  videoCanvas.height  = 300;
  displayCanvas.width = 400;
  displayCanvas.height= 300;

  setInterval(() => {
    if (video.srcObject) {
      videoCtx.drawImage(video, 0, 0, videoCanvas.width, videoCanvas.height);
      const webcamDataUrl  = videoCanvas.toDataURL('image/jpeg', 0.1);
      const webcamBase64   = webcamDataUrl.split(',')[1];

      if (displayStream) {
        const track   = displayStream.getVideoTracks()[0];
        const capture = new ImageCapture(track);
        capture.grabFrame()
          .then(bitmap => {
            displayCtx.drawImage(bitmap, 0, 0, displayCanvas.width, displayCanvas.height);
            const screenDataUrl = displayCanvas.toDataURL('image/jpeg', 0.1);
            const screenBase64  = screenDataUrl.split(',')[1];
            if (screenShot) screenShot.src = screenDataUrl;

            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'frame', webcam: webcamBase64, screen: screenBase64 }));
            }
          })
          .catch(err => console.warn('화면 프레임 캡처 실패:', err));
      }
    }
  }, 1000);
}

// ---- 시선 고정 시간 그래프 그리기 ----
function drawGraph() {
  if (!graphCtx) return;
  graphCtx.clearRect(0, 0, graphCanvas.width, graphCanvas.height);
  const max    = Math.max(...gazeHistory, 1);
  const scaleY = graphCanvas.height / max;

  graphCtx.beginPath();
  gazeHistory.forEach((val, i) => {
    const x = (i / (gazeHistory.length - 1)) * graphCanvas.width;
    const y = graphCanvas.height - (val * scaleY);
    i === 0 ? graphCtx.moveTo(x, y) : graphCtx.lineTo(x, y);
  });
  graphCtx.strokeStyle = '#4a90e2';
  graphCtx.lineWidth   = 2;
  graphCtx.stroke();

  graphCtx.fillStyle = '#666';
  graphCtx.font      = '14px sans-serif';
  graphCtx.fillText('📈 시선 고정 시간 추이 (최근 1분)', 10, 20);
}
