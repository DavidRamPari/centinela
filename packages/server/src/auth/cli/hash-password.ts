/** `npm run hash-password`: terminal and stdin handling around `hashPasswordCommand`. */
import { hashPasswordCommand } from '../hash-password.js';

/** First line of standard input (piped use). */
async function readStdinLine(): Promise<string> {
  let text = '';
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (text.includes('\n') || text.length > 4096) break;
  }
  return (text.split('\n')[0] ?? '').replace(/\r$/, '');
}

/** One line typed on the terminal without echo. Ctrl-C aborts. */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    let value = '';
    const done = (finish: () => void) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
      finish();
    };
    function onData(chunk: string) {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(value));
        if (ch === '\u0003') return done(() => reject(new Error('cancelled')));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    }
    stdin.on('data', onData);
  });
}

const interactive = process.stdin.isTTY;
hashPasswordCommand(process.argv.slice(2), {
  interactive,
  readPassword: (prompt) => (interactive ? readHidden(prompt) : readStdinLine()),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
}).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
