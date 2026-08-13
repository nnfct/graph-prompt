// 그래프 엔지니어링 역할 라이브러리.
// 멀티에이전트 설계 패턴 리서치 기반 큐레이션:
// generator-critic, plan-and-execute, map-reduce, debate/judge-panel,
// self-refine 루프, adversarial verify, completeness critic, ensemble.
// 각 항목은 즉시 삽입 가능한 노드 템플릿이다.

export const ROLES = [
  // ── 계획·분해 ──────────────────────────────────────────
  {
    cat: '계획·분해', id: 'planner', type: 'claude',
    when: '큰 할 일을 하위 질문·갈래로 쪼갤 때. 그래프의 첫 노드 (plan-and-execute 패턴)',
    prompt: '할 일을 서로 독립인 하위 질문 3~5개로 분해한다. 각 질문은 병렬 조사가 가능해야 한다.',
    out: '{subtasks: [{id, question, why}]}',
  },
  {
    cat: '계획·분해', id: 'router', type: 'claude', model: 'haiku',
    when: '입력 유형에 따라 어느 갈래를 태울지 분기할 때. 가벼운 분류라 haiku',
    prompt: '입력을 검토해 어떤 처리 갈래가 적합한지 판정하고 이유를 붙인다.',
    out: '{route, reason}',
  },
  // ── 수집 ──────────────────────────────────────────────
  {
    cat: '수집', id: 'researcher', type: 'research',
    when: '웹 근거 수집. 병렬 갈래로 여러 개 두는 게 기본형 (map 단계)',
    prompt: '주제를 웹에서 조사한다. 각 주장에 출처 URL 필수. 광고성 출처는 표시한다.',
    out: '{findings: [{claim, url, source_type}]}',
  },
  {
    cat: '수집', id: 'counter.evidence', type: 'research',
    when: '확증편향 차단 — 본대와 반대 방향 근거만 캐는 갈래를 병렬로 붙인다',
    prompt: '주 가설에 불리한 근거·실패 사례·반대 데이터만 수집한다. 유리한 근거는 버린다. 출처 URL 필수.',
    out: '{counter: [{claim, url}]}',
  },
  // ── 검증 ──────────────────────────────────────────────
  {
    cat: '검증', id: 'fact.checker', type: 'research',
    when: '상위 노드 주장을 하나씩 재검증. 근거 체인(_sources)이 진짜인지 확인',
    prompt: '입력의 각 주장에 대해 출처가 실제로 그 주장을 지탱하는지 웹에서 재검증한다. 판정: 지지/부분지지/불지지.',
    out: '{checks: [{claim, verdict, evidence_url}]}',
  },
  {
    cat: '검증', id: 'redteam', type: 'red-team', lens: '출처신뢰도, 결론반증, 놓친관점',
    when: '표준 3렌즈 공격. 렌즈별 동시 실행 (adversarial verify 패턴)',
    prompt: '입력의 결론을 공격한다. 죽일 수 있으면 죽인다. 살아남은 것과 죽은 것을 명시한다.',
    out: '{verdicts: [{target, survives, kill_reason}]}',
  },
  {
    cat: '검증', id: 'devils.advocate', type: 'claude', model: 'opus',
    when: '결론이 틀렸다고 가정하고 최강 반론 1개를 구성. redteam보다 좁고 깊게',
    prompt: '입력의 결론이 틀렸다고 가정한다. 가장 현실적인 반론 하나를 정교하게 구성하고, 그 반론이 맞다면 관측될 신호를 명시한다.',
    out: '{objection, failure_path, observable_signal}',
  },
  {
    cat: '검증', id: 'assumption.buster', type: 'claude',
    when: '숨은 전제를 드러낼 때. 조사 시작 전(설계 검증)이나 결론 직전에',
    prompt: '입력이 암묵적으로 깔고 있는 전제를 전부 나열하고, 각 전제가 깨지면 결론이 어떻게 무너지는지 쓴다.',
    out: '{assumptions: [{assumption, if_broken}]}',
  },
  // ── 종합 ──────────────────────────────────────────────
  {
    cat: '종합', id: 'synthesizer', type: 'claude', model: 'opus',
    when: '병렬 갈래 합류점 (reduce 단계). 근거 노드 id 명시가 핵심',
    prompt: '갈래별 입력을 종합한다. 각 결론에 근거가 된 상위 노드 id와 URL을 명시한다. 갈래 간 모순은 숨기지 말고 드러낸다.',
    out: '{synthesis: [{point, evidence: [{from, url}]}], conflicts: [str]}',
  },
  {
    cat: '종합', id: 'deduper', type: 'claude', model: 'haiku',
    when: '갈래들이 겹치는 항목을 낼 때 병합 전에 정규화. 기계적 작업이라 haiku',
    prompt: '입력 항목들에서 중복·유사 항목을 병합하고 표기를 정규화한다. 내용 판단은 하지 않는다.',
    out: '{items: [str], merged_count: 0}',
  },
  {
    cat: '종합', id: 'scorer', type: 'claude',
    when: '고정 루브릭 채점. 루프 종료조건과 연결하는 게 정석. 기준은 실행 전 고정',
    prompt: '아래 고정 기준으로 채점한다. 결과가 마음에 안 들어도 기준을 바꾸지 않는다.\n  기준: (여기에 1점/3점 기준을 명시)',
    out: '{scores: [{item, total}], all_pass: 0}',
  },
  {
    cat: '종합', id: 'judge.panel', type: 'red-team', lens: '정확성, 유용성, 리스크',
    when: '다수결 판정 (debate/panel 패턴). 렌즈 3개가 독립 심사',
    prompt: '입력 후보를 렌즈 관점에서 심사한다. 각 후보에 pass/fail과 한 줄 사유.',
    out: '{votes: [{item, pass, why}]}',
  },
  {
    cat: '종합', id: 'decider', type: 'claude', model: 'opus',
    when: '최종 1개 선택. 반론·kill signal·검증 실험까지 내야 의사결정에 쓸 수 있다',
    prompt: '최종 1개를 추천한다. 근거 노드 id, 가장 강한 반론, 반론이 맞을 때의 관측 신호, 30일 내 검증 실험 1개를 포함한다.',
    out: '{pick, why, evidence: [str], strongest_objection, kill_signal, experiment}',
  },
  // ── 품질·루프 ──────────────────────────────────────────
  {
    cat: '품질·루프', id: 'critic', type: 'claude',
    when: 'self-refine: critic → 개선 노드로 loop 연결. 루프 피드백 주입과 조합',
    prompt: '입력의 약점을 심각도순 3개 이내로 지적한다. 각 지적에 구체적 개선 방향을 붙인다. 칭찬 금지.',
    out: '{issues: [{severity, problem, fix}], pass: false}',
  },
  {
    cat: '품질·루프', id: 'completeness', type: 'claude',
    when: '빠진 축 점검 (completeness critic). 조사 단계 뒤에 붙여 놓친 갈래를 잡는다',
    prompt: '지금까지의 조사에서 다루지 않은 축(모달리티·이해관계자·리스크·기간)을 나열한다. 각 축이 결론을 바꿀 가능성을 평가한다.',
    out: '{missing: [{axis, could_change_conclusion}]}',
  },
  {
    cat: '품질·루프', id: 'editor', type: 'claude', model: 'haiku',
    when: '최종 산출물 문체·형식 정리. 내용 변경 없음. 기계적이라 haiku',
    prompt: '내용을 바꾸지 않고 문체와 형식만 다듬는다. 중복 문장 제거, 용어 통일.',
    out: '{text}',
  },
  // ── 구현 ──────────────────────────────────────────────
  {
    cat: '구현', id: 'coder', type: 'codex',
    when: '코드 작성·수정. codex CLI가 실행한다',
    prompt: '요구사항대로 구현한다. 변경 파일과 핵심 diff를 보고한다.',
    out: '{files_changed: [str], summary}',
  },
  {
    cat: '구현', id: 'code.reviewer', type: 'claude',
    when: 'coder 뒤에 직렬로. 심각도 태그, 칭찬 없음',
    prompt: '변경 코드를 리뷰한다. 한 줄에 하나: 위치, 문제, 수정안. 형식 지적은 의미가 바뀔 때만.',
    out: '{findings: [{loc, severity, problem, fix}]}',
  },
  {
    cat: '구현', id: 'test.writer', type: 'codex',
    when: '재현 테스트 먼저 → 구현 노드로 연결 (test-first)',
    prompt: '요구사항을 검증하는 최소 테스트를 작성하고 실행 결과를 보고한다.',
    out: '{tests: [str], result}',
  },
]

export const ROLE_CATS = [...new Set(ROLES.map((r) => r.cat))]
