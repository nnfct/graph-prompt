# graph-prompt

**그래프 프롬프트 콘솔** — 프롬프트 하나에 다 밀어넣는 대신, 작업을 노드로 쪼개고 에이전트를 배정하고 병렬/직렬/루프로 정보 흐름을 설계한다. Enter를 치면 그래프가 곧 프롬프트처럼 실행된다.

*A graph-as-prompt console: split one big prompt into a graph of agent nodes (parallel / serial / loop), press Enter, and the graph executes with a full per-node trace.*

## 왜

단일 프롬프트는 블랙박스다. 어떤 근거가 어디서 왔는지, 어느 단계가 시간을 먹었는지, 반박이 실제로 반영됐는지 보이지 않는다.

graph-prompt는 같은 작업을 **그래프**로 표현한다:

- **노드** = 에이전트 1명 (`claude` / `codex` / `research` / `red-team`)
- **엣지** = 정보 흐름. 병렬 갈래는 **진짜 동시 실행** (자식 프로세스 동시 spawn)
- **루프** = 종료조건 3종: 횟수(`max=3`) / 조건식(`until(coverage>=0.9)`) / AI판단(`until(충분히 검증되었는가)`)
- **트레이스** = 노드별 실제 발송 프롬프트·출력 전문·근거 체인(`_sources`)·토큰·비용·시간

그래프가 정본이고 MD는 직렬화 산출물이다. 라운드트립 무손실 — 해석 불가 라인은 조용히 버리지 않고 에러로 거부한다.

## 그래프 MD 스펙

헤딩 하나 = 노드 하나.

```markdown
---
title: 예제
layout:
  a: [80, 40]        # 캔버스 좌표 (선택)
---

## a `claude`
next: merge
prompt: |
  단어 "빨강" 하나만 반환한다.
out: {word: str}

## b `research`
next: merge
prompt: 웹에서 근거를 찾는다. 출처 URL 필수.

## merge `claude`
in: a, b             # 생략 시 next 로부터 자동 역산
loop: until(quality>=0.9, max=3) -> a
prompt: 두 입력을 종합한다.
```

- `next:` — 하류 노드 (쉼표 = 병렬 분기)
- `loop:` — 미달 시 `->` 대상으로 되돌아 재실행. **미달 사유가 다음 회차 프롬프트에 자동 주입**된다 (같은 주사위 다시 굴리기가 아니라 개선 루프)
- `lens:` — 렌즈 여러 개면 렌즈별 동시 실행 (예: red-team을 출처신뢰도/결론반증/놓친관점 3방향으로)
- `out:` — 출력 스키마. 노드 간 데이터는 JSON 강제
- 병렬 갈래 일부 실패 시 합류 노드는 남은 입력으로 진행(`degraded`), 전멸 시만 스킵

## 실행

요구사항: Node 18+, [Claude Code CLI](https://claude.com/claude-code) 로그인. `codex` 노드는 [Codex CLI](https://github.com/openai/codex) (선택). API 키 불필요 — 로그인된 CLI의 구독 인증을 그대로 사용한다.

### 웹 콘솔

```bash
cd web && npm install && npm run build && cd ..
npm start          # → http://localhost:4680 (127.0.0.1 전용)
```

- 좌: MD 에디터 ↔ 우: 캔버스, 실시간 양방향 (드래그=좌표, 엣지 연결=next 추가)
- 하단 입력창: 자연어 → AI가 그래프 초안 생성/수정
- **Ctrl+Enter = 실행.** 노드가 실시간으로 물든다 (노랑=실행중, 초록=완료, 빨강=실패)
- run 카드 스택: 1개 클릭=트레이스(입출력 전문·근거 체인·비용 분포), **2개 클릭=diff** (요약·노드별 대조·최종 출력·그래프 MD diff)
- 실행 중단 버튼 = 자식 프로세스 그룹째 종료 (고아 없음)

### CLI

```bash
node server/cli.mjs graphs/smoke.md
```

```
 0.002s ▶ 실행 시작 — 노드 3개
 0.003s ┌ a [claude] 시작 (iter 1)
 0.006s ┌ b [claude] 시작 (iter 1)      ← 진짜 병렬
  5.15s ┌ merge [claude] 시작 (iter 1)
  9.22s ■ 종료 · $0.0816 · 실패 [없음]
```

트레이스는 `runs/`에 2형식으로 남는다:

- `*.jsonl` — 증분 저장. run 도중 죽어도 그때까지의 기록 보존
- `*.json` — 완주 후 전체 (실행 시점 그래프 MD 원문 동봉 → run 간 diff 가능)

노드는 격리 실행된다 (`--strict-mcp-config --setting-sources ''`) — 개인 설정·MCP가 노드 프롬프트를 오염시키지 않고, 호출당 고정 컨텍스트가 57k → 5.4k 토큰으로 줄어든다.

## 테스트

```bash
npm test   # 파서·라운드트립·루프·에러 검출, 네트워크 불필요
```

## 로드맵

- [x] MD 파서 + 무손실 직렬화
- [x] 병렬 실행기 + 루프 3종 + 피드백 주입
- [x] 노드별 트레이스 (프롬프트·출력 전문·근거 체인·비용)
- [x] 웹 UI: React Flow 캔버스 ↔ MD 에디터 실시간 양방향
- [x] 자연어 → 그래프 AI draft
- [x] run 스택 + 2개 선택 diff (단일 프롬프트 vs 그래프 대조)
- [x] 실행 취소 (프로세스 그룹 kill)
- [ ] 노드 출력 스트리밍 (stream-json — 지금은 노드 완료 단위로 갱신)

## 라이선스

MIT
