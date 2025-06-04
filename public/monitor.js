const video = document.getElementById('video');
    const screenShot = document.getElementById('screenShot');
    const resultDiv = document.getElementById('result');
    const graphCanvas = document.getElementById('graph');
    const graphCtx = graphCanvas.getContext('2d');

    const ws = new WebSocket('ws://' + location.host + '/monitor_ws');
    let gazeHistory = [];

    ws.onopen = () => {
      console.log('WebSocket connected');
      startVideo();
      startDisplayCapture();
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      resultDiv.textContent =
        `📌 시선 고정 시간: ${data.gaze_duration}s\n` +
        `👁️ 분당 눈 깜빡임 횟수: ${data.blink_count}\n` +
        `🙂 얼굴 인식: ${data.face_detected}\n` +
        `📚 학습 상태: ${data.studying}`;

      if (typeof data.gaze_duration === 'number' && isFinite(data.gaze_duration)) {
        gazeHistory.push(data.gaze_duration);
        if (gazeHistory.length > 60) gazeHistory.shift();
        drawGraph();
      }
    };

    let displayStream = null;

    async function startDisplayCapture() {
      try {
        displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      } catch (err) {
        console.error("디스플레이 캡처 오류:", err);
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
      const videoCanvas = document.createElement('canvas');
      const displayCanvas = document.createElement('canvas');
      const videoCtx = videoCanvas.getContext('2d');
      const displayCtx = displayCanvas.getContext('2d');

      videoCanvas.width = 400;
      videoCanvas.height = 300;
      displayCanvas.width = 400;
      displayCanvas.height = 300;

      setInterval(() => {
        videoCtx.drawImage(video, 0, 0, videoCanvas.width, videoCanvas.height);
        const webcamDataUrl = videoCanvas.toDataURL('image/jpeg', 0.1);
        const webcamBase64 = webcamDataUrl.split(',')[1];

        if (displayStream) {
          const track = displayStream.getVideoTracks()[0];
          const capture = new ImageCapture(track);
          capture.grabFrame().then(bitmap => {
            displayCtx.drawImage(bitmap, 0, 0, displayCanvas.width, displayCanvas.height);
            const screenDataUrl = displayCanvas.toDataURL('image/jpeg', 0.1);
            const screenBase64 = screenDataUrl.split(',')[1];
            screenShot.src = screenDataUrl;

            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'frame',
                webcam: webcamBase64,
                screen: screenBase64
              }));
            }
          }).catch(err => {
            console.warn("화면 프레임 캡처 실패:", err);
          });
        }
      }, 1000);
    }

    function drawGraph() {
      graphCtx.clearRect(0, 0, graphCanvas.width, graphCanvas.height);
      const max = Math.max(...gazeHistory, 1);
      const scaleY = graphCanvas.height / max;

      graphCtx.beginPath();
      for (let i = 0; i < gazeHistory.length; i++) {
        const x = (i / (gazeHistory.length - 1)) * graphCanvas.width;
        const y = graphCanvas.height - (gazeHistory[i] * scaleY);
        if (i === 0) graphCtx.moveTo(x, y);
        else graphCtx.lineTo(x, y);
      }

      graphCtx.strokeStyle = '#4a90e2';
      graphCtx.lineWidth = 2;
      graphCtx.stroke();

      graphCtx.fillStyle = '#666';
      graphCtx.font = '14px sans-serif';
      graphCtx.fillText('📈 시선 고정 시간 추이 (최근 1분)', 10, 20);
    }