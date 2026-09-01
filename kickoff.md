# kickoff.md

以下のリポジトリ実装をお願いします。  
project_id: `ai-dev-progress-tracker`

添付ファイル: `DESIGN.md`, `TASKS.md`, `AGENTS.md`

1. `AGENTS.md`を読み、作業規約を把握してください。
2. `DESIGN.md`を読み、全体設計を把握してください。
3. `TASKS.md`のT001から順に実装してください。
4. 各タスクの検証コマンドを実行し、通ったらコミット、次へ進んでください。
5. `PROGRESS.md`を作成し、T001〜T020のタスクごとの状態を更新してください。
6. 設計から逸脱する必要が生じたら、実装せず停止して理由を`PROGRESS.md`へ記録し、報告してください。
7. dependencyのversionは`DESIGN.md`記載値へ完全固定し、`^`・`~`を付けないでください。
8. 実GitHub/CodexをCIから呼ばず、CIでは指定のfake executableを使用してください。
9. MVP標準AI経路はCodex CLIのChatGPT認証だけです。API key経路を追加しないでください。
10. appのDB・設定・log・backupへ秘密情報を保存しないでください。
11. 同一commitについてpush時にAI生成を再実行しないでください。
12. `TASKS.md`にない機能、特にWON'T(v1)を追加しないでください。

まずT001から始めてください。
