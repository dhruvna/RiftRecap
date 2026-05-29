/** @type {import('knip').KnipConfig} */
export default {
  // Runtime entry points plus slash command modules. Commands are loaded
  // dynamically via fs + import() in src/commands/loadCommands.js, so listing
  // them as entries keeps their helper imports visible to static analysis.
  entry: [
    'src/index.js',
    'src/register-commands.js',
    'src/commands/*.js',
    'src/tests/*.js',
  ],

  // Scan source files only.
  project: ['src/**/*.js'],
};
