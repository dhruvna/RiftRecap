/** @type {import('knip').KnipConfig} */
export default {
  // Analyze the real runtime and tooling entrypoints.
  entry: [
    'src/index.js',
    'src/register-commands.js',
    'src/tests/*.assert.js',
  ],

  // Scan source files only.
  project: ['src/**/*.js'],

  // Commands are loaded dynamically via fs + import() in src/commands/loadCommands.js.
  // Without this, Knip reports each command as an unused file.
  ignore: ['src/commands/*.js', '!src/commands/loadCommands.js'],
};
