import React, { useState, useEffect, useMemo } from 'react';
import { Calendar, Clock, MapPin, User, FileText, Trash2, CheckCircle, AlertCircle, ChevronLeft, ChevronRight, Users, Ban } from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, onSnapshot, addDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';

// --- Firebase Initialization ---
let app, auth, db, appId;
let isCanvasEnvironment = false;

try {
  let firebaseConfig;
  if (typeof __firebase_config !== 'undefined') {
    // Canvas Environment
    firebaseConfig = JSON.parse(__firebase_config);
    appId = typeof __app_id !== 'undefined' ? __app_id : 'school-reservation-system';
    isCanvasEnvironment = true;
  } else {
    // Standard Environment (Fallback)
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

const RESOURCES = ['2층 도서관', '4층 미래교실'];
const TIME_SLOTS = ['1교시', '2교시', '3교시', '4교시', '5교시', '6교시', '7교시', '방과후'];

const CLASSES = ['선택 안함', '동아리']; 
for (let grade = 1; grade <= 3; grade++) {
  for (let cls = 1; cls <= 6; cls++) {
    CLASSES.push(`${grade}학년 ${cls}반`);
  }
}

export default function App() {
  const [user, setUser] = useState(null);
  const [reservations, setReservations] = useState([]);
  const [loading, setLoading] = useState(true);

  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [resource, setResource] = useState(RESOURCES[0]);
  const [time, setTime] = useState('');
  const [userName, setUserName] = useState('');
  const [targetClass, setTargetClass] = useState(CLASSES[0]);
  const [isUnavailable, setIsUnavailable] = useState(false);
  const [isAllDay, setIsAllDay] = useState(false);
  const [unavailableReason, setUnavailableReason] = useState('');

  const [message, setMessage] = useState({ type: '', text: '' }); 
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [activeTab, setActiveTab] = useState(RESOURCES[0]);

  useEffect(() => {
    if (!auth) return;

    const initAuth = async () => {
      try {
        if (isCanvasEnvironment && typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (error) {
        console.error("Authentication Failed:", error);
      }
    };

    initAuth();
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user || !db) return;

    const reservationsRef = collection(db, 'artifacts', appId, 'public', 'data', 'space_reservations');
    const unsubscribe = onSnapshot(reservationsRef, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      data.sort((a, b) => {
        if (a.date === b.date) return TIME_SLOTS.indexOf(a.time) - TIME_SLOTS.indexOf(b.time);
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

  const bookedTimeSlots = useMemo(() => {
    return reservations
      .filter(r => r.date === date && r.resource === resource)
      .map(r => r.time);
  }, [reservations, date, resource]);

  // 선택된 날짜와 장소에 대한 상세 예약 매핑 (표 렌더링용)
  const dailyReservations = useMemo(() => {
    const daily = reservations.filter(r => r.date === date && r.resource === activeTab);
    const map = {};
    daily.forEach(r => { map[r.time] = r; });
    return map;
  }, [reservations, date, activeTab]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!isAllDay && !time) { setMessage({ type: 'error', text: '시간을 선택하세요.' }); return; }
    if (!isUnavailable && !userName) { setMessage({ type: 'error', text: '이름을 입력하세요.' }); return; }
    if (isUnavailable && !unavailableReason) { setMessage({ type: 'error', text: '불가 사유를 입력하세요.' }); return; }
    if (!isAllDay && bookedTimeSlots.includes(time)) { setMessage({ type: 'error', text: '이미 예약됨.' }); return; }

    try {
      const reservationsRef = collection(db, 'artifacts', appId, 'public', 'data', 'space_reservations');
      
      const targetSlots = isAllDay 
        ? TIME_SLOTS.filter(slot => !bookedTimeSlots.includes(slot))
        : [time];

      if (targetSlots.length === 0) {
        setMessage({ type: 'error', text: '차단할 수 있는 남은 교시가 없습니다.' });
        return;
      }

      const uploadPromises = targetSlots.map(slot => 
        addDoc(reservationsRef, {
          date, resource, time: slot,
          userName: isUnavailable ? (unavailableReason || '관리자') : userName,
          targetClass: isUnavailable ? '' : targetClass,
          isUnavailable,
          createdAt: serverTimestamp(),
          userId: user.uid
        })
      );

      await Promise.all(uploadPromises);

      setMessage({ type: 'success', text: isUnavailable ? '예약 불가 설정 완료' : '예약 등록 완료' });
      setTime('');
      setIsAllDay(false);
      setUnavailableReason('');
      if (!isUnavailable) setTargetClass(CLASSES[0]);
    } catch (error) {
      setMessage({ type: 'error', text: '오류 발생' });
    }
  };

  const handleDelete = async (id) => {
    try {
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'space_reservations', id));
      setMessage({ type: 'success', text: '삭제 완료' });
    } catch (error) {
      setMessage({ type: 'error', text: '삭제 실패' });
    }
  };

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

  const todayStr = new Date().toISOString().split('T')[0];

  return (
    <div className="min-h-screen bg-slate-100 p-4 md:p-8 font-sans">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <MapPin className="text-blue-600" /> 도서관 및 미래교실 예약 시스템
          </h1>
          <p className="text-slate-500 mt-2 text-sm">실시간 동기화 예약 시스템</p>
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
              <h2 className="text-lg font-bold mb-4 border-b pb-2 text-slate-800">신규 예약</h2>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="text-sm font-bold text-slate-600 block mb-1">날짜</label>
                  <input type="date" value={date} onChange={(e) => { setDate(e.target.value); setTime(''); }} className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" required />
                </div>
                <div>
                  <label className="text-sm font-bold text-slate-600 block mb-1">장소</label>
                  <select value={resource} onChange={(e) => { setResource(e.target.value); setActiveTab(e.target.value); setTime(''); }} className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
                    {RESOURCES.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                {!isAllDay && (
                  <div>
                    <label className="text-sm font-bold text-slate-600 block mb-2">교시</label>
                    <div className="grid grid-cols-4 gap-2">
                      {TIME_SLOTS.map(slot => (
                        <button key={slot} type="button" disabled={bookedTimeSlots.includes(slot)} onClick={() => setTime(slot)}
                          className={`py-2 text-xs rounded-lg border font-bold transition-colors ${bookedTimeSlots.includes(slot) ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed' : time === slot ? 'bg-blue-600 text-white border-blue-600 shadow-sm' : 'bg-white text-slate-700 hover:bg-slate-50 border-slate-300'}`}>
                          {slot}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                
                <div className="p-3 bg-red-50 rounded-lg border border-red-100 mt-2 space-y-3">
                  <div className="flex items-center gap-2">
                    <input type="checkbox" id="isUn" checked={isUnavailable} onChange={(e) => { setIsUnavailable(e.target.checked); if(!e.target.checked) { setIsAllDay(false); setUnavailableReason(''); } }} className="w-4 h-4 text-red-600 rounded border-slate-300 focus:ring-red-500"/>
                    <label htmlFor="isUn" className="text-sm font-bold text-red-700 cursor-pointer select-none">이 시간대 예약 불가 설정</label>
                  </div>
                  {isUnavailable && (
                    <>
                      <div className="flex items-center gap-2 pl-6">
                        <input type="checkbox" id="isAll" checked={isAllDay} onChange={(e) => setIsAllDay(e.target.checked)} className="w-3.5 h-3.5 text-red-600 rounded border-slate-300 focus:ring-red-500"/>
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
                      <label className="text-sm font-bold text-slate-600 block mb-1">예약자명 (교사명)</label>
                      <input type="text" value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="예: 홍길동" className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" required />
                    </div>
                    <div>
                      <label className="text-sm font-bold text-slate-600 block mb-1">이용 학반</label>
                      <select value={targetClass} onChange={(e) => setTargetClass(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
                        {CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                  </>
                )}
                <button type="submit" className={`w-full py-3 mt-4 rounded-lg text-white font-bold shadow-sm transition-colors ${isUnavailable ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}>
                  {isUnavailable ? (isAllDay ? '전체 교시 예약 불가 등록' : '예약 불가 등록') : '예약 등록하기'}
                </button>
              </form>
            </div>

            {/* 날짜 선택 시 상세 예약 현황을 보여주는 표 (도식화 영역) */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
              <h2 className="text-lg font-bold mb-4 border-b pb-2 text-slate-800 flex justify-between items-end">
                <span>일일 예약 현황</span>
                <span className="text-sm font-normal text-slate-500">{date} | {activeTab}</span>
              </h2>
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-sm text-left whitespace-nowrap">
                  <thead className="bg-slate-50 text-slate-700 font-bold border-b border-slate-200">
                    <tr>
                      <th className="px-3 py-2 text-center w-14">교시</th>
                      <th className="px-3 py-2 text-center w-16">상태</th>
                      <th className="px-3 py-2">예약자(사유)</th>
                      <th className="px-3 py-2 text-center w-10">관리</th>
                    </tr>
                  </thead>
                  <tbody>
                    {TIME_SLOTS.map(slot => {
                      const res = dailyReservations[slot];
                      return (
                        <tr key={slot} className="border-b last:border-0 border-slate-100 hover:bg-slate-50 transition-colors">
                          <td className="px-3 py-2 text-center font-bold text-slate-600 bg-slate-50 border-r border-slate-100">{slot}</td>
                          {res ? (
                            res.isUnavailable ? (
                              <>
                                <td className="px-3 py-2 text-center"><span className="px-1.5 py-0.5 rounded text-[11px] font-bold bg-red-100 text-red-700">불가</span></td>
                                <td className="px-3 py-2 text-red-700 font-bold truncate max-w-[120px]" title={res.userName}>{res.userName}</td>
                                <td className="px-3 py-2 text-center">
                                  <button onClick={() => handleDelete(res.id)} className="text-slate-400 hover:text-red-600 p-1"><Trash2 size={14}/></button>
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
                                  <button onClick={() => handleDelete(res.id)} className="text-slate-400 hover:text-red-600 p-1"><Trash2 size={14}/></button>
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

          <div className="lg:col-span-2 bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <div className="flex justify-between items-center mb-4">
              <div className="flex items-center gap-2 bg-slate-50 p-1 rounded-lg border border-slate-200">
                <button onClick={prevMonth} className="p-1 hover:bg-white rounded transition-colors"><ChevronLeft size={20} className="text-slate-600"/></button>
                <span className="font-bold w-24 text-center text-slate-800">{year}년 {month + 1}월</span>
                <button onClick={nextMonth} className="p-1 hover:bg-white rounded transition-colors"><ChevronRight size={20} className="text-slate-600"/></button>
              </div>
              <div className="flex gap-1">
                {RESOURCES.map(res => (
                  <button key={res} onClick={() => { setActiveTab(res); setResource(res); setTime(''); }}
                    className={`px-4 py-2 text-sm font-bold rounded-t-lg border-b-2 transition-colors ${activeTab === res ? 'border-blue-600 text-blue-600 bg-blue-50/50' : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'}`}>
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
                  <div key={d} onClick={() => { setDate(dateStr); setTime(''); if(resource!==activeTab) setResource(activeTab); }} 
                       className={`bg-white min-h-[140px] p-2 border-t border-slate-100 cursor-pointer transition-colors hover:bg-blue-50/30 ${isSelected ? 'ring-2 ring-inset ring-blue-500 bg-blue-50/30' : ''}`}>
                    <div className={`text-sm font-bold w-7 h-7 flex items-center justify-center rounded-lg mb-2 transition-colors ${isToday ? 'bg-blue-600 text-white' : isSelected ? 'text-blue-600' : 'text-slate-700'}`}>
                      {d}
                    </div>
                    <div className="space-y-1.5 overflow-y-auto max-h-[100px]">
                      {items.map(res => (
                        <div key={res.id} className={`text-[11px] p-2 rounded-lg border group relative flex flex-col gap-0.5 leading-tight ${res.isUnavailable ? 'bg-red-50 border-red-200 text-red-700' : 'bg-slate-50 border-slate-200 text-slate-800'}`}>
                          <div className="flex items-center gap-1 truncate">
                            <span className={`font-black shrink-0 ${res.isUnavailable ? 'text-red-700' : 'text-blue-700'}`}>{res.time}</span>
                            {!res.isUnavailable && res.targetClass && res.targetClass !== '선택 안함' && (
                              <span className="text-slate-500 font-bold truncate">| {res.targetClass}</span>
                            )}
                          </div>
                          <span className="font-bold truncate">
                            {res.isUnavailable ? `예약 불가 (${res.userName})` : res.userName}
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
    </div>
  );
}
