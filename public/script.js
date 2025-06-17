// 전역 변수 선언
var token = null;
var userId = null;
var socket = null;
var plans = [];

// 요일 및 시간 슬롯 정의
const days = ['일', '월', '화', '수', '목', '금', '토'];
const timeSlots = [];
for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 10) {
        timeSlots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
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
let currentWeekStart; // getDateOfWeek에서 사용하므로 전역 스코프에 유지
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
    const currentToken = localStorage.getItem('token');
    if (currentToken) {
        headers.Authorization = `Bearer ${currentToken}`;
    }
    const res = await fetch(`/api/${endpoint}`, { ...opts, headers });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || res.statusText);
    }
    // DELETE 요청 등 내용이 없는 성공 응답 처리
    const contentType = res.headers.get("content-type");
    if (contentType && contentType.indexOf("application/json") !== -1) {
        return res.json();
    }
    return {}; 
}


// 초기화 진입점
window.addEventListener('DOMContentLoaded', init);

function init() {
    const path = window.location.pathname;

    // 1. 플래너 페이지일 경우
    if (path.includes('planner.html')) {
        token = localStorage.getItem('token');
        if (!token) {
            window.location.replace('/login.html');
            return;
        }
        userId = JSON.parse(atob(token.split('.')[1])).userId;
        initializePlanner();
    }
    // 2. 로그인 페이지일 경우
    else if (path.includes('login.html')) {
        // [수정] 다른 계정 로그인을 위해 기존 토큰 삭제
        localStorage.removeItem('token'); 
        initializeLogin();
    }
    // 3. 회원가입 페이지일 경우
    else if (path.includes('signup.html')) {
        initializeSignUp();
    }
    // 4. 인덱스 페이지나 다른 페이지는 그냥 둠 (인라인 스크립트가 처리)
}


// 로그인 페이지 기능 초기화
function initializeLogin() {
    const loginBtn = document.getElementById('loginBtn');
    if (!loginBtn) return;

    loginBtn.onclick = async () => {
        try {
            const email = document.getElementById('loginEmail').value.trim();
            const password = document.getElementById('loginPwd').value;
            if (!email || !password) {
                return alert('이메일과 비밀번호를 모두 입력하세요.');
            }
            const { token: tkn } = await api('login', {
                method: 'POST',
                body: JSON.stringify({ email, password })
            });
            localStorage.setItem('token', tkn);
            window.location.replace('/planner.html');
        } catch (e) {
            alert(`로그인 실패: ${e.message}`);
        }
    };
}

// 회원가입 페이지 기능 초기화
function initializeSignUp() {
    const signBtn = document.getElementById('signBtn');
    if (!signBtn) return;

    signBtn.onclick = async () => {
        try {
            const email = document.getElementById('signEmail').value.trim();
            const password = document.getElementById('signPwd').value;
            if (!email || !password) {
                return alert('이메일과 비밀번호를 모두 입력하세요.');
            }
            const { message } = await api('signup', {
                method: 'POST',
                body: JSON.stringify({ email, password })
            });
            alert(message || '인증 메일을 전송했습니다. 확인 후 로그인해주세요.');
            window.location.replace('/login.html');
        } catch (e) {
            alert(`회원가입 실패: ${e.message}`);
        }
    };
}

// 플래너 페이지 기능 초기화
async function initializePlanner() {
    const logoutBtn    = document.getElementById('logoutBtn');
    const resetBtn     = document.getElementById('resetBtn');
    const bulkBtn      = document.getElementById('bulkBtn');
    const statusBtn    = document.getElementById('statusBtn');
    const prevWeekBtn  = document.getElementById('prevWeekBtn');
    const nextWeekBtn  = document.getElementById('nextWeekBtn');
    const StudyMoniter = document.getElementById('StudyMoniter');
    
    // 모달 관련 요소들
    const modalOverlay = document.getElementById('modalOverlay');
    const cancelBtn    = document.getElementById('cancelBtn');
    const saveBtn      = document.getElementById('saveBtn');
    const deleteBtn    = document.getElementById('deleteBtn');
    
    // 일괄등록 모달 관련 요소들
    const bulkOverlay   = document.getElementById('bulkOverlay');
    const bulkCancelBtn = document.getElementById('bulkCancelBtn');
    const bulkSaveBtn   = document.getElementById('bulkSaveBtn');

    if (!logoutBtn) return; // 플래너 페이지 요소가 없으면 실행 중단

    StudyMoniter.onclick = function () {
        window.open('monitor.html', '_blank');
    }

    prevWeekBtn.onclick = async () => { currentWeekStart.setDate(currentWeekStart.getDate() - 7); await updateWeek(); };
    nextWeekBtn.onclick = async () => { currentWeekStart.setDate(currentWeekStart.getDate() + 7); await updateWeek(); };

    logoutBtn.onclick = () => {
        localStorage.removeItem('token');
        socket?.disconnect();
        window.location.replace('/login.html');
    };
    
    connectSocket();

    resetBtn.onclick = async () => {
        if (!confirm('현재 사용자의 모든 일정을 삭제하고 초기화하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return;
        try {
            // 이 기능은 아직 백엔드에 구현되지 않았습니다.
            // 만약 구현한다면 아래와 같이 호출할 수 있습니다.
            // await api('plans/all', { method: 'DELETE' });
            alert('초기화 기능이 구현될 예정입니다.');
            // plans = [];
            // render();
        } catch (e) {
            alert(`초기화 실패: ${e.message}`);
        }
    };
    
    bulkBtn.onclick = () => bulkOverlay.style.display = 'flex';
    bulkCancelBtn.onclick = () => bulkOverlay.style.display = 'none';
    bulkSaveBtn.onclick = async () => { 
        alert('일괄 등록 기능이 구현될 예정입니다.');
        bulkOverlay.style.display = 'none';
    };

    statusBtn.onclick = async () => {
        try {
            const { userCount, noiseLevel } = await api('status');
            alert(`강의실 이용자 수: ${userCount}\n강의실 상태(소음): ${noiseLevel}`);
        } catch (e) {
            alert(`조회 실패: ${e.message}`);
        }
    };

    cancelBtn.onclick = () => {
        modalOverlay.style.display = 'none';
        selCells.forEach(td => td.classList.remove('cell-selected'));
        selCells = [];
        editPlan = null;
    };

    saveBtn.onclick = async () => {
        const planTitleEl = document.getElementById('planTitle');
        const planNoteEl = document.getElementById('planNote');
        const planColorEl = document.getElementById('planColor');

        const title = planTitleEl.value.trim();
        if (!title) return alert('제목을 입력하세요.');

        const body = { title, description: planNoteEl.value.trim(), color: planColorEl.value };
        try {
            if (editPlan) { // 수정
                const dateISO = getDateOfWeek(editPlan.day);
                body.start_time = `${dateISO}T${editPlan.start}:00`;
                body.end_time = `${dateISO}T${editPlan.end}:00`;
                const p = await api(`plans/${editPlan.id}`, { method: 'PUT', body: JSON.stringify(body) });
                Object.assign(editPlan, { title: p.title, note: p.description, color: p.color });
            } else { // 새로 만들기
                const startTime = selCells[0].dataset.time;
                const lastTime = selCells[selCells.length - 1].dataset.time;
                const day = +selCells[0].dataset.day;
                const dateISO = getDateOfWeek(day);
                const startDt = new Date(`${dateISO}T${startTime}:00`);
                const endDt = new Date(`${dateISO}T${lastTime}:00`);
                endDt.setMinutes(endDt.getMinutes() + 10);

                body.start_time = `${dateISO}T${String(startDt.getHours()).padStart(2, '0')}:${String(startDt.getMinutes()).padStart(2, '0')}:00`;
                body.end_time = `${dateISO}T${String(endDt.getHours()).padStart(2, '0')}:${String(endDt.getMinutes()).padStart(2, '0')}:00`;
                const p = await api('plans', { method: 'POST', body: JSON.stringify(body) });
                
                await updateWeek(); // [수정] 전체 데이터를 다시 불러와서 렌더링
            }
            cancelBtn.onclick();
            render();
        } catch (e) {
            alert(`저장 실패: ${e.message}`);
        }
    };

    deleteBtn.onclick = async () => {
        if (!editPlan || !confirm('정말로 이 플랜을 삭제하시겠습니까?')) return;
        try {
            await api(`plans/${editPlan.id}`, { method: 'DELETE' });
            await updateWeek(); // [수정] 전체 데이터를 다시 불러와서 렌더링
            cancelBtn.onclick();
        } catch (e) {
            alert(`삭제 실패: ${e.message}`);
        }
    };

    currentWeekStart = getWeekStart(new Date());
    await updateWeek();
}


// Socket.IO 연결
function connectSocket() {
    if (!localStorage.getItem('token')) return;
    if (socket) socket.disconnect();
    socket = io({ auth: { token: localStorage.getItem('token') } });
    socket.on('alarm', data => {
        const when = new Date(data.time);
        const msg = `[${data.title}] ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')} 시간입니다!`;
        if (Notification.permission === 'granted') {
            new Notification('스터디 알림', { body: msg });
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then(permission => {
                if (permission === 'granted') {
                    new Notification('스터디 알림', { body: msg });
                }
            });
        }
    });
    // planEntry, planExit 이벤트 수신 시 UI 업데이트
    socket.on('planEntry', () => updateWeek());
    socket.on('planExit', () => updateWeek());
}


// 주 업데이트
async function updateWeek() {
    updateWeekLabel();
    updateDayHeaders();
    try {
        await loadPlanner();
        render();
    } catch (err) {
        if (err.message === '인증 실패') {
            alert('세션이 만료되었거나 유효하지 않습니다. 다시 로그인해 주세요.');
            localStorage.removeItem('token');
            window.location.replace('/login.html');
        } else {
            alert('데이터 로딩 중 오류가 발생했습니다: ' + err.message);
        }
    }
}

function updateWeekLabel() {
    const s = currentWeekStart;
    const e = new Date(s);
    e.setDate(e.getDate() + 6);
    function fmt(d) { return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
    const weekLabel = document.getElementById('weekLabel');
    if (weekLabel) weekLabel.textContent = `${fmt(s)} ~ ${fmt(e)}`;
}

function updateDayHeaders() {
    for (let i = 0; i < 7; i++) {
        const th = document.getElementById(`day${i}`);
        if (th) {
            const dateStr = getDateOfWeek(i).slice(5).replace('-', '/');
            th.textContent = `${days[i]} ${dateStr}`;
        }
    }
}

// 플랜 로드
async function loadPlanner() {
    const data = await api('plans');
    const endOfWeek = new Date(currentWeekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    plans = data.map(p => {
        const s = new Date(p.start_time);
        const e = new Date(p.end_time);
        return {
            id: p.id,
            day: s.getDay(),
            date: s.toISOString().slice(0, 10),
            start: `${String(s.getHours()).padStart(2, '0')}:${String(s.getMinutes()).padStart(2, '0')}`,
            end: `${String(e.getHours()).padStart(2, '0')}:${String(e.getMinutes()).padStart(2, '0')}`,
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
        d.setHours(0,0,0,0);
        return d >= currentWeekStart && d < endOfWeek;
    });
}


// 렌더링 및 셀 처리
let isDown = false, selCells = [], editPlan = null;
function render() {
    const plannerBody = document.getElementById('plannerBody');
    if (!plannerBody) return;

    const now = new Date();
    plans.forEach(pl => {
        if (pl.entryTime && !pl.exitTime) {
            const entryDt = new Date(pl.entryTime);
            let endDt = new Date(pl.exit_time || `${pl.date}T${pl.end}:00`);
            const refTime = now < endDt ? now : endDt;
            const dur = Math.max(Math.floor((refTime - entryDt) / 60000), 0);
            pl.actualDuration = dur;
        }
    });

    plannerBody.innerHTML = '';
    timeSlots.forEach((t, rowIdx) => {
        const tr = document.createElement('tr');
        const tdTime = document.createElement('td');
        tdTime.textContent = t;
        tr.appendChild(tdTime);
        days.forEach((_, dIdx) => {
            const pl = plans.find(x => x.day === dIdx && x.start === t);
            if (pl) {
                const td = document.createElement('td');
                td.rowSpan = Math.floor(pl.plannedDuration / 10) || 1;
                td.style.background = pl.color;
                td.innerHTML = `
                    <div class="plan-cell position-relative">
                        <div class="plan-title">${pl.title}</div>
                        <div class="plan-time">${pl.start}–${pl.end}</div>
                        <div class="plan-duration">${pl.actualDuration}분 / ${pl.plannedDuration}분</div>
                        ${pl.isCompleted ? '<div class="plan-completed">✔️</div>' : ''}
                    </div>
                `;
                td.onclick = e => { e.stopPropagation(); openModal(pl); };
                tr.appendChild(td);
            } else {
                const occupied = plans.some(x => {
                    const startIndex = timeSlots.indexOf(x.start);
                    const endIndex = timeSlots.indexOf(x.end);
                    return x.day === dIdx && startIndex < rowIdx && rowIdx < endIndex;
                });
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

function endSelect() {
    isDown = false;
    if (selCells.length > 0) {
        const firstDay = selCells[0].dataset.day;
        const allSameDay = selCells.every(td => td.dataset.day === firstDay);

        if (allSameDay) {
            openModal();
        } else {
            alert("일정은 하루 안에서만 선택할 수 있습니다.");
            selCells.forEach(td => td.classList.remove('cell-selected'));
            selCells = [];
        }
    }
}

function openModal(p = null) {
    const modalOverlay = document.getElementById('modalOverlay');
    const mTitle = document.getElementById('modalTitle');
    const planTitle = document.getElementById('planTitle');
    const planNote = document.getElementById('planNote');
    const planColor = document.getElementById('planColor');
    const deleteBtn = document.getElementById('deleteBtn');

    editPlan = p;
    if (p) {
        mTitle.textContent = '플랜 수정';
        planTitle.value = p.title;
        planNote.value = p.note;
        planColor.value = p.color;
        deleteBtn.style.display = 'inline-block';
    } else {
        mTitle.textContent = '플랜 추가';
        planTitle.value = '';
        planNote.value = '';
        planColor.value = '#87CEEB';
        deleteBtn.style.display = 'none';
    }
    modalOverlay.style.display = 'flex';
}