# Dialogue Harness — ARIS 기반 OMP 플러그인

**Dialogue Harness is an ARIS-based OMP plugin.**

[ARIS](https://github.com/wanshuiyin/auto-claude-code-research-in-sleep)의 원본 스킬 87개를 OMP의 native 에이전트·도구·대화 UI에 연결하는 독립 플러그인입니다. **Fable Brain → Opus Worker + Astra 독립 검토자 → Fable 최종 종합**으로 연구 작업을 실행하고, 일반 작업은 Astra가 주도합니다. Terra가 경로와 **실행 Wave의 수·목표·병렬도**를 함께 결정합니다. 모델·추론 강도, OMP 본체·공통 하네스·인증·재귀 설정은 변경하지 않습니다.

- 저장소: [myunhh/dialogue-harness](https://github.com/myunhh/dialogue-harness)
- 플러그인 ID: `omp-agent-dialogue` · 명령: `/dialogue`
- 기반 프로젝트: ARIS 원본 스킬·보조 파일을 고정 commit으로 포함하며, 원본 MIT 라이선스는 [`ARIS-LICENSE`](ARIS-LICENSE)에 보존합니다. ARIS·OMP 공식 배포판과는 별개의 적용판입니다.

## 설치와 사용

Node.js 22 이상, OMP 18.15.0 이상이 필요합니다.

```sh
git clone https://github.com/myunhh/dialogue-harness.git
cd dialogue-harness
node install.mjs
```

현재 OMP에서 진행 중인 작업을 마친 뒤:

```text
/reload-plugins
/dialogue skills
/dialogue models
/dialogue on
```

- `/dialogue skills`: 설치된 ARIS 스킬 87개, 원본 commit, 설치 경로와 모델·native task 준비 상태.
- `/dialogue models`: Fable → Opus → Astra 순서로 선택. 어느 단계에서든 취소하면 세 선택 모두 유지.
- `/dialogue fable [provider/model]`, `/dialogue opus [provider/model]`, `/dialogue astra [provider/model]`: 역할별 모델 변경. 인자를 생략하면 선택창.
- `/dialogue status`: 현재 모드·모델·설치 상태.
- `/dialogue flow`: Wave 카드 그래프를 전체 화면으로 열고, 노드별 모델·native 작업 ID·작업 지시·공개 결과 원문을 확인.
- `/dialogue stop`: 진행 중인 라우팅 또는 확장이 시작한 실행 중단.
- `/dialogue off`: 다음 요청부터 자동 라우팅 해제. 이미 시작한 실행과 현재 모델은 유지.

새 세션은 기본 OFF입니다. 같은 세션·브랜치를 재개하면 기존 모드와 세 역할의 모델 선택을 복원합니다. 구버전(상태 v1–3)은 Fable 기본값을 추가하고, 이전 기본 selector `anthropic/claude-opus-4-6`을 Opus 5.5로 전환합니다. 다른 사용자 지정 selector와 상태 v4에서 명시한 선택은 유지합니다. 실행 전 설치·모델 검사를 다시 수행하며, `/dialogue agents` 대신 `/dialogue skills`를 사용합니다.

예시:

> ARIS research-review로 이 연구 초안을 검토해 줘. 먼저 한 라운드만 진행하고, 수용한 지적·반박·남은 이견을 구분해 줘.

> ARIS experiment-plan으로 이 가설을 구분할 실험을 설계해 줘. 실제 실험은 실행하지 마.

스킬 이름을 지정할 필요는 없습니다. `/dialogue on` 상태에서 평소처럼 작업을 요청하면 Terra가 내용과 최근 대화를 보고 선택합니다. 실험 실행·학습·평가·seed/config 배치·의존 작업 큐·밤샘 자율 개선은 명령이 단순해도 ARIS로 보냅니다. “그거 밤새 돌려줘” 같은 후속 요청도 앞선 작업을 이어받습니다.

| 요청 의도 | 기본 선택 |
| --- | --- |
| 지정된 실험·학습 실행 | `run-experiment` |
| 여러 seed/config, 의존 단계·작업 큐 | `experiment-queue` |
| 이미 실행 중인 작업 관찰 | `monitor-experiment` |
| 기존 연구를 검토·수정·재검토하며 자율 개선 | `auto-review-loop` |
| 아이디어 탐색부터 실험·검토까지 전체 자율 연구 | `research-pipeline` |

계획만 요청하면 실행 스킬을 선택하지 않습니다. 파일명·설명에 “실험”, “overnight”가 있다는 이유만으로 일반 코드 수정이나 설정 변경을 실험 실행으로 취급하지 않습니다. 환경 정보가 부족해도 ARIS 경로를 유지하며 실행자가 프로젝트의 실제 자원·권한·필수 입력을 확인합니다. 요청한 시간·라운드·비용 한도와 스킬의 종료 조건을 따르며, 밤샘 요청을 무한 반복이나 새 유료 자원 임대로 해석하지 않습니다.

OMP의 개별 스킬 slash command를 직접 실행하면 Dialogue 입력 라우팅을 거치지 않으므로 아래 OMP 리뷰어 변환 계약이 자동 적용되는 경로와 구분해야 합니다.

## 실행 계약

1. **설치 검사:** `/dialogue on`과 활성 입력에서 원본 스킬·공통 참조·도구·템플릿의 누락·잘림·실행 권한 손실을 확인합니다. 불완전하면 모델 호출 전에 차단합니다. 설치 파일 검사는 외부 서비스 인증이나 Python 의존성 검사가 아닙니다.
2. **Terra 라우팅·Wave 설계:** `openai-codex/gpt-6.1-terra`의 `xhigh`로 일반 작업 또는 ARIS 스킬 1–4개와 순서 있는 실행 Wave를 선택합니다. 단계별 ID·제목·목표·동시 작업 수(1–4)를 필수 JSON `waves`에 담습니다. 위임이 불필요하면 `[]`, 필요하면 최대 12단계이며 고정 개수로 채우지 않습니다. 실험·자율 작업과 명시적 두 모델 검토는 기존 ARIS 분류를 유지합니다. 잘못된 JSON·미등록 스킬·잘못된 Wave 계획은 실행하지 않습니다.
3. **스킬 적용과 Brain:** 선택된 `SKILL.md` 원문 전체와 설치 경로를 로드하고, OMP 적용 계약을 뒤에 붙여 **사용자 요청 전달 전에** 제공합니다. 일반 작업은 Astra, ARIS 작업은 Fable을 실제 세션 모델로 선택합니다. Fable이 분석·아이디어 발산·가정과 판단 기준·작업 계획·최종 종합을 맡습니다. 분석·계획만 요청하면 Worker를 강제 호출하지 않습니다.
4. **실행과 독립 검토:** 구체 실행은 native `task`의 `aris-worker`에 목표·파일·인터페이스·사용자 제약·완료 검사로 한정한 작업 패킷을 전달합니다. 확장이 Opus 모델과 `medium` 강도를 고정합니다. 원본 스킬의 전용 리뷰 호출은 native `aris-reviewer`로 바꾸며 Astra와 `max`를 고정합니다. 검토자는 `read`, `grep`, `glob`만 사용하고 원본 파일·중립 브리프를 직접 읽습니다. Worker는 재위임·검토·연구 주장 채택을 하지 않으며, Brain이 검토를 직접 요청하고 최종 답변을 작성합니다.
5. **라운드 연속성:** native task는 새 스레드입니다. 이후 라운드에는 검증된 이전 검토 출력 전체를 자동 첨부하며, 실행자가 근거 있는 응답과 변경 사항을 제공합니다. 원본 MCP threadId 재사용과 동일하다고 주장하지 않습니다. 라운드 수는 스킬과 사용자 범위를 따릅니다.
6. **완료 근거:** 실제 완료 결과, 일치하는 host 모델 메타데이터, 비어 있지 않은 공개 출력이 있어야 검토 라운드로 인정합니다. 직접 task 결과와 wait의 `resultText`, OMP의 `async-result` 자동 전달을 처리합니다. 자동 전달은 현재 실행에서 관측한 작업 ID·모델에 연결하고 같은 `agent://`의 게시된 최종 출력을 읽습니다. 긴 결과의 `<preview full-output="agent://…">`도 같은 작업의 원문 전체를 읽어 현재 Brain과 다음 검토 라운드에 전달합니다. 원문 수신 중에는 실행 중 상태를 유지합니다. 모델 불일치·빈 검토·읽기 실패·다른 원문은 실패이며 자동 재시도하지 않습니다. 상태만 있는 완료 알림은 결과를 대신하지 못합니다. 필요한 리뷰가 없으면 `incomplete`, 호출한 Worker나 리뷰가 실패하면 flow도 `failed`입니다.
7. **권한과 의미:** 스킬 선택은 무인 실행·실험·학습·설치·배포에 대한 추가 승인이 아닙니다. 사용자 요청과 프로젝트 권한을 유지합니다. 검토 완료는 주장 수용·과학적 입증이 아니며, 이견을 강제로 합의로 바꾸지 않습니다.

### Wave 실행 규칙

1. **Wave 0=Terra, Wave 1=메인 조정자, Wave 2부터=Terra가 정한 실행 단계.** 같은 단계의 독립 작업은 병렬 실행합니다. 모든 앞 단계 작업이 성공하고 비어 있지 않은 공개 결과 전문을 받은 뒤 다음 단계를 시작합니다. 완료 상태 알림만으로는 다음 단계가 열리지 않습니다.
2. 메인이 native `task`로 모든 단계를 직접 호출합니다. 작업 이름은 `<Wave ID>__<작업명>`(총 32자 이하)이며, 접두사를 생략하면 현재 단계에 속합니다. 이름을 생략하면 확장이 충돌 없는 이름을 예약합니다. 예: `Gather__Package`, `Check__Evidence`.
3. 하나의 배치에는 같은 Wave만 넣습니다. 확장이 호출 전에 이름과 병렬 슬롯을 예약해 초과 실행, 단계 건너뛰기, 완료한 이전 단계 재진입을 차단합니다. 자식 재위임과 `eval agent()`/`workpool` 대체 호출도 차단하며 재귀 한도를 높이지 않습니다.
4. 검토 반복·스킬 내부 루프는 해당 Wave 안에서 새 작업 이름으로 이어가고 사용자·스킬의 종료 조건을 따릅니다. 실패·취소한 작업을 자동 재시도하거나 다음 단계로 넘기지 않습니다. 실행하지 않은 계획 Wave는 완료로 표시하지 않습니다.
5. 구체 파일·명령·작업 패킷은 메인이 근거를 확인한 뒤 작성합니다. Wave 계획은 추가 실행 권한이 아니며 ARIS 역할 고정·독립 검토·결과 검증은 유지합니다.


### 모델별 역할과 기본값

| 역할 | 기본 selector · 강도 | 역할 지침에 반영한 특성 |
| --- | --- | --- |
| Fable Brain | `anthropic/claude-fable-5-2` · `high` | 심층 추론·장기 연구: 자료 분석, 서로 다른 아이디어와 가정 비교, 최소 변별 증거, 작업 패킷 설계·종합. 과도한 위임이나 계획 단계에서의 조기 종료를 피함 |
| Opus Worker | `anthropic/claude-opus-5-5` · `medium` | 효율적인 agentic coding·도구 실행: 범위가 정해진 구현·수집·측정·검증을 끝내고 실제 산출물·검사 결과를 반환 |
| Astra | `openai-codex/gpt-6-astra` · `max` 고정 | 복잡한 추론·코드·연구: 일반 작업 직접 처리, ARIS에서는 가정·논리·수치·코드 불변식·반례를 원본 근거로 독립 검토 |

근거: [Fable 5.2 개요](https://platform.claude.com/docs/en/models/fable-5-2/overview), [Fable 프롬프트 지침](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-2), [Opus 5.5](https://www.anthropic.com/claude-opus-5-5), [Astra API 문서](https://developers.openai.com/api/docs/models/gpt-6-astra). 역할 배치는 이 확장의 설계이며 모델 간 우열을 검증했다는 뜻은 아닙니다. Fable·Opus 강도는 공급자 기본값을 유지하고, Astra는 사용자 요청에 따라 일반 작업과 독립 검토 모두 `max`로 고정합니다. 호출자가 낮은 강도를 지정해도 검토자 spawn에는 `max`를 적용하며, 선택한 Astra 모델이 `max`를 지원하지 않으면 실행을 차단합니다.

모델·강도는 현재 세션에만 적용하며 전역 기본값은 바꾸지 않습니다. 요구 강도를 지원하지 않거나 모델을 사용할 수 없으면 자동 대체하지 않습니다. Terra 라우팅과 Worker·검토에는 추가 모델 사용량이 발생합니다. 라우팅에는 최근 텍스트 최대 24,000자와 요청·이미지가 전달됩니다. Fable 5.2의 데이터 보존 조건은 공급자 문서를 확인하세요.

취소·세션 이동 시 늦게 도착한 결과로 새 작업을 실행하지 않습니다. 같은 세션의 compaction은 진행 중인 native 검토 추적을 보존합니다. 시각화는 UI 전용이며 추가 모델 응답을 만들지 않습니다. 이전 3.x flow는 과거 기록으로 남으며 ARIS 검토 기록으로 재해석하지 않습니다.

## Agent Flow 그래프

- 입력창 위에는 **Terra 실행 Wave별 카드와 진행 순서 연결선**을 표시합니다. Wave는 재귀 깊이가 아닙니다. 모든 단계의 작업이 메인의 직접 자식이어도 서로 다른 Wave에 표시됩니다. 실제 부모 ID와 위임 깊이는 상세 화면에 별도로 보존합니다.
- 새 실행에서는 메인이 native `task`로 단계별 작업을 호출합니다. 일반 에이전트의 자동 완료·게시된 결과를 추적하며, 다른 실행·중단된 실행의 이벤트는 섞지 않습니다. Wave 계획이 없는 이전 저장 기록은 기존 위임 깊이로 표시하고 새 실행 단계로 재해석하지 않습니다.
- 카드에는 작업 이름·역할·모델·상태·관측 경과 시간·공개 요약을 표시합니다. 노드가 많으면 **카드 → 압축 카드 → 한 줄**로 밀도를 조절합니다. 아직 호출하지 않은 Terra Wave는 `예정`으로 표시하며 실제 호출·완료 집계에 넣지 않습니다.
- **`/dialogue flow` → 방향키/Tab으로 노드 선택 → Enter로 상세보기.** `←→`는 Wave, `↑↓`는 같은 Wave를 이동합니다. `PgUp/PgDn`은 화면 밖 노드로 페이지 이동하고 `Home/End`는 첫/마지막 노드로 이동합니다. 좁은 터미널은 전체 노드 목록을 사용합니다. 화면에 다 담지 못하면 현재 범위와 숨은 수를 표시하며, 모든 노드는 이동·상세보기가 가능합니다. 입력창 위 위젯은 높이를 제한합니다.
- 상세 화면에는 정확한 모델, 작업 ID, 부모 관계, 관측 시각, 공유 문맥·작업 지시, 공개 출력·오류 전문을 표시합니다. `↑↓`·`PgUp/PgDn`으로 스크롤하고 `Home/End`로 처음/끝을 봅니다. `Tab`은 다음 노드, `Enter`는 게시된 native 출력 다시 읽기, `Esc`는 카드로 복귀, `q`는 화면 닫기입니다. **화면을 닫아도 실행은 계속됩니다.**
- 실행 이벤트가 오면 열린 그래프와 상세 화면도 갱신합니다. 공개 텍스트만 저장하고 private thinking·도구 호출 본문은 표시하지 않습니다. 이전 기록에 없는 작업·원문·시각은 만들어 내지 않으며, 알려진 작업 ID의 게시된 출력은 필요할 때 읽습니다. 시간은 호스트가 관측한 구간이며 실제 작업의 내부 실행 시간을 보증하지 않습니다. 시각화·원문 읽기는 모델을 호출하지 않습니다.


## 설치 내용과 원본

- 원본: `wanshuiyin/auto-claude-code-research-in-sleep`
- 고정 commit: `2927b40b2ea37774de53763338c5e8f91a7601e6`
- `skills/`: 기본 스킬 87개와 `shared-references/`. Codex별 중복·legacy overlay는 제외.
- `tools/`, `templates/`: 원본 보조 파일. 설치 스크립트도 원본 자료로 포함되지만 이 설치 과정에서는 실행하지 않습니다.
- `ARIS-LICENSE`: 원본 MIT 라이선스. 스킬 내부 별도 라이선스도 보존.
- `aris-provenance.json`: 출처·commit·배포 파일 목록과 크기·실행 권한.

공식 plugin-root `skills/`·`agents/` 검색을 사용합니다. `install.mjs`는 코드·스킬·보조 파일을 `~/.local/share/omp-agent-dialogue/4.4.0-<fingerprint>/`에 독립 복사한 뒤 `omp plugin link`로 연결합니다. 이 작업공간이나 다운로드 clone을 지워도 설치본은 유지됩니다. upstream 업데이트는 자동 반영하지 않습니다.

**OMP 적용판의 경계:** 원본 파일은 보존하지만 원본 Claude/Codex MCP 서버, `reviewer_route.py`/`review_gate.py`의 백엔드 승인, Copilot native 증명은 사용하지 않습니다. OMP 결과를 원본 ARIS의 인증된 acceptance로 기록하지 않습니다. 검색·LaTeX·GPU·외부 API 등 스킬별 선택적 의존성은 별도이며, 없으면 해당 작업에서 부족한 조건을 보고해야 합니다. `aris-fanout-leaf`는 설치하지 않았으므로 해당 스킬의 순차 실행 대안을 사용합니다. 모델·도구 API의 미래 호환성까지 보장하지 않습니다.

## 기존 에이전트 보존과 복구

RH 역할 24개와 `dialogue-review`, `dialogue-synthesis`, `dialogue-agreement`는 활성 `agents/`에서 제거했습니다. 이 확장이 등록하는 에이전트는 `aris-worker`와 `aris-reviewer`입니다. Fable Brain은 메인 세션입니다. 다른 플러그인이나 프로젝트의 에이전트 정의는 변경하지 않습니다. ARIS 실행 안에서는 이전 `rh-*`·`dialogue-*` 역할 호출을 차단합니다.

이전 RH·paired 구현은 개발 작업공간의 `workspace/dialogue-legacy-3.1.1/`에만 보관하며 이 공개 저장소에는 포함하지 않습니다. 설치기는 이전 불변 설치본을 삭제하지 않습니다. 복구하려면 본인이 보유한 이전 설치 경로를 `omp plugin link`에 지정한 뒤 OMP에서 `/reload-plugins`를 실행하세요.

설치 명령은 실행한 호스트만 변경합니다. 다른 호스트에는 같은 배포 파일을 동기화한 뒤 그 호스트에서 `node install.mjs`를 실행합니다.

## 검증

```sh
node --test test/*.test.js
```

위 명령은 저장소 루트에서 실행합니다. 아래의 `runs/` 경로는 개발 작업공간의 검증 기록이며, 세션·실행 기록·인증 설정은 이 공개 저장소에 포함하지 않습니다.

역할·모델 선택·상태 복원·취소·완료 근거를 검증합니다. 4.2.0에서는 대상 모듈 테스트 60개를 통과했고 자동 전달 수정 후 controller 테스트 37개(새 회귀 3개 포함)를 통과했습니다. 실제 OMP 18.18.6에서 Terra → Fable 5.2 → Opus 5.5 Worker → Astra 독립 검토 → Fable 답변을 실행해 flow `completed`를 확인했습니다. 합성 입력의 산술 검사이며 실제 성능 실험이 아닙니다. 실제 TUI 예정·실행·실패·상세 화면과 20/40/80/120열 24개 렌더링 조합도 확인했습니다. 근거는 `runs/dialogue-brain-worker-verified.json`, `runs/dialogue-brain-worker-render.json`, `runs/dialogue-brain-worker-tui-*.txt`입니다. 최초 실행에서 발견한 자동 전달 미추적은 `runs/dialogue-brain-worker-native.json`에 그대로 보존합니다. 한 스킬의 성공이 모든 외부 연동 스킬의 실행 성공을 뜻하지 않습니다.

4.2.1에서는 controller/runtime 검사로 Astra 단독 실행의 `max`, 검토자 spawn의 `:max` 고정, `max` 미지원·지원 소실 시 호출 차단을 확인했습니다. Fable `high`, Opus `medium`, Terra `xhigh`는 유지합니다.

4.3.0에서는 flow/controller 검사 61개를 통과했습니다. 실제 OMP 18.18.8 TUI에서 합성 공개 이벤트로 Wave 카드, 노드 이동, 작업 지시·140행 결과의 끝까지 스크롤, 실행 중 실패 갱신, 닫기 후 실행 유지와 40열 리사이즈를 확인했습니다. 1/10/20/40/80/120/160열 × 6/12/24/42행의 28개 렌더 크기를 검사했습니다. 이 UI 검증은 새로운 모델 추론이나 연구 결과 검증이 아닙니다. 근거: `runs/dialogue-wave-runtime.json`, `runs/dialogue-wave-tui-*.txt`.

4.3.1에서는 일반 작업의 자동 완료, 이름 없는 eval, 중첩 부모 관계, 외부·취소·이전 실행 격리, 완료 알림 뒤 원문 도착을 포함한 flow/controller 69개 사례를 확인했습니다(최초 67개 통과, 실패 2개 수정 후 해당 2개 재검사 통과). 실제 OMP 18.18.8에서 합성 호스트 이벤트로 12개 형제·2개 하위 작업을 표시했고, 112개 렌더 크기/모드 조합의 폭·높이 경계를 통과했습니다. 이는 유료 서브 에이전트 14개의 실제 수행이나 연구 결과 검증을 뜻하지 않습니다. 근거: `runs/dialogue-all-agents-runtime.json`.

4.4.0에서는 protocol/Wave/controller/flow의 81개 사례를 확인했습니다. 최초 78개 통과 후 새 예약 계약에 맞게 기존 검토 fixture 두 개를 완료시키고 위치 의존 문자열 검사를 제거하여 나머지 3개도 대상 재검사에서 통과했습니다. 실제 Terra 한 번의 호출이 수집→대조→검사→문안 작성 4단계와 병렬도 2/1/1/1을 설계했습니다. 실제 OMP TUI에서 Wave 0–5, 예정·실행·완료, 단계 이동·상세·공개 결과 끝, 60열 목록을 확인했습니다. **작업자 결과는 UI 검증용 합성 이벤트이며 실제 작업자 모델 실행을 뜻하지 않습니다.** 근거: `runs/dialogue-terra-waves-runtime.json`, `runs/dialogue-terra-waves-*.txt`.
