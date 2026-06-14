# AI Tistory Writer 🤖✍️

주제만 적어두면 **AI가 글을 쓰고 티스토리에 매일 자동 발행**하는 봇입니다. (무료 Gemini로 시작, 한 줄 설정으로 유료 Claude 전환)
평소엔 내 PC가 발행하고, **PC가 꺼져 있으면 GitHub Actions가 대신** 발행합니다(이중 안전망).

```
[topics.json 주제 큐] → [AI가 글 작성] → [Playwright로 티스토리 발행] → [매일 06:00 / 22:00]
```

---

## 동작 방식

- **매일 아침 6시 / 저녁 10시**, `topics.json` 에서 다음 주제를 꺼내 AI가 글을 작성하고 발행합니다.
- 티스토리 공식 API는 사실상 종료되어, **브라우저 자동화(Playwright)** 로 발행합니다. 최초 1회만 직접 로그인해 세션을 저장합니다.
- **중복 방지**: PC와 GitHub가 둘 다 돌아도 `state.json` 의 "오늘 이 시간대 발행됨" 기록으로 한 번만 발행됩니다. GitHub는 PC보다 15분 늦게 실행되어 PC에 우선권을 줍니다.

---

## 처음 한 번만: 설정 (약 10분)

### 1. 의존성 설치
```powershell
npm install
npx playwright install chromium
```

### 2. API 키 설정
`.env.example` 을 `.env` 로 복사합니다.
```powershell
Copy-Item .env.example .env
```
기본 provider 는 **무료인 Google Gemini** 입니다. `.env` 의 `GEMINI_API_KEY` 에 키를 넣으세요.
(키 발급: https://aistudio.google.com/apikey — 무료)

> **유료(Claude)로 전환:** `config.json` 의 `llm.provider` 를 `"claude"` 로 바꾸고
> `.env` 의 `ANTHROPIC_API_KEY` 를 채우면 됩니다. (키 발급: https://console.anthropic.com)
> provider 별 모델은 `config.json` 의 `llm.models` 에 정의돼 있습니다.

### 3. 내 블로그 주소 설정
`config.json` 의 `tistory.blogName` 을 **본인 블로그 주소**로 바꿉니다.
예: 블로그가 `https://myblog.tistory.com` 이면 → `"blogName": "myblog"`

### 4. 티스토리 로그인 세션 저장 (최초 1회)
```powershell
npm run login
```
브라우저가 열리면 평소처럼 로그인(카카오 로그인 포함)을 끝내고, 터미널에서 **Enter** 를 누릅니다.
→ `storage_state.json` 이 생성됩니다. (이 파일은 비밀번호급 정보라 git에 올라가지 않습니다.)

### 5. 테스트 (발행하지 않고 글만 확인)
```powershell
npm run dry
```
`output/` 폴더에 미리보기 HTML이 생깁니다. 브라우저로 열어 글 품질을 확인하세요.

### 6. 실제 발행 한 번 테스트
```powershell
npm run post:morning
```
> 💡 티스토리 에디터 화면 구조가 바뀌면 발행이 실패할 수 있습니다. 그럴 땐
> `node src/main.js --slot morning --headful` 로 **브라우저를 띄워서** 어디서 막히는지 보고,
> `config.json` 의 `selectors` 값을 실제 화면에 맞게 조정하세요. 실패 시 `logs/` 에 스크린샷이 남습니다.

---

## 매일 자동 실행 설정

### A. 내 PC (윈도우 작업 스케줄러)
PowerShell에서 한 번만 실행:
```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-task-scheduler.ps1
```
→ 매일 06:00 / 22:00 자동 실행 작업이 등록됩니다. (예약 시각에 PC가 꺼져 있었다면 켜진 직후 실행)

### B. GitHub Actions (PC가 꺼져 있을 때 백업)
1. **세션을 secret 으로 등록**
   ```powershell
   npm run export-session
   ```
   출력된 긴 문자열을 복사 → GitHub 저장소 **Settings → Secrets and variables → Actions → New repository secret**
   - 이름: `TISTORY_STORAGE_STATE`, 값: 복사한 문자열
2. **API 키도 secret 으로 등록**
   - 무료(기본): 이름 `GEMINI_API_KEY`, 값: Gemini API 키
   - 유료 전환 시: 이름 `ANTHROPIC_API_KEY`, 값: Claude API 키
3. 코드를 GitHub에 푸시하면 끝. (`.github/workflows/publish.yml` 이 매일 06:15 / 22:15 KST 실행)

> ⚠️ 카카오 로그인 세션은 시간이 지나면 만료됩니다. GitHub 발행이 실패하기 시작하면
> `npm run login` 으로 다시 로그인하고 `npm run export-session` 으로 secret 을 갱신하세요.

---

## 주제 추가하기

`topics.json` 에 항목을 추가하면 됩니다. `status` 가 `pending` 인 것부터 순서대로 발행됩니다.
```json
{
  "topic": "글로 쓸 주제",
  "instructions": "말투, 대상 독자, 포함할 내용 등 간단한 요청",
  "status": "pending"
}
```

---

## 명령어 모음

| 명령 | 설명 |
|------|------|
| `npm run login` | 티스토리 로그인 세션 저장(최초 1회/세션 만료 시) |
| `npm run dry` | 발행하지 않고 글만 생성해 `output/` 에 미리보기 저장 |
| `npm run post` | 현재 시간대 슬롯으로 발행 |
| `npm run post:morning` / `:evening` | 특정 슬롯으로 강제 발행 |
| `npm run export-session` | 세션을 base64로 출력(GitHub secret용) |

추가 플래그: `--headful`(브라우저 표시), `--force`(중복 방지 무시), `--dry-run`(발행 안 함)

---

## 설정값 (`config.json`)

- `llm.provider`: `gemini`(무료, 기본) 또는 `claude`(유료). **이 한 줄만 바꾸면 전환됩니다.**
- `llm.models`: provider 별 모델. 기본 `gemini: gemini-2.0-flash`, `claude: claude-sonnet-4-6`. 더 좋은 Claude 품질은 `claude-opus-4-8`.
- `tistory.blogName`: 블로그 주소 앞부분.
- `tistory.publish`: `false` 로 두면 발행 직전까지만 하고 멈춤(테스트용).
- `tistory.publishVisibility`: `public`(공개) / `private`(비공개).
- `schedule.slots`: 아침/저녁 시간대 범위(슬롯 자동 판별용).
- `selectors`: 티스토리 에디터 요소 셀렉터(에디터 변경 시 조정).
- `gitSync`: `true` 면 발행 후 state를 git에 자동 커밋·푸시(PC↔GitHub 동기화).

---

## 비용 (대략)

- **Gemini(기본, 무료):** 무료 등급으로 하루 1~2편은 비용 0원. 무료 한도(분당/일일 요청 수)만 지키면 됩니다.
- **Claude(유료 전환 시):** Sonnet 기준 글 1편(약 2천 자) 보통 **수십 원**, 하루 2편이면 한 달 **1~2천 원 내외**(모델에 따라 변동, Opus는 더 비쌈).

---

## 주의사항

- 자동 발행 글이라도 **가끔 직접 검토**하세요. 사실 오류나 어색한 부분이 있을 수 있습니다.
- 티스토리 정책상 과도한 자동 발행/도배는 제재 대상이 될 수 있습니다. 하루 1~2편을 권장합니다.
- `storage_state.json`, `.env` 는 **절대 공개 저장소에 올리지 마세요** (`.gitignore`에 이미 포함).
