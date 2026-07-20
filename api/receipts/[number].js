import { kv } from '@vercel/kv';
import crypto from 'crypto';

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

    // PATCH — 등급 수정
    if(req.method === 'PATCH'){
      const { newGrade, reviewNote } = req.body || {};
      if(!newGrade || !reviewNote){
        return res.status(400).json({ error: '새 등급과 수정 사유가 필요합니다' });
      }
      if(reviewNote.trim().length < 5){
        return res.status(400).json({ error: '수정 사유를 5자 이상 입력해주세요' });
      }

      const record = await kv.get(`receipt:${number}`);
      if(!record){
        return res.status(404).json({ error: '접수를 찾을 수 없습니다' });
      }

      // 등급 및 이력 업데이트
      record.reviewedGrade = newGrade;
      record.reviewNote = reviewNote.trim();
      record.reviewedAt = new Date().toISOString();
      record.reviewedBy = userId;
      // AI 판정의 final_grade도 업데이트 (표시용)
      if(record.result){
        record.result.final_grade = newGrade;
      }

      await kv.set(`receipt:${number}`, record, { ex: 60 * 60 * 24 * 90 });

      return res.status(200).json({ ok: true, receipt: record });
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
