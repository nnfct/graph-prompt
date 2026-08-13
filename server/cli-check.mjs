// claude/codex CLI 계약 검증. 이 도구는 비공개 플래그에 의존한다 —
// CLI 자동 업데이트로 플래그가 사라지면 조용히 깨지는 대신, 기동 시
// 감지해서 경고하고 가능한 만큼 강등(degrade)한다.
import { spawnSync } from 'node:child_process';

// 우리가 의존하는 claude 플래그. help 에서 사라지면 해당 기능 강등.
const REQUIRED = [
  { flag: '--setting-sources', why: '노드 격리(개인 설정 미로드)' },
  { flag: '--strict-mcp-config', why: '노드 격리(MCP 미로드)' },
  { flag: '--output-format', why: '결과 파싱' },
  { flag: '--tools', why: '노드별 도구 제한' },
];
const OPTIONAL = [
  { flag: '--include-partial-messages', why: '스트리밍 draft' },
  { flag: '--effort', why: 'draft 첫 토큰 지연 단축' },
];

let cached = null;

export function checkCli() {
  if (cached) return cached;
  const out = { ok: true, version: null, missing: [], degraded: [], codex: false };

  const v = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 15000 });
  if (v.status !== 0) {
    cached = { ...out, ok: false, missing: ['claude CLI 자체'], hint: 'claude 미설치 또는 PATH 밖 — https://claude.com/claude-code' };
    return cached;
  }
  out.version = (v.stdout || '').trim();

  const h = spawnSync('claude', ['--help'], { encoding: 'utf8', timeout: 15000 });
  const help = h.stdout || '';
  for (const r of REQUIRED) if (!help.includes(r.flag)) out.missing.push(`${r.flag} (${r.why})`);
  for (const o of OPTIONAL) if (!help.includes(o.flag)) out.degraded.push(`${o.flag} (${o.why})`);
  if (out.missing.length) out.ok = false;

  const c = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 15000 });
  out.codex = c.status === 0 ? (c.stdout || '').trim() : false;

  cached = out;
  return out;
}

export function reportCli(log = console.log) {
  const r = checkCli();
  if (!r.ok) {
    log(`⚠ claude CLI 계약 불일치 — 이 버전(${r.version || '미검출'})에서 다음 플래그가 없다:`);
    for (const m of r.missing) log(`  - ${m}`);
    log('  실행이 실패하거나 격리 없이 돌 수 있다. 검증된 CLI 버전으로 내리거나 이슈를 확인하라.');
  } else {
    log(`claude ${r.version}${r.codex ? ` · codex ${r.codex}` : ' · codex 없음(codex 노드 사용 불가)'}`);
    for (const d of r.degraded) log(`  ⚠ ${d} 미지원 — 해당 기능 강등`);
  }
  return r;
}
