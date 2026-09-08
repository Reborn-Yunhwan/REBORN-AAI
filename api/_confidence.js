// ============================================================
// 신뢰도 산출 엔진
// AI 자기보고 confidence 를 기준점으로 두고, 룰 기반 감점을 적용해
// 최종 신뢰도(0~100)와 라우팅(auto / review)을 결정한다.
//
// 설계 의도:
//   AI가 스스로 매기는 confidence 는 근거가 약해서
//   "95% 확신"이라고 해놓고 틀리는 경우가 있다.
//   그래서 판정 결과 안에 남아있는 '불확실성의 흔적'을 룰로 잡아 깎는다.
//   → 관리자 화면에서 "왜 이 건이 검수로 넘어왔는지" 설명이 가능해진다.
// ============================================================

export const AUTO_THRESHOLD = 85; // 이 값 이상이면 자동 확정, 미만이면 사람 검수

// ── 감점 룰 정의 ─────────────────────────────────────────
// 각 룰은 { code, label, penalty, check(ctx) → boolean | number }
// check 가 숫자를 반환하면 그 값을 감점으로 사용(가변 감점)

const RULES = [
  // ① 사진 품질
  {
    code: 'PHOTO_UNUSABLE',
    label: '판정 불가 수준의 사진 포함',
    penalty: 35,
    check: function(ctx){
      return (ctx.photoQuality || []).some(function(p){ return p.quality === 'unusable'; });
    }
  },
  {
    code: 'PHOTO_WARNING',
    label: '사진 품질 경고(흐림·역광·거리)',
    penalty: 0, // 가변
    check: function(ctx){
      var n = (ctx.photoQuality || []).filter(function(p){ return p.quality === 'warning'; }).length;
      if(n === 0) return false;
      return Math.min(n * 6, 20); // 장당 6점, 최대 20점
    }
  },
  {
    code: 'PHOTO_TOO_FEW',
    label: '사진 장수 부족(5장 미만)',
    penalty: 12,
    check: function(ctx){ return ctx.photoCount > 0 && ctx.photoCount < 5; }
  },

  // ② LCD 의심 소견
  {
    code: 'LCD_SUSPECT',
    label: 'LCD 이상 의심 소견 있음',
    penalty: 18,
    check: function(ctx){
      return hasPositiveMention(ctx.lcdText, /의심|요주의|애매|가능성|추정|불명확|미세한?\s*색차|약잔상|중잔상/);
    }
  },
  {
    code: 'LCD_SEVERE_BUT_NOT_BAD',
    label: 'LCD 손상 언급이 있으나 Bad 로 확정되지 않음',
    penalty: 20,
    check: function(ctx){
      if(ctx.grade === 'Bad' || ctx.grade === '검수불가') return false;
      return hasPositiveMention(ctx.lcdText, /강잔상|중잔상|핑크틴트|백화|흑점|멍|번인|burn-?in/i);
    }
  },

  // ③ 사설수리 의심
  {
    code: 'REPAIR_SUSPECT',
    label: '사설수리 의심 정황 있으나 Bad 확정 아님',
    penalty: 22,
    check: function(ctx){
      if(ctx.grade === 'Bad' || ctx.grade === '검수불가') return false;
      return hasPositiveMention(ctx.allText, /사설\s*수리|비순정|알\s*수\s*없는\s*부품|부품\s*교체/);
    }
  },

  // ④ 등급 경계선
  {
    code: 'BORDERLINE',
    label: '등급 경계선 판정(결정 근거가 약함)',
    penalty: 15,
    check: function(ctx){
      // 결정 요인이 1개이고 그 강도가 minor 인데 등급이 하향된 경우 = 경계 케이스
      var pf = ctx.primaryFactors || [];
      if(pf.length !== 1) return false;
      var sev = (pf[0].severity || '').toLowerCase();
      if(sev !== 'minor') return false;
      return ['Good','Normal'].indexOf(ctx.grade) >= 0;
    }
  },
  {
    code: 'BORDERLINE_TEXT',
    label: '판정 근거에 불확실 표현 포함',
    penalty: 12,
    check: function(ctx){
      return /경계\s*케이스|경계선|애매|확신하기\s*어렵|판단이\s*어렵|다소\s*불명확|추가\s*확인\s*필요/.test(ctx.allText);
    }
  },

  // ⑤ 기기정보 / 단가 매칭
  {
    code: 'DEVICE_INFO_MISSING',
    label: '모델번호 또는 IMEI 미인식',
    penalty: 12,
    check: function(ctx){
      var di = ctx.deviceInfo || {};
      var missing = 0;
      if(!di.model_number) missing++;
      if(!di.imei) missing++;
      if(!di.storage) missing++;
      return missing >= 2 ? 12 : (missing === 1 ? 6 : false);
    }
  },
  {
    code: 'PRICE_UNCERTAIN',
    label: '단가 매칭이 부정확(모델 특정 실패)',
    penalty: 0, // 가변
    check: function(ctx){
      var mt = ctx.priceMatchType;
      if(mt === 'fallback') return 25;
      if(mt === 'petname_partial') return 12;
      if(mt === 'model_only') return 8;
      if(!mt) return 20; // 단가 못 찾음
      return false;
    }
  }
];

// ── 부정 표현 처리 ───────────────────────────────────────
// "잔상 없음", "사설수리 흔적 미발견" 처럼 손상 키워드가 부정형으로 쓰인 경우를
// 손상 언급으로 오인하지 않도록 한다.
const NEGATION = /(없|없음|없습니다|미발견|아님|아닙니다|정상|양호|해당\s*없|확인되지\s*않|관찰되지\s*않|보이지\s*않)/;

function hasPositiveMention(text, keywordRe){
  if(!text) return false;
  // 문장/구 단위로 잘라서, 키워드가 있는 조각만 부정 여부를 판단
  var chunks = String(text).split(/[.,;\n·]|그러나|하지만/);
  for(var i=0;i<chunks.length;i++){
    var c = chunks[i];
    if(!keywordRe.test(c)) continue;
    // 키워드 뒤 12자 이내에 부정 표현이 오면 '없다'는 뜻이므로 제외
    var m = c.match(keywordRe);
    var after = c.slice(c.indexOf(m[0]) + m[0].length, c.indexOf(m[0]) + m[0].length + 12);
    if(NEGATION.test(after)) continue;
    return true;
  }
  return false;
}

// ── 텍스트 수집 헬퍼 ─────────────────────────────────────
function collectText(result){
  var parts = [];
  if(result.summary) parts.push(result.summary);
  if(result.decision_path && result.decision_path.decisive_reason) parts.push(result.decision_path.decisive_reason);
  (result.primary_factors || []).forEach(function(f){
    parts.push([f.factor, f.location].filter(Boolean).join(' '));
  });
  var an = result.analysis || {};
  Object.keys(an).forEach(function(k){
    var v = an[k];
    if(!v) return;
    parts.push(typeof v === 'object' ? [v.grade, v.detail].filter(Boolean).join(' ') : String(v));
  });
  var ar = result.area_summary || {};
  Object.keys(ar).forEach(function(k){
    if(ar[k] && ar[k].note) parts.push(ar[k].note);
  });
  return parts.join(' \n ');
}

function lcdText(result){
  var parts = [];
  var an = result.analysis || {};
  if(an.lcd) parts.push(typeof an.lcd === 'object' ? [an.lcd.grade, an.lcd.detail].filter(Boolean).join(' ') : String(an.lcd));
  if(an.display) parts.push(typeof an.display === 'object' ? [an.display.grade, an.display.detail].filter(Boolean).join(' ') : String(an.display));
  (result.primary_factors || []).forEach(function(f){
    var s = [f.factor, f.location].filter(Boolean).join(' ');
    if(/LCD|액정|화면|디스플레이/i.test(s)) parts.push(s);
  });
  return parts.join(' \n ');
}

// ── 메인 ─────────────────────────────────────────────────
/**
 * @param {object} result   - grade.js 가 파싱한 AI 판정 JSON
 * @param {object} opts     - { photoCount, priceMatchType }
 * @returns {object} confidence 상세
 */
export function evaluateConfidence(result, opts){
  opts = opts || {};

  // AI 자기보고 신뢰도 (0~1 또는 0~100 둘 다 허용)
  var raw = result.confidence;
  var base;
  if(typeof raw === 'number'){
    base = raw <= 1 ? raw * 100 : raw;
  } else {
    base = 70; // 신뢰도 미반환 시 보수적 기본값
  }
  base = Math.max(0, Math.min(100, base));

  var ctx = {
    grade: result.final_grade,
    primaryFactors: result.primary_factors,
    photoQuality: result.photo_quality,
    deviceInfo: result.device_info,
    photoCount: opts.photoCount || 0,
    priceMatchType: opts.priceMatchType || null,
    allText: collectText(result),
    lcdText: lcdText(result)
  };

  var deductions = [];
  var total = 0;

  RULES.forEach(function(rule){
    var hit = rule.check(ctx);
    if(hit === false || hit === null || hit === undefined) return;
    var pen = (typeof hit === 'number') ? hit : rule.penalty;
    if(pen <= 0) return;
    deductions.push({ code: rule.code, label: rule.label, penalty: pen });
    total += pen;
  });

  // 감점 상한 — 룰이 중복 적중해도 점수가 비현실적으로 무너지지 않게 한다
  var MAX_PENALTY = 45;
  var applied = Math.min(total, MAX_PENALTY);
  var score = Math.max(0, Math.round(base - applied));

  // 검수불가는 신뢰도와 무관하게 무조건 사람이 본다
  var forcedReview = (result.final_grade === '검수불가');
  var route = (!forcedReview && score >= AUTO_THRESHOLD) ? 'auto' : 'review';

  if(forcedReview && deductions.length === 0){
    deductions.push({ code: 'FORCED_REVIEW', label: '검수불가 판정 — 사람 확인 필수', penalty: 0 });
  }

  return {
    aiConfidence: Math.round(base),   // AI 자기보고
    deductions: deductions,           // 적용된 감점 내역
    totalPenalty: applied,
    rawPenalty: total,
    score: score,                     // 최종 신뢰도 (0~100)
    threshold: AUTO_THRESHOLD,
    route: route,                     // 'auto' | 'review'
    reviewReason: route === 'review'
      ? (forcedReview
          ? '검수불가 판정으로 사람 확인이 필요합니다'
          : '신뢰도 ' + score + '% (기준 ' + AUTO_THRESHOLD + '% 미만) — ' +
            deductions.map(function(d){ return d.label; }).join(', '))
      : null
  };
}

export default { evaluateConfidence, AUTO_THRESHOLD };
