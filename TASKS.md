# TASKS.md — 実装タスクリスト

project_id: ai-dev-progress-tracker  
version: 1.1  
date: 2026-09-01  
source: DESIGN.md v1.1

## v1.1変更点

- npm package manager `12.0.2`とpackage.jsonのdependencies/devDependencies 16件（合計17件のnpm package指定）の完全一致versionは変更しない。
- Node.jsは`>=24.15.0 <25`、Gitは`>=2.45.0`、ghは`>=2.98.0`、Codex CLIは`>=0.146.0`として実装する。
- CIだけは再現性のためNode.js `24.15.0`を`setup-node`へ指定する。
- runtime/CLI検査は文字列完全一致ではなくDESIGN.md v1.1のsemantic version下限比較を使用する。
- 本v1.1のversion要件は、旧AGENTS.md等に残るv1.0の外部CLI完全一致記述より優先する。

## 依存関係

```text
T001
 ├─→ T002 ─→ T004 ─→ T005 ─→ T006 ─→ T007
 ├─→ T003 ───────────────┐
 └───────────────────────┴─→ T008 ─→ T009 ─→ T010 ─→ T011 ─→ T012
                                      │
                                      └──────────────→ T013 ─→ T014 ─→ T015 ─→ T016
T007 ───────────────────────────────────────────────────────────────┐
T012 ───────────────────────────────────────────────────────────────┼─→ T017 ─→ T018 ─→ T019 ─→ T020
T016 ───────────────────────────────────────────────────────────────┘
```

## 進め方

- 上から順に実行する。
- 依存タスクが未完了のタスクには着手しない。
- 1タスク内で機能実装と対応テストを同時に追加する。
- 各タスクの検証コマンドが全て通ってからコミットする。
- コミットメッセージは`Txxx: <タスク名>`。
- DESIGN.mdにないファイルを追加しない。

---

## T001: リポジトリ雛形・テスト基盤・CI

- 依存: なし
- 目的: 以降の全タスクを自動検証できる土台を作る。
- 触るファイル:
  - 新規: `package.json`
  - 新規: `package-lock.json`
  - 新規: `.nvmrc`
  - 新規: `.gitignore`
  - 新規: `.env.example`
  - 新規: `PROGRESS.md`
  - 新規: `tsconfig.json`
  - 新規: `tsconfig.server.json`
  - 新規: `vite.config.ts`
  - 新規: `vitest.config.ts`
  - 新規: `playwright.config.ts`
  - 新規: `biome.json`
  - 新規: `index.html`
  - 新規: `src/server/index.ts`
  - 新規: `src/server/app.ts`
  - 新規: `src/server/config.ts`
  - 新規: `src/server/routes/health.ts`
  - 新規: `src/shared/api.ts`
  - 新規: `src/shared/domain.ts`
  - 新規: `src/web/main.tsx`
  - 新規: `src/web/App.tsx`
  - 新規: `src/web/styles.css`
  - 新規: `tests/unit/smoke.test.ts`
  - 新規: `.github/workflows/ci.yml`
  - 新規: `CLAUDE.md`
- 実装内容:
  1. DESIGN.md v1.1のpackage.jsonをそのまま反映し、npm `12.0.2`とdependencies/devDependencies 16件は完全一致、`engines.node`は`>=24.15.0 <25`、`engines.npm`は`12.0.2`とする。
  2. `.nvmrc`を`24.15.0`にする。
  3. Fastifyへ`GET /api/health`を実装し、`127.0.0.1` bindの起動コードを作る。
  4. `@fastify/static`で`dist/web`を配信し、`/`と`/projects/*`は`index.html`へfallbackする。
  5. Reactは「AI Dev Progress Tracker」の最小画面だけを描画する。
  6. Vite build出力を`dist/web`、server build出力を`dist`にする。
  7. PlaywrightはChromiumのみ使用し、`npm start`をwebServerにする。
  8. CIは`ubuntu-24.04`、`actions/checkout@v7.0.1`、`actions/setup-node@v7.0.0`、`node-version: 24.15.0`を固定する。
  9. CIで`npm install --global npm@12.0.2`後にnpm versionを完全一致検証し、lint/typecheck/test/build/E2Eを実行する。
  10. `CLAUDE.md`は提供済み`AGENTS.md`の完全コピーにする。
  11. `PROGRESS.md`へT001〜T020を全行作成し、T001だけ`進行中`、残りを`未着手`にする。
- 完了条件:
  - [ ] `npm ci`が成功する。
  - [ ] `npm run lint`がerror 0。
  - [ ] `npm run typecheck`がerror 0。
  - [ ] `npm test`でsmoke testが1件以上通る。
  - [ ] `npm run build`が成功する。
  - [ ] CI YAMLがGitHub Actions構文として成立する。
  - [ ] CI actionとnpmは指定versionに固定され、CI Nodeは`24.15.0`を使用する。
  - [ ] package.jsonの`engines.node`が`>=24.15.0 <25`である。
  - [ ] dependencies/devDependencies 17件のversionがDESIGN.md v1.1から1文字も変わっていない。
  - [ ] `PROGRESS.md`にT001〜T020が存在する。
  - [ ] CIで外部GitHub/Codexを呼ばない。
- 検証コマンド:

```bash
node -e "const v=process.versions.node.split('.').map(Number); if (!(v[0]===24 && (v[1]>15 || (v[1]===15 && v[2]>=0)))) process.exit(1)" && test "$(npm --version)" = "12.0.2" && npm ci && npm run lint && npm run typecheck && npm test && npm run build
```

---

## T002: SQLite schema・migration・repository基盤

- 依存: T001
- 目的: DESIGN.mdの全永続化モデルをv1 schemaとして作る。
- 触るファイル:
  - 新規: `db/migrations/001_init.sql`
  - 新規: `src/server/db/connection.ts`
  - 新規: `src/server/db/migrations.ts`
  - 新規: `src/server/db/lease-repository.ts`
  - 新規: `src/server/db/project-repository.ts`
  - 新規: `src/server/db/progress-repository.ts`
  - 新規: `src/server/db/run-repository.ts`
  - 新規: `src/server/db/backup-repository.ts`
  - 新規: `tests/helpers/test-db.ts`
  - 新規: `tests/unit/lease-repository.test.ts`
  - 新規: `tests/integration/db-migrations.test.ts`
  - 変更: `src/server/config.ts`
- 実装内容:
  1. DESIGN.mdのDDLを`001_init.sql`へそのまま実装する。
  2. DB open時にmigrationを1回だけ適用する。
  3. WAL、foreign_keys、synchronous FULLを有効化する。
  4. project/run/snapshot/backup/worker leaseのCRUDをrepositoryへ分離する。
  5. leaseの作成・heartbeat・owner token一致release・180秒stale判定を実装する。
  6. テストDBは一時directoryへ作り、各テスト終了時に削除する。
- 完了条件:
  - [ ] 空DBへmigration v1を適用できる。
  - [ ] 再起動してもmigrationが二重適用されない。
  - [ ] foreign key違反が拒否される。
  - [ ] project/repo_node_id/local_pathのUNIQUEが機能する。
  - [ ] progress JSON列へinvalid JSONを保存できない。
  - [ ] worker leaseをscope単位で1件だけ取得でき、owner token不一致ではreleaseできない。
- 検証コマンド:

```bash
npx vitest run tests/integration/db-migrations.test.ts tests/unit/lease-repository.test.ts && npm run typecheck
```

---

## T003: process runner・秘密情報redaction・外部CLI検査

- 依存: T001
- 目的: git/gh/codexを秘密情報を保存せず安全に呼ぶ共通基盤を作る。
- 触るファイル:
  - 新規: `src/server/adapters/process-runner.ts`
  - 新規: `src/server/security/redaction.ts`
  - 新規: `src/server/logging.ts`
  - 新規: `src/cli/commands/doctor.ts`
  - 新規: `src/cli/index.ts`
  - 新規: `tests/unit/redaction.test.ts`
  - 新規: `tests/unit/version-check.test.ts`
  - 変更: `src/server/config.ts`
  - 変更: `src/server/index.ts`
  - 変更: `package.json`
- 実装内容:
  1. child processを`spawn`、`shell:false`で実行するrunnerを作る。
  2. stdout/stderrの最大captureを各1 MiBに制限する。
  3. timeout後はchild processをkillし、固定error codeへ変換する。
  4. DESIGN.mdのsecret key一覧を再帰redactionする。
  5. `src/server/config.ts`へDESIGN.md v1.1指定の`MAJOR.MINOR.PATCH`抽出、整数tuple比較、minimum/range判定pure functionを実装する。追加semver packageは禁止。
  6. `doctor`でNode `>=24.15.0 <25`、Git `>=2.45.0`、gh `>=2.98.0`、Codex `>=0.146.0`を下限比較し、gh auth、Codex ChatGPT authも検査する。
  7. server起動前にも同じversion判定を実行し、minimum未満またはparse不能ならlistenを開始せず終了する。
  8. Codex auth raw出力とgh auth raw出力をlogへ残さない。
- 完了条件:
  - [ ] sentinel tokenがredaction後に残らない。
  - [ ] timeout child processが終了する。
  - [ ] Node `24.14.9` fail / `24.15.0` pass / `24.99.99` pass / `25.0.0` fail。
  - [ ] Git `2.44.9` fail / `2.45.0` pass / `3.0.0` pass。
  - [ ] gh `2.97.9` fail / `2.98.0` pass / `3.0.0` pass。
  - [ ] Codex `0.145.9` fail / `0.146.0` pass / `0.147.0` pass。
  - [ ] parse不能versionは`VERSION_PARSE_ERROR`。
  - [ ] `doctor`はminimum未満・Node major上限超過・parse不能をnon-zeroで返す。
  - [ ] server起動時も同一判定関数を使用する。
  - [ ] `codex login status`がAPI key認証なら`AI_AUTH_NOT_CHATGPT`。
- 検証コマンド:

```bash
npx vitest run tests/unit/redaction.test.ts tests/unit/version-check.test.ts && npm run typecheck && npm run lint
```

---

## T004: Git・GitHub adapterとrepository帰属検証

- 依存: T002, T003
- 目的: local Git rootとGitHub repositoryを一意に検証できるようにする。
- 触るファイル:
  - 新規: `src/server/adapters/git.ts`
  - 新規: `src/server/adapters/github.ts`
  - 新規: `tests/helpers/fake-gh.ts`
  - 新規: `tests/helpers/temp-repo.ts`
  - 新規: `tests/unit/git-adapter.test.ts`
  - 新規: `tests/unit/github-adapter.test.ts`
- 実装内容:
  1. Git root realpath、absolute git dir、`core.hooksPath`、origin URL、HEAD SHA、commit metadataを取得する。
  2. standard layoutは`absolute git dir == <root>/.git`かつ`core.hooksPath`未設定と定義する。
  3. HTTPS/SSHのGitHub originを`owner/repo`へ正規化し、raw origin URLは返却後に保持しない。
  4. GitHub adapterへ`repo view`、Issue最大20件、PR最大20件を実装する。
  5. GitHub adapterは引数として渡された`owner/repo`以外を参照しない。
  6. fake-ghをPATH先頭へ差し込めるようにする。
- 完了条件:
  - [ ] HTTPS/SSH originを同じ`owner/repo`へ正規化できる。
  - [ ] Git root以外のsubdirectoryを登録対象として拒否できる。
  - [ ] linked worktreeを`GIT_LAYOUT_UNSUPPORTED`で拒否できる。
  - [ ] `core.hooksPath`設定済みrepoを`CUSTOM_HOOKS_PATH_UNSUPPORTED`で拒否できる。
  - [ ] 別repository指定を`REPOSITORY_MISMATCH`にできる。
  - [ ] Issue/PR取得コマンドへ常に`-R owner/repo`が入る。
- 検証コマンド:

```bash
npx vitest run tests/unit/git-adapter.test.ts tests/unit/github-adapter.test.ts && npm run typecheck
```

---

## T005: プロジェクト登録APIとGit hook設置

- 依存: T004
- 目的: US-01を実装し、登録済みprojectへcommit/push hookを設置する。
- 触るファイル:
  - 新規: `src/server/schemas/project.ts`
  - 新規: `src/server/services/project-service.ts`
  - 新規: `src/server/services/hook-service.ts`
  - 新規: `src/server/routes/projects.ts`
  - 新規: `tests/unit/hook-service.test.ts`
  - 新規: `tests/integration/project-registration.test.ts`
  - 変更(実行時): `<registered-project>/.git/hooks/post-commit`
  - 変更(実行時): `<registered-project>/.git/hooks/pre-push`
  - 変更: `src/server/app.ts`
  - 変更: `src/shared/api.ts`
  - 変更: `src/shared/domain.ts`
- 実装内容:
  1. `POST /api/projects`をDESIGN.mdの16段階固定処理順で実装する。
  2. `projects`保存前に重複を検査する。
  3. `post-commit`と`pre-push`へmarker付き管理ブロックを追加する。
  4. 既存shebang付きhookは本文を保持する。
  5. shebangなし既存hookは一切変更せず`HOOK_UNSUPPORTED`で失敗する。
  6. 同じproject IDの管理ブロックは重複追加しない。
- 完了条件:
  - [ ] 正しいlocal repoとGitHub repoを登録できる。
  - [ ] repo_node_idとlocal_pathが保存される。
  - [ ] originと入力repositoryが違う場合はDBへ保存されない。
  - [ ] 別repo情報が登録projectへ混入しない。
  - [ ] 2種hookが設置される。
  - [ ] 既存hook本文がbyte-for-byte保持される。
- 検証コマンド:

```bash
npx vitest run tests/unit/hook-service.test.ts tests/integration/project-registration.test.ts && npm run typecheck
```

---

## T006: dashboard API・登録フォーム・ProjectCard

- 依存: T005
- 目的: US-02の一覧表示とUI-01/UI-02を実装する。
- 触るファイル:
  - 新規: `src/web/api/client.ts`
  - 新規: `src/web/components/RegisterProjectForm.tsx`
  - 新規: `src/web/components/ProjectCard.tsx`
  - 新規: `src/web/components/StatusBanner.tsx`
  - 新規: `src/web/pages/DashboardPage.tsx`
  - 新規: `tests/e2e/dashboard.spec.ts`
  - 新規: `tests/e2e/registration.spec.ts`
  - 変更: `src/web/App.tsx`
  - 変更: `src/web/styles.css`
  - 変更: `src/server/routes/projects.ts`
  - 変更: `src/shared/api.ts`
- 実装内容:
  1. `GET /api/projects`へ最新snapshotをjoinしたread modelを実装する。
  2. ProjectCard表示順をDESIGN.mdどおり固定する。
  3. snapshotなしは「進捗生成中」または最後のfailureを表示する。
  4. `needs_input`は「要補完」表示する。
  5. 登録フォームから`POST /api/projects`を呼ぶ。
- 完了条件:
  - [ ] 全projectについてrepositoryと最終commitを識別できる。
  - [ ] current/completed/nextの3項目がカード内に表示される。
  - [ ] 別projectのsnapshotが表示されない。
  - [ ] 登録成功後に一覧へ追加される。
  - [ ] API error codeをStatusBannerへ表示できる。
- 検証コマンド:

```bash
npm run build && npx playwright test tests/e2e/dashboard.spec.ts tests/e2e/registration.spec.ts
```

---

## T007: project詳細・重要判断・根拠表示

- 依存: T006
- 目的: US-03とUS-05の確認画面を実装する。
- 触るファイル:
  - 新規: `src/web/components/ProgressSection.tsx`
  - 新規: `src/web/components/EvidenceList.tsx`
  - 新規: `src/web/pages/ProjectDetailPage.tsx`
  - 新規: `tests/e2e/project-detail.spec.ts`
  - 変更: `src/web/App.tsx`
  - 変更: `src/web/api/client.ts`
  - 変更: `src/server/routes/projects.ts`
  - 変更: `src/server/db/progress-repository.ts`
  - 変更: `src/shared/api.ts`
- 実装内容:
  1. `GET /api/projects/:id`を実装する。
  2. snapshot JSON内のevidence IDを`evidence`行へ解決する。
  3. decision、rationale、根拠を同じblockで表示する。
  4. commit/Issue/PRのURLがある場合のみ外部linkを表示する。
  5. route libraryを追加せず`App.tsx`で`window.location.pathname`を判定する。
- 完了条件:
  - [ ] 判断事項と判断理由を確認できる。
  - [ ] 使用したcommit/Issue/PRを識別できる。
  - [ ] unknown evidence IDはAPI層で500にせず、snapshot整合性errorとしてStatusBanner表示する。
  - [ ] project間でevidenceが混入しない。
- 検証コマンド:

```bash
npm run build && npx playwright test tests/e2e/project-detail.spec.ts && npm run typecheck
```

---

## T008: commit queue・dedupe・detached worker

- 依存: T003, T005
- 目的: post-commitからAI生成処理を非同期開始し、同一commitの二重生成を防ぐ。
- 触るファイル:
  - 新規: `src/cli/commands/hook-commit.ts`
  - 新規: `src/worker/index.ts`
  - 新規: `src/worker/generation-worker.ts`
  - 新規: `src/server/services/generation-service.ts`
  - 新規: `tests/integration/commit-generation-flow.test.ts`
  - 変更: `src/cli/index.ts`
  - 変更: `src/server/db/run-repository.ts`
- 実装内容:
  1. hook引数project ID/repo/SHAをDB登録前に検証する。
  2. commit metadataを`commits`へupsertする。
  3. `dedupe_key=generation:<project-id>:<sha>`でrunを1件だけqueueする。
  4. enqueue transactionで`worker_leases.scope=generation:<project-id>`を取得し、取得した呼出元だけ`shouldSpawn=true`にする。
  5. `shouldSpawn=true`の場合だけNode `spawn(process.execPath, ..., {detached:true,stdio:"ignore"})`でworkerを起動し`unref()`する。
  6. workerはlease tokenを検証し、queued runを`detected_at ASC, id ASC`で1件ずつatomicにrunningへ遷移して処理する。
  7. queueが空のtransaction内でowner token一致releaseを行う。
  8. worker spawn失敗時はleaseをreleaseし、起点runを`failed / WORKER_SPAWN_FAILED`にする。
- 完了条件:
  - [ ] hook commandは2秒以内にexitするテストが通る。
  - [ ] 同じcommitを10回enqueueしてgeneration runが1件。
  - [ ] 同projectへ連続3 runをqueueしてworker leaseは1件、処理順はenqueue順。
  - [ ] queue空判定と同時に新runをenqueueしても取りこぼさないtransaction testが通る。
  - [ ] 別projectの同一SHA文字列は別runとして扱える。
  - [ ] worker開始時刻が記録される。
- 検証コマンド:

```bash
npx vitest run tests/integration/commit-generation-flow.test.ts && npm run typecheck
```

---

## T009: commit・Issue・PR根拠収集とrun_evidence

- 依存: T008
- 目的: US-05の生成用evidence bundleを作る。
- 触るファイル:
  - 新規: `tests/unit/evidence-validation.test.ts`
  - 変更: `src/server/adapters/git.ts`
  - 変更: `src/server/adapters/github.ts`
  - 変更: `src/server/services/generation-service.ts`
  - 変更: `src/server/db/progress-repository.ts`
  - 変更: `tests/integration/commit-generation-flow.test.ts`
- 実装内容:
  1. commit patch最大120,000文字のcaptureを実装する。
  2. Issue/PRを各20件、body 8,000文字で正規化する。
  3. evidence IDをUUIDで払い出す。
  4. commit message/patchとIssue/PR title/bodyへDESIGN.mdのhigh-confidence secret scannerを保存前に適用する。
  5. 同source versionの同evidenceをupsertする。
  6. run_evidenceへ当該runで使うevidenceだけを紐付ける。
  7. 最新snapshot 1件を生成contextへ追加するが、evidence IDとしては扱わない。
- 完了条件:
  - [ ] commit/Issue/PRがbundleへ含まれる。
  - [ ] 他repositoryのfake-ghデータがbundleへ入らない。
  - [ ] patch/body上限が守られる。
  - [ ] GitHub/OpenAI/Anthropic/AWS/PEM/key-value sentinelがDBのevidenceへ平文保存されない。
  - [ ] run_evidence件数がbundle内evidence件数と一致する。
- 検証コマンド:

```bash
npx vitest run tests/unit/evidence-validation.test.ts tests/integration/commit-generation-flow.test.ts && npm run typecheck
```

---

## T010: Codex CLI adapter・JSON Schema・出力検証

- 依存: T009
- 目的: 追加従量課金APIなしで構造化progressを生成する。
- 触るファイル:
  - 新規: `schemas/progress-output.schema.json`
  - 新規: `src/server/schemas/progress.ts`
  - 新規: `src/server/adapters/codex.ts`
  - 新規: `tests/helpers/fake-codex.ts`
  - 新規: `tests/unit/progress-schema.test.ts`
  - 新規: `tests/unit/codex-adapter.test.ts`
  - 変更: `src/server/services/generation-service.ts`
- 実装内容:
  1. DESIGN.mdのprogress JSON contractをJSON Schemaへ実装する。
  2. 同じcontractをZodへ実装する。
  3. Codex実行直前に共有version判定関数でCodex CLIが`>=0.146.0`であることを検査し、その後ChatGPT authを再検査する。
  4. DESIGN.mdの固定argvでCodexを実行する。
  5. `OPENAI_API_KEY`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`を子環境から削除する。
  6. output JSONの全evidence IDがrun_evidenceに存在することを検査する。
- 完了条件:
  - [ ] valid outputはparse成功。
  - [ ] 4必須field欠落は失敗。
  - [ ] unknown evidence IDは失敗。
  - [ ] `needs_input`形式違反は失敗。
  - [ ] `importantDecisions`はfield-level evidence付きなら`confirmed/items=[]`を許可し、evidenceなしでは拒否。
  - [ ] Codex `0.145.9`はexec前に`CODEX_VERSION_UNSUPPORTED`で拒否し、`0.146.0`と`0.147.0`はversion検査を通過する。
  - [ ] API key authはCodex exec前に拒否。
  - [ ] fake Codexへ渡した環境に`OPENAI_API_KEY`が存在しない。
- 検証コマンド:

```bash
npx vitest run tests/unit/progress-schema.test.ts tests/unit/codex-adapter.test.ts && npm run typecheck
```

---

## T011: generation結果保存・failure可視化

- 依存: T010
- 目的: US-04の正常生成、失敗状態、push非再生成を完成させる。
- 触るファイル:
  - 変更: `src/server/services/generation-service.ts`
  - 変更: `src/worker/generation-worker.ts`
  - 変更: `src/server/db/progress-repository.ts`
  - 変更: `src/server/db/run-repository.ts`
  - 変更: `src/server/routes/projects.ts`
  - 変更: `src/web/components/StatusBanner.tsx`
  - 変更: `tests/integration/commit-generation-flow.test.ts`
  - 変更: `tests/e2e/dashboard.spec.ts`
- 実装内容:
  1. valid outputをprogress snapshotへtransaction保存する。
  2. confirmed数4なら`succeeded/complete`、1〜3なら`partial/partial`、0なら`unrecoverable/unrecoverable`にする。
  3. Codex failure、timeout、invalid outputはrun=`failed`にしsnapshotを作らない。
  4. dashboard/detailのlatest snapshotを`commits.detected_at DESC, progress_snapshots.created_at DESC`で選ぶ。
  5. push hookからgeneration serviceを呼ぶ経路を作らない。
  6. latest generation failure/partial/unrecoverableをdashboard/detailへ表示する。
- 完了条件:
  - [ ] 正常runで必須4項目が保存される。
  - [ ] 3 confirmed + 1 needs_inputが`partial`。
  - [ ] 0 confirmedが`unrecoverable`。
  - [ ] 古いcommit runが後から完了してもdashboardの最終反映commitが巻き戻らない。
  - [ ] Codex exit 1を成功扱いしない。
  - [ ] invalid JSONを成功扱いしない。
  - [ ] 同一commitのpush想定処理でgeneration run数が増えない。
  - [ ] failureがUIから確認できる。
- 検証コマンド:

```bash
npx vitest run tests/integration/commit-generation-flow.test.ts && npm run build && npx playwright test tests/e2e/dashboard.spec.ts
```

---

## T012: 自動復元・要補完・3段階判定

- 依存: T011
- 目的: US-06を実装する。
- 触るファイル:
  - 新規: `src/server/services/recovery-service.ts`
  - 新規: `tests/unit/recovery-classifier.test.ts`
  - 新規: `tests/integration/recovery-flow.test.ts`
  - 変更: `src/server/routes/projects.ts`
  - 変更: `src/server/services/project-service.ts`
  - 変更: `src/server/services/generation-service.ts`
  - 変更: `src/server/schemas/progress.ts`
  - 変更: `src/web/pages/ProjectDetailPage.tsx`
- 実装内容:
  1. project登録後にsnapshotがなければ`recovery` runを自動queueする。
  2. `POST /api/projects/:id/recover`で明示retry可能にする。
  3. recovery promptも同じ4-field schemaを使う。
  4. confirmed 4=complete、1〜3=partial、0=unrecoverable。
  5. `needs_input`fieldをUIで不足項目として列挙する。
- 完了条件:
  - [ ] 全4 fieldに根拠があるfixtureはcomplete。
  - [ ] 1 field根拠不足はそのfieldが「要補完」、全体partial。
  - [ ] 全field根拠不足はunrecoverable。
  - [ ] needs_inputを確定値として保存しない。
  - [ ] 不足field名をUIで確認できる。
- 検証コマンド:

```bash
npx vitest run tests/unit/recovery-classifier.test.ts tests/integration/recovery-flow.test.ts && npm run typecheck
```

---

## T013: backup export・schema・Private repository bootstrap

- 依存: T009
- 目的: F7のbackupデータ形式と専用Private repositoryを作る。
- 触るファイル:
  - 新規: `schemas/backup-v1.schema.json`
  - 新規: `src/server/schemas/backup.ts`
  - 新規: `src/server/services/backup-service.ts`
  - 新規: `tests/unit/backup-export.test.ts`
  - 変更: `src/server/adapters/github.ts`
  - 変更: `src/server/db/backup-repository.ts`
- 実装内容:
  1. DESIGN.md指定6テーブルをID順へsortしたJSONへexportし、`backup_runs`と`worker_leases`を含めない。
  2. export全文字列へhigh-confidence secret scannerを再適用し、1件でも検知したら`SECRET_DETECTED`で中止する。
  3. backup JSONのSHA-256と件数をmanifestへ書く。
  4. active gh loginからuser loginを取得する。
  5. `<login>/ai-dev-progress-tracker-backup`がなければPrivate作成する。
  6. 既存repoがPrivateでない、またはmarker不一致なら拒否する。
  7. `gh auth setup-git`をensure時に実行する。
- 完了条件:
  - [ ] 同じDBから2回exportしたdata部がbyte-identical。
  - [ ] backup JSONにbackup_runs/worker_leases/log/env/secretが含まれない。
  - [ ] secret-like sentinelを含むexportはpush前に`SECRET_DETECTED`で失敗する。
  - [ ] Private以外の既存backup repoを拒否する。
  - [ ] manifest SHA-256がdataと一致する。
- 検証コマンド:

```bash
npx vitest run tests/unit/backup-export.test.ts && npm run typecheck
```

---

## T014: backup worker・registration/pre-push自動backup・状態表示

- 依存: T013
- 目的: push時に進捗を再生成せずbackupを自動実行する。
- 触るファイル:
  - 新規: `src/cli/commands/hook-backup.ts`
  - 新規: `src/worker/backup-worker.ts`
  - 新規: `src/server/routes/backup.ts`
  - 新規: `tests/integration/backup-flow.test.ts`
  - 変更: `src/cli/index.ts`
  - 変更: `src/worker/index.ts`
  - 変更: `src/server/services/backup-service.ts`
  - 変更: `src/server/services/project-service.ts`
  - 変更: `src/server/app.ts`
  - 変更: `src/server/routes/system.ts`
  - 変更: `src/web/components/StatusBanner.tsx`
- 実装内容:
  1. registration完了後にbackup runをqueueする。
  2. pre-push hook commandはbackup runだけqueueしgenerationを呼ばない。
  3. enqueue transactionでglobal `worker_leases.scope=backup`を取得し、取得した呼出元だけworkerをspawnする。
  4. registration/pre-pushではsource commitのgeneration terminalを最大180秒待ち、manualでは全active generationが0件になるまで最大180秒待つ。
  5. timeout時は`GENERATION_NOT_SETTLED`でbackupを失敗させる。
  6. local backup cloneを`pull --ff-only`し、manifest/dataを書き、変更がある時だけcommit/pushする。
  7. exportが前回とbyte-identicalなら既存backup HEADを保存して成功扱いにする。
  8. backup成功/失敗をbackup_runsへ保存する。
  9. `POST /api/backup`をmanual triggerとして実装する。
  10. latest backup failureをdashboardで確認可能にする。
- 完了条件:
  - [ ] registrationでbackup runが1件queueされる。
  - [ ] pre-pushでbackup runがqueueされる。
  - [ ] pre-pushでgeneration runが増えない。
  - [ ] backup failureがfailedとして残る。
  - [ ] backup successでbackup commit SHAが保存される。
  - [ ] generation未完了のpre-push backupは先にexportせずterminal化を待つ。
  - [ ] 180秒待機超過は`GENERATION_NOT_SETTLED`。
  - [ ] 並行2回backupでDB leaseにより同時pushしない。
  - [ ] export差分なしでは不要なbackup commitを増やさない。
- 検証コマンド:

```bash
npx vitest run tests/integration/backup-flow.test.ts && npm run typecheck
```

---

## T015: restore import core・checksum/FK/件数検証

- 依存: T014
- 目的: backupから安全に新規DBを再構築するcoreを作る。
- 触るファイル:
  - 新規: `src/server/services/restore-service.ts`
  - 新規: `tests/integration/restore-flow.test.ts`
  - 変更: `src/server/schemas/backup.ts`
  - 変更: `src/server/db/migrations.ts`
- 実装内容:
  1. manifest appId/schemaVersionを検証する。
  2. data SHA-256を検証する。
  3. backup JSON schemaを検証する。
  4. temporary SQLiteへmigrationして6テーブルをtransaction importする。
  5. `PRAGMA foreign_key_check`が0行であることを確認する。
  6. table件数がmanifest countsと一致することを確認する。
  7. 全検証成功時だけtemporary DBを確定可能な状態として返す。
- 完了条件:
  - [ ] 正常backupを100% importできる。
  - [ ] checksum不一致を拒否する。
  - [ ] FK不整合を拒否する。
  - [ ] 件数不一致を拒否する。
  - [ ] 失敗時に既存tracker.dbを変更しない。
- 検証コマンド:

```bash
npx vitest run tests/integration/restore-flow.test.ts && npm run typecheck
```

---

## T016: restore CLI・atomic DB置換・hook再設置

- 依存: T015
- 目的: ローカルデータ消失からユーザーが1コマンドで復元できるようにする。
- 触るファイル:
  - 新規: `src/cli/commands/restore.ts`
  - 変更: `src/cli/index.ts`
  - 変更: `src/server/services/restore-service.ts`
  - 変更: `src/server/services/hook-service.ts`
  - 変更: `src/server/adapters/github.ts`
  - 変更: `tests/integration/restore-flow.test.ts`
  - 変更(実行時): `<restored-project>/.git/hooks/post-commit`
  - 変更(実行時): `<restored-project>/.git/hooks/pre-push`
- 実装内容:
  1. gh active userから固定backup repoを求める。
  2. local backup cloneがなければclone、あれば`pull --ff-only`する。
  3. 既存DBありで`--force`なしはexit 2。
  4. `--force`時は既存DBをtimestamp付きで退避する。
  5. 検証済みtemp DBをatomic renameして`tracker.db`にする。
  6. 各projectのlocal_pathが存在しrepo identity一致ならhookを再設置する。
  7. local_pathなしはproject status=`local_missing`にする。
- 完了条件:
  - [ ] DB削除後に全project/mapping/snapshot/evidence/runを復元できる。
  - [ ] 既存DBを無断上書きしない。
  - [ ] 復元後に対象repoのhookが存在する。
  - [ ] local missing projectはデータを失わず`local_missing`になる。
- 検証コマンド:

```bash
npx vitest run tests/integration/restore-flow.test.ts && npm run build
```

---

## T017: system status API・server hardening

- 依存: T007, T012, T016
- 目的: 失敗状態の一元表示とlocalhost境界を完成させる。
- 触るファイル:
  - 新規: `src/server/routes/system.ts`
  - 変更: `src/server/app.ts`
  - 変更: `src/server/index.ts`
  - 変更: `src/web/pages/DashboardPage.tsx`
  - 変更: `src/web/components/StatusBanner.tsx`
  - 変更: `src/shared/api.ts`
  - 変更: `tests/e2e/dashboard.spec.ts`
- 実装内容:
  1. `GET /api/system/status`へlatest generation/backup failureを返す。
  2. Host allowlistを実装する。
  3. mutation requestのOrigin allowlistを実装する。
  4. listen hostをconfig変更不可の`127.0.0.1`へ固定する。
  5. dashboard上部にsystem statusを表示する。
- 完了条件:
  - [ ] 非localhost Host requestを403。
  - [ ] 外部OriginのPOSTを403。
  - [ ] GETは同一hostから正常。
  - [ ] generation/backup failureをdashboardで確認できる。
- 検証コマンド:

```bash
npm run build && npx playwright test tests/e2e/dashboard.spec.ts && npm run typecheck
```

---

## T018: 非機能自動試験・秘密情報0件検査・評価harness

- 依存: T017
- 目的: PLAN.mdの数値要件を機械計測できるようにする。
- 触るファイル:
  - 新規: `tests/fixtures/generation-cases.json`
  - 新規: `tests/fixtures/recovery-cases.json`
  - 新規: `scripts/eval-generation.ts`
  - 新規: `scripts/eval-recovery.ts`
  - 新規: `scripts/verify-no-secrets.ts`
  - 変更: `tests/e2e/dashboard.spec.ts`
  - 変更: `tests/e2e/project-detail.spec.ts`
  - 変更: `tests/integration/commit-generation-flow.test.ts`
  - 変更: `tests/integration/recovery-flow.test.ts`
- 実装内容:
  1. dashboard 100project fixtureで2秒以内を計測する。
  2. detail evidence 100件fixtureで2秒以内を計測する。
  3. server start/stop 10回試験を追加する。
  4. commit hook→run startedのlatencyを計測する。
  5. fake failure 3種の100%失敗可視化試験を追加する。
  6. GitHub/OpenAI/Anthropic/AWS/PEM/password/token sentinelをevidenceとenvへ置き、DB/log/backup exportを走査するscriptを実装する。
  7. live Codex用generation/recovery各10ケース評価harnessを実装する。CIでは実行しない。
  8. 評価harnessはDESIGN.mdのNFKC+substring+evidence key方式でcaseごとのpass/failを判定する。
  9. generation harnessは`--repo <absolute-git-root>`を受け、fixtureのfile変更→commit→run terminal待機を10回行い、各runの`started_at-detected_at<=60秒`も判定する。
- 完了条件:
  - [ ] dashboard初回描画2秒以内。
  - [ ] detail表示2秒以内。
  - [ ] startup 10/10成功。
  - [ ] fake commit generation 10/10でstarted 60秒以内。
  - [ ] failure case 100%でsuccess扱いしない。
  - [ ] secret sentinel検出0件。
  - [ ] `eval:generation`と`eval:recovery`がcaseごとの判定、pass/fail件数、generation start latencyをJSONで出力する。
- 検証コマンド:

```bash
npm run test:all && npm run verify:secrets
```

---

## T019: README・運用手順・最終自動回帰

- 依存: T018
- 目的: セットアップ、登録、commit生成、backup、restoreを手順化して全自動試験を固定する。
- 触るファイル:
  - 新規: `README.md`
  - 変更: `.github/workflows/ci.yml`
- 実装内容:
  1. READMEへNode `>=24.15.0 <25`、npm `12.0.2`、Git `>=2.45.0`、gh `>=2.98.0`、Codex `>=0.146.0`を記載し、npm `12.0.2`とdependencies/devDependencies 16件（合計17件のnpm package指定）は完全一致固定であることを記載する。
  2. `gh auth login`、`codex login`、`doctor`、build/startを記載する。
  3. project登録手順を記載する。
  4. commit後の非同期生成とpush時backupを記載する。
  5. restore/restore --forceを記載する。
  6. API keyを標準経路に使わないことを明記する。
  7. CI最終内容をDESIGN.md v1.1と一致させ、`setup-node`は`24.15.0`を使う。
- 完了条件:
  - [ ] READMEだけで初回起動まで実施できる。
  - [ ] READMEだけでbackup/restore試験を実施できる。
  - [ ] AGENTS.mdとCLAUDE.mdが完全一致する。
  - [ ] 全自動試験が成功する。
- 検証コマンド:

```bash
cmp AGENTS.md CLAUDE.md && npm run test:all && npm run verify:secrets
```

---

## T020: 手動確認（最終タスク）

- 依存: T019
- 目的: 実GitHub・実Codex・人間操作を含むMVP受け入れを確認する。
- 触るファイル:
  - 変更: `PROGRESS.md`
- 実装内容:
  1. 下表を上から実施し、結果をPROGRESS.mdへ記録する。
  2. 1件でも期待結果を満たさなければT020を完了にしない。
- 完了条件:
  - [ ] 下表の全項目を実施済み。
  - [ ] generation 10ケース中8件以上pass。
  - [ ] recovery 10ケース中8件以上pass。
  - [ ] secret保存0件。
  - [ ] backup対象100%復元。
  - [ ] 新規固定費0円、新規従量請求0円を確認。
- 検証コマンド:

```bash
npm run lint && npm run typecheck && npm test && npm run build && npm run test:e2e && npm run verify:secrets
```

| # | 操作 | 期待結果 | 対応US |
|---:|---|---|---|
| 1 | `npm run cli -- doctor` | Node `>=24.15.0 <25`、Git `>=2.45.0`、gh `>=2.98.0`、Codex `>=0.146.0`を満たし、gh/Codex認証がpass | US-04, US-05, US-07 |
| 2 | GitHub上にテスト用repo A/Bを用意し、local repo Aを`owner/repo-a`として登録 | project名、repo A対応が保存される | US-01 |
| 3 | repo A登録後dashboardを開く | repo A、最新commit、現在地/完了/次が1分以内に確認可能 | US-02 |
| 4 | repo BのIssue/commitを作成してrepo A詳細を開く | repo B情報がrepo A根拠へ混入しない | US-01, US-05 |
| 5 | repo Aで判断理由を含むcommit/Issueを作成してcommit | 自動generationが開始される | US-04 |
| 6 | project詳細を開く | decision、rationale、根拠へ3分以内に到達できる | US-03 |
| 7 | `npm run eval:generation -- --repo <登録済み評価用repoの絶対Git root>` | 10 commit中8件以上で必須4項目pass、全10件で開始60秒以内 | US-04 |
| 8 | Codexを一時的に利用不能状態にしてcommit | runがfailedになりUIで確認可能 | US-04 |
| 9 | 同じcommitを`git push` | generation run件数が増えずbackup runが作られる | US-04, US-07 |
| 10 | `npm run eval:recovery` | 復元可能10ケース中8件以上pass | US-06 |
| 11 | 根拠不足fixtureを4件確認 | 根拠不足fieldが全件「要補完」 | US-06 |
| 12 | backup repoをGitHub UIで確認 | Private、manifest/data存在、秘密情報なし | US-07 |
| 13 | `tracker.db`を退避削除して`npm run cli -- restore` | project/mapping/progress/history/decision/evidenceが100%復元 | US-07 |
| 14 | 復元後dashboard/detailを開く | 表示2秒以内 | US-02, US-03 |
| 15 | `npm run verify:secrets` | 0件 | US-07 |
| 16 | MVP一連操作後の請求を確認 | 新規固定費0円、既存契約外の従量請求0円 | US-04, US-07 |
