import {
  type AgentIntegrationOptions,
  setupAgents,
} from '../../server/services/agent-integration-service.js'

export interface SetupAgentsArgs {
  repair?: boolean
  uninstall?: boolean
}

/**
 * Codex / Claude Code の user 設定へ tracker entry を 1 件だけ入れる。
 * 競合・hooks 無効は固定 error code で報告し、元 file を変更しない。
 */
export function runSetupAgents(
  args: SetupAgentsArgs,
  options: AgentIntegrationOptions = {},
): number {
  const mode = args.uninstall === true ? 'uninstall' : args.repair === true ? 'repair' : 'install'
  const outcomes = setupAgents(mode, options)
  for (const outcome of outcomes) {
    if (outcome.ok) {
      process.stdout.write(`OK   ${outcome.agent}: ${outcome.state}\n`)
    } else {
      process.stdout.write(`FAIL ${outcome.agent}: ${outcome.code}\n`)
    }
  }
  return outcomes.every((outcome) => outcome.ok) ? 0 : 1
}
