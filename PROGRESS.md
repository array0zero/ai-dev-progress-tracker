# PROGRESS.md — 実装進捗記録

project_id: ai-dev-progress-tracker  
source: TASKS.md v2.1 / DESIGN.md v2.1  
v1.3〜v1.7 (T001〜T020) の記録は `PROGRESS-v1.md` を参照。

| タスクID | 状態 | 更新日 | 備考 |
|----------|------|--------|------|
| T001 | 完了 | 2026-09-02 | commit SHA: 3e2eae0。engines を `node>=24.15.0` / `npm>=12.0.2` の下限のみへ変更、`packageManager` と `.nvmrc` を削除、`smol-toml@1.8.0` を完全一致でdependenciesへ追加(lock更新)。CIはnpm/Nodeを下限checkへ変更し `verify:secrets` step追加。smoke testへversion parserの正常/境界case(parse失敗・最小一致・最小-1・上限なし)を追加。検証: `npm ci`→lint→typecheck→test(18 files/165件)→build→e2e(14件)→verify:secrets(hit 0件) 全通過。`git status --porcelain` に検証由来の生成物なし。補足: `src/server/config.ts` の node `maxExclusive` は T004(config.ts担当)で除去する。既存 `tests/unit/version-check.test.ts` はDESIGN v2.1のtreeに未記載だがT001の対象外のため無変更。 |
| T002 | 完了 | 2026-09-02 | commit SHA: 4e262e9。`tests/fixtures/v1-compat/` へ3物理正本(001_init.sql / backup-v1.schema.json / progress-output.schema.json)をbyte-for-byte copyし、byte一致テストと1 byte改変で失敗するnegative testを追加。temp Git repoへ3 fixtureをcommitし`git show HEAD:<path>`のbytes一致を確認。golden 001をfresh temp data dirへ初回loadしv1全テーブル生成を確認。`buildGenerationPrompt`のv1.7意味契約6点(evidence本文のみconfirmed / タイトルのみ・routineはneeds_input / 4field canonical needs_input形 / 常にschema-valid JSON / confirmedはbundle内evidenceId参照 / decision+rationale)を回帰テスト化。`validateProgressOutput`の正規化・decision item除去・UNKNOWN_EVIDENCE_ID・CODEX_OUTPUT_INVALIDは既存testに加えclassification非弱化2件を追加。v1 backup restoreで6テーブル全行一致(論理項目欠損0件)と0件backupのrestore成功を追加。default `recovery-cases.json`に`mustContain`/`mustNotContain`が必須expectedとして存在しないこと、evaluator側では任意checkとして残ることを回帰テスト化。検証: lint/typecheck、test:unit(119件)、test:integration(65件) 通過。 |
| T003 | 完了 | 2026-09-02 | commit SHA: c4864b6。`db/migrations/002_v2.sql` をDESIGN記載どおり追加(projects へ summary/registration_source/review_required/review_required_at、registration_candidates + index)。migration runnerへversion 2を追加し、v1 DBを上げる直前だけ `tracker.db.pre-v2-<UTC>` を1 copy(WAL checkpoint後、自動削除なし)。`RegistrationSource`/`RegistrationCandidateStatus`/`RegistrationCandidate` をdomainへ、`CANDIDATE_NOT_FOUND`/`CANDIDATE_ALREADY_DECIDED` をapi error codeへ追加。project repositoryにv2 field(read必須・write任意でdefault summary=name / manual / review=false)と `setProjectReviewRequired` を追加。candidate repositoryは9 API(upsertDetected/markPrompted/beginRegistration/recordFailure/markRegistered/decline/reopen/list/get)で、state遷移違反はguard付きUPDATEのchanges=0→falseで拒否。検証: test:unit(128件)・test:integration(69件)・全体test(197件)・lint・typecheck・build・e2e(14件) 通過。補足: `LATEST_MIGRATION_VERSION` はrestore側のbackup manifest schemaVersion判定に使われているため値1のまま据え置き(v1/v2分岐はT016)。DB最新versionは `MIGRATIONS` 末尾。既存 db-migrations testの「再applyしない」assertionをversion一覧 [1,2] へ更新。 |
| T004 | 完了 | 2026-09-02 | commit SHA: __T004SHA__。`agent-integration-service.ts`: Codex `~/.codex/config.toml` を smol-toml でparseし、top-level notify不在時のみmanaged block(`# >>> ... >>>`)を最初のtable headerより前へ挿入。別notifyは`CODEX_NOTIFY_CONFLICT`でbyte不変、構文不正は`INVALID_AGENT_CONFIG`で無変更。Claude `~/.claude/settings.json` は未知key・他hookを保持してtracker matcher group 1件をmerge、`disableAllHooks=true`は`CLAUDE_HOOKS_DISABLED`で無変更。`--repair`はtracker entryのみ再生成(path staleを解消)、`--uninstall`はtracker entryのみ除去。`setup-agents` CLIと`npm run setup:agents`を追加。config.tsのversion下限をNode>=24.15.0/Git>=2.45.0/gh>=2.98.0/Codex>=0.152.0/Claude>=2.1.258へ更新し、Nodeの上限(`maxExclusive`)を削除。doctorへClaude Code version + Codex/Claude detection readiness(raw config/token非出力)を追加。system statusへ`agentIntegration`を追加。検証: test:unit(145件)/test全体(214件)/e2e(14件)/lint/typecheck/build 通過。`node dist/cli/index.js doctor` 実行済み。**実機所見(要判断)**: 利用者の`~/.codex/config.toml`に既存のtop-level notify(Codex computer-use `codex-computer-use.exe turn-ended`)があり、doctorが`CODEX_NOTIFY_CONFLICT`を報告してexit 1。AGENTS.mdの停止条件に該当するため、user configは一切変更していない。T009(実機Codex検知)はinvocation-level `--config notify=...`を使うため影響なし。影響するのは`setup-agents`のCodex側とT025 #4の実利用検知。補足: T004対象外だが版数変更の機械的追随として `tests/unit/version-check.test.ts`・`tests/unit/codex-adapter.test.ts`・`tests/helpers/fake-codex.ts` の期待値をv2.1下限へ更新。doctorはsetup前の`not_installed`をWARN(exit codeに非影響)、conflict/stale/disabled/invalidをFAILとした。README(T023/T024担当)のCodex版数記述は未更新。 |
| T005 | 未着手 | 2026-09-02 | agent-event検知・candidate upsert・登録確認起動 |
| T006 | 未着手 | 2026-09-02 | candidate API・登録確認UI・未登録候補UI |
| T007 | 未着手 | 2026-09-02 | 自動登録state machine・Git/GitHub adapter拡張 |
| T008 | 未着手 | 2026-09-02 | 自動登録retry・failed candidate・manual fallback回帰 |
| T009 | 未着手 | 2026-09-02 | Codex CLI実機で未登録folder検知 |
| T010 | 未着手 | 2026-09-02 | Claude Code実機で未登録folder検知 |
| T011 | 未着手 | 2026-09-02 | GitHub実機でPrivate repo作成・remote・初回push |
| T012 | 未着手 | 2026-09-02 | 進捗鮮度・最終更新・dashboard API projection |
| T013 | 未着手 | 2026-09-02 | 高密度dashboard・状態絞り込み・一覧比較 |
| T014 | 未着手 | 2026-09-02 | 要確認flag・AI再生成queue・UI |
| T015 | 未着手 | 2026-09-02 | 現在状態と進捗履歴の構造分離 |
| T016 | 未着手 | 2026-09-02 | backup-v2 export・v1/v2 restore互換 |
| T017 | 未着手 | 2026-09-02 | GitHub実機でbackup-v2→clone→restore roundtrip |
| T018 | 未着手 | 2026-09-02 | Codex実機で要確認→再生成→鮮度往復 |
| T019 | 未着手 | 2026-09-02 | dense / compact表示切替 |
| T020 | 未着手 | 2026-09-02 | project名・keyword検索 |
| T021 | 未着手 | 2026-09-02 | UI性能評価harness |
| T022 | 未着手 | 2026-09-02 | 実利用viewportで性能実測・観測値確定 |
| T023 | 未着手 | 2026-09-02 | 秘密情報0件・追加費用0円・外部境界の回帰 |
| T024 | 未着手 | 2026-09-02 | 全MUST回帰・README・agent設定最終同期 |
| T025 | 未着手 | 2026-09-02 | 手動確認（最終タスク） |
