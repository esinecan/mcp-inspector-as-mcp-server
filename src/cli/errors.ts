/**
 * Every failure mcp-cli reports carries the exit code it should leave behind.
 *
 * The alternative is a chain of `instanceof` tests in main(), which has to be
 * edited every time a new failure kind appears and silently gives the wrong
 * code when it is not. Here the code is a property of the error.
 *
 * 1 failure, 2 usage error, 3 blocked by the profile.
 */

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

/** The caller asked for something the command surface does not offer. */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2);
  }
}

/** A name the config file does not hold. A usage error, not a server failure. */
export class UnknownServerError extends UsageError {}

/** The config file is missing, unreadable, or the wrong shape. */
export class ConfigError extends UsageError {}

/** The arguments for a call or a prompt are not a JSON object. */
export class ArgumentError extends UsageError {}

/** The profile in force forbids this address. */
export class BlockedError extends CliError {
  constructor(message: string) {
    super(message, 3);
  }
}
