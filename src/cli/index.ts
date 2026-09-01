import { runDoctor } from './commands/doctor.js'

async function dispatch(argv: readonly string[]): Promise<number> {
  const [command] = argv
  switch (command) {
    case 'doctor':
      return runDoctor()
    default:
      process.stderr.write(`Unknown command: ${command ?? '(none)'}\n`)
      return 2
  }
}

dispatch(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
