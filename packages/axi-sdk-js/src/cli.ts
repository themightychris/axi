import { basename } from "node:path";
import { AxiError, exitCodeForError } from "./errors.js";
import {
  homeHeaderOutput,
  renderError,
  renderOutput,
  type AxiRenderable,
  type AxiStructuredOutput,
} from "./output.js";

type MaybePromise<T> = T | Promise<T>;

export type AxiCliCommand<TContext> = (
  args: string[],
  context: TContext | undefined,
) => MaybePromise<AxiRenderable>;

export interface AxiResolveContextInput {
  command: string | undefined;
  args: string[];
}

export interface AxiCliOptions<TContext = undefined> {
  description: string;
  version?: string;
  argv?: string[];
  topLevelHelp: string;
  commands: Record<string, AxiCliCommand<TContext>>;
  home: AxiCliCommand<TContext>;
  getCommandHelp?: (command: string) => string | null | undefined;
  initialize?: () => void;
  resolveContext?: (input: AxiResolveContextInput) => MaybePromise<TContext>;
  stdout?: { write: (chunk: string) => unknown };
  renderUnknownCommand?: (command: string) => string;
  formatError?: (error: unknown) => { output: string; exitCode: number };
}

function defaultFormatError(error: unknown): {
  output: string;
  exitCode: number;
} {
  if (error instanceof AxiError) {
    return {
      output: `${renderError(error.message, error.code, error.suggestions)}\n`,
      exitCode: exitCodeForError(error),
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    output: `${renderError(message, "UNKNOWN")}\n`,
    exitCode: 1,
  };
}

function defaultUnknownCommand(command: string): string {
  return `${renderError(`Unknown command: ${command}`, "VALIDATION_ERROR", [
    "Run `--help` to see available commands",
  ])}\n`;
}

export async function runAxiCli<TContext = undefined>(
  options: AxiCliOptions<TContext>,
): Promise<void> {
  options.initialize?.();

  const stdout = options.stdout ?? process.stdout;
  const argv = options.argv ?? process.argv.slice(2);

  if (argv.length === 1 && argv[0] === "--help") {
    stdout.write(options.topLevelHelp);
    return;
  }

  if (argv.length === 1 && isVersionFlag(argv[0])) {
    if (!options.version) {
      stdout.write(
        `${renderError("Version is not configured for this tool", "VALIDATION_ERROR")}\n`,
      );
      process.exitCode = 2;
      return;
    }

    stdout.write(`${options.version}\n`);
    return;
  }

  const command = argv[0];
  if (!command) {
    const context = await options.resolveContext?.({
      command: undefined,
      args: [],
    });
    await runHandler(options.home, [], context, stdout, options, true);
    return;
  }

  if (command.startsWith("-")) {
    stdout.write(renderLeadingFlagError(command));
    process.exitCode = 2;
    return;
  }

  const args = argv.slice(1);

  if (args.includes("--help")) {
    const help = options.getCommandHelp?.(command);
    if (help) {
      stdout.write(help);
      return;
    }
  }

  const handler = options.commands[command];
  if (!handler) {
    stdout.write(
      (options.renderUnknownCommand ?? defaultUnknownCommand)(command),
    );
    process.exitCode = 2;
    return;
  }

  const context = await options.resolveContext?.({ command, args });
  await runHandler(handler, args, context, stdout, options, false);
}

async function runHandler<TContext>(
  handler: AxiCliCommand<TContext>,
  args: string[],
  context: TContext | undefined,
  stdout: { write: (chunk: string) => unknown },
  options: AxiCliOptions<TContext>,
  isHomeView: boolean,
): Promise<void> {
  try {
    const output = await handler(args, context);
    stdout.write(`${renderCommandOutput(output, options, isHomeView)}\n`);
  } catch (error) {
    const formatted = (options.formatError ?? defaultFormatError)(error);
    stdout.write(formatted.output);
    process.exitCode = formatted.exitCode;
  }
}

function renderLeadingFlagError(flag: string): string {
  const bin = basename(process.argv[1] ?? "tool") || "tool";
  return `${renderError(
    "Flags must come after the command",
    "VALIDATION_ERROR",
    [
      `Run \`${bin} <command> [args] [flags]\``,
      `Move \`${flag}\` after the command instead of before it`,
    ],
  )}\n`;
}

function isVersionFlag(flag: string): boolean {
  return flag === "-v" || flag === "-V" || flag === "--version";
}

function renderCommandOutput<TContext>(
  output: AxiRenderable,
  options: AxiCliOptions<TContext>,
  isHomeView: boolean,
): string {
  if (!isHomeView) {
    return renderOutput(output);
  }

  const header = homeHeaderOutput({ description: options.description });

  if (typeof output === "string") {
    return `${renderOutput(header)}\n${output}`;
  }

  return renderOutput(mergeHomeHeader(header, output));
}

function mergeHomeHeader(
  header: AxiStructuredOutput,
  output: AxiStructuredOutput,
): AxiStructuredOutput {
  const rest = { ...output };
  delete rest.bin;
  delete rest.description;

  return {
    ...header,
    ...rest,
  };
}
