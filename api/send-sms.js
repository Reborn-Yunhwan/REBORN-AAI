// ============================================================
// 문자 발송 API (Solapi)
//
// 3가지 유형:
//   1) result  — 판정결과 안내 + 고객 확인 링크
//   2) verify  — 본인인증 인증번호 (시연용)
//   3) paid    — 입금 완료 안내
//
// 필요 환경변수:
//   SOLAPI_API_KEY     Solapi API Key
//   SOLAPI_API_SECRET  Solapi API Secret
//   SOLAPI_SENDER      등록된 발신번호 (숫자만, 예: 01012345678)
//   PUBLIC_BASE_URL    배포 도메인 (예: https://reborn-aai.vercel.app)
// ============================================================

import crypto from 'crypto';
import { kv } from '@vercel/kv';

const SOLAPI_URL = 'https://api.solapi.com/messages/v4/send';

// Solapi HMAC 인증 헤더 생성
function authHeader(){
  const apiKey = process.env.SOLAPI_API_KEY;
  const apiSecret = process.env.SOLAPI_API_SECRET;
  if(!apiKey || !apiSecret) return null;

  const date = new Date().toISOString();
  const salt = crypto.randomBytes(32).toString('hex');
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(date + salt)
    .digest('hex');

  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

function onlyDigits(v){ return String(v || '').replace(/[^0-9]/g, ''); }
function won(n){ return (n == null) ? '-' : Number(n).toLocaleString('ko-KR') + '원'; }

const GRADE_KO = {
  'Excellent': '최상', 'Very Good': '우수', 'Good': '좋음',
  'Normal': '보통', 'Bad': '나쁨', '검수불가': '검수불가'
};

// ── 문자 본문 생성 ────────────────────────────────────────
function buildMessage(type, data, baseUrl){
  const name = data.customerName || '고객';
  const num  = data.receiptNumber || '';

  if(type === 'verify'){
    return `[리본] 인증번호 ${data.code}\n` +
           `본인확인을 위해 인증번호를 입력해주세요.\n` +
           `타인에게 절대 알려주지 마세요.`;
  }

  if(type === 'paid'){
    return `[리본 중고폰 매입] ${name} 고객님\n\n` +
           `매입 대금이 입금되었습니다.\n\n` +
           `▶ 접수번호 : ${num}\n` +
           `▶ 반납모델 : ${data.modelName || '-'}\n` +
           `▶ 입금금액 : ${won(data.amount)}\n` +
           `▶ 입금계좌 : ${data.bankName || ''} ${maskAccount(data.accountNo)}\n\n` +
           `이용해주셔서 감사합니다.\n` +
           `문의 : 리본 고객센터(1588-3822)`;
  }

  // type === 'result' (기본)
  const grade = data.grade || '-';
  const ko = GRADE_KO[grade] || '';
  return `[리본 중고폰 AI 판정] 안녕하세요, ${name} 고객님.\n\n` +
         `접수해주신 단말기의 검수가 완료되었습니다.\n\n` +
         `▶ 접수번호 : ${num}\n` +
         `▶ 반납모델 : ${data.modelName || '-'}\n` +
         `▶ 판정등급 : ${grade}${ko ? ' (' + ko + ')' : ''}\n` +
         `▶ 매입금액 : ${won(data.price)}\n\n` +
         `아래 링크에서 거래내역 확인 후\n` +
         `본인인증과 계좌입력을 진행해주세요.\n` +
         `▶ ${baseUrl}/c/${num}\n\n` +
         `문의 : 리본 고객센터(1588-3822)`;
}

function maskAccount(acc){
  const s = onlyDigits(acc);
  if(!s) return '';
  if(s.length <= 4) return s;
  return s.slice(0, 3) + '*'.repeat(Math.max(0, s.length - 7)) + s.slice(-4);
}

// ── 핸들러 ────────────────────────────────────────────────
export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  if(req.method === 'OPTIONS'){ res.status(200).end(); return; }
  if(req.method !== 'POST'){ return res.status(405).json({ error: 'Method not allowed' }); }

  const { type, to, data } = req.body || {};
  const msgType = type || 'result';
  const phone = onlyDigits(to);

  if(!phone || phone.length < 10){
    return res.status(400).json({ error: '수신번호가 올바르지 않습니다' });
  }

  const sender = onlyDigits(process.env.SOLAPI_SENDER);
  const auth = authHeader();
  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://reborn-aai.vercel.app';

  // 인증번호 발송이면 코드 생성 + KV 저장 (3분 유효)
  let payload = Object.assign({}, data || {});
  if(msgType === 'verify'){
    const code = String(Math.floor(100000 + Math.random() * 900000));
    payload.code = code;
    try {
      await kv.set(`verify:${phone}`, code, { ex: 180 });
    } catch(e){
      console.error('verify code save failed:', e);
    }
  }

  const text = buildMessage(msgType, payload, baseUrl);

  // ── 환경변수 미설정 시: 시뮬레이션 모드 ──
  // 데모 준비 중에도 화면 흐름이 끊기지 않도록, 실제 발송 대신 성공 응답을 준다.
  if(!auth || !sender){
    console.warn('[send-sms] Solapi 환경변수 미설정 — 시뮬레이션 모드로 응답');
    return res.status(200).json({
      ok: true,
      simulated: true,
      to: phone,
      type: msgType,
      text,
      note: 'SOLAPI_API_KEY / SOLAPI_API_SECRET / SOLAPI_SENDER 미설정 — 실제 발송되지 않았습니다'
    });
  }

  try {
    const r = await fetch(SOLAPI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': auth
      },
      body: JSON.stringify({
        message: {
          to: phone,
          from: sender,
          text: text,
          // 90바이트 초과 시 자동으로 LMS 로 발송
          type: Buffer.byteLength(text, 'utf8') > 90 ? 'LMS' : 'SMS',
          subject: msgType === 'paid' ? '리본 입금완료 안내' : '리본 판정결과 안내'
        }
      })
    });

    const out = await r.json();

    if(!r.ok){
      console.error('solapi error:', out);
      return res.status(502).json({
        error: (out && (out.errorMessage || out.message)) || '문자 발송 실패',
        detail: out
      });
    }

    return res.status(200).json({
      ok: true,
      simulated: false,
      to: phone,
      type: msgType,
      messageId: out.messageId || null,
      text
    });

  } catch(e){
    console.error('send-sms error:', e);
    return res.status(500).json({ error: e.message || '서버 오류' });
  }
}
