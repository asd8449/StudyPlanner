// public/script.js

// 전역 변수 선언
var token = null;
var userId = null;
var socket = null;
var plans = [];

// 요일 및 시간 슬롯 정의
const days = ['일','월','화','수','목','금','토'];
const timeSlots = [];
for (let h = 0; h < 24; h++) {
  for (let m = 0; m < 60; m += 10) {
    timeSlots.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
  }
}

// 주 시작일(일요일) 계산
function getWeekStart(date) {
  const d = new Date(date);
  const diff = d.getDay();
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

// 주 내 특정 요일 날짜 문자열 (YYYY-MM-DD)
function getDateOfWeek(dayIndex) {
  const d = new Date(currentWeekStart);
  d.setDate(d.getDate() + dayIndex);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// API 호출 헬퍼
async function api(endpoint, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api/${endpoint}`, { ...opts, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// 전역: 현재 주 시작일
let currentWeekStart;

// 초기화 진입점
window.addEventListener('DOMContentLoaded', init);

async function init() {
  // DOM 요소
  const loginBox     = document.getElementById('loginBox');
  const signUpBox    = document.getElementById('signUpBox');
  const plannerApp   = document.getElementById('plannerApp');
  const showSignUp   = document.getElementById('showSignUp');
  const showLogin    = document.getElementById('showLogin');
  const loginBtn     = document.getElementById('loginBtn');
  const signBtn      = document.getElementById('signBtn');
  const logoutBtn    = document.getElementById('logoutBtn');
  const resetBtn     = document.getElementById('resetBtn');
  const bulkBtn      = document.getElementById('bulkBtn');
  const statusBtn    = document.getElementById('statusBtn');
  const plannerBody  = document.getElementById('plannerBody');

  const prevWeekBtn  = document.getElementById('prevWeekBtn');
  const nextWeekBtn  = document.getElementById('nextWeekBtn');
  const StudyMoniter = document.getElementById('StudyMoniter');
  const weekLabel    = document.getElementById('weekLabel');

  const modalOverlay = document.getElementById('modalOverlay');
  const mTitle       = document.getElementById('modalTitle');
  const planTitle    = document.getElementById('planTitle');
  const planNote     = document.getElementById('planNote');
  const planColor    = document.getElementById('planColor');
  const saveBtn      = document.getElementById('saveBtn');
  const deleteBtn    = document.getElementById('deleteBtn');
  const cancelBtn    = document.getElementById('cancelBtn');

  const bulkOverlay   = document.getElementById('bulkOverlay');
  const bulkDays      = document.getElementById('bulkDays');
  const bulkStart     = document.getElementById('bulkStart');
  const bulkEnd       = document.getElementById('bulkEnd');
  const bulkTitle     = document.getElementById('bulkTitle');
  const bulkNote      = document.getElementById('bulkNote');
  const bulkColor     = document.getElementById('bulkColor');
  const bulkSaveBtn   = document.getElementById('bulkSaveBtn');
  const bulkCancelBtn = document.getElementById('bulkCancelBtn');

  // 로그인/회원가입 토글
  showSignUp.onclick = e => { e.preventDefault(); loginBox.classList.add('hide'); signUpBox.classList.remove('hide'); };
  showLogin.onclick = e => { e.preventDefault(); signUpBox.classList.add('hide'); loginBox.classList.remove('hide'); };
  StudyMoniter.onclick = function(){
    window.location.href = 'http://localhost:5000/monitor.html'
  }

  // 주간 네비게이션 이벤트
  prevWeekBtn.onclick = async () => { currentWeekStart.setDate(currentWeekStart.getDate() - 7); await updateWeek(); };
  nextWeekBtn.onclick = async () => { currentWeekStart.setDate(currentWeekStart.getDate() + 7); await updateWeek(); };

  // 주 초기화 및 자동 로그인
  currentWeekStart = getWeekStart(new Date());
  const savedToken = localStorage.getItem('token');
  if (savedToken) {
    token = savedToken;
    userId = JSON.parse(atob(token.split('.')[1])).userId;
    loginBox.classList.add('hide');
    signUpBox.classList.add('hide');
    plannerApp.classList.remove('hide');
    connectSocket();
    await updateWeek();
  }

  // 회원가입
  signBtn.onclick = async () => {
    try {
      const { message } = await api('signup', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('signEmail').value.trim(),
          password: document.getElementById('signPwd').value
        })
      });
      alert(message);
      signUpBox.classList.add('hide');
      loginBox.classList.remove('hide');
    } catch (e) {
      alert(`회원가입 실패: ${e.message}`);
    }
  };

  // 로그인
  loginBtn.onclick = async () => {
    try {
      const { token: tkn } = await api('login', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('loginEmail').value.trim(),
          password: document.getElementById('loginPwd').value
        })
      });
      token = tkn;
      userId = JSON.parse(atob(token.split('.')[1])).userId;
      localStorage.setItem('token', token);

      loginBox.classList.add('hide');
      signUpBox.classList.add('hide');
      plannerApp.classList.remove('hide');

      connectSocket();
      await updateWeek();
    } catch (e) {
      alert(`로그인 실패: ${e.message}`);
    }
  };

  // 로그아웃
  logoutBtn.onclick = () => {
    token = null;
    userId = null;
    localStorage.removeItem('token');
    socket?.disconnect();
    plannerApp.classList.add('hide');
    loginBox.classList.remove('hide');
  };

  // Socket.IO 연결
  function connectSocket() {
    if (!token) return;
    if (socket) socket.disconnect();
    socket = io('http://localhost:5000', { auth: { token } });
    socket.on('alarm', data => {
      const when = new Date(data.time);
      const msg = `[${data.title}] ${String(when.getHours()).padStart(2,'0')}:${String(when.getMinutes()).padStart(2,'0')} 시간입니다!`;
      if (Notification.permission === 'granted') new Notification('스터디 알림', { body: msg });
      else alert(msg);
    });
  }

  // 주 업데이트
  async function updateWeek() {
    updateWeekLabel();
    updateDayHeaders();
    try {
    await loadPlanner();   // 일정 가져오기
    render();              // 일정 그리기
  } catch (err) {
   if (err.message === '인증 실패') {
     alert('로그인이 필요해요! 다시 로그인해 주세요.');
     localStorage.removeItem('token');  // 저장된 토큰 삭제
     location.reload();                  // 새로고침해서 init() → 로그인 화면
   } else {
     alert('오류가 생겼어요: ' + err.message);
   }
  }
  }

  function updateWeekLabel() {
    const s = currentWeekStart;
    const e = new Date(s);
    e.setDate(e.getDate() + 6);
    function fmt(d) { return `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
    weekLabel.textContent = `${fmt(s)} ~ ${fmt(e)}`;
  }

  function updateDayHeaders() {
    for (let i = 0; i < 7; i++) {
      const th = document.getElementById(`day${i}`);
      const dateStr = getDateOfWeek(i).slice(5).replace('-', '/');
      th.textContent = `${days[i]} ${dateStr}`;
    }
  }

  // 초기화 버튼
  resetBtn.onclick = async () => {
    if (!confirm('모든 일정을 삭제하고 초기화하시겠습니까?')) return;
    try {
      await api('plans', { method: 'DELETE' });
      plans = [];
      render();
      alert('초기화 완료');
    } catch (e) {
      alert(`초기화 실패: ${e.message}`);
    }
  };

  // 일괄 등록 (생략)
  bulkBtn.onclick = () => bulkOverlay.style.display = 'flex';
  bulkCancelBtn.onclick = () => bulkOverlay.style.display = 'none';
  bulkSaveBtn.onclick = async () => { /* ... */ render(); };

  // 강의실 현황
  statusBtn.onclick = async () => {
    try {
      const { userCount, noiseLevel } = await api('status');
      alert(`강의실 이용자 수: ${userCount}\n강의실 상태(소음): ${noiseLevel}`);
    } catch (e) {
      alert(`조회 실패: ${e.message}`);
    }
  };

  // 플랜 로드
  async function loadPlanner() {
    const data = await api('plans');
    plans = data.map(p => {
      const s = new Date(p.start_time), e = new Date(p.end_time);
      return {
        id: p.id,
        day: s.getDay(),
        date: s.toISOString().slice(0,10),
        start: `${String(s.getHours()).padStart(2,'0')}:${String(s.getMinutes()).padStart(2,'0')}`,
        end:   `${String(e.getHours()).padStart(2,'0')}:${String(e.getMinutes()).padStart(2,'0')}`,
        plannedDuration: Math.floor((e - s) / 60000),
        actualDuration: p.actual_duration || 0,
        entryTime: p.entry_time,
        exitTime: p.exit_time,
        title: p.title,
        note: p.description,
        color: p.color,
        isCompleted: p.is_completed
      };
    }).filter(pl => {
      const d = new Date(pl.date);
      return d >= currentWeekStart && d < new Date(currentWeekStart.getTime() + 7*24*60*60*1000);
    });
  }

  // 렌더링 및 셀 처리
  let isDown = false, selCells = [], editPlan = null;
  function render() {
    const now = new Date();
    plans.forEach(pl => {
      if (pl.entryTime && !pl.exitTime) {
        const entryDt = new Date(pl.entryTime);
        const endDt = new Date(`${pl.date}T${pl.end}:00`);
        const refTime = now < endDt ? now : endDt;
        const dur = Math.max(Math.floor((refTime - entryDt) / 60000), 0);
        pl.actualDuration = dur;
      }
    });

    plannerBody.innerHTML = '';
    timeSlots.forEach((t, rowIdx) => {
      const tr = document.createElement('tr');
      const tdTime = document.createElement('td'); tdTime.textContent = t; tr.appendChild(tdTime);
      days.forEach((_, dIdx) => {
        const pl = plans.find(x => x.day === dIdx && x.start === t);
        if (pl) {
          const td = document.createElement('td');
          td.rowSpan = Math.floor(pl.plannedDuration / 10) || 1;
          td.style.background = pl.color;
          td.innerHTML = `
            <div class="plan-cell">
              <div class="plan-title">${pl.title}</div>
              <div class="plan-time">${pl.start}–${pl.end}</div>
              <div class="plan-duration">${pl.actualDuration}분 / ${pl.plannedDuration}분</div>
              ${pl.isCompleted ? '<div class="plan-completed">✔️</div>' : ''}
            </div>
          `;
          td.onclick = e => { e.stopPropagation(); openModal(pl); };
          tr.appendChild(td);
        } else {
            const occupied = plans.some(x =>
            x.day === dIdx &&
            timeSlots.indexOf(x.start) < rowIdx &&
            rowIdx < timeSlots.indexOf(x.end)
          );
          if (!occupied) {
            const td = document.createElement('td');
            td.dataset.day = dIdx;
            td.dataset.time = t;
            td.onmousedown = () => { isDown = true; selCells = [td]; td.classList.add('cell-selected'); };
            td.onmouseover = () => { if (isDown) { selCells.push(td); td.classList.add('cell-selected'); } };
            td.onmouseup = endSelect;
            tr.appendChild(td);
          }
        }
      });
      plannerBody.appendChild(tr);
    });
  }

  document.body.onmouseup = () => { if (isDown) endSelect(); };
  function endSelect() { isDown = false; if (selCells.length) openModal(); }

  function openModal(p = null) {
    editPlan = p;
    if (p) {
      mTitle.textContent = '플랜 수정';
      planTitle.value   = p.title;
      planNote.value    = p.note;
      planColor.value   = p.color;
      deleteBtn.style.display = 'inline-block';
    } else {
      mTitle.textContent = '플랜 추가';
      planTitle.value   = '';
      planNote.value    = '';
      planColor.value   = '#87CEEB';
      deleteBtn.style.display = 'none';
    }
    modalOverlay.style.display = 'flex';
  }

  cancelBtn.onclick = () => {
    modalOverlay.style.display = 'none';
    selCells.forEach(td => td.classList.remove('cell-selected'));
    selCells = [];
    editPlan = null;
  };

  saveBtn.onclick = async () => {
    const title = planTitle.value.trim();
    if (!title) return alert('제목을 입력하세요.');

    const body = { title, description: planNote.value.trim(), color: planColor.value };
    if (editPlan) {
      const dateISO = getDateOfWeek(editPlan.day);
      body.start_time = `${dateISO}T${editPlan.start}:00`;
      body.end_time   = `${dateISO}T${editPlan.end}:00`;
      const p = await api(`plans/${editPlan.id}`, { method: 'PUT', body: JSON.stringify(body) });
      Object.assign(editPlan, { title: p.title, note: p.description, color: p.color });
    } else {
      const startTime = selCells[0].dataset.time;
      const lastTime  = selCells[selCells.length - 1].dataset.time;
      const day       = +selCells[0].dataset.day;
      const dateISO   = getDateOfWeek(day);
      const startDt = new Date(`${dateISO}T${startTime}:00`);
      const endDt   = new Date(`${dateISO}T${lastTime}:00`);
      endDt.setMinutes(endDt.getMinutes() + 10);
      body.start_time = `${dateISO}T${String(startDt.getHours()).padStart(2,'0')}:${String(startDt.getMinutes()).padStart(2,'0')}:00`;
      body.end_time   = `${dateISO}T${String(endDt.getHours()).padStart(2,'0')}:${String(endDt.getMinutes()).padStart(2,'0')}:00`;
      const p = await api('plans', { method: 'POST', body: JSON.stringify(body) });
      plans.push({
        id: p.id, day,
        date: dateISO,
        start: `${String(startDt.getHours()).padStart(2,'0')}:${String(startDt.getMinutes()).padStart(2,'0')}`,
        end:   `${String(endDt.getHours()).padStart(2,'0')}:${String(endDt.getMinutes()).padStart(2,'0')}`,
        plannedDuration: Math.floor((endDt - startDt) / 60000),
        actualDuration: p.actual_duration || 0,
        entryTime: p.entry_time,
        exitTime: p.exit_time,
        title: p.title,
        note:  p.description,
        color: p.color,
        isCompleted: p.is_completed
      });
    }
    cancelBtn.onclick();
    render();
  };

  deleteBtn.onclick = async () => {
    if (!editPlan) return;
    await api(`plans/${editPlan.id}`, { method: 'DELETE' });
    plans = plans.filter(x => x.id !== editPlan.id);
    cancelBtn.onclick();
    render();
  };

}
