// ============================================================
// 고객용 거래확인 API  (관리자 토큰 불필요 — 접수번호로 접근)
//
// GET    /api/customer/:number            거래내역 조회 (민감정보 제외)
// POST   /api/customer/:number
//    { action: 'agree' }                  거래 동의
//    { action: 'verify-confirm', code }   본인인증 코드 확인 (시연용)
//    { action: 'submit-account', ... }    계좌 등록 → 입금 처리
// ============================================================

import { kv } from '@vercel/kv';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

function maskPhone(p){
  const s = String(p || '').replace(/[^0-9]/g, '');
  if(s.length < 7) return s;
  return s.slice(0, 3) + '-****-' + s.slice(-4);
}

function maskAccount(acc){
  const s = String(acc || '').replace(/[^0-9]/g, '');
  if(s.length <= 4) return s;
  return s.slice(0, 3) + '*'.repeat(Math.max(0, s.length - 7)) + s.slice(-4);
}

// 고객에게 내려줄 안전한 형태로 가공
function toCustomerView(rec){
  const r = rec.result || {};
  return {
    receiptNumber: rec.receiptNumber,
    customerName: rec.customerName || null,
    customerPhone: maskPhone(rec.customerPhone),
    modelName: (r.device_info && r.device_info.model_name) || null,
    storage: (r.device_info && r.device_info.storage) || null,
    imei: (r.device_info && r.device_info.imei) || null,
    grade: r.final_grade || null,
    price: rec.finalPrice != null ? rec.finalPrice : (r.final_price != null ? r.final_price : null),
    priceVersion: (r.price_info && r.price_info.priceVersion) || null,
    summary: r.summary || null,
    areaSummary: r.area_summary || null,
    photos: (rec.photos || []).slice(0, 8),
    status: rec.status,
    agreedAt: rec.agreedAt || null,
    verifiedAt: rec.verifiedAt || null,
    paidAt: rec.paidAt || null,
    bankName: rec.bankName || null,
    accountMasked: rec.accountNo ? maskAccount(rec.accountNo) : null,
    createdAt: rec.createdAt,
    sentAt: rec.sentAt || null
  };
}

async function sendSms(type, to, data, req){
  // 같은 배포 내 send-sms 함수 호출
  const proto = (req.headers['x-forwarded-proto'] || 'https');
  const host  = req.headers['host'];
  const base  = process.env.PUBLIC_BASE_URL || `${proto}://${host}`;
  try {
    const r = await fetch(`${base}/api/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, to, data })
    });
    return await r.json();
  } catch(e){
    console.error('sendSms failed:', e);
    return { ok: false, error: e.message };
  }
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS'){ res.status(200).end(); return; }

  const { number } = req.query;
  if(!number) return res.status(400).json({ error: '접수번호가 필요합니다' });

  let rec;
  try {
    rec = await kv.get(`receipt:${number}`);
  } catch(e){
    return res.status(500).json({ error: 'DB 조회 실패' });
  }
  if(!rec) return res.status(404).json({ error: '거래내역을 찾을 수 없습니다' });

  // 아직 고객에게 발송되지 않은 건은 접근 차단
  if(!rec.sentAt && req.method === 'GET'){
    return res.status(403).json({ error: '아직 확인할 수 없는 거래입니다' });
  }

  // ── 조회 ──
  if(req.method === 'GET'){
    return res.status(200).json({ ok: true, receipt: toCustomerView(rec) });
  }

  if(req.method !== 'POST'){
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action } = req.body || {};

  try {
    // ── ① 거래 동의 ──
    if(action === 'agree'){
      rec.agreedAt = new Date().toISOString();
      rec.status = 'agreed';
      await kv.set(`receipt:${number}`, rec, { ex: 60 * 60 * 24 * 90 });
      return res.status(200).json({ ok: true, receipt: toCustomerView(rec) });
    }

    // ── ② 본인인증 코드 확인 ──
    if(action === 'verify-confirm'){
      const { code, phone } = req.body || {};
      const target = String(phone || rec.customerPhone || '').replace(/[^0-9]/g, '');
      if(!code) return res.status(400).json({ error: '인증번호를 입력해주세요' });

      let saved = null;
      try { saved = await kv.get(`verify:${target}`); } catch(e){}

      if(!saved){
        return res.status(400).json({ error: '인증번호가 만료되었습니다. 재발송해주세요.' });
      }
      if(String(saved) !== String(code).trim()){
        return res.status(400).json({ error: '인증번호가 일치하지 않습니다' });
      }

      rec.verifiedAt = new Date().toISOString();
      rec.status = 'verified';
      await kv.set(`receipt:${number}`, rec, { ex: 60 * 60 * 24 * 90 });
      try { await kv.del(`verify:${target}`); } catch(e){}

      return res.status(200).json({ ok: true, receipt: toCustomerView(rec) });
    }

    // ── ③ 계좌 등록 → 입금 처리 ──
    if(action === 'submit-account'){
      if(!rec.verifiedAt){
        return res.status(400).json({ error: '본인인증을 먼저 완료해주세요' });
      }
      const { bankName, accountNo, holderName } = req.body || {};
      if(!bankName || !accountNo || !holderName){
        return res.status(400).json({ error: '은행·계좌번호·예금주를 모두 입력해주세요' });
      }
      const acc = String(accountNo).replace(/[^0-9]/g, '');
      if(acc.length < 8){
        return res.status(400).json({ error: '계좌번호를 정확히 입력해주세요' });
      }

      rec.bankName = bankName;
      rec.accountNo = acc;
      rec.holderName = holderName;
      rec.accountAt = new Date().toISOString();
      rec.status = 'paying';
      await kv.set(`receipt:${number}`, rec, { ex: 60 * 60 * 24 * 90 });

      // 입금 처리 (시연: 즉시 완료 처리 + 입금완료 문자 발송)
      const amount = rec.finalPrice != null
        ? rec.finalPrice
        : ((rec.result && rec.result.final_price) || null);

      rec.paidAt = new Date().toISOString();
      rec.paidAmount = amount;
      rec.status = 'paid';
      await kv.set(`receipt:${number}`, rec, { ex: 60 * 60 * 24 * 90 });

      const smsResult = await sendSms('paid', rec.customerPhone, {
        receiptNumber: number,
        customerName: rec.customerName,
        modelName: (rec.result && rec.result.device_info && rec.result.device_info.model_name) || null,
        amount: amount,
        bankName: bankName,
        accountNo: acc
      }, req);

      return res.status(200).json({
        ok: true,
        receipt: toCustomerView(rec),
        sms: smsResult
      });
    }

    return res.status(400).json({ error: '알 수 없는 요청입니다' });

  } catch(e){
    console.error('customer api error:', e);
    return res.status(500).json({ error: e.message || '서버 오류' });
  }
}
