# kickoff.md

以下のリポジトリ実装をお願いします。  
対象: `ai-dev-progress-tracker` v2.0（設計ファイル revision 2.1）  
添付ファイル: `DESIGN.md`, `TASKS.md`, `AGENTS.md`

1. `AGENTS.md` を読み、作業規約を把握してください。
2. `DESIGN.md` を読み、全体設計、v1.3互換インベントリ、技術選定、データモデル、Codex / Claude Code検知方式を把握してください。
3. `TASKS.md` の T001 から依存関係どおり順に実装してください。
4. 各タスクの検証コマンドを実行し、通ったら `Txxx: <タスク名>` でコミット、次へ進んでください。
5. `PROGRESS.md` を作成し、T001〜T025の状態を更新してください。各完了行にはcommit SHAと検証結果を記録してください。
6. 設計から逸脱する必要が生じたら、実装せず停止して理由を報告してください。
7. `schemas/progress-output.schema.json`, `db/migrations/001_init.sql`, `schemas/backup-v1.schema.json` はv1.3互換正本なので変更しないでください。加えて公開commit `c281f91` / DESIGN v1.7の`generation-service.ts` prompt契約、`progress.ts`のneeds_input正規化、`eval:recovery`判定規則をF13互換として維持してください。
8. Node/npm/Git/gh/Codex/Claude Codeのversion条件はDESIGN.mdの最低versionだけを使い、上限を追加しないでください。npm packageはDESIGN.mdの完全一致versionから変更しないでください。
9. 外部CLI/service機能はfakeだけで完了させず、T009/T010/T011/T017/T018の実機タスクまで実行してください。実機検証は指定のtemp環境/専用Private fixture repoだけを使い、対象repository・production backup・利用者project dataを評価目的で変更しないでください。
10. recovery評価のdefault fixtureで自然言語本文をexpectedに固定せず、`mustContain` / `mustNotContain`を必須expectedへ戻さないでください（v1.7の任意補助check機能は維持）。expected recovery/field status、required evidence、unknown evidence 0件と、根拠不足caseでもcanonical needs_input snapshotを残すv1.7挙動を回帰させないでください。
11. UI性能の期待値を想定で書かないでください。T021でharnessを実装し、T022で実測した出力から`tests/fixtures/ui-performance-observed.json`を生成してください。
12. `AGENTS.md` と `CLAUDE.md` は同一内容に保ってください。
13. 外部認証不足、Codex notify競合、Claude hooks無効、fixture repo所有確認不能などAGENTS.mdの停止条件に到達した場合だけ停止して報告してください。それ以外では人間の追加判断を求めず実装を続行してください。

実測済み前提:
- Node.js `24.15.0`
- npm `12.0.2`
- Git `2.45.1.windows.1`
- GitHub CLI `2.98.0` / 認証済み
- Codex CLI `0.152.0` / ChatGPT認証済み
- Claude Code `2.1.258` / 認証状態はT010で実測
- Python `3.14.5`（製品依存ではない）
- UI受入viewport `2005 x 1271`
- Windows edition/build・実利用browser名/versionはT025で記録する

まず T001 から始めてください。
