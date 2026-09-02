# TASKS.md — 実装タスクリスト

project_id: ai-dev-progress-tracker  
version: 2.2  
date: 2026-09-02  
source: DESIGN.md v2.2

## 依存関係

```text
T001 → T002 → T003
                ├─→ T004 → T005 → T006 → T007 → T008
                │                     ├────→ T009
                │                     └────→ T010
                │             T007 ─────────→ T011
                ├─→ T012 → T013
                ├─→ T014 ────────────────→ T018
                ├─→ T015
                └─→ T016 ────────────────→ T017

T013 → T019 → T020 → T021 → T022
T011 ─┐
T017 ─┼→ T023 → T024 → T025
T018 ─┤
T022 ─┘
```

## 進め方

- 上から順に実行する。依存タスクが未完了のタスクには着手しない。
- 1タスクを小さめのPRとして完結させる。タスク間で未検証コードを持ち越さない。
- 各タスクの検証コマンドが通ったら `Txxx: <タスク名>` でcommitする。
- fakeを使う機能でも、外部CLI/service依存経路はT009/T010/T011/T017/T018の実機タスクが完了するまで完成扱いにしない。
- eval/benchmarkはtemp data dir / dedicated fixture repoで実行し、対象repo・利用者project dataを変更しない。
- evalの期待値は想定で書かず、harness作成と実測結果確定を別タスクにする。

---

## T001: v2リポジトリ基盤・テスト基盤・CIを成立させる

- 依存: なし
- 目的: 機能実装前に、v2のruntime制約・完全一致npm依存・テスト・CIが通る土台を作る。
- 触るファイル:
  - 変更: `package.json`
  - 変更: `package-lock.json`
  - 変更: `.github/workflows/ci.yml`
  - 変更: `tests/unit/smoke.test.ts`
  - 変更: `CLAUDE.md`
  - 削除: `.nvmrc`
- 実装内容:
  1. `engines.node=">=24.15.0"`、`engines.npm=">=12.0.2"`とし、上限・完全一致runtime指定を削除する。
  2. `packageManager`を削除する。
  3. `smol-toml` `1.8.0`をdependenciesへ完全一致追加し、他npm依存はDESIGN.md記載値に完全一致させる。
  4. `allowScripts`は`esbuild@0.28.2`と`better-sqlite3@13.0.3`だけ。
  5. CIはNode `24.15.0`で`npm ci → lint → typecheck → test → build → e2e → verify:secrets`。
  6. smoke testへversion parserの正常/境界caseを追加する。
  7. `CLAUDE.md`を`AGENTS.md`と同一内容へ同期する。
- 完了条件:
  - [ ] **初回実行**: clean checkoutで`npm ci`から全検証が成功する。
  - [ ] **ゼロ件・空入力**: 空DB/fixtureなしでもsmoke testが成功する。
  - [ ] **外部往復**: `git status --porcelain`を実Gitから再取得し、検証による意図しない生成物が残らない。
  - [ ] npm packageはDESIGN.mdの完全一致versionでlock済み。
  - [ ] Node/npmには上限を設定していない。
  - [ ] CI workflowがT001終了時点で成功可能。
- 検証コマンド:

```powershell
npm ci; if ($LASTEXITCODE) { exit $LASTEXITCODE }; npm run lint; if ($LASTEXITCODE) { exit $LASTEXITCODE }; npm run typecheck; if ($LASTEXITCODE) { exit $LASTEXITCODE }; npm test; if ($LASTEXITCODE) { exit $LASTEXITCODE }; npm run build; if ($LASTEXITCODE) { exit $LASTEXITCODE }; npm run test:e2e; if ($LASTEXITCODE) { exit $LASTEXITCODE }; npm run verify:secrets
```

---

## T002: v1.7物理・AI生成・recovery互換goldenを固定する

- 依存: T001
- 目的: v2改修中にv1.3の物理schemaと、commit `c281f91` / DESIGN v1.7で追加されたAI prompt・出力正規化・recovery評価契約へ回帰しないテストゲートを作る。
- 触るファイル:
  - 新規: `tests/fixtures/v1-compat/001_init.sql`
  - 新規: `tests/fixtures/v1-compat/backup-v1.schema.json`
  - 新規: `tests/fixtures/v1-compat/progress-output.schema.json`
  - 変更: `tests/unit/progress-schema.test.ts`
  - 変更: `tests/unit/recovery-classifier.test.ts`
  - 変更: `tests/integration/recovery-flow.test.ts`
  - 変更: `tests/integration/db-migrations.test.ts`
  - 変更: `tests/integration/restore-flow.test.ts`
- 実装内容:
  1. タスク開始時点の既存3物理正本（001 migration / backup-v1 schema / progress-output schema）をbyte-for-byteでfixtureへcopyする。手編集しない。
  2. working tree正本とfixtureがbyte一致するテストを追加する。
  3. `buildGenerationPrompt`がv1.7の意味契約を維持することを回帰テストする。必須: evidence本文のみconfirmed、薄いevidenceはneeds_input、4fieldのcanonical needs_input形、常にschema-valid JSON要求、confirmedのexisting evidence参照、decision+rationale。
  4. `validateProgressOutput`回帰テストを追加する。必須:
     - non-canonicalな`needs_input`の説明文/item/evidenceIdsがcanonical empty形へ正規化される。
     - `importantDecisions.confirmed`の空decision/空rationale/item evidence 0件itemだけが除去され、field-level evidenceがあればrun全体はvalid。
     - unknown evidence IDは`UNKNOWN_EVIDENCE_ID`。
     - top-level schema不一致は`CODEX_OUTPUT_INVALID`。
  5. recovery classificationの4/4=`complete`, 1..3/4=`partial`, 0/4=`unrecoverable`を維持する。
  6. v1 backup restoreの既存論理項目欠損0件baselineを追加する。
  7. `scripts/eval-recovery.ts`とdefault `recovery-cases.json`のv1.7契約を維持する。default expectedはrecovery status / field status / required evidenceを中心とし、`mustContain`/`mustNotContain`は任意補助checkのまま必須expectedへ戻さない。unknown evidence 0件も維持する。
- 完了条件:
  - [ ] **初回実行**: v1 DB/backup fixtureを新しいtemp data dirへ初回loadできる。
  - [ ] **ゼロ件・空入力**: project 0件のv1 backupをrestoreして0件のまま成功し、4fieldすべて根拠不足のprogressはcanonical needs_inputとして受理される。
  - [ ] **外部往復**: temp Git repoへ3fixtureをcommitし、`git show HEAD:<path>`で再取得したbytesが元と一致する。
  - [ ] 3物理正本を1 byte変えるnegative testで検証が失敗する。
  - [ ] `needs_input`へ余分なtext/item/evidence IDを含むschema-parse可能な入力をvalidatorへ渡すと、固定形へ正規化されsnapshot保存可能なvalid結果になる。
  - [ ] malformed decision itemが1件あってもfield-level evidenceがvalidなら、そのitemだけ除去されrun全体を`CODEX_OUTPUT_INVALID`へしない。
  - [ ] unknown evidence参照とtop-level schema不一致は引き続きrejectする。
  - [ ] fixture expected値は実ファイル/実装契約から作成し、想定の自然言語本文をexpectedにしない。
- 検証コマンド:

```powershell
npm run test:unit -- tests/unit/progress-schema.test.ts tests/unit/recovery-classifier.test.ts; if ($LASTEXITCODE) { exit $LASTEXITCODE }; npm run test:integration -- tests/integration/recovery-flow.test.ts tests/integration/db-migrations.test.ts tests/integration/restore-flow.test.ts
```

---

## T003: migration 002・v2 domain/API型・candidate repository

- 依存: T002
- 目的: additive migrationとcandidate/review/summaryの永続化基盤を実装する。
- 触るファイル:
  - 新規: `db/migrations/002_v2.sql`
  - 新規: `src/server/db/candidate-repository.ts`
  - 新規: `tests/unit/candidate-repository.test.ts`
  - 変更: `src/shared/domain.ts`
  - 変更: `src/shared/api.ts`
  - 変更: `src/server/db/migrations.ts`
  - 変更: `src/server/db/project-repository.ts`
  - 変更: `tests/integration/db-migrations.test.ts`
  - 変更: `tests/helpers/test-db.ts`
- 実装内容:
  1. DESIGN.mdの`002_v2.sql`をそのまま追加。
  2. `RegistrationCandidate`, `RegistrationCandidateStatus`, `RegistrationSource`型を追加。
  3. project read/writeへsummary/review/sourceを追加し既存fieldを削除しない。
  4. candidate repositoryへ`upsertDetected`, `markPrompted`, `beginRegistration`, `recordFailure`, `markRegistered`, `decline`, `reopen`, `list`, `get`。
  5. state transition違反をrepositoryで拒否。
  6. v1 DB migration前にpre-v2 DB copyを作成。
- 完了条件:
  - [ ] **初回実行**: migration未適用v1 DBを開くと既存dataを保ったまま002が1回適用される。
  - [ ] **ゼロ件・空入力**: project/candidate 0件DBでもmigration/listが成功し空配列。
  - [ ] **外部往復**: temp DBをclose→reopenしてcandidate/project v2 fieldを再取得し書込値と一致。
  - [ ] v1 projectは`summary=name`,`registration_source=manual`,`review_required=0`。
  - [ ] `attempt_count>2`、不正status、重複local_pathは拒否。
- 検証コマンド:

```powershell
npm run test:unit -- tests/unit/candidate-repository.test.ts; if ($LASTEXITCODE) { exit $LASTEXITCODE }; npm run test:integration -- tests/integration/db-migrations.test.ts
```

---

## T004: Codex/Claude user integration installer・doctor

- 依存: T003
- 目的: F1用user設定を既存設定を破壊せずinstall/repair/uninstallできるようにする。
- 触るファイル:
  - 新規: `src/cli/commands/setup-agents.ts`
  - 新規: `src/server/services/agent-integration-service.ts`
  - 新規: `tests/unit/agent-integration.test.ts`
  - 変更: `src/cli/commands/doctor.ts`
  - 変更: `src/cli/index.ts`
  - 変更: `src/server/config.ts`
  - 変更: `src/shared/api.ts`
  - 変更: `src/server/routes/system.ts`
  - 変更: `package.json`
- 実装内容:
  1. Codex `~/.codex/config.toml`のtop-level notifyを`smol-toml`で検査しmanaged blockをroot位置へ挿入。
  2. 別notifyがstring配列ならchainする。既存raw行をmanaged blockへbase64退避し、tracker argvへ`--chain <既存argv JSON>`を付ける。`--uninstall`で元のraw行を書き戻す。string配列でなくchainできない形のときだけ`CODEX_NOTIFY_CONFLICT`で**無変更**。
  3. Claude `~/.claude/settings.json`の`hooks.UserPromptSubmit`へtracker handlerをmergeし他設定を保持。
  4. `--repair`はtracker entryだけ更新、`--uninstall`はtracker entryだけ除去。
  5. version: Node>=24.15.0, Git>=2.45.0, gh>=2.98.0, Codex>=0.152.0, Claude>=2.1.258。上限なし。
  6. system status/doctorはraw auth/token/config内容を返さない。
- 完了条件:
  - [ ] **初回実行**: temp HOMEの設定0件からCodex/Claude entryが各1件作成。
  - [ ] **ゼロ件・空入力**: file未存在/空TOML/空JSONを正常初期化。
  - [ ] **外部往復**: temp HOMEへ書いた設定をfilesystemから再読込し、argv/argsの絶対pathがexpectedと一致。
  - [ ] chainできない既存notifyでは元file byte列が不変。
  - [ ] chain install→uninstallで元のnotify raw行がbyte一致で復元される。
  - [ ] Claude既存hook/未知keyを消さない。
  - [ ] install→installで1件、install→uninstallでtracker entryだけ消える。
- 検証コマンド:

```powershell
npm run test:unit -- tests/unit/agent-integration.test.ts; if ($LASTEXITCODE) { exit $LASTEXITCODE }; npm run build; if ($LASTEXITCODE) { exit $LASTEXITCODE }; node dist/cli/index.js doctor
```

---

## T005: agent-event検知・candidate upsert・登録確認起動

- 依存: T004
- 目的: Codex/Claude eventから未登録folderをcandidate化し、作業中に登録確認を提示する。
- 触るファイル:
  - 新規: `src/cli/commands/agent-event.ts`
  - 新規: `src/server/adapters/desktop.ts`
  - 新規: `tests/integration/agent-detection.test.ts`
  - 変更: `src/cli/index.ts`
  - 変更: `src/server/services/agent-integration-service.ts`
  - 変更: `src/server/db/candidate-repository.ts`
  - 変更: `tests/helpers/temp-repo.ts`
- 実装内容:
  1. Codexはargv JSON、Claudeはstdin JSONをparse。`--chain`があれば最初にchain対象をdetachedで起動し、待たない。
  2. event typeとcwdだけを使用し会話fieldを保存しない。
  3. Git配下ならtop-level、Git外ならcwdをcanonical pathにする。
  4. project既登録ならno-op、未登録ならlocal_path unique candidate upsert。
  5. 初回candidateでserver health確認。未起動なら`dist/server/index.js`をdetached spawnし最大3秒/100ms間隔でpoll。
  6. server ready後 `/?candidate=<id>` をbrowser open。成功時だけ`prompted`。
  7. hook callerを止めないよう内部errorでも5秒以内exit 0。
- 完了条件:
  - [ ] **初回実行**: DBなし・server未起動・Git外folderの最初のeventからcandidate作成→server起動→確認URL open。
  - [ ] **ゼロ件・空入力**: 空stdin/空argv/対象外eventでcandidate 0件、exit 0。
  - [ ] **外部往復**: temp real Git repo subdirのeventで、`git rev-parse --show-toplevel`再取得値とDB local_path一致。
  - [ ] 同folderへ10 eventでもcandidate 1件。
  - [ ] registered projectからcandidateを作らない。
  - [ ] prompt/transcript/messageがDB/logに0件。
  - [ ] chain対象が失敗してもcandidateは作られ、tracker側が失敗してもchain対象は起動済み。
- 検証コマンド:

```powershell
npm run test:integration -- tests/integration/agent-detection.test.ts
```

---

## T006: candidate API・登録確認UI・未登録候補UI

- 依存: T005
- 目的: approve/decline/reopenとfailed candidateの可視化、manual fallback導線を作る。
- 触るファイル:
  - 新規: `src/server/routes/candidates.ts`
  - 新規: `src/server/schemas/candidate.ts`
  - 新規: `src/web/components/RegistrationPrompt.tsx`
  - 新規: `src/web/components/RegistrationCandidatePanel.tsx`
  - 変更: `src/server/app.ts`
  - 変更: `src/web/api/client.ts`
  - 変更: `src/web/pages/DashboardPage.tsx`
  - 変更: `src/web/components/RegisterProjectForm.tsx`
  - 変更: `tests/e2e/registration.spec.ts`
- 実装内容:
  1. candidate GET/list/approve/decline/reopen API。
  2. `?candidate=id`でRegistrationPromptを最優先表示。
  3. declineはauto registrationを起動せずcandidateを保持。
  4. failed panelへerror code、reopen、manual registration導線。
  5. promptはpollしてregistering→registered/failedを反映。
- 完了条件:
  - [ ] **初回実行**: candidate 1件の初回URLで「このプロジェクトを登録しますか？」とapprove/decline表示。
  - [ ] **ゼロ件・空入力**: candidate 0件でpanelなし。空name overrideはsuggested name扱い。
  - [ ] **外部往復**: approve/decline/reopenをHTTP write後GET再取得しstatus/decision_atとUIが一致。
  - [ ] decline後project 0件。
  - [ ] failed candidateからmanual formへpath/nameを引継ぐがsubmitまでprojectを作らない。
- 検証コマンド:

```powershell
npm run test:e2e -- tests/e2e/registration.spec.ts
```

---

## T007: 自動登録state machine・Git/GitHub adapter拡張

- 依存: T006
- 目的: approve後にGitHub既存/未作成、commitあり/なしを固定フローで登録する。
- 触るファイル:
  - 新規: `src/server/services/registration-service.ts`
  - 新規: `src/worker/registration-worker.ts`
  - 新規: `tests/unit/registration-service.test.ts`
  - 変更: `src/server/adapters/git.ts`
  - 変更: `src/server/adapters/github.ts`
  - 変更: `src/server/routes/candidates.ts`
  - 変更: `src/server/db/project-repository.ts`
  - 変更: `src/worker/index.ts`
  - 変更: `tests/helpers/fake-gh.ts`
  - 変更: `tests/integration/project-registration.test.ts`
- 実装内容:
  1. DESIGN.mdのrepo name normalization、summary、Git init、origin検証を実装。
  2. originなしは`gh repo create owner/name --private --source path --remote origin`。
  3. 新規repo + HEADありだけinitial push。HEADなしはpushしない。
  4. `gh repo view`、`git remote get-url origin`、push後`git ls-remote`でreadback。
  5. project登録後に既存hook install、HEADありならrecovery、backup queue。
  6. approve APIは202でworkerへ渡す。
- 完了条件:
  - [ ] **初回実行**: Git未初期化・repoなし・commit0のfolderで`git init -b main`→Private repo create→origin→pushなし→project登録。
  - [ ] **ゼロ件・空入力**: README/description/commit 0件でもsummary=name、current=`初回コミット待ち`、next=[]。
  - [ ] **外部往復**: fake-ghでもcreate後repo view、push後ls-remoteを再取得しowner/name/visibility/SHAが完全一致。
  - [ ] 既存GitHub originのprojectは新repoを作らない。
  - [ ] commitあり新repoはremote SHA=local HEADまで確認しない限りregisteredにしない。
  - [ ] repo名衝突時はsuffixを作らず`REPOSITORY_NAME_CONFLICT`。
- 検証コマンド:

```powershell
npm run test:unit -- tests/unit/registration-service.test.ts; if ($LASTEXITCODE) { exit $LASTEXITCODE }; npm run test:integration -- tests/integration/project-registration.test.ts
```

---

## T008: 自動登録retry・failed candidate・manual fallback回帰

- 依存: T007
- 目的: 一時失敗を1回だけ自動再試行し、再失敗を100%可視化する。
- 触るファイル:
  - 新規: `tests/integration/registration-retry.test.ts`
  - 変更: `src/server/services/registration-service.ts`
  - 変更: `src/server/db/candidate-repository.ts`
  - 変更: `src/worker/registration-worker.ts`
  - 変更: `src/web/components/RegistrationCandidatePanel.tsx`
  - 変更: `tests/e2e/registration.spec.ts`
- 実装内容:
  1. attempt1失敗→error保存→2秒→attempt2。
  2. attempt2失敗→`failed`, attempt_count=2。
  3. worker再起動時、`registering`かつattempt_count=1で最終更新から2秒以上ならattempt2を1回だけ実行。
  4. failed candidateをdashboardから消さない。
  5. reopen時にattempt_count=0/error=nullへreset。
- 完了条件:
  - [ ] **初回実行**: 空DBから初回失敗→2秒後成功でregistered、追加操作0回。
  - [ ] **ゼロ件・空入力**: failed candidate 0件でpanel空、retry対象0件でworker正常。
  - [ ] **外部往復**: fake external command履歴を再取得しexactly 2 attempts、成功時project GET readback一致。
  - [ ] 2回とも失敗したcandidateのfailed反映率100%。
  - [ ] 3回目の自動attemptなし。
  - [ ] manual registration既存E2E回帰成功。
- 検証コマンド:

```powershell
npm run test:integration -- tests/integration/registration-retry.test.ts; if ($LASTEXITCODE) { exit $LASTEXITCODE }; npm run test:e2e -- tests/e2e/registration.spec.ts
```


---

## T009: Codex CLI実機で未登録folder検知を検証する

- 依存: T005, T007
- 目的: fakeではなく実測Codex CLIから`notify` eventを発生させ、F1のCodex経路を確認する。
- 触るファイル:
  - 新規: `scripts/real-check-codex-detection.ts`
  - 変更: `package.json`
- 実装内容:
  1. OS tempにproject dirと`TRACKER_DATA_DIR`を作る。
  2. user `~/.codex/config.toml`を変更せず、Codex invocation-level `--config notify=...`でreal tracker handlerを指定。
  3. `codex login status`がChatGPT login、version>=0.152.0を確認。
  4. temp cwdで`codex exec`へ「ファイルを変更せずOKだけ返す」promptを送り1 turn完了。
  5. temp DBを読みcandidateを検証し、temp local dataだけ削除。
- 完了条件:
  - [ ] **初回実行**: 未初期化temp folderからreal Codex 1 turnでcandidate 1件。
  - [ ] **ゼロ件・空入力**: handlerへ対象外event/空payloadを渡してcandidate数が増えない。
  - [ ] **外部往復**: Codex通知cwdをcandidate DBから再取得しreal temp cwd canonical pathと一致。
  - [ ] target repository working tree/DBを変更しない。
  - [ ] user Codex configを変更しない。
- 検証コマンド:

```powershell
npm run real:codex-detection
```

---

## T010: Claude Code実機で未登録folder検知を検証する

- 依存: T005, T007
- 目的: fakeではなくreal Claude Codeの`UserPromptSubmit` hookからF1のClaude経路を確認する。
- 触るファイル:
  - 新規: `scripts/real-check-claude-detection.ts`
  - 変更: `package.json`
- 実装内容:
  1. `claude --version`>=2.1.258と`claude auth status` exit0を確認。未認証ならAGENTS.mdどおりblock。
  2. OS tempへproject、settings JSON、`TRACKER_DATA_DIR`。
  3. user settingsを変更せず、`claude --restricted -p` + `--settings <temp-settings>` + `--tools ""`でtracker UserPromptSubmit hookを注入。
  4. promptは「OKだけ返す」。project file変更禁止。
  5. temp DB candidateを検証してtempだけ削除。
- 完了条件:
  - [ ] **初回実行**: 未初期化temp folderの最初のreal Claude promptでcandidate 1件。
  - [ ] **ゼロ件・空入力**: handlerへ空stdin/別eventを渡しcandidate 0件。
  - [ ] **外部往復**: Claude hook JSON cwdからDBへ保存されたpathを再取得しtemp cwdと一致。
  - [ ] target repositoryとuser `~/.claude/settings.json`を変更しない。
  - [ ] auth raw output/tokenをlog/DBへ保存しない。
- 検証コマンド:

```powershell
npm run real:claude-detection
```

---

## T011: GitHub実機でPrivate repo作成・remote・初回pushを往復検証する

- 依存: T007
- 目的: F3をreal gh/GitHubで1回以上検証する。
- 触るファイル:
  - 新規: `scripts/real-check-github-registration.ts`
  - 変更: `package.json`
- 実装内容:
  1. `gh auth status`成功を確認。
  2. active user配下の専用repo `ai-dev-progress-tracker-e2e-fixture`だけを使う。
  3. repo不存在ならPrivate作成し、marker `.tracker-e2e-fixture`を最初のcommitへ含める。
  4. 既存ならvisibility=PRIVATEかつmarkerがdefault branchに存在すること。不一致なら停止し既存repoを変更しない。
  5. OS temp local repoからunique fixture fileをcommit/push。
  6. GitHubからcontent/refを取り直しcontent/SHAを比較。
- 完了条件:
  - [ ] **初回実行**: fixture repo不存在でもPrivate作成からpushまで完了。
  - [ ] **ゼロ件・空入力**: commit 0件caseは別temp repoでserviceを呼び、remote作成後にpushしないことをreal `git ls-remote`で確認。
  - [ ] **外部往復**: commitありcaseのremote ref SHA=local HEAD、GitHub再取得fixture content=local content。
  - [ ] fixture repo以外をcreate/delete/pushしない。
  - [ ] tokenを取得/保存しない。
- 検証コマンド:

```powershell
npm run real:github-registration
```

---

## T012: 進捗鮮度・最終更新・dashboard API projection

- 依存: T003
- 目的: F10と一覧判断用derived状態を固定ロジックで提供する。
- 触るファイル:
  - 新規: `src/server/services/freshness-service.ts`
  - 新規: `tests/unit/freshness.test.ts`
  - 新規: `tests/integration/dashboard-freshness.test.ts`
  - 変更: `src/server/routes/projects.ts`
  - 変更: `src/server/db/progress-repository.ts`
  - 変更: `src/server/db/project-repository.ts`
  - 変更: `src/shared/api.ts`
- 実装内容:
  1. DESIGN.mdの`lastGeneratedCommitSha/At`,`unreflected`,`hasNextAction`,`lastUpdatedAt`を実装。
  2. GET projectsでlocal HEADを最大4 parallelで取得。local_missingは既存statusへ反映。
  3. 未登録commit SHAならmetadataをDBへupsertし再GET可能にする。
  4. snapshotなしfallbackを固定。
- 完了条件:
  - [ ] **初回実行**: project+commitあり/snapshotなしで`unreflected=true`,`current=進捗生成待ち`。
  - [ ] **ゼロ件・空入力**: project 0件で`projects=[]`、HEADなしで`unreflected=false`,`current=初回コミット待ち`。
  - [ ] **外部往復**: temp real Git repoへcommit→API GET→`git rev-parse HEAD`再取得し`latestCommitSha`一致。snapshot SHA一致/不一致case双方。
  - [ ] generation commit/timeはexisting snapshotから取得しduplicate保存しない。
  - [ ] lastUpdatedAtにbackup timestampを含めない。
- 検証コマンド:

```powershell
npm run test:unit -- tests/unit/freshness.test.ts; if ($LASTEXITCODE) { exit $LASTEXITCODE }; npm run test:integration -- tests/integration/dashboard-freshness.test.ts
```

---

## T013: 高密度dashboard・状態絞り込み・一覧比較

- 依存: T012
- 目的: F5/F8/F9を2005x1271の1画面で満たす。
- 触るファイル:
  - 新規: `src/web/components/DashboardToolbar.tsx`
  - 新規: `src/web/components/DenseProjectRow.tsx`
  - 変更: `src/web/pages/DashboardPage.tsx`
  - 変更: `src/web/components/ProjectCard.tsx`
  - 変更: `src/web/styles.css`
  - 変更: `tests/e2e/dashboard.spec.ts`
- 実装内容:
  1. denseをdefaultにし固定row/column/layoutをDESIGNどおり実装。
  2. `has_next_action`,`needs_review`,`unreflected` filterは複数OR、searchとのAND。search UIはT020までhidden。
  3. default sort=`lastUpdatedAt DESC`, tie=`name ASC`。
  4. project name/currentを最上位visual hierarchyにする。
- 完了条件:
  - [ ] **初回実行**: 8project fixtureを2005x1271で表示し通常状態でvertical scrollなしに8行全部がviewport内。
  - [ ] **ゼロ件・空入力**: project 0件でempty state、filter結果0件でempty state。
  - [ ] **外部往復**: temp project real Git HEADをAPIから再取得し表示freshness badgeと一致。
  - [ ] 各rowにproject名・現在地・次の作業・最終更新がdetail遷移なしで存在。
  - [ ] 各state filter単独/複数caseが期待projectだけを表示。
- 検証コマンド:

```powershell
npm run test:e2e -- tests/e2e/dashboard.spec.ts
```

---

## T014: 要確認flag・AI再生成queue・UI

- 依存: T003
- 目的: F11を既存recovery pipelineへ接続する。
- 触るファイル:
  - 新規: `src/web/components/ReviewControls.tsx`
  - 新規: `tests/integration/review-regeneration.test.ts`
  - 変更: `src/server/routes/projects.ts`
  - 変更: `src/server/schemas/project.ts`
  - 変更: `src/server/services/recovery-service.ts`
  - 変更: `src/web/api/client.ts`
  - 変更: `src/web/pages/ProjectDetailPage.tsx`
  - 変更: `tests/e2e/project-detail.spec.ts`
- 実装内容:
  1. PATCH review。true時`review_required_at=now`、false時null。
  2. 既存POST recoverを「再生成」UIから呼びtrigger=`manual_recovery`。
  3. regenerate成功/失敗でreview flagを自動clearしない。
  4. HEADなしはrecoverを422 `INVALID_REQUEST`で開始しない。
- 完了条件:
  - [ ] **初回実行**: review=false projectへtrueを付けdetail/dashboard双方へ反映。
  - [ ] **ゼロ件・空入力**: HEADなしprojectは再生成を開始せずreview flagは設定可能。
  - [ ] **外部往復**: review PATCH後GET readback一致。fake Codex outputをsnapshot保存後再GETしsnapshot commit SHA=fake input HEAD。
  - [ ] regenerate成功後も`reviewRequired=true`。
  - [ ] userがfalse操作した時だけ解除。
- 検証コマンド:

```powershell
npm run test:integration -- tests/integration/review-regeneration.test.ts; if ($LASTEXITCODE) { exit $LASTEXITCODE }; npm run test:e2e -- tests/e2e/project-detail.spec.ts
```

---

## T015: 現在状態と進捗履歴を構造分離する

- 依存: T003
- 目的: F12としてcurrent snapshotとhistoryを別sectionで読めるようにする。
- 触るファイル:
  - 新規: `src/web/components/ProgressHistory.tsx`
  - 変更: `src/server/routes/projects.ts`
  - 変更: `src/server/db/progress-repository.ts`
  - 変更: `src/web/api/client.ts`
  - 変更: `src/web/pages/ProjectDetailPage.tsx`
  - 変更: `src/web/styles.css`
  - 変更: `tests/e2e/project-detail.spec.ts`
- 実装内容:
  1. `/history`をnewest-first、default20/max100、stable cursorで返す。
  2. current state sectionをhistoryより前へ固定。
  3. historyは別heading/divider、20件単位load more。
  4. 遅れて完了した古いcommit snapshotがcurrentを巻き戻さない既存selection ruleを維持。
- 完了条件:
  - [ ] **初回実行**: history 1件でcurrent/historyが別section。
  - [ ] **ゼロ件・空入力**: history 0件でもcurrent sectionを表示し別sectionへ「履歴なし」。
  - [ ] **外部往復**: temp Git複数commit→snapshot→API history再取得し各commit SHAがreal `git log` SHAと一致。
  - [ ] 21件fixtureで20件+load more 1件。
  - [ ] current stateがhistory DOM内にnestされない。
- 検証コマンド:

```powershell
npm run test:e2e -- tests/e2e/project-detail.spec.ts
```

---

## T016: backup-v2 export・v1/v2 restore互換

- 依存: T003
- 目的: F14のv2追加論理項目をbackup/restoreしつつv1 backupを読み続ける。
- 触るファイル:
  - 新規: `schemas/backup-v2.schema.json`
  - 新規: `tests/integration/backup-v2.test.ts`
  - 変更: `src/server/schemas/backup.ts`
  - 変更: `src/server/db/backup-repository.ts`
  - 変更: `src/server/services/backup-service.ts`
  - 変更: `src/server/services/restore-service.ts`
  - 変更: `tests/unit/backup-export.test.ts`
  - 変更: `tests/integration/backup-flow.test.ts`
  - 変更: `tests/integration/restore-flow.test.ts`
- 実装内容:
  1. DESIGN.mdのbackup-v2 shapeをJSON Schema化。
  2. production exportをmanifest schemaVersion2 + `data/backup-v2.json`へ。
  3. project v2 fieldsとregistrationCandidatesをdeterministic sort/serialize。
  4. restoreはmanifest v1/v2分岐。v1 import後migration002。
  5. restore後foreign key/integrity/論理項目比較。
  6. backup-v1 schema/fileを変更しない。
- 完了条件:
  - [ ] **初回実行**: v1 DB由来backup-v1を空v2環境へrestoreし既存論理項目欠損0件。
  - [ ] **ゼロ件・空入力**: project/candidate 0件のbackup-v2 export→restore成功。
  - [ ] **外部往復**: temp Git backup repoへv2を書きcommit→fresh clone→checksum/schema→fresh DB restoreし対象論理項目一致。
  - [ ] review/freshness input/candidate fieldsが復元。
  - [ ] `unreflected`はrestore後derived再計算でbackup前と一致。
  - [ ] secret、backup_runs、worker_leases、logs、auth payloadはbackup 0件。
- 検証コマンド:

```powershell
npm run test:unit -- tests/unit/backup-export.test.ts; if ($LASTEXITCODE) { exit $LASTEXITCODE }; npm run test:integration -- tests/integration/backup-v2.test.ts tests/integration/backup-flow.test.ts tests/integration/restore-flow.test.ts
```

---

## T017: GitHub実機でbackup-v2→clone→restore roundtrip

- 依存: T016
- 目的: fakeだけでなくPrivate GitHubを往復して復元同一性を確認する。
- 触るファイル:
  - 新規: `scripts/real-check-backup-restore.ts`
  - 変更: `package.json`
- 実装内容:
  1. production backup repoは触らず専用Private `ai-dev-progress-tracker-backup-e2e-fixture`を使う。
  2. repo不存在なら作成。既存時はPrivate + markerでfixture所有を確認し不一致なら停止。
  3. temp DBへv2 field/candidate/snapshotをseed。
  4. dependency injectionでbackup repo名だけfixtureへ差替え、production defaultは固定名のまま。
  5. push後fresh clone、checksum、別temp DB restore、論理比較。
- 完了条件:
  - [ ] **初回実行**: fixture backup repo不存在からcreate→push→fresh clone→restore成功。
  - [ ] **ゼロ件・空入力**: 0 project backupでもreal repo roundtrip成功。
  - [ ] **外部往復**: fresh clone bytes checksum=manifest、restore後対象論理項目不一致0件。
  - [ ] production `<login>/ai-dev-progress-tracker-backup`を変更しない。
  - [ ] user project repo/DBを変更しない。
- 検証コマンド:

```powershell
npm run real:backup-restore
```

---

## T018: Codex実機で要確認→再生成→鮮度を往復検証する

- 依存: T014
- 目的: F11/F13のreal Codex generation経路をfake以外で確認する。
- 触るファイル:
  - 新規: `scripts/real-check-regeneration.ts`
  - 変更: `package.json`
- 実装内容:
  1. `codex login status` ChatGPT、version>=0.152.0。
  2. OS tempにisolated Git repo/DBを作りfixture evidenceだけを使用。
  3. review=true→manual recovery queue→real Codex `gpt-5.6-terra`→schema validation→snapshot。
  4. real output自然言語本文を事前expectedにしない。schema/status/evidence整合/commit SHAだけ機械判定。
  5. generation後にlocal HEADとsnapshot commitを再取得してfreshness確認。
  6. 既存`npm run eval:recovery`も同じ実機ゲートで実行し、default fixtureのv1.7判定条件（recovery status + field status + required evidence + unknown evidence 0件）を維持する。`mustContain`/`mustNotContain`は任意補助checkのままdefault必須expectedへ戻さない。
- 完了条件:
  - [ ] **初回実行**: snapshot 0件のtemp projectからreal recovery snapshotを1件生成。
  - [ ] **ゼロ件・空入力**: evidence不足fieldは既存schemaの`needs_input`を許容し、捏造evidence ID 0件。
  - [ ] **外部往復**: Codex output→DB保存→再取得snapshot commit SHA=`git rev-parse HEAD`。
  - [ ] `progress-output.schema.json` v1に完全適合。
  - [ ] 根拠不足caseでも`CODEX_OUTPUT_INVALID`でsnapshot 0件にならず、4field needs_inputなら`unrecoverable` snapshotが残る。
  - [ ] `eval:recovery`は復元可能10case中8以上、根拠不足4caseは4/4 `unrecoverable`。
  - [ ] default `recovery-cases.json`に自然言語本文の`mustContain`/`mustNotContain`必須期待値を再導入しない。任意補助checkを指定したcaseでは現行v1.7 evaluatorのcheck動作を維持する。
  - [ ] review flagは自動clearされない。
  - [ ] target repo/user dataを変更しない。
- 検証コマンド:

```powershell
npm run real:regeneration; if ($LASTEXITCODE) { exit $LASTEXITCODE }; $out = Join-Path $env:TEMP 'ai-dev-progress-tracker-recovery-eval.json'; npm run eval:recovery -- --out $out; if ($LASTEXITCODE) { exit $LASTEXITCODE }; $r = Get-Content $out -Raw | ConvertFrom-Json; $thin = @($r.cases | Where-Object { $_.id -in @('rec-11','rec-12','rec-13','rec-14') }); $recoverable = @($r.cases | Where-Object { $_.id -notin @('rec-11','rec-12','rec-13','rec-14') }); $recoverablePassed = @($recoverable | Where-Object { $_.pass -eq $true }).Count; $thinBad = @($thin | Where-Object { $_.recoveryStatus -ne 'unrecoverable' -or $_.fieldStatus.currentPosition -ne 'needs_input' -or $_.fieldStatus.completedItems -ne 'needs_input' -or $_.fieldStatus.nextActions -ne 'needs_input' -or $_.fieldStatus.importantDecisions -ne 'needs_input' }).Count; Remove-Item $out -Force -ErrorAction SilentlyContinue; if ($recoverable.Count -ne 10 -or $recoverablePassed -lt 8 -or $thin.Count -ne 4 -or $thinBad -ne 0) { Write-Error "recovery eval gate failed: recoverable=$recoverablePassed/10 thinBad=$thinBad"; exit 1 }
```


---

## T019: dense / compact表示切替

- 依存: T013
- 目的: F6を管理data無変更で実装する。
- 触るファイル:
  - 新規: `src/web/components/CompactProjectCard.tsx`
  - 変更: `src/web/components/DashboardToolbar.tsx`
  - 変更: `src/web/pages/DashboardPage.tsx`
  - 変更: `src/web/styles.css`
  - 変更: `tests/e2e/dashboard.spec.ts`
- 実装内容:
  1. toggleを`dense|compact`固定値で実装。
  2. localStorage key/valueをDESIGN.mdどおり実装。
  3. compactはwidth>=1600pxで3 columns、同じProjectSummaryV2だけを表示。
  4. toggleでAPI mutationを呼ばない。
- 完了条件:
  - [ ] **初回実行**: localStorage keyなしでdense。
  - [ ] **ゼロ件・空入力**: project 0件で両viewともempty state。
  - [ ] **外部往復**: toggle前後にproject GETを再取得し、管理payloadが同一であることを確認。
  - [ ] reload後にvalid localStorage値を復元。
  - [ ] invalid localStorage値はdenseへfallback。
- 検証コマンド:

```powershell
npm run test:e2e -- tests/e2e/dashboard.spec.ts
```

---

## T020: project名・keyword検索

- 依存: T019
- 目的: F7を固定normalized substring検索で実装する。
- 触るファイル:
  - 変更: `src/web/components/DashboardToolbar.tsx`
  - 変更: `src/web/pages/DashboardPage.tsx`
  - 変更: `tests/e2e/dashboard.spec.ts`
- 実装内容:
  1. NFKC/lower/trim/whitespace-tokenize。
  2. name, summary, owner/repo, current, completed item texts, next action textsを対象。
  3. token間AND、field内substring。
  4. searchとstate filterはAND。
- 完了条件:
  - [ ] **初回実行**: 8件からname/日本語keywordで正しいsubset。
  - [ ] **ゼロ件・空入力**: 空/whitespace queryで全件、match 0でsearch-empty。
  - [ ] **外部往復**: APIからcurrent/nextを再取得し、その値をqueryに使った結果のproject idが表示と一致。
  - [ ] NFKCで全角ASCII/半角ASCIIが同一match。
  - [ ] 2 tokenは両方を含むprojectだけ。
- 検証コマンド:

```powershell
npm run test:e2e -- tests/e2e/dashboard.spec.ts
```

---

## T021: UI性能評価harnessを隔離環境で実装する

- 依存: T020
- 目的: PLANの性能値を実測するscriptを、expected値を捏造せず作る。
- 触るファイル:
  - 新規: `scripts/eval-ui-performance.ts`
  - 変更: `package.json`
- 実装内容:
  1. OS temp `TRACKER_DATA_DIR`と固定`TRACKER_PORT=4318`。port使用中はfail。
  2. 8project + realistic text lengthのfixture DBをtempに生成。
  3. Playwright viewport=`2005x1271`。
  4. 計測:
     - navigation開始→8 row ready=`initialRenderMs`
     - search input event→result ready=`searchMs`
     - filter click→result ready=`filterMs`
  5. JSONをstdoutへ出す。このタスクでは`ui-performance-observed.json`を作らない。
  6. target repoのDB/project filesへwriteしない。
- 完了条件:
  - [ ] **初回実行**: temp DB未存在から8件seedしdry-run/measurement harnessが起動。
  - [ ] **ゼロ件・空入力**: 0件modeもoptionで実行できexception 0。
  - [ ] **外部往復**: temp project Git HEADを実Gitから取得しseed/API/DOMのproject id/SHA一致を確認してから計測。
  - [ ] 実測値を事前expected fixtureとしてコードに埋め込んでいない。
  - [ ] target `~/.ai-dev-progress-tracker`をread/writeしない。
- 検証コマンド:

```powershell
npm run eval:ui -- --dry-run
```

---

## T022: 実利用viewportで性能を実測し観測値を確定する

- 依存: T021
- 目的: harnessの実出力を確認してからbaseline evidenceを保存しPLAN thresholdを判定する。
- 触るファイル:
  - 新規: `tests/fixtures/ui-performance-observed.json`
  - 変更: `scripts/eval-ui-performance.ts`
  - 変更: `tests/e2e/dashboard.spec.ts`
- 実装内容:
  1. `npm run eval:ui`を5回実行。
  2. actual JSONをそのまま`ui-performance-observed.json`へrecordする`--record` modeを実装。手書き禁止。
  3. initial<=2000ms、search<=500ms、filter<=500msを判定。
  4. 5 runs全raw valuesを保存し、各runがthreshold以下の場合だけpass。
  5. failure時はthresholdを緩めず実装修正へ戻る。
- 完了条件:
  - [ ] **初回実行**: observation fixture未存在からactual run後に生成。
  - [ ] **ゼロ件・空入力**: 0件runもrecord内に含めerror 0。
  - [ ] **外部往復**: 各run前にtemp Git/API/DOM identityを再検証し同一8件で計測。
  - [ ] 5/5 runでinitial<=2.0s。
  - [ ] 5/5 runでsearch/filter<=0.5s。
  - [ ] fixture値はscript実出力であり想定値でない。
- 検証コマンド:

```powershell
npm run eval:ui:record
```

---

## T023: 秘密情報0件・追加費用0円・外部境界の回帰

- 依存: T011, T017, T018, T022
- 目的: F14/NFRのsecurity/cost制約をrelease gate化する。
- 触るファイル:
  - 変更: `scripts/verify-no-secrets.ts`
  - 変更: `tests/unit/redaction.test.ts`
  - 変更: `tests/integration/backup-v2.test.ts`
  - 変更: `README.md`
- 実装内容:
  1. scanner対象をDB、config example、log fixture、backup-v1/v2、test outputへ拡張。
  2. agent input message/transcriptも保存禁止として検証。
  3. child env scrubへAnthropic/OpenAI/GitHub secret keyを含める。
  4. READMEへ追加serviceなし、使用外部serviceはGitHub/既契約Codex/既存Claude Codeのみと明記。
  5. network SaaS SDKが新規dependencyにないことをassert。
- 完了条件:
  - [ ] **初回実行**: clean temp DB/log/backupでsecret scan 0件。
  - [ ] **ゼロ件・空入力**: 0 byte log/0 project backupでscanner成功。
  - [ ] **外部往復**: T011/T017でGitHubから再取得したfixture contentもscanしsecret 0件。
  - [ ] fake tokenを保存面へ注入するnegative testは必ずscanner failure。
  - [ ] 新規固定費/従量課金service 0件。
- 検証コマンド:

```powershell
npm run verify:secrets; if ($LASTEXITCODE) { exit $LASTEXITCODE }; npm run test:unit -- tests/unit/redaction.test.ts; if ($LASTEXITCODE) { exit $LASTEXITCODE }; npm run test:integration -- tests/integration/backup-v2.test.ts
```

---

## T024: 全MUST回帰・README・agent設定最終同期

- 依存: T008, T009, T010, T015, T023
- 目的: M1/M2の全MUSTを自動回帰し、利用手順とagent規約を完成させる。
- 触るファイル:
  - 変更: `README.md`
  - 変更: `AGENTS.md`
  - 変更: `CLAUDE.md`
  - 変更: `PROGRESS.md`
- 実装内容:
  1. READMEへinstall/build/setup-agents/doctor/start/manual register/restore/repair/uninstallを固定コマンドで記載。
  2. Codex notify conflict、Claude hooks disabled、agent path staleの解決手順を記載。
  3. `AGENTS.md`と`CLAUDE.md`をbyte-for-byte一致。
  4. 全fake自動test + build + secret scan。
  5. T009/T010/T011/T017/T018/T022がPROGRESS上完了済みであることを確認。
- 完了条件:
  - [ ] **初回実行**: READMEだけでclean checkout→build→doctor→setup→startまで到達可能。
  - [ ] **ゼロ件・空入力**: project/candidate 0件fresh appでempty dashboard正常。
  - [ ] **外部往復**: latest Git HEAD、GitHub fixture refs、backup fixture、real generation resultを各実機task記録から再確認し未完了0件。
  - [ ] `npm run test:all`成功。
  - [ ] `AGENTS.md`と`CLAUDE.md`のhash一致。
- 検証コマンド:

```powershell
npm run test:all; if ($LASTEXITCODE) { exit $LASTEXITCODE }; npm run verify:secrets; if ($LASTEXITCODE) { exit $LASTEXITCODE }; if ((Get-FileHash AGENTS.md).Hash -ne (Get-FileHash CLAUDE.md).Hash) { Write-Error 'AGENTS.md and CLAUDE.md differ'; exit 1 }
```

---

## T025: 手動確認（最終タスク）

- 依存: T024
- 目的: 自動テストで担保できない実利用UX、実利用PC、30秒判断テストを人間が確認する。
- 触るファイル:
  - 変更: `PROGRESS.md`
- 実装内容:
  1. 下表を上から実施し、実測値/結果をPROGRESS.mdへ記録。
  2. Windows edition/build、実利用browser名/version、Claude auth statusをこのタスクで記録。DESIGNの技術選定は変更しない。
  3. 失敗項目が1つでもあればT025は完了にしない。
- 完了条件:
  - [ ] **初回実行**: data dirを新規にして初回setup/empty dashboard/初回candidateを確認。
  - [ ] **ゼロ件・空入力**: project 0件、検索0件、history 0件を確認。
  - [ ] **外部往復**: GitHub fixture/backup fixture/real Codex generationの再取得一致を最後に1回確認。
  - [ ] 下表すべてPass。
- 検証コマンド:

```powershell
npm run test:all; if ($LASTEXITCODE) { exit $LASTEXITCODE }; npm run verify:secrets
```

| # | 操作 | 期待結果 | 対応US |
|---:|---|---|---|
| 1 | Windows edition/build、実利用browser name/versionを記録 | Windows利用時はWindows 11 24H2+。viewportを2005x1271にして以降確認 | NFR |
| 2 | `node/npm/git/gh/codex/claude --version`、`gh auth status`、`codex login status`、`claude auth status` | 各DESIGN minimum以上。gh/Codex/Claude認証OK。token本文は記録しない | F1,F3,F11 |
| 3 | empty data dirでapp起動 | 異常終了なし、empty dashboard | F5 |
| 4 | 未登録folderでCodex作業を1回 | 1st turn完了までに登録確認が開く | US-01 |
| 5 | 未登録folderでClaude Code作業を1回 | 最初のprompt処理中に登録確認が開く | US-01 |
| 6 | 登録確認で拒否 | project自動登録0件 | US-01 |
| 7 | GitHub repoなし・commitなしを承認 | Private repo + origin、push不要、project登録 | US-02 |
| 8 | GitHub repoなし・commitありを承認 | Private repo + origin + initial push、remote SHA=local HEAD | US-02 |
| 9 | 登録を意図的に2回失敗 | 1回auto retry後failed candidate表示、manual導線あり | US-03 |
| 10 | 8件dashboardを2005x1271で表示 | 通常状態で8件が1画面、各行に名前/現在地/次/最終更新 | US-04 |
| 11 | dense↔compact切替 | DB管理data不変、reloadでview modeだけ復元 | US-05 |
| 12 | name/keyword search、3 state filter | 一致対象だけ表示、空query全件、0件state正常 | US-06 |
| 13 | 8件から次project選択を5回 | 4/5以上30秒以内、各回detail遷移<=1 | US-07 |
| 14 | snapshot後に新commit | 未反映表示。再生成後snapshot SHA=HEADなら未反映解除 | US-08 |
| 15 | 要確認→再生成 | 要確認filter対象、real Codex再生成開始。成功後も要確認は自動解除されない | US-09 |
| 16 | detailでcurrent/history | currentが上部独立section、historyに埋もれない | US-10 |
| 17 | commit→generation、push→backup | commitで生成。pushだけではgeneration run増加0件 | US-11 |
| 18 | v1 backup/DBをv2へrestore | v1論理項目欠損0件 | US-12 |
| 19 | v2 backup→Private GitHub→fresh restore | v2論理項目不一致0件、derived未反映も一致 | US-12 |
| 20 | DB/config/log/backupをsecret scan | 秘密情報保存0件 | US-12/NFR |
| 21 | dashboard性能5run | initial<=2.0s、search/filter<=0.5sを各5/5 | NFR |
| 22 | 主要受入フローを5回連続 | app異常終了0回 | NFR |
| 23 | 利用service一覧/課金確認 | 追加固定費0円/月、追加従量課金0円/月 | NFR |
