// alarmService.js

async function sendScheduledAlarms() {
  // TODO: 실제로는 여기서 DB에서 알람 데이터를 꺼내서
  // 사용자에게 푸시 알림을 보내는 로직을 작성하세요.
  console.log("알람 전송! 현재 시간:", new Date().toLocaleString());
}

module.exports = { sendScheduledAlarms };
