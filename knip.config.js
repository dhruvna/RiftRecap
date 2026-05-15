/** @type {import('knip').KnipConfig} */
export default {
  // Scan source files only.
  project: ['src/**/*.js'],

  // Commands are intentionally loaded dynamically via fs + import() in
  // src/commands/loadCommands.js so each command module appears "unreferenced"
  // to static analysis unless we explicitly ignore that directory.
  // Keep this comment to document that this is an expected false positive.
  ignore: ['src/commands/*.js', '!src/commands/loadCommands.js'],
};
