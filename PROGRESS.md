# PROGRESS.md — 実装進捗記録

project_id: ai-dev-progress-tracker  
source: TASKS.md v2.1 / DESIGN.md v2.1  
v1.3〜v1.7 (T001〜T020) の記録は `PROGRESS-v1.md` を参照。

| タスクID | 状態 | 更新日 | 備考 |
|----------|------|--------|------|
| T001 | 完了 | 2026-09-02 | commit SHA: 36832f0。engines を `node>=24.15.0` / `npm>=12.0.2` の下限のみへ変更、`packageManager` と `.nvmrc` を削除、`smol-toml@1.8.0` を完全一致でdependenciesへ追加(lock更新)。CIはnpm/Nodeを下限checkへ変更し `verify:secrets` step追加。smoke testへversion parserの正常/境界case(parse失敗・最小一致・最小-1・上限なし)を追加。検証: `npm ci`→lint→typecheck→test(18 files/165件)→build→e2e(14件)→verify:secrets(hit 0件) 全通過。`git status --porcelain` に検証由来の生成物なし。補足: `src/server/config.ts` の node `maxExclusive` は T004(config.ts担当)で除去する。既存 `tests/unit/version-check.test.ts` はDESIGN v2.1のtreeに未記載だがT001の対象外のため無変更。 |
| T002 | 未着手 | 2026-09-02 | v1.7物理・AI生成・recovery互換golden |
| T003 | 未着手 | 2026-09-02 | migration 002・v2 domain/API型・candidate repository |
| T004 | 未着手 | 2026-09-02 | Codex/Claude user integration installer・doctor |
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
