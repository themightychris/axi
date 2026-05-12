import { runAxiCli } from "../../src/cli.ts";

await runAxiCli({
  description: "Fixture CLI",
  version: "9.9.9",
  topLevelHelp: "fixture help",
  hooks: false,
  home: async () => "home output",
  commands: {
    issue: async () => "issue output",
  },
});
