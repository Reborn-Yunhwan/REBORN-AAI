import { kv } from '@vercel/kv';
import crypto from 'crypto';
import { lookupPrice } from '../_prices.js';

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

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const userId = verifySession(req);
  if(!userId){
    return res.status(401).json({ error: '인증이 필요합니다' });
  }

  const { number } = req.query;
  if(!number){
    return res.status(400).json({ error: '접수번호가 필요합니다' });
  }

  try {
    // GET — 상세 조회
    if(req.method === 'GET'){
      const record = await kv.get(`receipt:${number}`);
      if(!record){
        return res.status(404).json({ error: '접수를 찾을 수 없습니다' });
      }
      return res.status(200).json({ ok: true, receipt: record });
    }

    // PATCH — 등급 확정 (검수)
    // v24: AI 판정과 '동일한 등급으로 확정'하는 것도 허용한다.
    //      검수자가 "AI 판정이 맞다"고 확인하는 것 역시 유효한 검수 결과이기 때문.
    //      확정된 등급으로 매입가도 다시 계산해서 반영한다.
    if(req.method === 'PATCH'){
      const { newGrade, reviewNote } = req.body || {};
      if(!newGrade || !reviewNote){
        return res.status(400).json({ error: '확정 등급과 사유가 필요합니다' });
      }
      if(reviewNote.trim().length < 5){
        return res.status(400).json({ error: '사유를 5자 이상 입력해주세요' });
      }

      const record = await kv.get(`receipt:${number}`);
      if(!record){
        return res.status(404).json({ error: '접수를 찾을 수 없습니다' });
      }

      const prevGrade = record.result ? record.result.final_grade : null;
      const prevPrice = record.finalPrice;

      // 등급 및 이력 업데이트
      record.reviewedGrade = newGrade;
      record.reviewNote = reviewNote.trim();
      record.reviewedAt = new Date().toISOString();
      record.reviewedBy = userId;
      record.gradeChanged = (prevGrade !== newGrade);
      if(record.result){
        record.result.final_grade = newGrade;
      }

      // ── 확정 등급 기준으로 매입가 재계산 ──
      // 접수 시 조회해둔 price_info 를 우선 사용하고, 없으면 단가표를 다시 조회한다.
      let priceInfo = record.result && record.result.price_info;
      if(!priceInfo){
        const di = (record.result && record.result.device_info) || {};
        priceInfo = lookupPrice(di.model_number, di.storage, di.model_name, null);
        if(record.result) record.result.price_info = priceInfo;
      }

      let newPrice = null;
      if(priceInfo && priceInfo.prices && priceInfo.prices[newGrade] != null){
        newPrice = priceInfo.prices[newGrade];
      }
      record.finalPrice = newPrice;
      if(record.result) record.result.final_price = newPrice;

      record.priceChanged = (prevPrice !== newPrice);

      await kv.set(`receipt:${number}`, record, { ex: 60 * 60 * 24 * 90 });

      return res.status(200).json({
        ok: true,
        receipt: record,
        change: {
          gradeFrom: prevGrade, gradeTo: newGrade, gradeChanged: record.gradeChanged,
          priceFrom: prevPrice, priceTo: newPrice, priceChanged: record.priceChanged
        }
      });
    }

    // DELETE — 삭제
    if(req.method === 'DELETE'){
      await kv.del(`receipt:${number}`);
      await kv.zrem('receipts:index', number);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch(e){
    console.error('receipt detail error:', e);
    return res.status(500).json({ error: e.message || '서버 오류' });
  }
}
