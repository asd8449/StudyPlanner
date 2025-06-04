// server.js

require('dotenv').config();
const express    = require('express');
const bodyParser = require('body-parser');
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const { Sequelize, DataTypes, Op } = require('sequelize');
const schedule   = require('node-schedule');
const http       = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const app    = express();
const server = http.createServer(app);
const io     = require('socket.io')(server);

// 현재 강의실 입장자 관리 및 액세스 로그
const currentUsers = new Set();
let accessLogs     = [];
let noiseLevel     = '보통';

app.use(express.static('public'));
app.use(bodyParser.json());

// SQLite DB 설정
const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: process.env.DB_STORAGE || './plans.sqlite',
  logging: false
});

// User 모델
const User = sequelize.define('User', {
  email:       { type: DataTypes.STRING, unique: true },
  passwordHash:{ type: DataTypes.STRING },
  verified:    { type: DataTypes.BOOLEAN, defaultValue: false },
  verifyToken: { type: DataTypes.STRING, allowNull: true }
}, { timestamps: false });

// Plan 모델
const Plan = sequelize.define('Plan', {
  title:           { type: DataTypes.STRING,  allowNull: false },
  description:     { type: DataTypes.TEXT },
  start_time:      { type: DataTypes.DATE,    allowNull: false },
  end_time:        { type: DataTypes.DATE,    allowNull: false },
  entry_time:      { type: DataTypes.DATE,    allowNull: true },
  exit_time:       { type: DataTypes.DATE,    allowNull: true },
  actual_duration: { type: DataTypes.INTEGER, allowNull: true },
  color:           { type: DataTypes.STRING },
  is_completed:    { type: DataTypes.BOOLEAN, defaultValue: false },
  user_id:         { type: DataTypes.INTEGER, references: { model: User, key: 'id' } }
}, { timestamps: false });

const jobs = new Map();

// DB sync 및 기존 플랜 스케줄 복원
(async () => {
  await sequelize.sync();

  const allPlans = await Plan.findAll();
  for (const p of allPlans) {
    // 1) 시작 알림 스케줄
    const alarmJob = schedule.scheduleJob(p.start_time, () => {
      io.to(`user_${p.user_id}`).emit('alarm', {
        title: p.title,
        time:  p.start_time
      });
    });
    jobs.set(`alarm_${p.id}`, alarmJob);

    // 2) 플랜 시작 시점에 이미 입장한 사용자는 entry_time 세팅
    const entryJob = schedule.scheduleJob(p.start_time, async () => {
      const user = await User.findByPk(p.user_id);
      if (user && currentUsers.has(user.email)) {
        const plan = await Plan.findByPk(p.id);
        if (plan && !plan.entry_time) {
          plan.entry_time = p.start_time;
          await plan.save();
          io.to(`user_${plan.user_id}`).emit('planEntry', {
            planId:    plan.id,
            entryTime: plan.entry_time
          });
        }
      }
    });
    jobs.set(`entry_${p.id}`, entryJob);
  }
})();

// 이메일 전송 설정
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   +process.env.SMTP_PORT,
  secure: process.env.SMTP_SECURE === 'true',
  auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

// 1) 체크인 엔드포인트
app.post('/entry', async (req, res) => {
  const { email, timestamp } = req.body;
  if (!email || !timestamp) return res.status(400).send('Invalid data');

  // 현황 업데이트
  currentUsers.add(email);
  accessLogs.push({ email, timestamp });

  const checkTime = new Date(timestamp);
  const user = await User.findOne({ where: { email } });
  if (user) {
    // 진행 중인 플랜 전부 찾아 entry_time 기록
    const ongoingPlans = await Plan.findAll({
      where: {
        user_id:    user.id,
        start_time: { [Op.lte]: checkTime },
        end_time:   { [Op.gt]:  checkTime }
      }
    });
    for (const plan of ongoingPlans) {
      if (!plan.entry_time) {
        plan.entry_time = checkTime;
        await plan.save();
        io.to(`user_${user.id}`).emit('planEntry', {
          planId:    plan.id,
          entryTime: plan.entry_time
        });
      }
    }
  }

  res.send('Data received');
});

// 2) 체크아웃 엔드포인트
app.post('/exit', async (req, res) => {
  const { email, timestamp } = req.body;
  if (!email || !timestamp) return res.status(400).send('Invalid data');

  // 현황 업데이트
  currentUsers.delete(email);

  const exitTime = new Date(timestamp);
  const user = await User.findOne({ where: { email } });
  if (user) {
    const plan = await Plan.findOne({
      where: {
        user_id:    user.id,
        entry_time: { [Op.not]: null },
        exit_time:  null
      }
    });
    if (plan) {
      plan.exit_time      = exitTime;
      plan.actual_duration = Math.max(
        Math.floor((exitTime - plan.entry_time) / 60000), 0
      );
      plan.is_completed   = true;
      await plan.save();
      io.to(`user_${user.id}`).emit('planExit', {
        planId:         plan.id,
        actualDuration: plan.actual_duration
      });
    }
  }

  res.send('Exit recorded');
});

// 3) 소음 상태 업데이트
app.post('/api/data', (req, res) => {
  const { status } = req.body;
  if (typeof status !== 'string') {
    return res.status(400).json({ error: 'status 문자열을 보내주세요' });
  }
  noiseLevel = status;
  res.json({ success: true });
});

// 4) 강의실 현황 조회
app.get('/api/status', (req, res) => {
  res.json({
    userCount: currentUsers.size,
    noiseLevel
  });
});

// 5) 회원가입
app.post('/api/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email.toLowerCase().endsWith('@office.kopo.ac.kr')) {
    return res.status(400).json({ error: '허용되지 않은 도메인입니다' });
  }
  try {
    let user = await User.findOne({ where: { email } });
    if (user) {
      if (user.verified) {
        return res.status(409).json({ error: '이미 가입된 계정입니다' });
      }
      user.verifyToken = crypto.randomBytes(32).toString('hex');
      await user.save();
    } else {
      const hash = await bcrypt.hash(password, 12);
      user = await User.create({
        email,
        passwordHash: hash,
        verified: false,
        verifyToken: crypto.randomBytes(32).toString('hex')
      });
    }
    const url = `${req.protocol}://${req.get('host')}/api/verify?token=${user.verifyToken}`;
    await transporter.sendMail({
      from:    `"스터디 플래너" <${process.env.SMTP_FROM}>`,
      to:      email,
      subject: '이메일 인증을 완료해주세요',
      html:    `인증 링크: <a href="${url}">${url}</a>`
    });
    res.json({ message: '인증 메일을 전송했습니다' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 이메일 인증
app.get('/api/verify', async (req, res) => {
  try {
    const user = await User.findOne({ where: { verifyToken: req.query.token } });
    if (!user) return res.status(400).send('유효하지 않은 토큰입니다');
    user.verified    = true;
    user.verifyToken = null;
    await user.save();
    res.send('<h2>인증 완료!</h2><script>setTimeout(()=>window.close(),3000);</script>');
  } catch {
    res.status(500).send('인증 처리 실패');
  }
});

// 로그인
app.post('/api/login', async (req, res) => {
  try {
    const user = await User.findOne({ where: { email: req.body.email } });
    if (!user) return res.status(404).json({ error: '등록되지 않은 이메일' });
    if (!user.verified) return res.status(403).json({ error: '이메일 인증 필요' });
    const ok = await bcrypt.compare(req.body.password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: '잘못된 비밀번호' });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 인증 미들웨어
function auth(req, res, next) {
  try {
    const tok     = req.headers.authorization.split(' ')[1];
    const payload = jwt.verify(tok, process.env.JWT_SECRET);
    req.userId    = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: '인증 실패' });
  }
}

// 플랜 CRUD
app.get('/api/plans', auth, async (req, res) => {
  const list = await Plan.findAll({ where: { user_id: req.userId } });
  res.json(list);
});

app.post('/api/plans', auth, async (req, res) => {
  try {
    const { title, description, start_time, end_time, color } = req.body;
    const p = await Plan.create({
      user_id:     req.userId,
      title, description, start_time, end_time, color
    });
    // 알림 스케줄
    const alarmJob = schedule.scheduleJob(p.start_time, () => {
      io.to(`user_${p.user_id}`).emit('alarm', {
        title: p.title,
        time:  p.start_time
      });
    });
    jobs.set(`alarm_${p.id}`, alarmJob);
    // 시작 시 entry_time 자동 설정 스케줄
    const entryJob = schedule.scheduleJob(p.start_time, async () => {
      const user = await User.findByPk(p.user_id);
      if (user && currentUsers.has(user.email)) {
        const plan = await Plan.findByPk(p.id);
        if (plan && !plan.entry_time) {
          plan.entry_time = p.start_time;
          await plan.save();
          io.to(`user_${plan.user_id}`).emit('planEntry', {
            planId:    plan.id,
            entryTime: plan.entry_time
          });
        }
      }
    });
    jobs.set(`entry_${p.id}`, entryJob);

    res.status(201).json(p);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/plans/:id', auth, async (req, res) => {
  try {
    const p = await Plan.findOne({ where: { id: req.params.id, user_id: req.userId } });
    if (!p) return res.status(404).json({ error: '플랜 없음' });
    const { title, description, start_time, end_time, color } = req.body;
    Object.assign(p, { title, description, start_time, end_time, color });
    await p.save();
    // 기존 jobs 삭제 후 재등록
    jobs.get(`alarm_${p.id}`)?.cancel();
    jobs.get(`entry_${p.id}`)?.cancel();
    const alarmJob = schedule.scheduleJob(p.start_time, () => {
      io.to(`user_${p.user_id}`).emit('alarm', { title: p.title, time: p.start_time });
    });
    const entryJob = schedule.scheduleJob(p.start_time, async () => {
      const user = await User.findByPk(p.user_id);
      if (user && currentUsers.has(user.email)) {
        const plan = await Plan.findByPk(p.id);
        if (plan && !plan.entry_time) {
          plan.entry_time = p.start_time;
          await plan.save();
          io.to(`user_${plan.user_id}`).emit('planEntry', {
            planId:    plan.id,
            entryTime: plan.entry_time
          });
        }
      }
    });
    jobs.set(`alarm_${p.id}`, alarmJob);
    jobs.set(`entry_${p.id}`, entryJob);
    res.json(p);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/plans/:id', auth, async (req, res) => {
  try {
    const p = await Plan.findOne({ where: { id: req.params.id, user_id: req.userId } });
    if (!p) return res.status(404).json({ error: '플랜 없음' });
    jobs.get(`alarm_${p.id}`)?.cancel();
    jobs.get(`entry_${p.id}`)?.cancel();
    jobs.delete(`alarm_${p.id}`);
    jobs.delete(`entry_${p.id}`);
    await p.destroy();
    res.json({ message: '삭제됨' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/plans', auth, async (req, res) => {
  try {
    const plans = await Plan.findAll({ where: { user_id: req.userId } });
    for (const p of plans) {
      jobs.get(`alarm_${p.id}`)?.cancel();
      jobs.get(`entry_${p.id}`)?.cancel();
      jobs.delete(`alarm_${p.id}`);
      jobs.delete(`entry_${p.id}`);
    }
    await Plan.destroy({ where: { user_id: req.userId } });
    res.json({ message: '전체 삭제됨' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Socket.IO 인증 및 연결
io.use((socket, next) => {
  try {
    const tok     = socket.handshake.auth.token;
    const payload = jwt.verify(tok, process.env.JWT_SECRET);
    socket.userId = payload.userId;
    next();
  } catch {
    next(new Error('인증 실패'));
  }
});
io.on('connection', socket => {
  socket.join(`user_${socket.userId}`);
});

if (process.env.NODE_ENV !== 'test') {
  // Python 스크립트 실행
  const pyProc = spawn('python', ['gaze_blink.py']);
  pyProc.stdout.setEncoding('utf8');
  pyProc.stderr.setEncoding('utf8');
  pyProc.stderr.on('data', data => console.error('PY ERR:', data));

  let pyBuffer = '';

  // 기존 Express + Socket.IO 설정 바로 아래에 붙이기
  // → server 변수는 이미 `const server = http.createServer(app);` 로 존재합니다.
  const wss = new WebSocket.Server({ server, path: '/monitor_ws' });

  wss.on('connection', ws => {
    console.log('Monitor 클라이언트 접속됨');

    ws.on('message', msg => {
      // 클라이언트(브라우저)에서 보낸 프레임(base64) 받아서 Python에 전달
      const data = JSON.parse(msg);
      if (data.type === 'frame') {
        pyProc.stdin.write(data.webcam + '\n');
      }
    });

    // Python이 stdout에 찍는 JSON 결과를 그대로 클라이언트에 보낸다
    pyProc.stdout.on('data', chunk => {
      pyBuffer += chunk;
      const lines = pyBuffer.split('\n');
      pyBuffer = lines.pop();  // 마지막은 불완전할 수 있으니 버퍼에 남겨둠

      lines.forEach(line => {
        if (!line) return;
        try {
          const result = JSON.parse(line);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(result));
          }
        } catch (e) {
          console.error('Python → JSON 파싱 실패:', e);
        }
      });
    });

    ws.on('close', () => console.log('Monitor 클라이언트 연결 끊김'));
  });
}

// 서버 시작
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => {
    console.log(`서버 실행 중: http://localhost:${PORT}`);
  });
}

module.exports = { app, sequelize, User, Plan };

