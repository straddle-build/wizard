import { styleText } from 'node:util';

export interface Option<T> { label: string; value: T; hint?: string }

// Numbered menus over plain lines. Cooked terminal mode keeps line editing and Ctrl-C with the terminal, and
// the same code reads scripted answers from a pipe.
export class Prompter {
  #input: NodeJS.ReadableStream;
  #output: NodeJS.WritableStream;
  #color: boolean;
  #lines: string[] = [];
  #waiting: ((line: string | null) => void) | null = null;
  #buffer = '';
  #ended = false;

  constructor(input: NodeJS.ReadableStream, output: NodeJS.WritableStream & { isTTY?: boolean }) {
    this.#input = input;
    this.#output = output;
    this.#color = Boolean(output.isTTY) && !process.env.NO_COLOR;
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      this.#buffer += chunk;
      const parts = this.#buffer.split(/\r?\n/);
      this.#buffer = parts.pop() ?? '';
      for (const line of parts) this.#push(line);
    });
    input.on('end', () => {
      if (this.#buffer) this.#push(this.#buffer);
      this.#buffer = '';
      this.#ended = true;
      this.#waiting?.(null);
      this.#waiting = null;
    });
    input.pause();
  }

  #push(line: string): void {
    if (this.#waiting) {
      const resolve = this.#waiting;
      this.#waiting = null;
      resolve(line);
    } else {
      this.#lines.push(line);
    }
  }

  #nextLine(): Promise<string | null> {
    const queued = this.#lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#ended) return Promise.resolve(null);
    const { promise, resolve } = Promise.withResolvers<string | null>();
    this.#waiting = resolve;
    this.#input.resume();
    return promise.finally(() => this.#input.pause());
  }

  bold(value: string): string {
    return this.#color ? styleText('bold', value) : value;
  }

  dim(value: string): string {
    return this.#color ? styleText('dim', value) : value;
  }

  say(line = ''): void {
    this.#output.write(line + '\n');
  }

  async ask(question: string): Promise<string | null> {
    this.#output.write(question);
    const line = await this.#nextLine();
    if (line !== null && !process.stdin.isTTY) this.#output.write('\n');
    return line?.trim() ?? null;
  }

  // Resolves null when input ends: callers treat that as the developer stopping.
  async choose<T>(question: string, options: readonly Option<T>[], defaultIndex?: number): Promise<T | null> {
    this.say(this.bold(question));
    const width = Math.max(...options.map((o) => o.label.length));
    options.forEach((o, i) => this.say(`  ${i + 1}) ${o.hint ? o.label.padEnd(width) + '  ' + this.dim(o.hint) : o.label}`));
    for (;;) {
      const answer = await this.ask(defaultIndex === undefined ? 'Choose: ' : `Choose [${defaultIndex + 1}]: `);
      if (answer === null) return null;
      const index = answer === '' && defaultIndex !== undefined ? defaultIndex : Number(answer) - 1;
      const picked = Number.isInteger(index) ? options[index] : undefined;
      if (picked) return picked.value;
      this.say(`Enter a number from 1 to ${options.length}.`);
    }
  }
}
