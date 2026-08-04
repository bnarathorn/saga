/**
 * API compatibility (spec 13.1 step 7, 13.4).
 *
 * Saga is pre-1.0, so the usual semver rule does not apply: under 0.x a *minor* bump is the
 * breaking one. The comparison below encodes that, and treats anything it cannot parse as a
 * warning rather than a failure — an unreadable version string is not evidence of breakage.
 */

/**
 * This CLI's own version, and the only definition of it — `saga --version`, the MCP server's
 * advertised version and the compatibility check below all read this one.
 *
 * Deliberately not `SAGA_VERSION`: that names the *server's* version and is set in the server's
 * own environment (deploy/systemd/saga.env.example). Running `saga` on the host that serves the
 * API would then hand `checkApiCompatibility` the same number on both sides, so a CLI too old to
 * talk to that server would report itself compatible with it. Injected at build time; the
 * fallback matches `package.json`.
 */
export const CLI_VERSION = process.env.SAGA_CLI_VERSION ?? '0.1.0';

export type CompatibilityVerdict = 'compatible' | 'unknown' | 'incompatible';

export interface Compatibility {
  verdict: CompatibilityVerdict;
  message: string;
  /** What the user should do. Absent when nothing is required. */
  action?: string;
}

interface Version {
  major: number;
  minor: number;
}

function parse(value: string): Version | null {
  const match = /^v?(\d+)\.(\d+)/.exec(value.trim());
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function checkApiCompatibility(
  serverVersion: string,
  cliVersion: string = CLI_VERSION,
): Compatibility {
  const server = parse(serverVersion);
  const cli = parse(cliVersion);

  if (server === null || cli === null) {
    return {
      verdict: 'unknown',
      message: `Could not compare CLI ${cliVersion} with server ${serverVersion}.`,
      action: 'Check the versions by hand if something behaves unexpectedly.',
    };
  }

  if (server.major !== cli.major) {
    return {
      verdict: 'incompatible',
      message: `This CLI is ${cliVersion}; the server speaks ${serverVersion}.`,
      action:
        server.major > cli.major
          ? 'Upgrade the CLI to match the server: pull the Saga repository, then `pnpm --filter @saga/cli build && pnpm -C apps/cli link --global`.'
          : 'This CLI is newer than the server. Upgrade the server, or use a matching CLI.',
    };
  }

  // Before 1.0 the minor carries breaking changes, so a mismatch is real — but the endpoints
  // this CLI uses are the stable ones, so it is reported as a warning, not a hard stop.
  if (server.major === 0 && server.minor !== cli.minor) {
    return {
      verdict: 'unknown',
      message: `CLI ${cliVersion} and server ${serverVersion} differ before 1.0, where minor versions may break.`,
      action: 'Upgrade whichever is older if a command behaves unexpectedly.',
    };
  }

  return { verdict: 'compatible', message: `CLI ${cliVersion}, server ${serverVersion}.` };
}
