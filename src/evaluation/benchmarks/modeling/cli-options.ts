import { Command, InvalidArgumentError, Option } from "commander";

/** 为离线基准命令保留显式、唯一且非空的长选项约束。 */
export function parseStrictOptions(
  args: string[],
  allowed: readonly string[],
  help: string,
): Record<string, string> {
  const uniqueValue = (value: string, previous: string | undefined) => {
    if (!value || previous !== undefined || value.startsWith("--"))
      throw new InvalidArgumentError("Invalid or duplicate option");
    return value;
  };
  const cli = new Command()
    .helpOption(false)
    .configureOutput({ writeErr: () => {} })
    .exitOverride();
  for (const flag of allowed)
    cli.addOption(new Option(`${flag} <value>`).argParser(uniqueValue));
  try {
    cli.parse(args, { from: "user" });
    if (cli.args.length) throw new Error(help);
  } catch {
    throw new Error(help);
  }
  const values = cli.opts<Record<string, string>>();
  return Object.fromEntries(
    allowed.flatMap((flag) => {
      const name = flag
        .slice(2)
        .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      return values[name] === undefined ? [] : [[flag, values[name]]];
    }),
  );
}
