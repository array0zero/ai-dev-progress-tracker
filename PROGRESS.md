# PROGRESS.md — 実装進捗記録

project_id: ai-dev-progress-tracker
source: TASKS.md v1.1 / DESIGN.md v1.1

| タスクID | 状態 | 更新日 | 備考 |
|----------|------|--------|------|
| T001 | 完了 | 2026-09-01 | 検証コマンド全通過。npm 12.0.2はdependency install scriptを既定でblockするため、native依存(better-sqlite3)とesbuildのみpackage.jsonの`allowScripts`で許可した。dependency版数・ファイル構成は変更なし。 |
| T002 | 完了 | 2026-09-01 | SQLite schema/migration/repository基盤。検証(db-migrations+lease-repository+typecheck)通過。better-sqlite3が型を同梱しないため`@types/better-sqlite3@9.6.0`をdevDependenciesへ追加しDESIGN v1.2 D020へ記録(ランタイム依存は不変更)。 |
| T003 | 未着手 | 2026-09-01 | |
| T004 | 未着手 | 2026-09-01 | |
| T005 | 未着手 | 2026-09-01 | |
| T006 | 未着手 | 2026-09-01 | |
| T007 | 未着手 | 2026-09-01 | |
| T008 | 未着手 | 2026-09-01 | |
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
