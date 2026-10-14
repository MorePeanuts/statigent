import { Command, InvalidArgumentError, Option } from "commander";

export function uniqueOptionValue(value: string, previous: string | undefined) {
  if (!value || previous !== undefined || value.startsWith("--"))
    throw new InvalidArgumentError("Invalid or duplicate option");
  return value;
}

/** 为离线基准命令保留显式、唯一且非空的长选项约束。 */
export function parseStrictOptions(
  args: string[],
  allowed: readonly string[],
  help: string,
  booleanFlags: readonly string[] = [],
): Record<string, string> {
  const cli = new Command()
    .helpOption(false)
    .configureOutput({ writeErr: () => {} })
    .exitOverride();
  for (const flag of allowed)
    cli.addOption(new Option(`${flag} <value>`).argParser(uniqueOptionValue));
  for (const flag of booleanFlags) cli.addOption(new Option(flag));
  try {
    cli.parse(args, { from: "user" });
    if (
      booleanFlags.some((flag) => args.filter((arg) => arg === flag).length > 1)
    )
      throw new Error(help);
    if (cli.args.length) throw new Error(help);
  } catch {
    throw new Error(help);
  }
  const values = cli.opts<Record<string, string | boolean>>();
  return Object.fromEntries(
    [...allowed, ...booleanFlags].flatMap((flag) => {
      const name = flag
        .slice(2)
        .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      return values[name] === undefined ? [] : [[flag, String(values[name])]];
    }),
  );
}

export function parsePositionals(
  args: string[],
  syntax: string,
  help: string,
): string[] {
  const cli = new Command()
    .helpOption(false)
    .configureOutput({ writeErr: () => {} })
    .exitOverride()
    .allowExcessArguments(false)
    .arguments(syntax);
  try {
    cli.parse(args, { from: "user" });
  } catch {
    throw new Error(help);
  }
  return cli.args;
}
