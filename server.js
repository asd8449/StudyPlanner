// server.js

require('dotenv').config();
const express    = require('express');
const bodyParser = require('body-parser');
const Tesseract = require('tesseract.js');
const multer = require('multer');
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const { Sequelize, DataTypes, Op } = require('sequelize');
const schedule   = require('node-schedule');
const http       = require('http');
const WebSocket  = require('ws');
const { spawn }  = require('child_process');
const path       = require('path'); // << [수정] path 모듈 추가
const fs = require('fs');
const https = require('https');


// 환경변수
const SSL_KEY_PATH  = process.env.SSL_KEY_PATH;
const SSL_CERT_PATH = process.env.SSL_CERT_PATH;
// SSL 인증서 로드
const privateKey  = fs.readFileSync(SSL_KEY_PATH, 'utf8');
const certificate = fs.readFileSync(SSL_CERT_PATH, 'utf8');
const credentials = { key: privateKey, cert: certificate };

const PYTHON_PATH = "C:\\Users\\User\\anaconda3\\envs\\teamproject\\python.exe";

const app    = express();
const server = https.createServer(credentials, app);
const io     = require('socket.io')(server);
const upload = multer({ dest: 'uploads/' });

const currentUsers = new Set();
let accessLogs   = [];
let noiseLevel   = '보통';

app.use(express.static('public'));
app.use(bodyParser.json());

// << [수정] 루트 경로 접속 시 index.html 제공하는 코드 추가
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// SQLite DB 설정
const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: './plans.sqlite',
  logging: false
});

// User 모델
const User = sequelize.define('User', {
  email:       { type: DataTypes.STRING, unique: true },
  passwordHash:{ type: DataTypes.STRING },
  name:        { type: DataTypes.STRING },
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
    if (new Date(p.start_time) > new Date()) {
      const alarmJob = schedule.scheduleJob(p.start_time, () => {
        io.to(`user_${p.user_id}`).emit('alarm', {
          title: p.title,
          time:  p.start_time
        });
      });
      jobs.set(`alarm_${p.id}`, alarmJob);
    }

    // 2) 플랜 시작 시점에 이미 입장한 사용자는 entry_time 세팅
    if (new Date(p.start_time) > new Date()) {
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

  currentUsers.add(email);
  accessLogs.push({ email, timestamp });

  const checkTime = new Date(timestamp);
  const user = await User.findOne({ where: { email } });
  if (user) {
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

  currentUsers.delete(email);

  const exitTime = new Date(timestamp);
  const user = await User.findOne({ where: { email } });
  if (user) {
    const plan = await Plan.findOne({
      where: {
        user_id:    user.id,
        entry_time: { [Op.not]: null },
        exit_time:  null
      },
      order: [['start_time', 'DESC']] // 가장 최근에 시작한 플랜을 대상으로
    });
    if (plan) {
      plan.exit_time       = exitTime;
      plan.actual_duration = Math.max(
        Math.floor((exitTime - plan.entry_time) / 60000), 0
      );
      plan.is_completed    = true;
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
app.get('/api/status', auth, (req, res) => { // 'auth' 미들웨어 추가
  res.json({
    userCount: currentUsers.size,
    noiseLevel
  });
});

// 5) 회원가입
app.post('/api/signup', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: '이메일과 비밀번호를 모두 입력해야 합니다.' });
    }
    if (!email.toLowerCase().endsWith('@office.kopo.ac.kr')) {
        return res.status(400).json({ error: '허용되지 않은 도메인입니다.' });
    }
    try {
        let user = await User.findOne({ where: { email } });
        if (user && user.verified) {
            return res.status(409).json({ error: '이미 가입된 계정입니다.' });
        }
        
        const verifyToken = crypto.randomBytes(32).toString('hex');
        
        if (user) { // 미인증 사용자 정보 업데이트
            user.passwordHash = await bcrypt.hash(password, 12);
            user.verifyToken = verifyToken;
            await user.save();
        } else { // 신규 사용자 생성
            const hash = await bcrypt.hash(password, 12);
            user = await User.create({
                email,
                passwordHash: hash,
                verified: false,
                verifyToken: verifyToken
            });
        }
        
        const url = `${req.protocol}://${req.get('host')}/api/verify?token=${user.verifyToken}`;
        await transporter.sendMail({
            from:    `"스터디 플래너" <${process.env.SMTP_FROM}>`,
            to:      email,
            subject: '이메일 인증을 완료해주세요',
            html:    `인증 링크: <a href="${url}">${url}</a>`
        });
        res.json({ message: '인증 메일을 전송했습니다. 메일 확인 후 로그인해주세요.' });

    } catch (err) {
        console.error('Signup Error:', err);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
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
    res.send('<h2>인증 완료!</h2><p>3초 후에 이 창은 자동으로 닫힙니다.</p><script>setTimeout(()=>window.close(),3000);</script>');
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
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: '인증 토큰이 없습니다.' });
    }
    const tok     = authHeader.split(' ')[1];
    const payload = jwt.verify(tok, process.env.JWT_SECRET);
    req.userId    = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: '인증 실패' });
  }
}

// 플랜 CRUD
app.get('/api/plans', auth, async (req, res) => {
  const list = await Plan.findAll({ where: { user_id: req.userId }, order: [['start_time', 'ASC']] });
  res.json(list);
});

app.post('/api/plans', auth, async (req, res) => {
  try {
    const { title, description, start_time, end_time, color } = req.body;
    const p = await Plan.create({
      user_id: req.userId,
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

// Python 스크립트 실행
const pyProc = spawn(PYTHON_PATH, ['-u', 'gaze_blink.py']); // '-u' for unbuffered output
pyProc.stdout.setEncoding('utf8');
pyProc.stderr.setEncoding('utf8');

pyProc.stdout.on('data', data => {
    // Python에서 오는 데이터 처리 로직은 wss.on('connection', ...) 안으로 이동
});
pyProc.stderr.on('data', data => console.error('PY ERR:', data));
pyProc.on('close', (code) => console.log(`Python process exited with code ${code}`));


// WebSocket 서버 (모니터링용)
const wss = new WebSocket.Server({ server, path: '/monitor_ws' });

wss.on('connection', ws => {
  console.log('Monitor 클라이언트 접속됨');
  
  const forwardPyOutput = (data) => {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
      if (!line.trim()) return;
      try {
        const result = JSON.parse(line);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(result));
        }
      } catch (e) {
        // console.error('Python → JSON 파싱 실패:', line, e);
      }
    });
  };

  pyProc.stdout.on('data', forwardPyOutput);

  ws.on('message', msg => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'frame' && typeof data.webcam === 'string') {
        pyProc.stdin.write(data.webcam + '\n');
      }
    } catch (e) {
      console.error('클라이언트 frame 메시지 파싱 오류:', e);
    }
  });

  ws.on('close', () => {
    console.log('Monitor 클라이언트 연결 끊김');
    pyProc.stdout.removeListener('data', forwardPyOutput); // 리스너 제거
  });
});

// OCR 키워드 정의
const DISTRACTION_KEYWORDS = [
    'youtube', '유튜브', '나무위키', '웹툰', '넷플릭스', 'netflix', '틱톡', 'tiktok',
    '게임', 'game', '롤', '리그오브레전드', 'lol', '배틀그라운드', '오버워치',
    '페이스북', 'facebook', '인스타', 'instagram', '트위터', 'twitter',
    '카카오톡', '카톡', '밴드', 'discord', '디스코드',
    '쇼핑', '쿠팡', '배달', '배달의민족',
    '음악', 'spotify', '팟캐스트'
];

const SUBJECT_KEYWORDS = {
    'Java': [
        'java', '자바', 'javaproject', 'javastudy', 'javacode', 'javaclass', '자바기초', '자바공부', '자바수업', 'javapractice',
        'javadev', 'javadevtools', 'jvm', 'javacs', 'javaprogramming', 'class',
    ],
    'Web Programming': [
        'web', '웹', 'html', 'css', 'javascript', 'js', 'vue', 'react', 'nextjs', 'nodejs', 'express', '웹프로그래밍', '프론트엔드',
        '백엔드', 'front', 'backend', '웹개발', '웹사이트', '웹코딩', 'fullstack', '웹기초', '웹수업', 'ajax', 'api', '웹페이지',
        '웹디자인', '웹서버', '웹서버구축', 'jsp', 'spring', 'mvc', 'xml'
    ],
    'Algorithm': [
        'algorithm', '알고리즘', 'problem solving', 'ps', '백준', 'baekjoon', 'boj', '프로그래머스', 'programmers',
        'leetcode', '코테', '코딩테스트', 'codeforces', '알고리즘기초', '문제풀이', '정렬', '탐색', 'dfs', 'bfs',
        'dynamic', 'dp', 'greedy', 'graph', '자료구조', 'stack', 'queue', '알고문제', '알고리즘스터디', '코딩', '코딩기초', 'coding'
    ],
    'Deep Learning': [
        'deeplearning', 'deep learning', '딥러닝', '인공지능', 'ai', 'tensorflow', 'keras', 'pytorch', 'ml', 'machinelearning',
        '머신러닝', '학습모델', '신경망', 'cnn', 'rnn', 'transformer', 'resnet', 'yolo', 'objectdetection', '이미지분류',
        '자연어처리', 'nlp', 'bert', '인공신경망', '딥러닝기초', '딥러닝모델', '강화학습', 'reinfocementlearning', '예측', '모델'
    ],
    '비학습': DISTRACTION_KEYWORDS
};

function inferSubject(text) {
    const compactText = text.replace(/\s/g, '').toLowerCase();

    const scores = {};
    const matchedKeywords = {};
    const WEIGHTS = {
        Java: 1.2,
        'Web Programming': 1.1,
        Algorithm: 1.3,
        'Deep Learning': 1.0,
        '비학습': 1.0
    };

    for (const subject of Object.keys(SUBJECT_KEYWORDS)) {
        scores[subject] = 0;
        matchedKeywords[subject] = new Set();
    }

    for (const [subject, keywords] of Object.entries(SUBJECT_KEYWORDS)) {
        for (const keyword of keywords) {
            const keywordNoSpace = keyword.replace(/\s/g, '').toLowerCase();
            let index = 0;
            while ((index = compactText.indexOf(keywordNoSpace, index)) !== -1) {
                scores[subject] += WEIGHTS[subject] || 1;
                matchedKeywords[subject].add(keyword);
                index += keywordNoSpace.length;
            }
        }
    }

    // 강제 분류 키워드
    const forceJavaIndicators = ['@springbootapplication', 'publicstaticvoidmain', 'maincontrollerjava', '.java', 'springframework'];
    const forceWebIndicators = ['.html', '.css', 'vue', 'react', 'express'];

    for (const kw of forceJavaIndicators) {
        if (compactText.includes(kw)) {
            return { subject: 'Java', keywords: Array.from(matchedKeywords['Java']) };
        }
    }
    for (const kw of forceWebIndicators) {
        if (compactText.includes(kw)) {
            return { subject: 'Web Programming', keywords: Array.from(matchedKeywords['Web Programming']) };
        }
    }

    const maxScore = Math.max(...Object.values(scores));
    if (maxScore === 0) return { subject: '기타', keywords: [] };

    const topSubject = Object.entries(scores).find(([_, score]) => score === maxScore)[0];
    return { subject: topSubject, keywords: Array.from(matchedKeywords[topSubject]) };
}

app.use(express.json());

app.get('/keywords', (req, res) => {
    const keywords = Object.values(SUBJECT_KEYWORDS).flat();
    res.json({ keywords });
});

app.post('/upload', upload.single('file'), async (req, res) => {
    const { username, timestamp } = req.body;
    const filePath = req.file.path;

    if (!username || !timestamp) {
        // 파일 삭제는 finally 블록에서 처리
        return res.status(400).json({ error: 'username and timestamp required' });
    }

    try {
        // 1) OCR 수행
        const { data: { text } } = await Tesseract.recognize(filePath, 'eng+kor');

        // 2) 과목·키워드 매핑
        const { subject, keywords } = inferSubject(text);

        // 3) 콘솔 출력
        console.log(`[${username} @ ${timestamp}] OCR →`, text.trim());
        console.log(`과목 매핑 결과: ${subject}, 매칭된 키워드: ${keywords.join(', ')}`);

        // 4) Socket.IO를 통해 모든 연결된 monitor 클라이언트에게 OCR 결과 푸시
        // `ocrResult` 이벤트를 사용하며, OCR 결과 데이터를 객체로 전송
        io.emit('ocrResult', {
            username: username,
            timestamp: timestamp,
            ocrText: text.trim(),
            subject: subject,
            keywords: keywords
        });

        // 5) CSV 저장
        const safeText = text.replace(/"/g, '""').trim();
        const logDir = path.join(__dirname, 'collect_data');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

        const fileName = `${username}.csv`;
        const filePathCSV = path.join(logDir, fileName);
        const line = `"${timestamp}","${subject}","${safeText}"\n`;

        if (!fs.existsSync(filePathCSV)) {
            fs.writeFileSync(filePathCSV, '\uFEFF"timestamp","subject","text"\n', { encoding: 'utf8' });
        }
        // 비동기 fs.appendFile 사용 권장 (현재는 동기)
        fs.appendFileSync(filePathCSV, line, { encoding: 'utf8' });

        return res.json({ message: 'OCR 및 저장 완료', subject, keywords, text: safeText });

    } catch (error) {
        console.error('OCR 실패:', error);
        return res.status(500).json({ error: 'OCR 실패' });
    } finally {
        // 업로드된 파일 삭제
        fs.unlink(filePath, (err) => {
            if (err) console.error('임시 파일 삭제 실패:', err);
        });
    }
});

// /latest-result 엔드포인트는 Socket.IO로 대체되었으므로 필요 없으나,
// 혹시 모를 외부 사용을 위해 남겨두려면 최신 값을 DB에 저장하거나
// Redis 같은 휘발성 스토리지에 저장 후 가져와야 함.
// 현재는 전역변수 대신 Socket.IO 푸시를 사용하므로 이 엔드포인트는 제거됨.


app.get('/report/:username', (req, res) => {
    const username = req.params.username;
    const csvPath = path.join(__dirname, 'collect_data', `${username}.csv`);

    if (!fs.existsSync(csvPath)) {
        return res.status(404).json({ error: '데이터 없음' });
    }

    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.trim().split('\n').slice(1);

    const subjectCount = {};
    lines.forEach(line => {
        const parts = line.split('","');
        const subject = parts[1]?.replace(/"/g, '');
        if (subject) {
            subjectCount[subject] = (subjectCount[subject] || 0) + 1;
        }
    });

    const total = lines.length;
    res.json({ username, total, subjectCount });
});

// 중앙 집중식 오류 처리 미들웨어 (모든 try-catch 블록 다음 또는 마지막에 추가)
app.use((err, req, res, next) => {
    console.error(err.stack); // 스택 트레이스 로깅 (개발 시 유용)
    res.status(500).json({ error: 'Internal Server Error' });
});


// 서버 시작
const PORT = process.env.HTTPS_PORT || process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`서버 실행 중: https://localhost:${PORT}`);
});