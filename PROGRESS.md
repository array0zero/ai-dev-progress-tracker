# PROGRESS.md — 実装進捗記録

project_id: ai-dev-progress-tracker
source: TASKS.md v1.1 / DESIGN.md v1.1

| タスクID | 状態 | 更新日 | 備考 |
|----------|------|--------|------|
| T001 | 完了 | 2026-09-01 | 検証コマンド全通過。npm 12.0.2はdependency install scriptを既定でblockするため、native依存(better-sqlite3)とesbuildのみpackage.jsonの`allowScripts`で許可した。dependency版数・ファイル構成は変更なし。 |
| T002 | 完了 | 2026-09-01 | SQLite schema/migration/repository基盤。検証(db-migrations+lease-repository+typecheck)通過。better-sqlite3が型を同梱しないため`@types/better-sqlite3@9.6.0`をdevDependenciesへ追加しDESIGN v1.2 D020へ記録(ランタイム依存は不変更)。 |
| T003 | 完了 | 2026-09-01 | process-runner(shell:false/1MiB上限/timeout kill)、redaction(15キー再帰)、logging(JSON Lines/5MiB rotate)、config へ version判定 pure function、doctor CLI、server起動時 Node version gate。検証(redaction+version-check+typecheck+lint)通過。package.json は既存`cli`スクリプトで doctor 起動可能なため変更不要と判断。 |
| T004 | 完了 | 2026-09-01 | git adapter(inspectRepository: root realpath/absolute-git-dir/hooksPath/origin正規化/HEAD、NOT_GIT_ROOT・GIT_LAYOUT_UNSUPPORTED・CUSTOM_HOOKS_PATH_UNSUPPORTED・REPOSITORY_MISMATCH)、github adapter(checkAuth/viewRepo/listIssues/listPullRequests、常に-R、body 8000上限、updatedAt降順、Zod検証)。fake-ghは`node <fake-gh.mjs>` seam(TRACKER_GH_BIN/ARGS)でPATH非依存にしWindows/CI両対応。検証(git-adapter+github-adapter+typecheck)通過。 |
| T005 | 完了 | 2026-09-01 | POST /api/projects を固定検証順1..14で実装(15 recovery enqueue/16 backup enqueue は T012/T014へ委譲)。hook-service(shebang保持/非shebangはHOOK_UNSUPPORTEDで無変更/project-id重複ブロックなし)。検証(hook-service+project-registration+typecheck)通過。補足: commitsのCRUD割当ファイルがないため`upsertCommit`等を run-repository.ts へ追加(T008で拡張予定)。buildApp が db 必須になり smoke.test.ts を追随更新。shared/domain.ts は本タスク範囲で変更不要。 |
| T006 | 完了 | 2026-09-01 | GET /api/projects read model、DashboardPage/RegisterProjectForm/ProjectCard(DESIGN表示順)/StatusBanner、App.tsx で `/` 描画。検証(build + dashboard.spec + registration.spec、Chromium 4件)通過。補足: E2Eで実ghを呼ばないため playwright.config.ts を更新(runnerが fake gh + 専用DATA_DIRをenvへ確定、workerはenv参照)。snapshot join は未生成のため read model は null 返し(T011で拡張)。fake-gh.ts へ writeFakeGh/addRepoFixture を追加。 |
| T007 | 完了 | 2026-09-01 | GET /api/projects/:id、snapshot JSONのevidence ID解決(当該project限定→他projectは未解決=SNAPSHOT_INCONSISTENT・500にしない)、decision/rationale/根拠を同一block表示、URLがある時のみ外部link。App.tsx が pathname で `/projects/:id` を分岐。検証(build + project-detail.spec 4件 + typecheck)通過。補足: 整合性エラー用に `SNAPSHOT_INCONSISTENT` を API error 一覧へ追加(DESIGN未記載)。snapshot field 展開は progress-repository.ts の readSnapshotView/resolveEvidence(T009/T010の schemas/progress.ts 前の暫定)。generation/backup status は T011 で配線。styles.css は T007対象外のため未変更。 |
| T008 | 完了 | 2026-09-01 | hook-commit(引数検証→commit upsert→enqueue→spawn、即return)、generation-service(enqueueGeneration: dedupe_key 1件・同一txnでlease取得・stale lease回収でWORKER_LEASE_EXPIRED、startGenerationWorker: 同期spawn失敗でWORKER_SPAWN_FAILED)、generation-worker(lease token検証・detected_at ASC,id ASCで1件ずつrunning遷移・queue空txn内でrelease・取りこぼし防止)、worker/index.ts。run-repository へ claim/hasQueued/markRunTerminal/failRunning 追加。検証(commit-generation-flow 6件 + typecheck)通過。runGeneration は暫定で failed(CODEX_UNAVAILABLE)、T009-T011で本実装。 |
| T009 | 未着手 | 2026-09-01 | |
| T010 | 未着手 | 2026-09-01 | |
| T011 | 未着手 | 2026-09-01 | |
| T012 | 未着手 | 2026-09-01 | |
| T013 | 未着手 | 2026-09-01 | |
| T014 | 未着手 | 2026-09-01 | |
| T015 | 未着手 | 2026-09-01 | |
| T016 | 未着手 | 2026-09-01 | |
| T017 | 未着手 | 2026-09-01 | |
| T018 | 未着手 | 2026-09-01 | |
| T019 | 未着手 | 2026-09-01 | |
| T020 | 未着手 | 2026-09-01 | |
