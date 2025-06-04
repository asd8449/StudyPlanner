// app.js (중략)
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const { sendScheduledAlarms } = require("./alarmService");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));     // ← public 폴더를 정적 제공

// cron 스케줄러
cron.schedule("0 * * * *", () => {
  console.log("[Cron] 알람 전송:", new Date().toLocaleString());
  sendScheduledAlarms().catch(console.error);
});

// 테스트 엔드포인트
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

// 서버 시작
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
