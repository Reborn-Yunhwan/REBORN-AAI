import { kv } from '@vercel/kv';
import crypto from 'crypto';

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
    // POST — 접수 저장 (사용자 판정기에서 호출)
    if(req.method === 'POST'){
      const { receiptNumber, result, photos, authInfo, method } = req.body || {};
      if(!receiptNumber || !result || !authInfo){
        return res.status(400).json({ error: '필수 데이터 누락' });
      }

      const record = {
        receiptNumber,
        result,
        photos: photos || [],
        authInfo,
        method,
        createdAt: new Date().toISOString(),
        status: 'completed',
        originalGrade: result.final_grade,   // AI 원본 등급 보존
        reviewedGrade: null,                  // 검수자 수정 등급
        reviewNote: null,                     // 검수 사유
        reviewedAt: null,
        reviewedBy: null
      };

      // 개별 저장
      await kv.set(`receipt:${receiptNumber}`, record, { ex: 60 * 60 * 24 * 90 }); // 90일 보관

      // 인덱스 리스트에 추가 (최신순 정렬용)
      await kv.zadd('receipts:index', {
        score: Date.now(),
        member: receiptNumber
      });

      return res.status(200).json({ ok: true, receiptNumber });
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
