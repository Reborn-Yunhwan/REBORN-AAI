import { kv } from '@vercel/kv';
import crypto from 'crypto';
import { lookupPrice } from './_prices.js';

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } }
};

// 토큰 서명 검증 (login.js와 짝을 이루는 로직)
function verifySession(req){
  const token = req.headers['x-admin-token'];
  if(!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if(parts.length !== 2) return null;
  const [payloadB64, signature] = parts;
  const secret = process.env.ADMIN_SECRET;
  if(!secret) return null;
  try {
    const payload = Buffer.from(payloadB64, 'base64url').toString('utf-8');
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if(expected !== signature) return null;
    const [userId, expiresAtStr] = payload.split('.');
    const expiresAt = parseInt(expiresAtStr, 10);
    if(!expiresAt || Date.now() > expiresAt) return null;
    return userId;
  } catch(e){
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    // POST — 접수 저장 / 고객 발송
    if(req.method === 'POST'){
      const body = req.body || {};

      // ── action: 'send' — 고객에게 판정결과 문자 발송 ──
      if(body.action === 'send'){
        const { receiptNumber } = body;
        if(!receiptNumber) return res.status(400).json({ error: '접수번호가 필요합니다' });

        const rec = await kv.get(`receipt:${receiptNumber}`);
        if(!rec) return res.status(404).json({ error: '접수를 찾을 수 없습니다' });
        if(!rec.customerPhone) return res.status(400).json({ error: '고객 연락처가 없습니다' });

        // 검수 대기 건은 관리자 확정 전에는 발송 불가
        if(rec.route === 'review' && !rec.reviewedAt){
          return res.status(400).json({
            error: '신뢰도 기준 미달로 관리자 검수가 필요한 건입니다. 검수 확정 후 발송할 수 있습니다.'
          });
        }

        const r = rec.result || {};
        const proto = (req.headers['x-forwarded-proto'] || 'https');
        const base = process.env.PUBLIC_BASE_URL || `${proto}://${req.headers['host']}`;

        const smsRes = await fetch(`${base}/api/send-sms`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'result',
            to: rec.customerPhone,
            data: {
              receiptNumber,
              customerName: rec.customerName,
              modelName: (r.device_info && r.device_info.model_name) || null,
              grade: r.final_grade,
              price: rec.finalPrice != null ? rec.finalPrice : r.final_price
            }
          })
        });
        const smsOut = await smsRes.json();

        if(!smsRes.ok){
          return res.status(502).json({ error: smsOut.error || '문자 발송 실패', detail: smsOut });
        }

        rec.sentAt = new Date().toISOString();
        rec.status = 'sent';
        await kv.set(`receipt:${receiptNumber}`, rec, { ex: 60 * 60 * 24 * 90 });

        return res.status(200).json({
          ok: true,
          receiptNumber,
          sentAt: rec.sentAt,
          sms: smsOut,
          link: `${base}/c/${receiptNumber}`
        });
      }

      // ── 간편접수 (촬영 없이 모델/용량/IMEI 만으로 접수) ──
      if(body.receiptType === 'simple'){
        const { receiptNumber, customerName, customerPhone, maker, modelName, modelNo, storage, imei } = body;
        if(!receiptNumber || !modelName || !storage){
          return res.status(400).json({ error: '모델과 용량은 필수입니다' });
        }
        if(!customerName || !customerPhone){
          return res.status(400).json({ error: '고객 성함과 연락처는 필수입니다' });
        }

        const priceInfo = lookupPrice(modelNo, storage, modelName, maker);

        const record = {
          receiptNumber,
          receiptType: 'simple',
          customerName,
          customerPhone: String(customerPhone).replace(/[^0-9]/g, ''),
          method: 'none',
          createdAt: new Date().toISOString(),

          // 간편접수는 사진이 없으므로 AI 판정 자체가 없다.
          // 입고 후 판정 단계로 넘어가는 상태로 저장한다.
          result: {
            final_grade: null,
            price_info: priceInfo,
            final_price: null,
            device_info: {
              model_name: modelName,
              model_number: modelNo || null,
              storage: storage,
              imei: imei || null
            },
            summary: '간편접수 건 — 단말기 입고 후 검수 예정'
          },
          photos: [],
          route: 'simple',
          confidenceScore: null,
          confidenceDetail: null,
          status: 'awaiting_delivery',   // 입고 대기
          finalPrice: null,
          originalGrade: null,
          reviewedGrade: null,
          reviewNote: null,
          reviewedAt: null,
          reviewedBy: null,
          sentAt: null,
          pickupRequestedAt: new Date().toISOString()
        };

        await kv.set(`receipt:${receiptNumber}`, record, { ex: 60 * 60 * 24 * 90 });
        await kv.zadd('receipts:index', { score: Date.now(), member: receiptNumber });

        // 택배 접수 안내 문자 발송
        const proto = (req.headers['x-forwarded-proto'] || 'https');
        const base = process.env.PUBLIC_BASE_URL || `${proto}://${req.headers['host']}`;
        let smsOut = null;
        try {
          const pr = priceInfo ? priceInfo.prices : null;
          const priceRange = pr
            ? (Number(pr['Bad']).toLocaleString('ko-KR') + '원 ~ ' + Number(pr['Excellent']).toLocaleString('ko-KR') + '원')
            : null;
          const smsRes = await fetch(`${base}/api/send-sms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'pickup',
              to: record.customerPhone,
              data: { receiptNumber, customerName, modelName: modelName + ' ' + storage, priceRange }
            })
          });
          smsOut = await smsRes.json();
        } catch(e){
          console.error('pickup sms failed:', e);
        }

        return res.status(200).json({
          ok: true,
          receiptNumber,
          receiptType: 'simple',
          status: record.status,
          priceInfo,
          sms: smsOut
        });
      }

      // ── 기본: 촬영 접수 저장 ──
      const { receiptNumber, result, photos, customerName, customerPhone, method } = body;
      if(!receiptNumber || !result){
        return res.status(400).json({ error: '필수 데이터 누락' });
      }

      const conf = result.confidence_detail || null;
      const route = result.route || (conf ? conf.route : 'review');

      const record = {
        receiptNumber,
        result,
        photos: photos || [],
        customerName: customerName || null,
        customerPhone: String(customerPhone || '').replace(/[^0-9]/g, '') || null,
        method,
        createdAt: new Date().toISOString(),

        // 신뢰도 라우팅
        route,                                        // 'auto' | 'review'
        confidenceScore: conf ? conf.score : null,
        confidenceDetail: conf,

        // 상태: review_pending(검수대기) → confirmed(확정) → sent(발송) →
        //       agreed(동의) → verified(인증) → paying → paid(입금완료)
        status: route === 'auto' ? 'confirmed' : 'review_pending',

        finalPrice: result.final_price != null ? result.final_price : null,
        originalGrade: result.final_grade,   // AI 원본 등급 보존
        reviewedGrade: null,
        reviewNote: null,
        reviewedAt: null,
        reviewedBy: null,
        sentAt: null
      };

      await kv.set(`receipt:${receiptNumber}`, record, { ex: 60 * 60 * 24 * 90 }); // 90일 보관

      await kv.zadd('receipts:index', {
        score: Date.now(),
        member: receiptNumber
      });

      return res.status(200).json({
        ok: true,
        receiptNumber,
        route,
        confidenceScore: record.confidenceScore,
        status: record.status
      });
    }

    // GET — 접수 목록 조회 (관리자 페이지에서만)
    if(req.method === 'GET'){
      const userId = verifySession(req);
      if(!userId){
        return res.status(401).json({ error: '인증이 만료되었거나 유효하지 않습니다' });
      }

      // 최신순으로 접수번호 목록 조회
      const numbers = await kv.zrange('receipts:index', 0, -1, { rev: true });

      if(!numbers || numbers.length === 0){
        return res.status(200).json({ ok: true, receipts: [] });
      }

      // 각 접수의 상세 데이터 병렬 조회
      const receipts = await Promise.all(
        numbers.map(async (num) => {
          const rec = await kv.get(`receipt:${num}`);
          if(!rec) return null;
          // 목록용으로 사진은 첫 장의 썸네일만 포함 (용량 절약)
          return {
            ...rec,
            photos: rec.photos && rec.photos.length > 0 ? [rec.photos[0]] : [],
            photoCount: rec.photos ? rec.photos.length : 0
          };
        })
      );

      return res.status(200).json({
        ok: true,
        receipts: receipts.filter(r => r !== null)
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch(e){
    console.error('receipts error:', e);
    return res.status(500).json({ error: e.message || '서버 오류' });
  }
}
