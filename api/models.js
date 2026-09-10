// ============================================================
// 모델 카탈로그 API — 간편접수(촬영 없이) 화면에서 사용
//
// GET /api/models              제조사 → 모델 → 용량 목록
// GET /api/models?modelNo=&storage=   해당 모델의 등급별 단가
// ============================================================

import { getCatalog, lookupPrice, PRICE_VERSION } from './_prices.js';

let cached = null;

export default function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS'){ res.status(200).end(); return; }
  if(req.method !== 'GET'){ return res.status(405).json({ error: 'Method not allowed' }); }

  const { modelNo, storage, modelName } = req.query || {};

  // 단가 조회 모드
  if(modelNo || modelName){
    const info = lookupPrice(modelNo, storage, modelName, null);
    if(!info) return res.status(404).json({ error: '단가 정보를 찾을 수 없습니다' });
    return res.status(200).json({ ok: true, priceInfo: info });
  }

  // 카탈로그 모드 (자주 바뀌지 않으므로 함수 인스턴스에 캐싱)
  if(!cached) cached = getCatalog();

  // 삼성 → 애플 → LG 순으로 정렬해서 내려준다
  const order = ['삼성', '애플', 'LG'];
  const makers = order.filter(function(m){ return cached[m] && cached[m].length; });

  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(200).json({
    ok: true,
    priceVersion: PRICE_VERSION,
    makers: makers,
    catalog: cached
  });
}
