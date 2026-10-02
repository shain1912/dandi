---
name: dandi-deploy
description: 교사가 만든 정적 웹사이트(미니앱) 폴더를 Dandi 허브에 올리고 등록합니다. 로그인 상태를 확인하고 필요하면 브라우저 승인으로 로그인한 뒤, 빌드 결과 폴더를 바로 비공개 미리보기로 올리고, 교사가 답한 등록 정보와 셀프점검 5문항으로 허브에 등록합니다. 토큰을 붙여 넣지 않습니다. Use when the user asks to publish, deploy or upload a site, web app or mini app to Dandi or the Dandi hub, or pastes a Dandi llms.txt link. Triggers include Dandi에 올려줘, 단디에 올려줘, 내 사이트 올려줘, 이 폴더 허브에 올려줘, 허브에 등록해줘, 미니앱 공유해줘, publish to Dandi, deploy my site to the hub, upload this folder to Dandi, share my mini app.
---

# dandi-deploy (Dandi v0.2, 스킬 1.3.0과 같은 흐름)

교사가 만든 정적 사이트 폴더(맨 위에 index.html이 있는 폴더)를 Dandi 허브에 올리고 미니앱으로 등록하는 스킬입니다. 이 파일은 허브 주소를 HUB로 적은 요약본이고, 실제 명령과 순서는 허브의 런북(HUB/llms.txt)이 정합니다. 교사에게는 쉬운 한국어 합니다체로 말하고, 주소는 한 줄에 하나씩 고치지 않고 보여 줍니다.

허브 주소가 들어간 최신판은 한 줄로 설치할 수 있습니다(Claude Code·Cursor·Codex·Antigravity·Grok에 함께 설치합니다). 이미 Dandi CLI를 쓰고 있다면 `CLI setup` 으로도 설치됩니다.

```
npx -y skills@latest add HUB/.well-known/agent-skills/dandi-deploy --skill dandi-deploy -a claude-code -a cursor -a codex -a antigravity-cli -a grok --copy
```

직접 넣을 때의 위치: Claude Code는 `.claude/skills/dandi-deploy/SKILL.md`, Codex·Cursor·Antigravity는 `.agents/skills/dandi-deploy/SKILL.md`, Grok은 `.grok/skills/dandi-deploy/SKILL.md` 입니다.

## 0. 허브 주소와 런북

1. 허브 주소(HUB)를 확인합니다. 교사가 준 Dandi 주소나 llms.txt 링크의 앞부분(예: https://dandi.example.kr)입니다. 모르면 교사에게 묻고, 추측하지 않습니다.
2. Windows PowerShell이면 먼저 `[Console]::OutputEncoding=[Text.Encoding]::UTF8`을 실행합니다. 그러지 않으면 런북과 CLI 출력의 한국어가 깨집니다. `--json` 출력은 `ConvertFrom-Json`으로 읽습니다(PowerShell·cmd에서는 한글이 \uXXXX 형태로 적혀 나옵니다).
3. 런북 원문을 읽습니다. 요약하지 말고 원문 그대로 읽으십시오.
   - Git Bash·bash·zsh: `curl -s HUB/llms.txt`
   - Windows PowerShell: `curl.exe -s HUB/llms.txt`
   - 공개 HTTPS 허브라면 웹 읽기 도구로 읽어도 됩니다. localhost·내부망(http) 허브는 웹 읽기 도구가 열지 못하므로 위 명령을 씁니다.
4. 런북에 적힌 CLI 접두어(`npx -y HUB/dandi-<버전>.tgz`)를 모든 명령에 그대로 씁니다. 버전 부분은 CLI가 바뀔 때마다 달라지므로 이 파일이나 기억에 있는 값을 쓰지 않습니다. 아래에서는 이 접두어를 `CLI`로 줄여 적습니다(실행할 때는 접두어 전체를 씁니다). 접두어가 404로 실패하면 런북을 다시 읽고, whoami 결과에 cli_update가 있으면 cli_update.prefix를 씁니다.
5. 셸에 따라 npx를 고릅니다. Git Bash·macOS·Linux: npx / Windows PowerShell·cmd: npx.cmd — CLI가 주는 next_step에는 알맞은 쪽이 이미 들어 있으므로 next_step은 그대로 실행합니다. Git Bash(Windows의 Claude Code가 쓰는 셸)에서 npx.cmd를 쓰면 공백이 든 폴더 이름 같은 인자가 깨지므로 쓰지 않습니다. PowerShell은 기본 실행 정책이 npx.ps1을 막으므로 npx.cmd를 씁니다.
6. 모든 명령에 `--json` 을 붙입니다. 오류에는 hint와 다음 명령(next_step, 또는 채워서 쓸 next_step_template)이 함께 옵니다.

## 1. 로그인 확인과 로그인(브라우저 승인)

1~2단계는 확인 질문 없이 바로 진행합니다.

1. `CLI whoami --json` - 종료 코드 0이면 2단계로, 4이면 로그인합니다.
2. `CLI login --hub HUB --json` - 종료 코드 5와 `"done":false`가 나옵니다(아직 로그인 전). `verification_uri_complete` 주소를 한 줄에 그대로 보여 주고 "위 링크를 열고, 코드가 <user_code>와 같으면 [승인]을 누르십시오."라고 말합니다.
3. 차례를 끝내지 말고 같은 차례에서 바로 next_step(`CLI login --wait --json`)을 실행합니다. 이 명령이 최대 90초 동안 승인을 기다리므로, 백그라운드로 돌리거나 교사의 답을 기다리며 멈추지 않습니다. 0이면 다음 단계, 5이면 같은 명령을 다시 실행합니다. 6(거부)이면 교사에게 다시 로그인할지 먼저 묻고, 원할 때만 처음부터 합니다. 7(만료)이면 한 번만 처음부터 다시 하고, 또 실패하면 멈추고 알립니다.
4. 토큰, 비밀번호, API 키를 채팅에 붙여 넣으라고 요청하지 않습니다. 로그인은 브라우저에서만 합니다.

## 2. 바로 올리기(비공개 미리보기)

1. package.json에 build 스크립트가 있으면 먼저 빌드합니다(예: npm run build). 그다음 `CLI deploy --json` 을 실행합니다. 폴더를 적지 않으면 dandi.json의 outputDir, dist, build, out, 현재 폴더 순으로 맨 위에 index.html이 있는 곳을 고릅니다. package.json이 있는 프로젝트 폴더 자체는 올리지 않습니다. 교사가 폴더를 말했으면 `CLI deploy "<폴더>" --json` 처럼 적고, 어느 폴더가 사이트인지 알 수 없을 때만 묻습니다.
2. `previewUrl`을 한 줄에 보여 주고 "비공개 미리보기입니다. 아직 허브에 공개되지 않았습니다."라고 말합니다.
3. `warnings`(개인정보로 보이는 값)와 `skipped`(올리지 못한 파일)가 있으면 파일 이름을 교사에게 알립니다. 한글·워드·엑셀 파일은 허브 자료실(HUB/files)에 올리거나 PDF로 바꾸도록 권합니다. `notes`는 참고 사항(예: 공개하지 않은 빌드 설정 파일)이고 개인정보 경고가 아닙니다.
4. 종료 코드 20의 `secret_detected`: 오류의 hint를 그대로 전합니다. 허브의 안내 문장은 하나입니다. "Dandi 사이트 호스팅은 정적 파일만 제공하므로 키를 보관할 수 없습니다. AI 기능은 서버 프록시(HUB/downloads/ai-proxy-example.md)를 따로 배포해 publish --url로 등록하거나, AI 호출을 빼십시오. 키를 숨기거나 나눠서 검사를 피하지 마십시오."
5. `source_folder`(빌드 전 소스 폴더)이면 빌드한 뒤 결과 폴더를 올립니다. 이 폴더를 그대로 올려야 한다고 교사가 확인한 경우에만 `--allow-source`를 붙입니다.
6. `site_not_found`(dandi.json의 siteId가 지금 로그인한 계정에 없음): 바로 새 사이트를 만들지 않습니다. 오류에 나온 계정 이름을 말하고 "지금 <이름> 계정으로 로그인되어 있습니다. 이 사이트를 올린 계정이 맞습니까?"라고 먼저 묻습니다. 아니면 `CLI login --force --json`으로 맞는 계정에 다시 로그인한 뒤 다시 올립니다. 새 사이트로 올리자고 교사가 확인한 경우에만 next_step_template(`--new-site`)을 실행합니다(예전 siteId는 dandi.json의 previousSiteId에 남습니다).
7. 사이트를 다른 프로젝트로 옮기는 것은 교사가 요청할 때만 `CLI deploy <폴더> --project <프로젝트 ID> --json`으로 합니다. dandi.json의 projectId는 새 사이트를 만들 때만 쓰이고, 이미 있는 사이트는 허브에 연결된 프로젝트를 그대로 따릅니다.

## 3. 등록 정보와 셀프점검, 허브 등록

교사의 요청에 제목, 설명, 학교급, 분류, ①~⑤ 답이 이미 모두 있으면 그대로 쓰고 다시 묻지 않습니다. 빠진 항목이 있으면 한 번의 메시지로 묻습니다. 코드를 보고 예상한 답을 제안하되, 교사가 하나씩 직접 확인하게 합니다. "공개 전에 아래 항목에 직접 답해 주십시오."

제목 / 한 줄 설명 / 학교급(초·중·고·특수) / 분류(수업·업무·학생지도·기타)

① 학생 개인정보(이름, 학번, 연락처, 상담 기록 등)를 수집하거나 처리합니까? (예/아니요)
② 데이터 저장 위치 (예: 저장 안 함(브라우저 안에서만 처리), Supabase(서울 리전))
③ 보관 기간 (예: 저장 안 함, 학기 종료 시 삭제)
④ 입력 내용을 외부 서비스(해외 AI API 등)로 보냅니까? (예/아니요)
⑤ 학교 내부 승인(운영위원회 등)이 필요합니까? (예/아니요, ①이 "예"면 반드시 "예")

⑤가 "예"이면 승인 대기(①이 "예"면 ⑤도 반드시 "예")

1. 교사가 확인한 답만 deploy 결과의 `manifest`가 가리키는 dandi.json에 씁니다(siteId는 그대로 둡니다): title, description, schoolLevels(elem·middle·high·special 중 하나 이상), category(class·work·guidance·etc), privacyCheck(collectsStudentData ①, storageLocation ②, retention ③, externalTransfer ④, needsSchoolApproval ⑤; ①④⑤는 true/false). 파일은 UTF-8로 저장합니다. Windows PowerShell에서는 `Set-Content -Encoding UTF8`이나 `[IO.File]::WriteAllText`를 씁니다(그냥 Set-Content로 쓰면 한글이 깨져 `manifest_encoding` 오류가 납니다). 오류가 나도 dandi.json을 지우지 않습니다.
2. deploy 결과의 next_step(`CLI publish --json`, 필요하면 `--dir`이 붙습니다)을 실행합니다. 종료 코드 21이면 빠진 항목만 교사에게 묻습니다. 값의 형식만 틀렸다면(예: "중" 대신 "middle") 다시 묻지 말고 고칩니다. ①이 "예"인데 ⑤가 "아니요"이면 등록되지 않으므로 ⑤를 스스로 바꾸지 말고 교사에게 다시 묻습니다.
3. 확인된 결과만 알립니다. 결과의 `message`를 고치지 말고 그대로 전하고, `appUrl`을 한 줄에 보여 줍니다. 등록에 쓴 제목, 설명, 학교급, 분류, ①~⑤ 답도 함께 보여 줍니다. `approvalStatus`는 approved(승인 유지)·not_required(승인 필요 없음)·pending(승인 대기) 중 하나이고, `liveVersion`은 updated(공개 주소가 이 버전을 보여 줌) 또는 kept_until_approval(승인 완료를 표시해야 이 버전이 공개됨)입니다. kept_until_approval이면 `liveUrl`도 한 줄에 보여 주고, 승인 완료를 표시할 때까지 그 주소는 이전에 공개한 버전을 그대로 보여 준다고 알립니다. 승인 대기인 앱은 교사가 학교 내부 승인을 마치고 HUB/studio/apps 에서 승인 완료를 표시하기 전까지 허브 목록에 나타나지 않습니다.

이미 공개한 사이트를 고칠 때: 1단계와 2단계를 거친 뒤 dandi.json에 저장된 답(deploy 결과의 `saved_answers`)을 한 번에 보여 주고, 그대로 두어도 되는지 확인만 받습니다(교사가 요청에서 이미 말했으면 묻지 않습니다). 그리고 "지금 공개된 버전은 다시 등록할 때까지 그대로입니다."라고 알린 뒤 publish합니다. 학교 내부 승인이 필요한 앱은 답이 바뀌면 새 버전이 다시 승인을 기다리고, 그동안 이전에 공개한 버전이 계속 보입니다.

## 한 번에 실행하는 방식(headless)

Codex(codex exec), Antigravity(agy -p), Grok(grok -p)처럼 한 번에 실행하는 방식은 중간에 답을 받을 수 없습니다. 교사에게 먼저 터미널에서 `CLI login` 으로 로그인해 두고, 요청 문장에 제목, 설명, 학교급, 분류, ①~⑤ 답을 함께 적도록 안내합니다. 답이 빠졌으면 미리보기까지만 하고 필요한 항목을 알려 줍니다.

## 셸을 쓸 수 없을 때

- 공개 HTTPS 허브: 교사가 HUB/connect 에서 원격 MCP를 연결하고 브라우저에서 [허용]을 누릅니다. 도구는 dandi_deploy_files(파일 내용을 보냄), dandi_privacy_questions, dandi_publish_site입니다. 셀프점검은 위와 같이 교사에게 묻습니다.
- localhost·내부망 허브, 또는 MCP도 없을 때: "HUB/studio/sites 에서 사이트 폴더를 올려 주십시오."라고 안내하고 멈춥니다.
- 허브를 업데이트한 뒤 로컬 MCP(stdio)가 시작되지 않거나 예전 CLI로 돌면, HUB/connect 에서 MCP 설정 줄을 다시 복사해 바꾸도록 교사에게 안내합니다.

## 하지 않는 일

- 토큰·비밀번호·API 키를 채팅에 요구하거나 출력하지 않습니다. ~/.dandi/, .env* 파일을 올리거나 커밋하지 않습니다.
- 키를 숨기거나 나눠서 비밀값 검사를 피하지 않습니다.
- 셀프점검 질문에 교사 대신 답하거나, 교사가 확인하기 전에 publish하지 않습니다. 교사가 요청에 적은 답은 교사가 확인한 답으로 봅니다.
- 교사 대신 로그인을 승인하거나 학교 내부 승인 완료를 표시하지 않습니다.
- 실제 학생 이름·연락처가 든 파일을 올리지 않습니다. 시연에는 가상의 데이터를 씁니다.
- 교사가 고른 폴더 밖의 파일을 올리지 않고, 보여 주는 주소를 줄이거나 고치지 않습니다.
- 계정을 확인하지 않고 새 사이트(--new-site)를 만들지 않습니다.
