# @torque-ai/peek

`@torque-ai/peek` is the standalone visual UI capture and interaction server used by TORQUE peek tools. It runs on a workstation with a display, exposes a local HTTP API, and lets TORQUE capture screenshots, inspect windows, compare images, launch apps, and send basic input events through native OS tooling.

## Install

Install globally on the machine whose display TORQUE should inspect:

    npm install -g @torque-ai/peek

The package requires Node.js 18 or newer.

## Usage

Start the local server on the default loopback address and port:

    torque-peek start

Use a custom port:

    torque-peek start --port 9877

Expose the server to another TORQUE instance on your network:

    torque-peek start --host 0.0.0.0 --token <shared-secret>

Check platform dependencies without starting the server:

    torque-peek check

Show server status:

    torque-peek status

Stop the server:

    torque-peek stop

When TORQUE can reach a peek host, existing tools such as `peek_ui`, `peek_interact`, and `peek_diagnose` use it through the registered host URL. A remote host can be registered from TORQUE with:

    register_peek_host { name: "remote-display", url: "http://display-host:9876" }

## Platform Requirements

| Platform | Required native tools | Capabilities |
| --- | --- | --- |
| Windows | PowerShell with .NET desktop APIs | Window listing, screenshot capture, input events, app launch |
| macOS | `screencapture`, `osascript`, `open` | Window listing, screenshot capture, input events, app launch |
| Linux | `xdotool`, `xprop`, plus `maim` or ImageMagick `import` | Window listing, screenshot capture, input events, app launch |

The server starts with reduced capabilities when optional native tools are missing. Run `torque-peek check` to see the exact capability set available on the current workstation.

## Security

By default, `torque-peek start` binds to `127.0.0.1:9876`, so only local processes can connect. Use `--host 0.0.0.0` only for remote display hosts, and pair it with `--token` so requests must include the matching `X-Peek-Token` header.

## Superpowers Companion

TORQUE handles task orchestration and provider execution. For planning, TDD, debugging, and code review workflows around visual changes, pair TORQUE with the Superpowers companion plugin and use `@torque-ai/peek` as the display host that provides screenshots and interaction evidence.

Install Superpowers in Claude Code with:

    /plugin install superpowers

Together, Superpowers helps structure the work while TORQUE and peek execute and verify UI behavior across local or remote workstations.

## License

`@torque-ai/peek` is licensed under the Business Source License 1.1. See [LICENSE](./LICENSE) for details.
