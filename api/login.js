import crypto from 'crypto';

// HMAC 서명 방식 토큰 생성 (재배포 없이 검증 가능)
function sign(payload, secret){
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { return res.status(405).json({ error: 'Method not allowed' }); }

  try {
    const { userId, password } = req.body || {};
    if(!userId || !password){
      return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요' });
    }

    // 환경변수에서 계정 정보 읽기 (형식: "id1:pw1,id2:pw2,...")
    const accountsRaw = process.env.ADMIN_ACCOUNTS || '';
    const accounts = {};
    accountsRaw.split(',').forEach(pair => {
      const [id, pwd] = pair.trim().split(':');
      if(id && pwd) accounts[id.trim()] = pwd.trim();
    });

    if(!accounts[userId] || accounts[userId] !== password){
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다' });
    }

    // 서명된 토큰: base64(userId.expiresAt).signature
    const secret = process.env.ADMIN_SECRET;
    if(!secret){
      return res.status(500).json({ error: '서버 설정 오류 (ADMIN_SECRET 없음)' });
    }

    const expiresAt = Date.now() + 12 * 60 * 60 * 1000; // 12시간 유효
    const payload = `${userId}.${expiresAt}`;
    const signature = sign(payload, secret);
    const token = Buffer.from(payload).toString('base64url') + '.' + signature;

    return res.status(200).json({
      ok: true,
      token: token,
      userId: userId,
      expiresAt: expiresAt
    });

  } catch(e){
    console.error('login error:', e);
    return res.status(500).json({ error: e.message || '서버 오류' });
  }
}
