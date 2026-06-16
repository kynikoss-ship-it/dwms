import React, { useState, useEffect, useMemo } from 'react';
import { MapPin, Trash2, CheckCircle, AlertCircle, ChevronLeft, ChevronRight, Shield, ShieldOff, X } from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import {
  getFirestore, collection, onSnapshot, doc, deleteDoc,
  serverTimestamp, runTransaction
} from 'firebase/firestore';

/* global __firebase_config, __app_id, __initial_auth_token */

// --- Firebase Initialization ---
let app, auth, db, appId;
let isCanvasEnvironment = false;

try {
  let firebaseConfig;
  if (typeof __firebase_config !== 'undefined') {
    firebaseConfig = JSON.parse(__firebase_config);
    appId = typeof __app_id !== 'undefined' ? __app_id : 'school-reservation-system';
    isCanvasEnvironment = true;
  } else {
    firebaseConfig = {
      apiKey: "AIzaSyAgDV2hh7m4j22EiZfgZXSVVdChgh_G00Y",
      authDomain: "reservation-system-8440f.firebaseapp.com",
      projectId: "reservation-system-8440f",
      storageBucket: "reservation-system-8440f.firebasestorage.app",
      messagingSenderId: "129906163603",
      appId: "1:129906163603:web:5354b62468f1e229ba7266",
      measurementId: "G-99TZFWY2QN"
    };
    appId = "school-reservation-system";
  }

  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
} catch (error) {
  console.error("Firebase Initialization Error:", error);
}

// 수정 1: 탭 순서 — 행사(학생,교직원), 외부 방문자, 2층 도서관, 4층 미래교실
const EVENT_RESOURCE = '행사(학생,교직원)';
const VISITOR_RESOURCE = '외부 방문자';
const RESOURCES = [EVENT_RESOURCE, VISITOR_RESOURCE, '2층 도서관', '4층 미래교실'];

// 수정 2: 행사 대상자 — 학년(1·2·3·기타) + 교직원 체크박스로 분리
const EVENT_STUDENT_GRADES = ['1', '2', '3', '기타'];
const TIME_SLOTS = ['1교시', '2교시', '3교시', '4교시', '5교시', '6교시', '7교시', '방과후'];

// 수정 1: 외부 방문자 시간 슬롯 — 08:30~16:30, 30분 간격
const generateVisitorTimeSlots = () => {
  const slots = [];
  for (let h = 8; h <= 16; h++) {
    for (let m of [0, 30]) {
      if (h === 8 && m === 0) continue; // 08:00 제외, 08:30부터
      if (h === 16 && m === 30) { slots.push('16:30'); break; }
      slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return slots;
};
const VISITOR_TIME_SLOTS = generateVisitorTimeSlots();

const CLASSES = ['선택 안함', '동아리'];
for (let grade = 1; grade <= 3; grade++) {
  for (let cls = 1; cls <= 6; cls++) {
    CLASSES.push(`${grade}학년 ${cls}반`);
  }
}

const ADMIN_PASSCODE = process.env.REACT_APP_ADMIN_PASSCODE || '3328';

const getLocalDateString = (d = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const makeSlotId = (date, resource, time) =>
  `${date}__${resource.replace(/\//g, '_').replace(/[(),]/g, '_')}__${time}`;

// 수정 2: 행사 대상자 포맷 — 학생 학년 + 교직원 여부 조합
const formatEventTarget = (studentGrades, etcText, includeStaff) => {
  const parts = [];
  if (Array.isArray(studentGrades) && studentGrades.length > 0) {
    const nums = studentGrades.filter(g => ['1', '2', '3'].includes(g));
    const hasEtc = studentGrades.includes('기타');
    const gradeParts = [];
    if (nums.length >= 3) gradeParts.push('전교생');
    else if (nums.length > 0) gradeParts.push([...nums].sort().map(g => `${g}학년`).join(', '));
    if (hasEtc) gradeParts.push(etcText?.trim() || '기타');
    if (gradeParts.length > 0) parts.push(gradeParts.join(', '));
  }
  if (includeStaff) parts.push('교직원');
  return parts.join(' + ');
};

const statusBadge = (res) => {
  if (res.isUnavailable) return <span className="px-2 py-0.5 rounded text-xs font-bold bg-red-100 text-red-700">불가</span>;
  if (res.isVisitor) return <span className="px-2 py-0.5 rounded text-xs font-bold bg-green-100 text-green-700">방문</span>;
  if (res.isEvent) return <span className="px-2 py-0.5 rounded text-xs font-bold bg-purple-100 text-purple-700">행사</span>;
  return <span className="px-2 py-0.5 rounded text-xs font-bold bg-blue-100 text-blue-700">예약</span>;
};

const DetailRow = ({ label, value }) => (
  <div className="flex justify-between gap-4 border-b border-slate-100 pb-2 last:border-0">
    <dt className="font-bold text-slate-500 shrink-0">{label}</dt>
    <dd className="text-slate-800 text-right break-keep">{value || '-'}</dd>
  </div>
);

export default function App() {
  const [user, setUser] = useState(null);
  const [authError, setAuthError] = useState(false);
  const [reservations, setReservations] = useState([]);
  const [loading, setLoading] = useState(true);

  const todayStr = getLocalDateString();

  const [date, setDate] = useState(todayStr);
  const [resource, setResource] = useState(RESOURCES[0]);
  const [times, setTimes] = useState([]);
  const [userName, setUserName] = useState('');
  const [targetClass, setTargetClass] = useState(CLASSES[0]);

  // 수정 2: 행사 대상자 — 학생 학년 배열 + 교직원 여부
  const [targetStudentGrades, setTargetStudentGrades] = useState([]);
  const [includeStaff, setIncludeStaff] = useState(false);
  const [etcTarget, setEtcTarget] = useState('');
  const [eventName, setEventName] = useState('');
  const [isUnavailable, setIsUnavailable] = useState(false);
  const [isAllDay, setIsAllDay] = useState(false);
  const [unavailableReason, setUnavailableReason] = useState('');

  // 수정 1: 외부 방문자 전용 필드
  const [visitorName, setVisitorName] = useState('');
  const [visitorContact, setVisitorContact] = useState('');
  const [visitPurpose, setVisitPurpose] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  const [contactPersonPhone, setContactPersonPhone] = useState('');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [adminMode, setAdminMode] = useState(false);
  const [detailRes, setDetailRes] = useState(null);
  const [message, setMessage] = useState({ type: '', text: '' });
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [activeTab, setActiveTab] = useState(RESOURCES[0]);

  useEffect(() => {
    if (!auth) { setAuthError(true); setLoading(false); return; }
    const initAuth = async () => {
      try {
        if (isCanvasEnvironment && typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (error) {
        console.error("Authentication Failed:", error);
        setAuthError(true);
        setLoading(false);
      }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (!u) setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user || !db) return;
    const reservationsRef = collection(db, 'artifacts', appId, 'public', 'data', 'space_reservations');
    const unsubscribe = onSnapshot(reservationsRef, (snapshot) => {
      const data = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      data.sort((a, b) => {
        if (a.date === b.date) {
          const aIdx = TIME_SLOTS.indexOf(a.time);
          const bIdx = TIME_SLOTS.indexOf(b.time);
          if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
          return (a.time || '').localeCompare(b.time || '');
        }
        return a.date > b.date ? 1 : -1;
      });
      setReservations(data);
      setLoading(false);
    }, (err) => {
      console.error(err);
      setLoading(false);
    });
    return () => unsubscribe();
  }, [user]);

  useEffect(() => {
    if (message.text) {
      const timer = setTimeout(() => setMessage({ type: '', text: '' }), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const isEvent = resource === EVENT_RESOURCE;
  const isVisitor = resource === VISITOR_RESOURCE;

  // 현재 탭에서 예약된 슬롯 목록
  const bookedTimeSlots = useMemo(() => {
    return reservations
      .filter(r => r.date === date && r.resource === resource)
      .map(r => r.time);
  }, [reservations, date, resource]);

  const dailyReservations = useMemo(() => {
    const daily = reservations.filter(r => r.date === date && r.resource === activeTab);
    const map = {};
    daily.forEach(r => { map[r.time] = r; });
    return map;
  }, [reservations, date, activeTab]);

  const isPastDate = date < todayStr;

  const toggleTime = (slot) => {
    setTimes(prev => prev.includes(slot) ? prev.filter(t => t !== slot) : [...prev, slot]);
  };

  const toggleStudentGrade = (g) => {
    const willRemove = targetStudentGrades.includes(g);
    setTargetStudentGrades(prev => prev.includes(g) ? prev.filter(x => x !== g) : [...prev, g]);
    if (g === '기타' && willRemove) setEtcTarget('');
  };

  const resetForm = () => {
    setTimes([]);
    setIsAllDay(false);
    setUnavailableReason('');
    setTargetClass(CLASSES[0]);
    setEventName('');
    setTargetStudentGrades([]);
    setIncludeStaff(false);
    setEtcTarget('');
    setVisitorName('');
    setVisitorContact('');
    setVisitPurpose('');
    setContactPerson('');
    setContactPersonPhone('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!user) { setMessage({ type: 'error', text: '인증되지 않았습니다.' }); return; }

    if (isPastDate && !adminMode) {
      setMessage({ type: 'error', text: '과거 날짜는 예약할 수 없습니다.' });
      return;
    }

    // 수정 1: 방문자 탭 전용 처리
    if (isVisitor) {
      if (times.length === 0) { setMessage({ type: 'error', text: '방문 시간을 선택하세요.' }); return; }
      if (!visitorName.trim()) { setMessage({ type: 'error', text: '방문자 이름을 입력하세요.' }); return; }
      if (!visitorContact.trim()) { setMessage({ type: 'error', text: '방문자 연락처를 입력하세요.' }); return; }
      if (!visitPurpose.trim()) { setMessage({ type: 'error', text: '방문 목적을 입력하세요.' }); return; }
      if (!contactPerson.trim()) { setMessage({ type: 'error', text: '담당자를 입력하세요.' }); return; }

      setIsSubmitting(true);
      try {
        const reservationsRef = collection(db, 'artifacts', appId, 'public', 'data', 'space_reservations');
        const conflicts = [];
        for (const slot of times) {
          const slotId = makeSlotId(date, resource, slot);
          const slotRef = doc(reservationsRef, slotId);
          try {
            await runTransaction(db, async (tx) => {
              const snap = await tx.get(slotRef);
              if (snap.exists()) throw new Error('SLOT_TAKEN');
              tx.set(slotRef, {
                date, resource, time: slot,
                isVisitor: true,
                isEvent: false,
                isUnavailable: false,
                visitorName: visitorName.trim(),
                visitorContact: visitorContact.trim(),
                visitPurpose: visitPurpose.trim(),
                contactPerson: contactPerson.trim(),
                contactPersonPhone: contactPersonPhone.trim(),
                // userName은 조회 시 담당자로 표시
                userName: contactPerson.trim(),
                createdAt: serverTimestamp(),
                userId: user.uid,
              });
            });
          } catch (err) {
            if (err.message === 'SLOT_TAKEN') conflicts.push(slot);
            else throw err;
          }
        }
        if (conflicts.length === times.length) {
          setMessage({ type: 'error', text: '선택한 시간이 이미 등록되었습니다.' });
        } else if (conflicts.length > 0) {
          setMessage({ type: 'success', text: `일부 등록됨 — 충돌: ${conflicts.join(', ')}` });
        } else {
          setMessage({ type: 'success', text: '방문자 등록 완료' });
        }
        resetForm();
      } catch (error) {
        console.error(error);
        setMessage({ type: 'error', text: '오류: ' + (error.message || '알 수 없음') });
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    // 기존 예약 / 행사 / 불가 처리
    if (!isAllDay && times.length === 0) { setMessage({ type: 'error', text: '교시를 선택하세요.' }); return; }
    if (!isUnavailable && !userName.trim()) { setMessage({ type: 'error', text: '담당 부서 또는 교사명을 입력하세요.' }); return; }

    // 수정 2: 행사 대상자 검증 — 학생 학년 or 교직원 중 하나 이상 필수
    if (isEvent && !isUnavailable && targetStudentGrades.length === 0 && !includeStaff) {
      setMessage({ type: 'error', text: '행사 대상자를 선택하세요 (학생 학년 또는 교직원).' }); return;
    }
    if (isEvent && !isUnavailable && targetStudentGrades.includes('기타') && !etcTarget.trim()) {
      setMessage({ type: 'error', text: '기타 대상을 직접 입력하세요.' }); return;
    }
    if (isEvent && !isUnavailable && !eventName.trim()) { setMessage({ type: 'error', text: '행사명(장소)을 입력하세요.' }); return; }
    if (isUnavailable && !unavailableReason.trim()) { setMessage({ type: 'error', text: '불가 사유를 입력하세요.' }); return; }

    setIsSubmitting(true);
    try {
      const reservationsRef = collection(db, 'artifacts', appId, 'public', 'data', 'space_reservations');
      const targetSlots = isAllDay
        ? TIME_SLOTS.filter(slot => !bookedTimeSlots.includes(slot))
        : times.filter(slot => !bookedTimeSlots.includes(slot));

      if (targetSlots.length === 0) {
        setMessage({ type: 'error', text: '선택한 교시가 모두 이미 예약되었습니다.' });
        return;
      }

      const conflicts = [];
      for (const slot of targetSlots) {
        const slotId = makeSlotId(date, resource, slot);
        const slotRef = doc(reservationsRef, slotId);
        try {
          await runTransaction(db, async (tx) => {
            const snap = await tx.get(slotRef);
            if (snap.exists()) throw new Error('SLOT_TAKEN');
            tx.set(slotRef, {
              date, resource, time: slot,
              userName: isUnavailable ? unavailableReason.trim() : userName.trim(),
              targetClass: (isUnavailable || isEvent) ? '' : targetClass,
              isUnavailable,
              isEvent,
              isVisitor: false,
              eventName: (isEvent && !isUnavailable) ? eventName.trim() : '',
              // 수정 2: 학생 학년 배열 + 교직원 여부 저장
              targetGrades: (isEvent && !isUnavailable) ? targetStudentGrades : [],
              targetGradesEtc: (isEvent && !isUnavailable && targetStudentGrades.includes('기타')) ? etcTarget.trim() : '',
              includeStaff: (isEvent && !isUnavailable) ? includeStaff : false,
              createdAt: serverTimestamp(),
              userId: user.uid,
            });
          });
        } catch (err) {
          if (err.message === 'SLOT_TAKEN') conflicts.push(slot);
          else throw err;
        }
      }

      if (conflicts.length === targetSlots.length) {
        setMessage({ type: 'error', text: '선택한 시간이 이미 예약되었습니다.' });
      } else if (conflicts.length > 0) {
        setMessage({ type: 'success', text: `일부 등록됨 — 충돌: ${conflicts.join(', ')}` });
      } else {
        setMessage({ type: 'success', text: isUnavailable ? '예약 불가 설정 완료' : (isEvent ? '행사 등록 완료' : '예약 등록 완료') });
      }
      resetForm();
    } catch (error) {
      console.error(error);
      setMessage({ type: 'error', text: '오류: ' + (error.message || '알 수 없음') });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (res) => {
    const isOwner = user && res.userId === user.uid;
    if (!isOwner && !adminMode) {
      setMessage({ type: 'error', text: '본인이 등록한 예약만 삭제할 수 있습니다.' });
      return;
    }
    if (!window.confirm('정말 삭제하시겠습니까?')) return;
    try {
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'space_reservations', res.id));
      setMessage({ type: 'success', text: '삭제 완료' });
    } catch (error) {
      console.error(error);
      setMessage({ type: 'error', text: '삭제 실패: 권한이 없거나 네트워크 오류입니다.' });
    }
  };

  const toggleAdminMode = () => {
    if (adminMode) {
      setAdminMode(false);
      setMessage({ type: 'success', text: '관리자 모드 해제' });
      return;
    }
    const input = window.prompt('관리자 비밀번호를 입력하세요');
    if (input === null) return;
    if (input === ADMIN_PASSCODE) {
      setAdminMode(true);
      setMessage({ type: 'success', text: '관리자 모드 활성화' });
    } else {
      setMessage({ type: 'error', text: '비밀번호가 일치하지 않습니다.' });
    }
  };

  const canDelete = (res) => (user && res.userId === user.uid) || adminMode;

  if (authError) return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 text-center bg-slate-100">
      <AlertCircle className="text-red-500 mb-4" size={48} />
      <p className="font-bold text-slate-700">인증 실패</p>
      <p className="text-sm text-slate-500 mt-2">네트워크 또는 Firebase 설정을 확인하세요.</p>
    </div>
  );
  if (loading) return <div className="flex items-center justify-center min-h-screen font-semibold text-slate-600">데이터 동기화 중...</div>;

  const prevMonth = () => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1));
  const nextMonth = () => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1));

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const blankCount = (firstDay === 0 || firstDay === 6) ? 0 : firstDay - 1;
  const blanks = Array(Math.max(0, blankCount)).fill(null);
  const weekdays = Array.from({ length: daysInMonth }, (_, i) => i + 1).filter(d => {
    const day = new Date(year, month, d).getDay();
    return day !== 0 && day !== 6;
  });

  // 수정 1: 방문자 탭 — 시간 슬롯 선택 UI에 사용할 슬롯 목록
  const currentTimeSlots = isVisitor ? VISITOR_TIME_SLOTS : TIME_SLOTS;

  return (
    <div className="min-h-screen bg-slate-100 p-4 md:p-8 font-sans">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 flex justify-between items-start gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
              <MapPin className="text-blue-600" /> 동원중학교 통합 예약 시스템
            </h1>
            <p className="text-slate-500 mt-2 text-sm">실시간 동기화 예약 시스템</p>
          </div>
          <button
            onClick={toggleAdminMode}
            title={adminMode ? '관리자 모드 해제' : '관리자 모드 진입'}
            aria-label={adminMode ? '관리자 모드 해제' : '관리자 모드 진입'}
            className={`shrink-0 p-2 rounded-lg border transition-colors text-xs font-bold flex items-center gap-1 ${
              adminMode
                ? 'bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100'
                : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100'
            }`}
          >
            {adminMode ? <Shield size={14} /> : <ShieldOff size={14} />}
            {adminMode ? '관리자' : '일반'}
          </button>
        </header>

        {message.text && (
          <div className={`p-4 rounded-lg flex items-center gap-2 font-bold ${message.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
            {message.type === 'success' ? <CheckCircle size={20} /> : <AlertCircle size={20} />}
            <span>{message.text}</span>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="space-y-6">
            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 h-fit">
              <h2 className="text-lg font-bold mb-4 border-b pb-2 text-slate-800">
                {isVisitor ? '방문자 등록' : '신규 예약'}
              </h2>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="text-sm font-bold text-slate-600 block mb-1">날짜</label>
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => { setDate(e.target.value); setTimes([]); }}
                    className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                    required
                  />
                  {isPastDate && (
                    <p className="text-[11px] text-amber-700 mt-1 font-bold">
                      ⚠ 과거 날짜 — {adminMode ? '관리자 모드로 등록 가능' : '조회만 가능'}
                    </p>
                  )}
                </div>
                <div>
                  <label className="text-sm font-bold text-slate-600 block mb-1">구분</label>
                  <select
                    value={resource}
                    onChange={(e) => {
                      setResource(e.target.value);
                      setActiveTab(e.target.value);
                      setTimes([]);
                    }}
                    className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                  >
                    {RESOURCES.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>

                {/* ─── 외부 방문자 탭 전용 폼 ─── */}
                {isVisitor ? (
                  <>
                    <div>
                      <label className="text-sm font-bold text-slate-600 block mb-2">
                        방문 시간 <span className="font-normal text-slate-400">(다중 선택 가능)</span>
                      </label>
                      <div className="grid grid-cols-4 gap-1.5">
                        {VISITOR_TIME_SLOTS.map(slot => (
                          <button
                            key={slot}
                            type="button"
                            disabled={bookedTimeSlots.includes(slot)}
                            onClick={() => toggleTime(slot)}
                            className={`py-1.5 text-xs rounded-lg border font-bold transition-colors ${
                              bookedTimeSlots.includes(slot)
                                ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                                : times.includes(slot)
                                  ? 'bg-green-600 text-white border-green-600 shadow-sm'
                                  : 'bg-white text-slate-700 hover:bg-slate-50 border-slate-300'
                            }`}
                          >
                            {slot}
                          </button>
                        ))}
                      </div>
                      {times.length > 0 && (
                        <p className="text-[11px] text-green-700 mt-1.5 font-bold">선택: {times.join(', ')}</p>
                      )}
                    </div>

                    <div>
                      <label className="text-sm font-bold text-slate-600 block mb-1">방문자 이름 <span className="text-red-500">*</span></label>
                      <input
                        type="text"
                        value={visitorName}
                        onChange={(e) => setVisitorName(e.target.value)}
                        placeholder="예: 홍길동"
                        className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-sm font-bold text-slate-600 block mb-1">방문자 연락처 <span className="text-red-500">*</span></label>
                      <input
                        type="tel"
                        value={visitorContact}
                        onChange={(e) => setVisitorContact(e.target.value)}
                        placeholder="예: 010-1234-5678"
                        className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-sm font-bold text-slate-600 block mb-1">방문 목적 <span className="text-red-500">*</span></label>
                      <input
                        type="text"
                        value={visitPurpose}
                        onChange={(e) => setVisitPurpose(e.target.value)}
                        placeholder="예: 수업 참관, 업체 미팅"
                        className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-sm font-bold text-slate-600 block mb-1">담당자 <span className="text-red-500">*</span></label>
                      <input
                        type="text"
                        value={contactPerson}
                        onChange={(e) => setContactPerson(e.target.value)}
                        placeholder="예: 교무부 김교사"
                        className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-sm font-bold text-slate-600 block mb-1">담당자 연락처</label>
                      <input
                        type="tel"
                        value={contactPersonPhone}
                        onChange={(e) => setContactPersonPhone(e.target.value)}
                        placeholder="예: 010-9876-5432 (선택)"
                        className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                      />
                    </div>
                  </>
                ) : (
                  /* ─── 기존 예약 / 행사 / 불가 폼 ─── */
                  <>
                    {!isAllDay && (
                      <div>
                        <label className="text-sm font-bold text-slate-600 block mb-2">교시 <span className="font-normal text-slate-400">(다중 선택 가능)</span></label>
                        <div className="grid grid-cols-4 gap-2">
                          {TIME_SLOTS.map(slot => (
                            <button key={slot} type="button" disabled={bookedTimeSlots.includes(slot)} onClick={() => toggleTime(slot)}
                              className={`py-2 text-xs rounded-lg border font-bold transition-colors ${bookedTimeSlots.includes(slot) ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed' : times.includes(slot) ? 'bg-blue-600 text-white border-blue-600 shadow-sm' : 'bg-white text-slate-700 hover:bg-slate-50 border-slate-300'}`}>
                              {slot}
                            </button>
                          ))}
                        </div>
                        {times.length > 0 && (
                          <p className="text-[11px] text-blue-700 mt-1.5 font-bold">선택: {times.join(', ')}</p>
                        )}
                      </div>
                    )}

                    <div className="p-3 bg-red-50 rounded-lg border border-red-100 mt-2 space-y-3">
                      <div className="flex items-center gap-2">
                        <input type="checkbox" id="isUn" checked={isUnavailable} onChange={(e) => { setIsUnavailable(e.target.checked); if (!e.target.checked) { setIsAllDay(false); setUnavailableReason(''); } }} className="w-4 h-4 text-red-600 rounded border-slate-300 focus:ring-red-500" />
                        <label htmlFor="isUn" className="text-sm font-bold text-red-700 cursor-pointer select-none">이 시간대 예약 불가 설정</label>
                      </div>
                      {isUnavailable && (
                        <>
                          <div className="flex items-center gap-2 pl-6">
                            <input type="checkbox" id="isAll" checked={isAllDay} onChange={(e) => setIsAllDay(e.target.checked)} className="w-3.5 h-3.5 text-red-600 rounded border-slate-300 focus:ring-red-500" />
                            <label htmlFor="isAll" className="text-xs font-bold text-red-600 cursor-pointer select-none">종일(전체 교시) 적용</label>
                          </div>
                          <div className="pl-6">
                            <label className="text-[11px] font-bold text-red-600 block mb-1">불가 사유 (예: 행사명, 공사 등)</label>
                            <input type="text" value={unavailableReason} onChange={(e) => setUnavailableReason(e.target.value)} placeholder="사유를 입력하세요" className="w-full p-2 text-sm border border-red-200 rounded focus:ring-1 focus:ring-red-500 outline-none" required={isUnavailable} />
                          </div>
                        </>
                      )}
                    </div>

                    {!isUnavailable && (
                      <>
                        <div>
                          <label className="text-sm font-bold text-slate-600 block mb-1">담당 부서 또는 교사</label>
                          <input type="text" value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="예: 교무부 또는 홍길동" className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" required />
                        </div>

                        {/* 수정 2: 행사 대상자 UI — 학생 학년 + 교직원 체크박스 */}
                        {isEvent ? (
                          <>
                            <div>
                              <label className="text-sm font-bold text-slate-600 block mb-2">행사 대상자</label>

                              {/* 학생 학년 */}
                              <p className="text-xs font-bold text-slate-500 mb-1.5">학생 (학년 선택)</p>
                              <div className="grid grid-cols-4 gap-2 mb-2">
                                {EVENT_STUDENT_GRADES.map(g => (
                                  <button key={g} type="button" onClick={() => toggleStudentGrade(g)}
                                    className={`py-2 text-sm rounded-lg border font-bold transition-colors ${targetStudentGrades.includes(g) ? 'bg-blue-600 text-white border-blue-600 shadow-sm' : 'bg-white text-slate-700 hover:bg-slate-50 border-slate-300'}`}>
                                    {g === '기타' ? '기타' : `${g}학년`}
                                  </button>
                                ))}
                              </div>
                              {targetStudentGrades.includes('기타') && (
                                <input type="text" value={etcTarget} onChange={(e) => setEtcTarget(e.target.value)} placeholder="대상 직접 입력 (예: 학부모)" className="mb-2 w-full p-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" />
                              )}

                              {/* 교직원 체크박스 */}
                              <div className="flex items-center gap-2 mt-1 p-2 bg-slate-50 rounded-lg border border-slate-200">
                                <input
                                  type="checkbox"
                                  id="includeStaff"
                                  checked={includeStaff}
                                  onChange={(e) => setIncludeStaff(e.target.checked)}
                                  className="w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500"
                                />
                                <label htmlFor="includeStaff" className="text-sm font-bold text-slate-700 cursor-pointer select-none">교직원 포함</label>
                              </div>

                              {/* 선택된 대상자 요약 */}
                              {(targetStudentGrades.length > 0 || includeStaff) && (
                                <p className="text-[11px] text-blue-700 mt-1.5 font-bold">
                                  대상: {formatEventTarget(targetStudentGrades, etcTarget, includeStaff)}
                                </p>
                              )}
                            </div>

                            <div>
                              <label className="text-sm font-bold text-slate-600 block mb-1">행사명(장소)</label>
                              <input type="text" value={eventName} onChange={(e) => setEventName(e.target.value)} placeholder="예: 진로체험의 날 (체육관)" className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" required={isEvent} />
                            </div>
                          </>
                        ) : (
                          <div>
                            <label className="text-sm font-bold text-slate-600 block mb-1">이용 학반</label>
                            <select value={targetClass} onChange={(e) => setTargetClass(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
                              {CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className={`w-full py-3 mt-4 rounded-lg text-white font-bold shadow-sm transition-colors ${
                    isSubmitting
                      ? 'bg-slate-400 cursor-not-allowed'
                      : isVisitor
                        ? 'bg-green-600 hover:bg-green-700'
                        : isUnavailable
                          ? 'bg-red-600 hover:bg-red-700'
                          : 'bg-blue-600 hover:bg-blue-700'
                  }`}
                >
                  {isSubmitting
                    ? '등록 중...'
                    : isVisitor
                      ? '방문자 등록하기'
                      : isUnavailable
                        ? (isAllDay ? '전체 교시 예약 불가 등록' : '예약 불가 등록')
                        : isEvent
                          ? '행사 등록하기'
                          : '예약 등록하기'}
                </button>
              </form>
            </div>

            {/* 일일 예약 현황 */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
              <h2 className="text-lg font-bold mb-4 border-b pb-2 text-slate-800 flex justify-between items-end">
                <span>일일 현황</span>
                <span className="text-sm font-normal text-slate-500">{date} | {activeTab}</span>
              </h2>
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-sm text-left whitespace-nowrap">
                  <thead className="bg-slate-50 text-slate-700 font-bold border-b border-slate-200">
                    <tr>
                      <th className="px-3 py-2 text-center w-16">{activeTab === VISITOR_RESOURCE ? '시간' : '교시'}</th>
                      <th className="px-3 py-2 text-center w-16">상태</th>
                      <th className="px-3 py-2">{activeTab === VISITOR_RESOURCE ? '방문자(목적)' : '예약자(사유)'}</th>
                      <th className="px-3 py-2 text-center w-10">관리</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(activeTab === VISITOR_RESOURCE ? VISITOR_TIME_SLOTS : TIME_SLOTS).map(slot => {
                      const res = dailyReservations[slot];
                      return (
                        <tr
                          key={slot}
                          onClick={res ? () => setDetailRes(res) : undefined}
                          className={`border-b last:border-0 border-slate-100 hover:bg-slate-50 transition-colors ${res ? 'cursor-pointer' : ''}`}
                        >
                          <td className="px-3 py-2 text-center font-bold text-slate-600 bg-slate-50 border-r border-slate-100">{slot}</td>
                          {res ? (
                            res.isVisitor ? (
                              <>
                                <td className="px-3 py-2 text-center">
                                  <span className="px-1.5 py-0.5 rounded text-[11px] font-bold bg-green-100 text-green-700">방문</span>
                                </td>
                                <td className="px-3 py-2 text-slate-800 font-medium truncate max-w-[120px]" title={`${res.visitorName} (${res.visitPurpose})`}>
                                  {res.visitorName}
                                  <span className="ml-1 text-slate-500 text-[11px] font-normal">({res.visitPurpose})</span>
                                </td>
                                <td className="px-3 py-2 text-center">
                                  {canDelete(res) && (
                                    <button onClick={(e) => { e.stopPropagation(); handleDelete(res); }} aria-label="삭제" className="text-slate-400 hover:text-red-600 p-1"><Trash2 size={14} /></button>
                                  )}
                                </td>
                              </>
                            ) : res.isUnavailable ? (
                              <>
                                <td className="px-3 py-2 text-center"><span className="px-1.5 py-0.5 rounded text-[11px] font-bold bg-red-100 text-red-700">불가</span></td>
                                <td className="px-3 py-2 text-red-700 font-bold truncate max-w-[120px]" title={res.userName}>{res.userName}</td>
                                <td className="px-3 py-2 text-center">
                                  {canDelete(res) && (
                                    <button onClick={(e) => { e.stopPropagation(); handleDelete(res); }} aria-label="삭제" className="text-slate-400 hover:text-red-600 p-1"><Trash2 size={14} /></button>
                                  )}
                                </td>
                              </>
                            ) : res.isEvent ? (
                              <>
                                <td className="px-3 py-2 text-center"><span className="px-1.5 py-0.5 rounded text-[11px] font-bold bg-purple-100 text-purple-700">행사</span></td>
                                <td className="px-3 py-2 text-slate-800 font-medium truncate max-w-[120px]"
                                  title={`${res.eventName} (${res.userName}) · ${formatEventTarget(res.targetGrades, res.targetGradesEtc, res.includeStaff)}`}>
                                  {res.eventName}
                                  <span className="ml-1 text-slate-500 text-[11px] font-normal">
                                    ({res.userName}{formatEventTarget(res.targetGrades, res.targetGradesEtc, res.includeStaff) ? ` · ${formatEventTarget(res.targetGrades, res.targetGradesEtc, res.includeStaff)}` : ''})
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-center">
                                  {canDelete(res) && (
                                    <button onClick={(e) => { e.stopPropagation(); handleDelete(res); }} aria-label="삭제" className="text-slate-400 hover:text-red-600 p-1"><Trash2 size={14} /></button>
                                  )}
                                </td>
                              </>
                            ) : (
                              <>
                                <td className="px-3 py-2 text-center"><span className="px-1.5 py-0.5 rounded text-[11px] font-bold bg-blue-100 text-blue-700">예약</span></td>
                                <td className="px-3 py-2 text-slate-800 font-medium truncate max-w-[120px]" title={`${res.userName} ${res.targetClass !== '선택 안함' ? `(${res.targetClass})` : ''}`}>
                                  {res.userName}
                                  {res.targetClass !== '선택 안함' && <span className="ml-1 text-slate-500 text-[11px] font-normal">({res.targetClass})</span>}
                                </td>
                                <td className="px-3 py-2 text-center">
                                  {canDelete(res) && (
                                    <button onClick={(e) => { e.stopPropagation(); handleDelete(res); }} aria-label="삭제" className="text-slate-400 hover:text-red-600 p-1"><Trash2 size={14} /></button>
                                  )}
                                </td>
                              </>
                            )
                          ) : (
                            <>
                              <td className="px-3 py-2 text-center"><span className="text-[11px] text-slate-400">가능</span></td>
                              <td className="px-3 py-2 text-slate-400">-</td>
                              <td className="px-3 py-2"></td>
                            </>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* 캘린더 */}
          <div className="lg:col-span-2 bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <div className="flex justify-between items-center mb-4 gap-2 flex-wrap">
              <div className="flex items-center gap-2 bg-slate-50 p-1 rounded-lg border border-slate-200">
                <button onClick={prevMonth} className="p-1 hover:bg-white rounded transition-colors" aria-label="이전 달"><ChevronLeft size={20} className="text-slate-600" /></button>
                <span className="font-bold w-24 text-center text-slate-800">{year}년 {month + 1}월</span>
                <button onClick={nextMonth} className="p-1 hover:bg-white rounded transition-colors" aria-label="다음 달"><ChevronRight size={20} className="text-slate-600" /></button>
              </div>
              <div className="flex gap-1 flex-wrap">
                {RESOURCES.map(res => (
                  <button key={res} onClick={() => { setActiveTab(res); setResource(res); setTimes([]); }}
                    className={`px-3 py-2 text-xs font-bold rounded-t-lg border-b-2 transition-colors ${activeTab === res ? 'border-blue-600 text-blue-600 bg-blue-50/50' : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'}`}>
                    {res}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-5 gap-px bg-slate-200 rounded-lg overflow-hidden border border-slate-200">
              {['월', '화', '수', '목', '금'].map(d => <div key={d} className="bg-slate-50 py-2 text-center text-sm font-bold text-slate-600">{d}</div>)}
              {blanks.map((_, i) => <div key={`blank-${i}`} className="bg-white min-h-[120px]"></div>)}
              {weekdays.map(d => {
                const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                const items = reservations.filter(r => r.date === dateStr && r.resource === activeTab);
                const isSelected = date === dateStr;
                const isToday = todayStr === dateStr;

                return (
                  <div key={d} onClick={() => { setDate(dateStr); setTimes([]); if (resource !== activeTab) setResource(activeTab); }}
                    className={`bg-white min-h-[140px] p-2 border-t border-slate-100 cursor-pointer transition-colors hover:bg-blue-50/30 ${isSelected ? 'ring-2 ring-inset ring-blue-500 bg-blue-50/30' : ''}`}>
                    <div className={`text-sm font-bold w-7 h-7 flex items-center justify-center rounded-lg mb-2 transition-colors ${isToday ? 'bg-blue-600 text-white' : isSelected ? 'text-blue-600' : 'text-slate-700'}`}>
                      {d}
                    </div>
                    <div className="space-y-1.5 overflow-y-auto max-h-[100px]">
                      {items.map(res => (
                        <div key={res.id}
                          onClick={(e) => { e.stopPropagation(); setDetailRes(res); }}
                          title="클릭하여 상세 보기"
                          className={`text-[11px] p-2 rounded-lg border group relative flex flex-col gap-0.5 leading-tight cursor-pointer hover:ring-2 hover:ring-blue-400 transition-shadow ${
                            res.isUnavailable ? 'bg-red-50 border-red-200 text-red-700'
                            : res.isVisitor ? 'bg-green-50 border-green-200 text-green-800'
                            : res.isEvent ? 'bg-purple-50 border-purple-200 text-purple-800'
                            : 'bg-slate-50 border-slate-200 text-slate-800'}`}>
                          <div className="flex items-center gap-1 truncate">
                            <span className={`font-black shrink-0 ${
                              res.isUnavailable ? 'text-red-700'
                              : res.isVisitor ? 'text-green-700'
                              : res.isEvent ? 'text-purple-700'
                              : 'text-blue-700'}`}>{res.time}</span>
                            {res.isVisitor && (
                              <span className="text-slate-500 font-bold truncate">| {res.visitPurpose}</span>
                            )}
                            {!res.isUnavailable && !res.isVisitor && res.isEvent && (formatEventTarget(res.targetGrades, res.targetGradesEtc, res.includeStaff)) && (
                              <span className="text-slate-500 font-bold truncate">| {formatEventTarget(res.targetGrades, res.targetGradesEtc, res.includeStaff)}</span>
                            )}
                            {!res.isUnavailable && !res.isVisitor && !res.isEvent && res.targetClass && res.targetClass !== '선택 안함' && (
                              <span className="text-slate-500 font-bold truncate">| {res.targetClass}</span>
                            )}
                          </div>
                          <span className="font-bold truncate">
                            {res.isUnavailable
                              ? `예약 불가 (${res.userName})`
                              : res.isVisitor
                                ? `${res.visitorName} (${res.contactPerson})`
                                : res.isEvent
                                  ? `${res.eventName} (${res.userName})`
                                  : res.userName}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* 상세 팝업 모달 */}
      {detailRes && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => setDetailRes(null)}>
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 relative" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setDetailRes(null)} className="absolute top-4 right-4 text-slate-400 hover:text-slate-700" aria-label="닫기"><X size={20} /></button>
            <div className="flex items-center gap-2 mb-5 pr-8">
              {statusBadge(detailRes)}
              <h3 className="text-xl font-bold text-slate-800 break-keep">
                {detailRes.isVisitor
                  ? detailRes.visitorName
                  : detailRes.isUnavailable
                    ? '예약 불가'
                    : detailRes.isEvent
                      ? detailRes.eventName
                      : detailRes.userName}
              </h3>
            </div>
            <dl className="space-y-3 text-sm">
              <DetailRow label="날짜" value={detailRes.date} />
              <DetailRow label="구분" value={detailRes.resource} />
              <DetailRow label={detailRes.resource === VISITOR_RESOURCE ? '시간' : '교시'} value={detailRes.time} />
              {detailRes.isVisitor ? (
                <>
                  <DetailRow label="방문자" value={detailRes.visitorName} />
                  <DetailRow label="방문자 연락처" value={detailRes.visitorContact} />
                  <DetailRow label="방문 목적" value={detailRes.visitPurpose} />
                  <DetailRow label="담당자" value={detailRes.contactPerson} />
                  {detailRes.contactPersonPhone && (
                    <DetailRow label="담당자 연락처" value={detailRes.contactPersonPhone} />
                  )}
                </>
              ) : detailRes.isUnavailable ? (
                <DetailRow label="사유" value={detailRes.userName} />
              ) : detailRes.isEvent ? (
                <>
                  <DetailRow label="행사명(장소)" value={detailRes.eventName} />
                  <DetailRow label="담당 부서/교사" value={detailRes.userName} />
                  <DetailRow label="대상자" value={formatEventTarget(detailRes.targetGrades, detailRes.targetGradesEtc, detailRes.includeStaff)} />
                </>
              ) : (
                <>
                  <DetailRow label="담당 부서/교사" value={detailRes.userName} />
                  {detailRes.targetClass && detailRes.targetClass !== '선택 안함' && (
                    <DetailRow label="이용 학반" value={detailRes.targetClass} />
                  )}
                </>
              )}
            </dl>
            {canDelete(detailRes) && (
              <button
                onClick={() => { const target = detailRes; setDetailRes(null); handleDelete(target); }}
                className="mt-6 w-full py-2.5 rounded-lg bg-red-50 text-red-700 font-bold border border-red-200 hover:bg-red-100 flex items-center justify-center gap-2 transition-colors"
              >
                <Trash2 size={16} /> 삭제
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
